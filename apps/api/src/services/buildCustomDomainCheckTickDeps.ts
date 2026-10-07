/**
 * Composition root for the custom-domain checker.
 *
 * Wires for checkCustomDomain / runCustomDomainCheckTick:
 *   loadDue           -> custom_domains where nextCheckAt <= now, bounded,
 *                        and at most CHECK_BATCH_PER_ORG rows of any one
 *                        organization: the organizations with due rows
 *                        (longest-waiting first), each one's oldest rows, then
 *                        one row from each in turn. An explicit select that
 *                        never reads the certificate key columns
 *   lookupTxt, lookupAddresses, isZoneApex, caaDiagnostic
 *                     -> services/domainDns.ts (configured resolvers, timeout)
 *   loadEntitlements  -> effectivePlan over org_subscriptions, one query for
 *                        all the tick's organisations
 *   targetExists      -> the agent or deployment, scoped to the row's org
 *   probeTls          -> services/tlsCertificateProbe.ts, to the address the
 *                        core chose from the configured edge addresses, with
 *                        the domain's proof; public trust roots only, unless a
 *                        non-production server was given an extra CA
 *   persist           -> compare-and-set updateMany on the statuses, the
 *                        switch and the token as loaded. updatedAt is NOT the
 *                        version: request counters bump it constantly.
 *   logEvents         -> domain_events
 *
 * The verified claim is the unique verified_domain column. persist is one
 * statement outside any transaction, so the unique violation that means
 * "another organisation verified this name first" can be caught here.
 */

import tls from "node:tls";

import type { CustomDomainConfig, CustomDomainEdgeConfig } from "../config/customDomains.js";
import {
  CHECK_BATCH_PER_ORG,
  computeDomainProof,
  DOMAIN_PROOF_PATH,
  interleaveByOrganization,
  type CustomDomainCheckRow,
  type CustomDomainPatch,
} from "./customDomainRules.js";
import { createDomainDns, type DomainDns } from "./domainDns.js";
import { effectivePlan, limitsFor } from "./plans.js";
import type { CustomDomainCheckTickDeps } from "./runCustomDomainCheckTick.js";
import { probeTlsCertificate } from "./tlsCertificateProbe.js";

/** The certificate authority the edge uses first; named in the CAA diagnostic. */
export const EDGE_CERTIFICATE_AUTHORITY = "letsencrypt.org";

const DEFAULT_BATCH_LIMIT = 50;

/**
 * Exactly the columns a check reads. customCert, customKey and
 * customCertChain are deliberately absent: nothing in the checker needs key
 * material, so none is ever loaded.
 */
export const CUSTOM_DOMAIN_CHECK_SELECT = {
  id: true,
  orgId: true,
  domain: true,
  targetType: true,
  targetId: true,
  verificationToken: true,
  verificationStatus: true,
  verificationError: true,
  verifiedDomain: true,
  verifiedAt: true,
  verificationStartedAt: true,
  verificationLostAt: true,
  routingStatus: true,
  routingFailures: true,
  routingError: true,
  observedAddresses: true,
  isApex: true,
  sslStatus: true,
  sslFailures: true,
  sslProvisioningSince: true,
  sslExpiresAt: true,
  sslFingerprint256: true,
  sslError: true,
  enabled: true,
  isActive: true,
  pausedReason: true,
} as const;

/** The slice of the Prisma client the checker uses. */
export interface CustomDomainCheckPrisma {
  customDomain: {
    groupBy: (args: {
      by: ["orgId"];
      where: { nextCheckAt: { lte: Date } };
      _min: { nextCheckAt: true };
      orderBy: { _min: { nextCheckAt: "asc" } };
      take: number;
    }) => Promise<Array<{ orgId: string }>>;
    findMany: (args: {
      where: { orgId: string; nextCheckAt: { lte: Date } };
      orderBy: { nextCheckAt: "asc" };
      take: number;
      select: typeof CUSTOM_DOMAIN_CHECK_SELECT;
    }) => Promise<CustomDomainCheckRow[]>;
    updateMany: (args: {
      where: {
        id: string;
        verificationStatus: string;
        verificationToken: string;
        routingStatus: string;
        sslStatus: string;
        enabled: boolean;
      };
      data: CustomDomainPatch;
    }) => Promise<{ count: number }>;
  };
  domainEvent: {
    createMany: (args: {
      data: Array<{
        domainId: string;
        eventType: string;
        message: string;
        previousStatus?: string;
        newStatus?: string;
        details?: Record<string, unknown>;
      }>;
    }) => Promise<unknown>;
  };
  orgSubscription: {
    findMany: (args: {
      where: { orgId: { in: string[] } };
      select: { orgId: true; plan: true; status: true };
    }) => Promise<Array<{ orgId: string; plan: string; status: string }>>;
  };
  agent: { count: (args: { where: { id: string; orgId: string } }) => Promise<number> };
  deployment: { count: (args: { where: { id: string; orgId: string } }) => Promise<number> };
}

