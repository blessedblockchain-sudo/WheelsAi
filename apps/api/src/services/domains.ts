/**
 * Custom domains: what an organization can do with its own.
 *
 * This module records what the owner asked for (the name, its target, the
 * switch, a new token) and asks for checks. It never decides what a domain IS:
 * every status comes from services/customDomainRules.ts, and a certificate
 * status only from a handshake services/runCustomDomainCheckTick.ts made with
 * the edge. There is no timer here and nothing is assumed to have happened.
 *
 *   createDomainsService(deps)   the service over a structural database
 *                                surface (unit tests drive it with fakes)
 *   domainsService()             the production instance
 *
 * Every read and write is scoped to the caller's organization, every write to
 * a status is a compare-and-set against the row as it was read, and no query
 * selects the certificate key columns.
 */

import crypto from "node:crypto";

import {
  CUSTOM_DOMAINS_UNAVAILABLE_MESSAGE,
  getCustomDomainConfig,
  type CustomDomainConfig,
} from "../config/customDomains.js";
import {
  buildDnsInstructions,
  buildReservedHosts,
  decideEnabledChange,
  normalizeDomainInput,
  reverifyAvailableAt,
  reverifyDecision,
  SSL_EXPIRING_SOON_MS,
  txtContainsToken,
  validateCustomHeaders,
  type CustomDomainCheckRow,
  type DnsInstructions,
  type DomainEventInput,
} from "./customDomainRules.js";
import { checkCustomDomain, type CustomDomainCheckDeps } from "./runCustomDomainCheckTick.js";

// ============================================
// Types
// ============================================

export interface CreateDomainInput {
  domain: string;
  targetType: "agent" | "deployment";
  targetId: string;
  headers?: Record<string, string>;
}

export interface UpdateDomainInput {
  headers?: Record<string, string>;
  isPrimary?: boolean;
}