export interface BuildCustomDomainCheckTickDepsInput {
  prisma: CustomDomainCheckPrisma;
  edge: CustomDomainEdgeConfig;
  config: Pick<CustomDomainConfig, "dnsServers" | "probeTimeoutMs" | "extraCaPem">;
  batchLimit?: number;
  /** The most rows of one organization in a batch. */
  perOrgLimit?: number;
  /** Injected by tests. */
  dns?: DomainDns;
  /** Injected by tests. */
  probe?: typeof probeTlsCertificate;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

export function buildCustomDomainCheckTickDeps(
  input: BuildCustomDomainCheckTickDepsInput,
): CustomDomainCheckTickDeps {
  const { prisma, edge, config } = input;
  const dns = input.dns ?? createDomainDns({ servers: config.dnsServers });
  const probe = input.probe ?? probeTlsCertificate;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const perOrgLimit = input.perOrgLimit ?? CHECK_BATCH_PER_ORG;
  // `ca` REPLACES the default roots, so the extra CA is added to them. With no
  // extra CA nothing is passed and the runtime's public roots apply.
  const ca = config.extraCaPem ? [...tls.rootCertificates, config.extraCaPem] : undefined;

  return {
    edge: { ipv4: edge.ipv4, ipv6: edge.ipv6 },

    loadDue: async ({ now }) => {
      const due = { nextCheckAt: { lte: now } };
      // "Oldest rows first" across all organizations would let one
      // organization with thousands of due rows fill every batch and push
      // everyone else's checks back. So the batch is built per organization.
      const organizations = await prisma.customDomain.groupBy({
        by: ["orgId"],
        where: due,
        _min: { nextCheckAt: true },
        orderBy: { _min: { nextCheckAt: "asc" } },
        take: batchLimit,
      });
      const groups: CustomDomainCheckRow[][] = [];
      for (const { orgId } of organizations) {
        groups.push(
          await prisma.customDomain.findMany({
            where: { orgId, ...due },
            orderBy: { nextCheckAt: "asc" },
            take: perOrgLimit,
            select: CUSTOM_DOMAIN_CHECK_SELECT,
          }),
        );
      }
      return interleaveByOrganization(groups, batchLimit);
    },

    lookupTxt: (name) => dns.lookupTxt(name),
    lookupAddresses: (name) => dns.lookupAddresses(name),
    isZoneApex: (name) => dns.isZoneApex(name),
    caaDiagnostic: (name) => dns.caaDiagnostic(name, EDGE_CERTIFICATE_AUTHORITY),

    loadEntitlements: async (orgIds) => {
      const subscriptions = await prisma.orgSubscription.findMany({
        where: { orgId: { in: orgIds } },
        select: { orgId: true, plan: true, status: true },
      });
      const byOrg = new Map(subscriptions.map((sub) => [sub.orgId, sub]));
      // No subscription row is a known answer: the Starter plan.
      return new Map(
        orgIds.map((orgId) => [orgId, limitsFor(effectivePlan(byOrg.get(orgId))).customDomains]),
      );
    },

    targetExists: async (row) => {
      const where = { id: row.targetId, orgId: row.orgId };
      if (row.targetType === "agent") return (await prisma.agent.count({ where })) > 0;
      if (row.targetType === "deployment") return (await prisma.deployment.count({ where })) > 0;
      return false;
    },

    probeTls: ({ address, row }) =>
      probe({
        address,
        servername: row.domain,
        timeoutMs: config.probeTimeoutMs,
        proof: { path: DOMAIN_PROOF_PATH, expected: computeDomainProof(edge.edgeSecret, row.id) },
        ...(ca ? { ca } : {}),
      }),

    persist: async (row, patch) => {
      try {
        const { count } = await prisma.customDomain.updateMany({
          where: {
            id: row.id,
            verificationStatus: row.verificationStatus,
            // A re-verify rotates the token and keeps the status 'pending':
            // without the token here, a record matched against the OLD token
            // could verify the row after the rotation.
            verificationToken: row.verificationToken,
            routingStatus: row.routingStatus,
            sslStatus: row.sslStatus,
            enabled: row.enabled,
          },
          data: patch,
        });
        return count === 0 ? "conflict" : "ok";
      } catch (error) {
        // The only unique column a check writes is verified_domain, and only
        // when it acquires the claim.
        if (isUniqueViolation(error) && typeof patch.verifiedDomain === "string") {
          return "claimed_elsewhere";
        }
        throw error;
      }
    },

    logEvents: async (domainId, events) => {
      if (events.length === 0) return;
      await prisma.domainEvent.createMany({
        data: events.map((event) => ({ domainId, ...event })),
      });
    },
  };
}