/** A refusal with the status and code the API answers. */
export class DomainError extends Error {
  override name = "DomainError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Every column a caller may see. customCert, customKey and customCertChain
 * are absent on purpose: key material is never read into an API process, so
 * it can never be returned by one.
 */
export const CUSTOM_DOMAIN_VIEW_SELECT = {
  id: true,
  orgId: true,
  domain: true,
  subdomain: true,
  rootDomain: true,
  verifiedDomain: true,
  targetType: true,
  targetId: true,
  verificationStatus: true,
  verificationToken: true,
  verificationMethod: true,
  verifiedAt: true,
  lastCheckedAt: true,
  verificationError: true,
  verificationStartedAt: true,
  verificationLostAt: true,
  routingStatus: true,
  routingFailures: true,
  routingCheckedAt: true,
  routingError: true,
  observedAddresses: true,
  isApex: true,
  sslStatus: true,
  sslProvider: true,
  sslExpiresAt: true,
  sslError: true,
  sslCheckedAt: true,
  sslValidFrom: true,
  sslIssuer: true,
  sslFingerprint256: true,
  sslFailures: true,
  sslProvisioningSince: true,
  routingMode: true,
  forceHttps: true,
  headers: true,
  enabled: true,
  isActive: true,
  pausedReason: true,
  isPrimary: true,
  nextCheckAt: true,
  totalRequests: true,
  lastRequestAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CustomDomainRow extends CustomDomainCheckRow {
  subdomain: string | null;
  rootDomain: string;
  verificationMethod: string;
  lastCheckedAt: Date | null;
  routingCheckedAt: Date | null;
  sslProvider: string | null;
  sslCheckedAt: Date | null;
  sslValidFrom: Date | null;
  sslIssuer: string | null;
  routingMode: string;
  forceHttps: boolean;
  headers: unknown;
  isPrimary: boolean;
  nextCheckAt: Date | null;
  totalRequests: bigint;
  lastRequestAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DomainEventRow {
  id: string;
  domainId: string;
  eventType: string;
  message: string | null;
  details: unknown;
  previousStatus: string | null;
  newStatus: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/** The slice of the Prisma client this service uses. */
export interface DomainsDb {
  customDomain: {
    findFirst: (args: { where: Where; select: typeof CUSTOM_DOMAIN_VIEW_SELECT }) => Promise<CustomDomainRow | null>;
    findMany: (args: {
      where: Where;
      orderBy: { createdAt: "desc" };
      take: number;
      skip: number;
      select: typeof CUSTOM_DOMAIN_VIEW_SELECT;
    }) => Promise<CustomDomainRow[]>;
    count: (args: { where: Where }) => Promise<number>;
    create: (args: { data: Record<string, unknown>; select: typeof CUSTOM_DOMAIN_VIEW_SELECT }) => Promise<CustomDomainRow>;
    updateMany: (args: { where: Where; data: Record<string, unknown> }) => Promise<{ count: number }>;
    deleteMany: (args: { where: { id: string; orgId: string } }) => Promise<{ count: number }>;
  };
  domainEvent: {
    createMany: (args: { data: Array<DomainEventInput & { domainId: string }> }) => Promise<unknown>;
    findMany: (args: {
      where: { domainId: string };
      orderBy: { createdAt: "desc" };
      take: number;
      skip: number;
    }) => Promise<DomainEventRow[]>;
    count: (args: { where: { domainId: string } }) => Promise<number>;
    deleteMany: (args: { where: { domainId: string } }) => Promise<unknown>;
  };
  agent: { count: (args: { where: { id: string; orgId: string } }) => Promise<number> };
  deployment: { count: (args: { where: { id: string; orgId: string } }) => Promise<number> };
}

export interface DomainsServiceDeps {
  db: DomainsDb;
  getConfig: () => CustomDomainConfig;
  /** The platform's own hosts, which nobody may register. */
  reservedHosts: () => readonly string[];
  /** The check core's dependencies for a configured edge. */
  buildCheckDeps: (edge: NonNullable<CustomDomainConfig["edge"]>) => CustomDomainCheckDeps;
  /**
   * Runs `run` while no other request can add a domain to the same
   * organization (production: a transaction holding a Postgres advisory
   * lock), so counting the organization's domains and adding one more cannot
   * interleave with another request doing the same.
   */
  withOrgLock: <T>(orgId: string, run: (db: Pick<DomainsDb, "customDomain">) => Promise<T>) => Promise<T>;
  /**
   * The host router's local copy. `drop` stops routing a name on this machine
   * at once; `refresh` reloads it in the background.
   */
  routes?: { drop: (domain: string) => void; refresh: () => void };
  now?: () => Date;
  generateToken?: () => string;
}

export interface CertificateView {
  status: string;
  provider: string | null;
  issuer: string | null;
  validFrom: Date | null;
  expiresAt: Date | null;
  fingerprint256: string | null;
  checkedAt: Date | null;
  error: string | null;
}

export interface RoutingView {
  status: string;
  checkedAt: Date | null;
  error: string | null;
  observedAddresses: string[];
}

export type CustomDomainView = CustomDomainRow & {
  dnsRecords: DnsInstructions;
  routing: RoutingView;
  certificate: CertificateView;
};

// ============================================
// Helpers
// ============================================

/** While a certificate is not yet active, an owner may ask for a handshake this often. */
export const MANUAL_PROBE_SPACING_MS = 15 * 60_000;
/** An active certificate is just read again; that can be asked for more often. */
export const MANUAL_PROBE_SPACING_ACTIVE_MS = 60_000;

function parseDomain(domain: string): { subdomain: string | null; rootDomain: string } {
  const parts = domain.split(".");
  if (parts.length <= 2) return { subdomain: null, rootDomain: domain };
  // Display only (the dashboard groups by it); routing never reads it.
  const twoLevelSuffixes = ["co.uk", "com.au", "com.br", "co.nz", "co.jp"];
  const take = twoLevelSuffixes.includes(parts.slice(-2).join(".")) ? 3 : 2;
  if (parts.length === take) return { subdomain: null, rootDomain: domain };
  return { subdomain: parts.slice(0, -take).join("."), rootDomain: parts.slice(-take).join(".") };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

const notFound = () => new DomainError(404, "not_found", "Domain not found");

// ============================================
// Service
// ============================================

export function createDomainsService(deps: DomainsServiceDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const generateToken =
    deps.generateToken ?? (() => `wheels-verify-${crypto.randomBytes(16).toString("hex")}`);

  /** The edge, or the house 501 naming why there is none. */
  function requireEdge() {
    const config = deps.getConfig();
    if (!config.edge) {
      throw new DomainError(
        501,
        "custom_domains_not_configured",
        CUSTOM_DOMAINS_UNAVAILABLE_MESSAGE,
      );
    }
    return config.edge;
  }

  async function load(domainId: string, orgId: string): Promise<CustomDomainRow> {
    const row = await db.customDomain.findFirst({
      where: { id: domainId, orgId },
      select: CUSTOM_DOMAIN_VIEW_SELECT,
    });
    if (!row) throw notFound();
    return row;
  }

  function toView(row: CustomDomainRow): CustomDomainView {
    return {
      ...row,
      dnsRecords: buildDnsInstructions(row, deps.getConfig().edge),
      routing: {
        status: row.routingStatus,
        checkedAt: row.routingCheckedAt,
        error: row.routingError,
        observedAddresses: row.observedAddresses,
      },
      certificate: {
        status: row.sslStatus,
        provider: row.sslProvider,
        issuer: row.sslIssuer,
        validFrom: row.sslValidFrom,
        expiresAt: row.sslExpiresAt,
        fingerprint256: row.sslFingerprint256,
        checkedAt: row.sslCheckedAt,
        error: row.sslError,
      },
    };
  }

  async function logEvents(domainId: string, events: DomainEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await db.domainEvent.createMany({ data: events.map((event) => ({ domainId, ...event })) });
  }

  async function targetExists(orgId: string, targetType: string, targetId: string): Promise<boolean> {
    const where = { id: targetId, orgId };
    if (targetType === "agent") return (await db.agent.count({ where })) > 0;
    if (targetType === "deployment") return (await db.deployment.count({ where })) > 0;
    return false;
  }

  /** The statuses a compare-and-set holds a row to, as it was read. */
  function asRead(row: CustomDomainRow, orgId: string): Where {
    return {
      id: row.id,
      orgId,
      verificationStatus: row.verificationStatus,
      verificationToken: row.verificationToken,
      routingStatus: row.routingStatus,
      sslStatus: row.sslStatus,
      enabled: row.enabled,
    };
  }

  const changedUnderneath = () =>
    new DomainError(409, "domain_changed", "The domain changed while this was being done. Try again.");

  // ---- create / read / update / delete ----

  async function createCustomDomain(orgId: string, input: CreateDomainInput): Promise<CustomDomainView> {
    requireEdge();

    const normalized = normalizeDomainInput(input.domain, { reservedHosts: deps.reservedHosts() });
    if (!normalized.ok) throw new DomainError(400, normalized.error, normalized.message);
    const domain = normalized.domain;

    const headers = validateCustomHeaders(input.headers);
    if (!headers.ok) throw new DomainError(400, "invalid_headers", headers.message);

    if (input.targetType !== "agent" && input.targetType !== "deployment") {
      throw new DomainError(400, "target_not_found", "A domain points at an agent or a model deployment.");
    }
    if (!(await targetExists(orgId, input.targetType, input.targetId))) {
      throw new DomainError(
        400,
        "target_not_found",
        `That ${input.targetType === "agent" ? "agent" : "deployment"} does not exist in this organization.`,
      );
    }

    // A name is taken when this organization already added it, or when another
    // organization has VERIFIED it. Someone else's unverified claim blocks nobody.
    const [own, claimed] = await Promise.all([
      db.customDomain.count({ where: { orgId, domain } }),
      db.customDomain.count({ where: { verifiedDomain: domain } }),
    ]);
    if (own > 0) {
      throw new DomainError(409, "domain_exists", "This domain is already added to your organization.");
    }
    if (claimed > 0) {
      throw new DomainError(
        409,
        "domain_claimed",
        "This domain is already verified by another organization.",
      );
    }

    // Every domain is checked on a schedule and may cost the platform's
    // shared certificate account an order, so an organization has a bounded
    // number of them. Every row counts, whatever its state: an unverified or
    // expired one is still a row the owner can delete to make room.
    const limit = deps.getConfig().limits.maxDomainsPerOrg;
    const created = now();
    let row: CustomDomainRow;
    try {
      row = await deps.withOrgLock(orgId, async (locked) => {
        const count = await locked.customDomain.count({ where: { orgId } });
        if (count >= limit) {
          throw new DomainError(
            403,
            "domain_limit_reached",
            `An organization can have at most ${limit} custom domains, and this one has ${count}. Delete one you no longer use to add another.`,
            { limit, count },
          );
        }
        return locked.customDomain.create({
          data: {
            orgId,
            domain,
            ...parseDomain(domain),
            targetType: input.targetType,
            targetId: input.targetId,
            verificationToken: generateToken(),
            verificationStartedAt: created,
            // HTTPS is always enforced on a custom domain.
            forceHttps: true,
            headers: headers.headers,
            // The checker picks the row up on its own; the owner need not press anything.
            nextCheckAt: new Date(created.getTime() + 2 * 60_000),
          },
          select: CUSTOM_DOMAIN_VIEW_SELECT,
        });
      });
    } catch (error) {
      // Two requests adding the same name at once: the unique (org, domain) decides.
      if (isUniqueViolation(error)) {
        throw new DomainError(409, "domain_exists", "This domain is already added to your organization.");
      }
      throw error;
    }

    await logEvents(row.id, [
      {
        eventType: "created",
        message: "Domain added",
        details: { domain, targetType: input.targetType, targetId: input.targetId },
      },
    ]);

    return toView(row);
  }

  async function getCustomDomains(
    orgId: string,
    options: {
      targetType?: string;
      targetId?: string;
      isActive?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const { targetType, targetId, isActive, limit = 20, offset = 0 } = options;
    const where: Where = {
      orgId,
      ...(targetType && { targetType }),
      ...(targetId && { targetId }),
      ...(isActive !== undefined && { isActive }),
    };
    const [domains, total] = await Promise.all([
      db.customDomain.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: CUSTOM_DOMAIN_VIEW_SELECT,
      }),
      db.customDomain.count({ where }),
    ]);
    return { domains: domains.map(toView), total, limit, offset };
  }

  async function getCustomDomain(domainId: string, orgId: string): Promise<CustomDomainView> {
    return toView(await load(domainId, orgId));
  }

  async function updateCustomDomain(
    domainId: string,
    orgId: string,
    updates: UpdateDomainInput,
  ): Promise<CustomDomainView> {
    const row = await load(domainId, orgId);

    const data: Record<string, unknown> = {};
    if (updates.headers !== undefined) {
      const headers = validateCustomHeaders(updates.headers);
      if (!headers.ok) throw new DomainError(400, "invalid_headers", headers.message);
      data.headers = headers.headers;
    }
    if (updates.isPrimary !== undefined) data.isPrimary = updates.isPrimary;

    // One primary domain per target: the others give it up first.
    if (updates.isPrimary) {
      await db.customDomain.updateMany({
        where: { orgId, targetType: row.targetType, targetId: row.targetId, id: { not: domainId } },
        data: { isPrimary: false },
      });
    }
    if (Object.keys(data).length > 0) {
      await db.customDomain.updateMany({ where: { id: domainId, orgId }, data });
      if (data.headers !== undefined) deps.routes?.refresh();
    }
    return toView(await load(domainId, orgId));
  }

  async function deleteCustomDomain(domainId: string, orgId: string) {
    const row = await load(domainId, orgId);
    // Deleting the row releases the verified claim with it.
    const { count } = await db.customDomain.deleteMany({ where: { id: domainId, orgId } });
    if (count === 0) throw notFound();
    deps.routes?.drop(row.domain);
    await db.domainEvent.deleteMany({ where: { domainId } });
    return { success: true };
  }

  // ---- checks ----

  /**
   * "Check now": looks the ownership record and the addresses up and records
   * what was found. It never waits for a certificate; the checker makes the
   * first handshake on its next pass over the domain.
   */
  async function verifyDomain(domainId: string, orgId: string) {
    const edge = requireEdge();
    const row = await load(domainId, orgId);
    const result = await checkCustomDomain(row, { probeTls: false, now: now() }, deps.buildCheckDeps(edge));

    if (result.outcome === "entitlement_unknown") {
      throw new DomainError(
        503,
        "plan_unavailable",
        "The organization's plan could not be read, so the domain was not checked. Try again shortly.",
      );
    }
    // No answer about the ownership record is not "the record is missing":
    // nothing about the verification was written, and the token stays as it is.
    if (result.observation?.txt.kind === "transient") {
      throw new DomainError(
        503,
        "dns_unavailable",
        "DNS could not be queried just now, so the verification was left as it is. Try again shortly.",
        { retryable: true },
      );
    }
    if (result.outcome === "claimed_elsewhere") {
      throw new DomainError(
        409,
        "domain_claimed",
        "This domain is already verified by another organization, so it cannot be verified here.",
      );
    }
    if (result.outcome === "conflict") throw changedUnderneath();

    const after = await load(domainId, orgId);
    // The name may have started or stopped routing here.
    deps.routes?.refresh();

    const observation = result.observation!;
    const verified = after.verificationStatus === "verified";
    const addressesKnown = observation.addresses.kind !== "transient";
    let message: string;
    if (!verified) {
      message = after.verificationError ?? "The TXT record was not found. Add it and check again.";
    } else if (!addressesKnown) {
      message = "Ownership is verified. The domain's addresses could not be looked up just now.";
    } else if (after.routingStatus !== "ok") {
      message = `Ownership is verified. ${after.routingError ?? "The domain does not point at the edge yet."}`;
    } else if (after.sslStatus === "active") {
      message = "Ownership is verified and the domain points at the edge.";
    } else {
      message =
        "Ownership is verified and the domain points at the edge. The certificate is checked automatically within a few minutes.";
    }

    return {
      verified,
      verificationStatus: after.verificationStatus,
      routingStatus: after.routingStatus,
      sslStatus: after.sslStatus,
      isActive: after.isActive,
      pausedReason: after.pausedReason,
      message,
      dnsRecords: buildDnsInstructions(after, edge),
      observed: {
        txtFound:
          observation.txt.kind === "found" && txtContainsToken(observation.txt.records, row.verificationToken),
        addresses: observation.addresses.kind === "found" ? [...observation.addresses.addresses].sort() : [],
        addressesChecked: addressesKnown,
      },
      domain: toView(after),
    };
  }

  /**
   * "Re-check the certificate now": one handshake with the edge, recorded as
   * observed. A handshake for a name without a certificate makes the edge try
   * to obtain one, and the certificate authority limits failed attempts per
   * name per hour, so while no certificate is active the owner's handshakes
   * are spaced out.
   */
  async function renewSsl(domainId: string, orgId: string) {
    const edge = requireEdge();
    const row = await load(domainId, orgId);
    if (row.verificationStatus !== "verified") {
      throw new DomainError(400, "not_verified", "Verify the domain before checking its certificate.");
    }
    if (row.routingStatus !== "ok") {
      throw new DomainError(
        400,
        "dns_not_routed",
        row.routingError ?? "The domain does not point at the edge yet, so no certificate can be issued for it.",
      );
    }

    const at = now();
    const spacing = row.sslStatus === "active" ? MANUAL_PROBE_SPACING_ACTIVE_MS : MANUAL_PROBE_SPACING_MS;
    if (row.sslCheckedAt !== null && at.getTime() - row.sslCheckedAt.getTime() < spacing) {
      const retryAt = new Date(row.sslCheckedAt.getTime() + spacing);
      throw new DomainError(
        429,
        "checked_recently",
        `The certificate was checked at ${row.sslCheckedAt.toISOString()}. It can be checked again after ${retryAt.toISOString()}.`,
        { retryAfterSeconds: Math.ceil((retryAt.getTime() - at.getTime()) / 1000), nextCheckAt: row.nextCheckAt },
      );
    }

    const result = await checkCustomDomain(row, { probeTls: true, now: at }, deps.buildCheckDeps(edge));
    if (result.outcome === "entitlement_unknown") {
      throw new DomainError(
        503,
        "plan_unavailable",
        "The organization's plan could not be read, so the certificate was not checked. Try again shortly.",
      );
    }
    if (result.outcome === "conflict") throw changedUnderneath();
    if (result.outcome === "claimed_elsewhere") {
      throw new DomainError(
        409,
        "domain_claimed",
        "This domain is already verified by another organization, so it cannot be verified here.",
      );
    }

    const after = await load(domainId, orgId);
    deps.routes?.refresh();

    const probe = result.observation?.probe ?? null;
    let message: string;
    if (probe === null) {
      message = after.pausedReason
        ? `No handshake was made: the domain is paused (${after.pausedReason}).`
        : "No handshake was made: the domain no longer qualifies for a certificate.";
    } else if (probe.kind === "valid" && after.sslStatus === "active") {
      message = "A valid certificate was observed.";
    } else if (probe.kind === "unreachable") {
      message = `The edge could not be reached (${probe.code}); nothing was changed.`;
    } else {
      message = after.sslError ?? "No valid certificate was observed.";
    }

    return {
      message,
      probed: probe !== null,
      sslStatus: after.sslStatus,
      sslIssuer: after.sslIssuer,
      sslExpiresAt: after.sslExpiresAt,
      sslCheckedAt: after.sslCheckedAt,
      sslError: after.sslError,
      isActive: after.isActive,
      pausedReason: after.pausedReason,
    };
  }

  // ---- owner actions ----

  /**
   * Switches the domain on or off. Switching off needs nothing and stops
   * serving at once. Switching on serves only if what was last observed
   * allows it; the checker then confirms within minutes.
   */
  async function toggleDomain(domainId: string, orgId: string, enabled: boolean): Promise<CustomDomainView> {
    const edge = enabled ? requireEdge() : null;
    const row = await load(domainId, orgId);
    if (row.enabled === enabled) return toView(row);

    // Off is "disabled" whatever the plan or the target say, so neither is read.
    let facts = { entitled: true, targetExists: true };
    if (edge) {
      const check = deps.buildCheckDeps(edge);
      const [entitlements, exists] = await Promise.all([
        check.loadEntitlements([orgId]),
        check.targetExists(row),
      ]);
      const entitled = entitlements.get(orgId);
      if (entitled === undefined) {
        throw new DomainError(503, "plan_unavailable", "The organization's plan could not be read. Try again shortly.");
      }
      facts = { entitled, targetExists: exists };
    }

    const decision = decideEnabledChange(row, enabled, facts, now());
    const { count } = await db.customDomain.updateMany({ where: asRead(row, orgId), data: { ...decision.patch } });
    if (count === 0) throw changedUnderneath();
    if (!enabled) deps.routes?.drop(row.domain);
    deps.routes?.refresh();
    await logEvents(row.id, decision.events);
    return toView(await load(domainId, orgId));
  }

  /**
   * Issues a new verification token. The previous proof stops counting at
   * once: the claim on the name is released and the domain stops serving.
   * Spaced per domain, because each new token restarts the checker's fast
   * schedule and the 14 days an unverified name is kept.
   */
  async function reverifyDomain(domainId: string, orgId: string) {
    const edge = requireEdge();
    const row = await load(domainId, orgId);
    const at = now();
    const availableAt = reverifyAvailableAt(row, at);
    if (availableAt) {
      throw new DomainError(
        429,
        "reverified_recently",
        `This domain's verification token was issued at ${row.verificationStartedAt.toISOString()}. A new one can be generated after ${availableAt.toISOString()}.`,
        { retryAfterSeconds: Math.ceil((availableAt.getTime() - at.getTime()) / 1000) },
      );
    }
    const decision = reverifyDecision(row, generateToken(), at);
    const { count } = await db.customDomain.updateMany({ where: asRead(row, orgId), data: { ...decision.patch } });
    if (count === 0) throw changedUnderneath();
    deps.routes?.drop(row.domain);
    deps.routes?.refresh();
    await logEvents(row.id, decision.events);
    const after = await load(domainId, orgId);
    return { domain: toView(after), dnsRecords: buildDnsInstructions(after, edge) };
  }

  // ---- reads ----

  async function getDomainEvents(
    domainId: string,
    orgId: string,
    options: { limit?: number; offset?: number } = {},
  ) {
    const { limit = 50, offset = 0 } = options;
    await load(domainId, orgId);
    const [events, total] = await Promise.all([
      db.domainEvent.findMany({
        where: { domainId },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.domainEvent.count({ where: { domainId } }),
    ]);
    return { events, total, limit, offset };
  }

  async function getDomainStats(orgId: string) {
    const expiringBefore = new Date(now().getTime() + SSL_EXPIRING_SOON_MS);
    const [total, verified, active, pending, paused, sslExpiringSoon] = await Promise.all([
      db.customDomain.count({ where: { orgId } }),
      db.customDomain.count({ where: { orgId, verificationStatus: "verified" } }),
      db.customDomain.count({ where: { orgId, isActive: true } }),
      db.customDomain.count({ where: { orgId, verificationStatus: "pending" } }),
      db.customDomain.count({ where: { orgId, pausedReason: { not: null } } }),
      // The edge renews about 30 days before expiry, so an observed
      // certificate this close to its end is a renewal that is not happening.
      db.customDomain.count({
        where: { orgId, sslStatus: "active", sslExpiresAt: { lte: expiringBefore } },
      }),
    ]);
    return { total, verified, active, pending, paused, sslExpiringSoon };
  }

  /** The certificate as last observed. Fields are null until something was. */
  async function checkSslStatus(domainId: string, orgId: string) {
    const row = await load(domainId, orgId);
    return {
      sslStatus: row.sslStatus,
      sslProvider: row.sslProvider,
      sslIssuer: row.sslIssuer,
      sslValidFrom: row.sslValidFrom,
      sslExpiresAt: row.sslExpiresAt,
      sslFingerprint256: row.sslFingerprint256,
      sslCheckedAt: row.sslCheckedAt,
      sslError: row.sslError,
      needsRenewal:
        row.sslStatus === "active" && row.sslExpiresAt !== null
          ? row.sslExpiresAt.getTime() - now().getTime() < SSL_EXPIRING_SOON_MS
          : false,
    };
  }

  /**
   * The custom endpoint of a target: its primary serving domain, or failing
   * that its oldest serving one. Null when no domain of the target serves.
   */
  async function servingDomainsFor(
    orgId: string,
    targetType: "agent" | "deployment",
    targetIds: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (targetIds.length === 0) return out;
    const rows = await db.customDomain.findMany({
      where: { orgId, targetType, targetId: { in: targetIds }, isActive: true },
      orderBy: { createdAt: "desc" },
      take: 500,
      skip: 0,
      select: CUSTOM_DOMAIN_VIEW_SELECT,
    });
    // Newest first, so an older row overwrites a newer one; a primary row wins outright.
    const primary = new Set<string>();
    for (const row of rows) {
      if (primary.has(row.targetId)) continue;
      out.set(row.targetId, row.domain);
      if (row.isPrimary) primary.add(row.targetId);
    }
    return out;
  }

  return {
    createCustomDomain,
    getCustomDomains,
    getCustomDomain,
    updateCustomDomain,
    deleteCustomDomain,
    verifyDomain,
    renewSsl,
    toggleDomain,
    reverifyDomain,
    getDomainEvents,
    getDomainStats,
    checkSslStatus,
    servingDomainsFor,
  };
}

export type DomainsService = ReturnType<typeof createDomainsService>;

// ============================================
// Production instance
// ============================================

let production: DomainsService | null = null;
let productionRoutes: DomainsServiceDeps["routes"];

/** Called once by the edge wiring so owner actions reach the host router. */
export function connectDomainRoutes(routes: DomainsServiceDeps["routes"]): void {
  productionRoutes = routes;
}

/** The service over the real database, built on first use. */
export async function domainsService(): Promise<DomainsService> {
  if (production) return production;
  const [{ prisma }, { env }, { buildCustomDomainCheckTickDeps }] = await Promise.all([
    import("../lib/prisma.js"),
    import("../config/env.js"),
    import("./buildCustomDomainCheckTickDeps.js"),
  ]);
  const reservedHosts = () =>
    buildReservedHosts({
      urls: [env.PUBLIC_API_URL, env.PUBLIC_WEB_URL, env.CORS_ORIGIN],
      hosts: [env.COOKIE_DOMAIN, env.OPENCLAW_SUBDOMAIN_BASE, getCustomDomainConfig().edge?.hostname],
    });
  production = createDomainsService({
    db: prisma as unknown as DomainsDb,
    getConfig: getCustomDomainConfig,
    reservedHosts,
    buildCheckDeps: (edge) =>
      buildCustomDomainCheckTickDeps({
        prisma: prisma as unknown as Parameters<typeof buildCustomDomainCheckTickDeps>[0]["prisma"],
        edge,
        config: getCustomDomainConfig(),
      }),
    // The P2002 of two requests adding the same name surfaces from the
    // transaction as a whole and is handled by the caller, outside it.
    withOrgLock: (orgId, run) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`custom-domains:${orgId}`}))::text`;
        return run(tx as unknown as DomainsDb);
      }),
    routes: {
      drop: (domain) => productionRoutes?.drop(domain),
      refresh: () => productionRoutes?.refresh(),
    },
  });
  return production;
}
