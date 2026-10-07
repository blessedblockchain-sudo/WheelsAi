import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";

import { loadCustomDomainConfig } from "../config/customDomains.js";
import {
  buildCustomDomainCheckTickDeps,
  CUSTOM_DOMAIN_CHECK_SELECT,
  type CustomDomainCheckPrisma,
} from "../services/buildCustomDomainCheckTickDeps.js";
import {
  CHECK_BATCH_PER_ORG,
  CLAIMED_ELSEWHERE_MESSAGE,
  computeDomainProof,
  type CustomDomainCheckRow,
  type TlsProbeOutcome,
} from "../services/customDomainRules.js";
import type { DomainDns } from "../services/domainDns.js";
import { runCustomDomainCheckTick } from "../services/runCustomDomainCheckTick.js";
import type { probeTlsCertificate } from "../services/tlsCertificateProbe.js";

// services/buildCustomDomainCheckTickDeps.ts - the composition root, against
// a small in-memory database. No network: DNS and the prober are injected.

const NOW = new Date("2026-10-06T12:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const EDGE = {
  hostname: "edge.wheelsai.io",
  ipv4: ["137.66.10.1"],
  ipv6: ["2a09:8280:1::a:1"],
  askToken: "a".repeat(32),
  edgeSecret: "b".repeat(32),
};
const CONFIG = { dnsServers: [], probeTimeoutMs: 20_000, extraCaPem: null };

// ---------------------------------------------------------------------------
// In-memory database: just the surface the builder uses.
// ---------------------------------------------------------------------------

type StoredDomain = CustomDomainCheckRow & {
  nextCheckAt: Date | null;
  lastCheckedAt: Date | null;
  customCert: Buffer | null;
  customKey: Buffer | null;
  customCertChain: Buffer | null;
  [column: string]: unknown;
};

function stored(id: string, over: Partial<StoredDomain> = {}): StoredDomain {
  return {
    id,
    orgId: "org1",
    domain: `${id}.customer.com`,
    targetType: "agent",
    targetId: "agent-1",
    verificationToken: `token-${id}`,
    verificationStatus: "pending",
    verificationError: null,
    verifiedDomain: null,
    verifiedAt: null,
    verificationStartedAt: new Date(NOW.getTime() - 10 * MINUTE),
    verificationLostAt: null,
    routingStatus: "pending",
    routingFailures: 0,
    routingError: null,
    observedAddresses: [],
    isApex: false,
    sslStatus: "pending",
    sslFailures: 0,
    sslProvisioningSince: null,
    sslExpiresAt: null,
    sslFingerprint256: null,
    sslError: null,
    enabled: true,
    isActive: false,
    pausedReason: null,
    nextCheckAt: new Date(NOW.getTime() - MINUTE),
    lastCheckedAt: null,
    customCert: Buffer.from("cert"),
    customKey: Buffer.from("PRIVATE KEY MATERIAL"),
    customCertChain: Buffer.from("chain"),
    ...over,
  };
}

interface Db {
  domains: StoredDomain[];
  events: Array<Record<string, unknown>>;
  subscriptions: Array<{ orgId: string; plan: string; status: string }>;
  agents: Array<{ id: string; orgId: string }>;
  deployments: Array<{ id: string; orgId: string }>;
}

function memoryPrisma(db: Db) {
  const log = {
    findMany: [] as unknown[],
    groupBy: [] as unknown[],
    updateMany: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    subscriptionQueries: [] as unknown[],
    counts: [] as Array<{ model: string; where: unknown }>,
  };
  const prisma: CustomDomainCheckPrisma = {
    customDomain: {
      groupBy: async (args) => {
        log.groupBy.push(args);
        const oldest = new Map<string, number>();
        for (const d of db.domains) {
          if (d.nextCheckAt === null || d.nextCheckAt.getTime() > args.where.nextCheckAt.lte.getTime()) continue;
          oldest.set(d.orgId, Math.min(oldest.get(d.orgId) ?? Infinity, d.nextCheckAt.getTime()));
        }
        return [...oldest]
          .sort((a, b) => a[1] - b[1])
          .slice(0, args.take)
          .map(([orgId]) => ({ orgId }));
      },
      findMany: async (args) => {
        log.findMany.push(args);
        const selected = Object.keys(args.select);
        return db.domains
          .filter((d) => d.orgId === args.where.orgId)
          .filter((d) => d.nextCheckAt !== null && d.nextCheckAt.getTime() <= args.where.nextCheckAt.lte.getTime())
          .sort((a, b) => a.nextCheckAt!.getTime() - b.nextCheckAt!.getTime())
          .slice(0, args.take)
          .map((d) => Object.fromEntries(selected.map((key) => [key, d[key]])) as unknown as CustomDomainCheckRow);
      },
      updateMany: async (args) => {
        log.updateMany.push(args as never);
        const matches = db.domains.filter((d) =>
          Object.entries(args.where).every(([key, value]) => d[key] === value),
        );
        const claim = args.data.verifiedDomain;
        if (typeof claim === "string" && matches.length > 0) {
          const holder = db.domains.find((d) => d.verifiedDomain === claim && !matches.includes(d));
          if (holder) {
            // What Prisma throws for the unique index on verified_domain.
            throw Object.assign(new Error("Unique constraint failed on the fields: (`verified_domain`)"), {
              code: "P2002",
              meta: { target: ["verified_domain"] },
            });
          }
        }
        for (const d of matches) Object.assign(d, args.data);
        return { count: matches.length };
      },
    },
    domainEvent: {
      createMany: async (args) => {
        db.events.push(...args.data);
      },
    },
    orgSubscription: {
      findMany: async (args) => {
        log.subscriptionQueries.push(args);
        return db.subscriptions.filter((s) => args.where.orgId.in.includes(s.orgId));
      },
    },
    agent: {
      count: async (args) => {
        log.counts.push({ model: "agent", where: args.where });
        return db.agents.filter((a) => a.id === args.where.id && a.orgId === args.where.orgId).length;
      },
    },
    deployment: {
      count: async (args) => {
        log.counts.push({ model: "deployment", where: args.where });
        return db.deployments.filter((a) => a.id === args.where.id && a.orgId === args.where.orgId).length;
      },
    },
  };
  return { prisma, log };
}

function emptyDb(over: Partial<Db> = {}): Db {
  return {
    domains: [],
    events: [],
    subscriptions: [{ orgId: "org1", plan: "pro", status: "active" }],
    agents: [{ id: "agent-1", orgId: "org1" }],
    deployments: [],
    ...over,
  };
}

/** DNS in which every domain has published its own token and points at the edge. */
function fakeDns(over: Partial<DomainDns> = {}): DomainDns {
  return {
    lookupTxt: async (name) => ({
      kind: "found",
      records: [[`token-${name.replace("_wheels-verification.", "").split(".")[0]}`]],
    }),
    lookupAddresses: async () => ({ kind: "found", addresses: ["137.66.10.1"] }),
    isZoneApex: async () => false,
    lookupCaa: async () => ({ kind: "absent" }),
    caaDiagnostic: async () => null,
    ...over,
  };
}

const VALID: TlsProbeOutcome = {
  kind: "valid",
  proof: "ok",
  certificate: {
    issuer: "Let's Encrypt R11",
    validFrom: new Date(NOW.getTime() - DAY),
    validTo: new Date(NOW.getTime() + 89 * DAY),
    fingerprint256: "AA:BB",
    altNames: [],
  },
};

function build(db: Db, over: { dns?: DomainDns; probe?: typeof probeTlsCertificate; batchLimit?: number; perOrgLimit?: number; extraCaPem?: string | null } = {}) {
  const { prisma, log } = memoryPrisma(db);
  const probeCalls: Array<Parameters<typeof probeTlsCertificate>[0]> = [];
  const deps = buildCustomDomainCheckTickDeps({
    prisma,
    edge: EDGE,
    config: { ...CONFIG, extraCaPem: over.extraCaPem ?? null },
    dns: over.dns ?? fakeDns(),
    probe:
      over.probe ??
      (async (input) => {
        probeCalls.push(input);
        return VALID;
      }),
    ...(over.batchLimit !== undefined ? { batchLimit: over.batchLimit } : {}),
    ...(over.perOrgLimit !== undefined ? { perOrgLimit: over.perOrgLimit } : {}),
  });
  return { deps, log, probeCalls };
}

// ---------------------------------------------------------------------------
// loadDue
// ---------------------------------------------------------------------------

test("loadDue: rows whose nextCheckAt has passed, oldest first, bounded", async () => {
  const db = emptyDb({
    domains: [
      stored("later", { nextCheckAt: new Date(NOW.getTime() + MINUTE) }),
      stored("due-new", { nextCheckAt: new Date(NOW.getTime() - MINUTE) }),
      stored("never", { nextCheckAt: null }),
      stored("due-old", { nextCheckAt: new Date(NOW.getTime() - 60 * MINUTE) }),
      stored("due-now", { nextCheckAt: NOW }),
    ],
  });
  const { deps, log } = build(db, { batchLimit: 2 });
  const rows = await deps.loadDue({ now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ["due-old", "due-new"]);
  assert.deepEqual(log.groupBy, [
    {
      by: ["orgId"],
      where: { nextCheckAt: { lte: NOW } },
      _min: { nextCheckAt: true },
      orderBy: { _min: { nextCheckAt: "asc" } },
      take: 2,
    },
  ]);
  assert.deepEqual(log.findMany, [
    {
      where: { orgId: "org1", nextCheckAt: { lte: NOW } },
      orderBy: { nextCheckAt: "asc" },
      take: CHECK_BATCH_PER_ORG,
      select: CUSTOM_DOMAIN_CHECK_SELECT,
    },
  ]);
});

test("loadDue: one organization with thousands of due rows cannot fill a batch", async () => {
  // The flood is older than everything else, so "oldest first" alone would
  // return nothing but the flood, tick after tick.
  const flood = Array.from({ length: 3_000 }, (_, i) =>
    stored(`junk${i}`, { orgId: "flood", nextCheckAt: new Date(NOW.getTime() - 60 * MINUTE - i) }),
  );
  const others = ["a", "b", "c"].map((org, i) =>
    stored(`real-${org}`, { orgId: `org-${org}`, nextCheckAt: new Date(NOW.getTime() - (i + 1) * MINUTE) }),
  );
  const { deps, log } = build(emptyDb({ domains: [...flood, ...others] }));
  const rows = await deps.loadDue({ now: NOW });

  const perOrg = new Map<string, number>();
  for (const row of rows) perOrg.set(row.orgId, (perOrg.get(row.orgId) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(perOrg), {
    flood: CHECK_BATCH_PER_ORG,
    "org-a": 1,
    "org-b": 1,
    "org-c": 1,
  });
  // Every organization's first row comes before anyone's second.
  assert.deepEqual(rows.slice(0, 4).map((r) => r.orgId).sort(), ["flood", "org-a", "org-b", "org-c"]);
  // The flooding organization still gets its own oldest rows, in order.
  assert.deepEqual(
    rows.filter((r) => r.orgId === "flood").map((r) => r.id),
    Array.from({ length: CHECK_BATCH_PER_ORG }, (_, i) => `junk${2_999 - i}`),
  );
  // And no query asked for more than the per-organization share.
  assert.ok(log.findMany.every((args) => (args as { take: number }).take === CHECK_BATCH_PER_ORG));
});

test("loadDue: more organizations than the batch holds - the longest-waiting ones, one row each", async () => {
  const domains = Array.from({ length: 6 }, (_, org) =>
    [0, 1].map((n) =>
      stored(`o${org}-${n}`, { orgId: `org${org}`, nextCheckAt: new Date(NOW.getTime() - (10 - org) * MINUTE + n) }),
    ),
  ).flat();
  const { deps } = build(emptyDb({ domains }), { batchLimit: 4, perOrgLimit: 2 });
  const rows = await deps.loadDue({ now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ["o0-0", "o1-0", "o2-0", "o3-0"]);
});

test("loadDue never reads certificate key material", async () => {
  const selected = Object.keys(CUSTOM_DOMAIN_CHECK_SELECT);
  for (const column of ["customKey", "customCert", "customCertChain"]) {
    assert.equal(selected.includes(column), false, column);
  }
  const { deps } = build(emptyDb({ domains: [stored("d1")] }));
  const [row] = await deps.loadDue({ now: NOW });
  assert.ok(row);
  assert.equal("customKey" in row, false);
  assert.equal("customCert" in row, false);
  assert.equal("customCertChain" in row, false);
  assert.equal(JSON.stringify(row).includes("PRIVATE KEY"), false);
});

// ---------------------------------------------------------------------------
// persist
// ---------------------------------------------------------------------------

test("persist is a compare-and-set on the statuses, the switch and the token as loaded", async () => {
  const db = emptyDb({ domains: [stored("d1")] });
  const { deps, log } = build(db);
  const [row] = await deps.loadDue({ now: NOW });
  assert.equal(await deps.persist(row!, { routingStatus: "ok", lastCheckedAt: NOW }), "ok");
  assert.deepEqual(log.updateMany[0]!.where, {
    id: "d1",
    verificationStatus: "pending",
    verificationToken: "token-d1",
    routingStatus: "pending",
    sslStatus: "pending",
    enabled: true,
  });
  // updatedAt is not the version: request counters bump it.
  assert.equal("updatedAt" in log.updateMany[0]!.where, false);
  assert.equal(db.domains[0]!.routingStatus, "ok");
});

test("persist: a row that moved since it was loaded is a conflict and is not overwritten", async () => {
  for (const change of [
    { verificationStatus: "verified" },
    { verificationToken: "rotated" },
    { routingStatus: "misrouted" },
    { sslStatus: "provisioning" },
    { enabled: false },
  ] as Array<Partial<StoredDomain>>) {
    const db = emptyDb({ domains: [stored("d1")] });
    const { deps } = build(db);
    const [row] = await deps.loadDue({ now: NOW });
    Object.assign(db.domains[0]!, change);
    assert.equal(await deps.persist(row!, { verificationError: "stale write" }), "conflict", JSON.stringify(change));
    assert.equal(db.domains[0]!.verificationError, null);
  }
});

test("persist: a unique violation while taking the claim means claimed_elsewhere", async () => {
  const db = emptyDb({
    domains: [
      stored("theirs", { orgId: "org2", domain: "shop.customer.com", verificationStatus: "verified", verifiedDomain: "shop.customer.com" }),
      stored("ours", { domain: "shop.customer.com" }),
    ],
  });
  const { deps } = build(db);
  const ours = (await deps.loadDue({ now: NOW })).find((r) => r.id === "ours")!;
  assert.equal(
    await deps.persist(ours, { verificationStatus: "verified", verifiedDomain: "shop.customer.com" }),
    "claimed_elsewhere",
  );
  assert.equal(db.domains[1]!.verificationStatus, "pending");
  assert.equal(db.domains[1]!.verifiedDomain, null);
});

test("persist: any other database error is thrown, including a unique violation on a write that takes no claim", async () => {
  const { prisma } = memoryPrisma(emptyDb());
  prisma.customDomain.updateMany = async () => {
    throw Object.assign(new Error("unique"), { code: "P2002" });
  };
  const deps = buildCustomDomainCheckTickDeps({ prisma, edge: EDGE, config: CONFIG, dns: fakeDns() });
  await assert.rejects(() => deps.persist(stored("d1"), { routingStatus: "ok" }), /unique/);

  prisma.customDomain.updateMany = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(() => deps.persist(stored("d1"), { verifiedDomain: "d1.customer.com" }), /connection lost/);
});

// ---------------------------------------------------------------------------
// Entitlement and targets
// ---------------------------------------------------------------------------

test("loadEntitlements uses effectivePlan: trialing, active, past_due and manual are entitled", async () => {
  const db = emptyDb({
    subscriptions: [
      { orgId: "trialing", plan: "pro", status: "trialing" },
      { orgId: "active", plan: "pro", status: "active" },
      { orgId: "past-due", plan: "pro", status: "past_due" },
      { orgId: "manual", plan: "enterprise", status: "manual" },
      { orgId: "canceled", plan: "pro", status: "canceled" },
      { orgId: "unpaid", plan: "pro", status: "unpaid" },
      { orgId: "starter", plan: "starter", status: "active" },
    ],
  });
  const { deps, log } = build(db);
  const orgIds = ["trialing", "active", "past-due", "manual", "canceled", "unpaid", "starter", "no-row"];
  const entitled = await deps.loadEntitlements(orgIds);
  assert.deepEqual(Object.fromEntries(entitled), {
    trialing: true,
    active: true,
    "past-due": true,
    manual: true,
    canceled: false,
    unpaid: false,
    starter: false,
    // No subscription row is the Starter plan: a known answer, not an unknown.
    "no-row": false,
  });
  // One query for all of them.
  assert.equal(log.subscriptionQueries.length, 1);
});

test("loadEntitlements lets a database failure through, so the tick leaves rows alone", async () => {
  const { prisma } = memoryPrisma(emptyDb());
  prisma.orgSubscription.findMany = async () => {
    throw new Error("connection lost");
  };
  const deps = buildCustomDomainCheckTickDeps({ prisma, edge: EDGE, config: CONFIG, dns: fakeDns() });
  await assert.rejects(() => deps.loadEntitlements(["org1"]), /connection lost/);
});

test("targetExists is scoped to the row's organisation", async () => {
  const db = emptyDb({
    agents: [{ id: "agent-1", orgId: "org1" }, { id: "agent-2", orgId: "org2" }],
    deployments: [{ id: "dep-1", orgId: "org1" }],
  });
  const { deps, log } = build(db);
  assert.equal(await deps.targetExists(stored("a", { targetType: "agent", targetId: "agent-1" })), true);
  // Another organisation's agent is not this domain's target.
  assert.equal(await deps.targetExists(stored("b", { targetType: "agent", targetId: "agent-2" })), false);
  assert.equal(await deps.targetExists(stored("c", { targetType: "deployment", targetId: "dep-1" })), true);
  assert.equal(await deps.targetExists(stored("d", { targetType: "deployment", targetId: "agent-1" })), false);
  assert.equal(await deps.targetExists(stored("e", { targetType: "workflow", targetId: "agent-1" })), false);
  for (const call of log.counts) {
    assert.deepEqual(Object.keys(call.where as object).sort(), ["id", "orgId"]);
    assert.equal((call.where as { orgId: string }).orgId, "org1");
  }
});

// ---------------------------------------------------------------------------
// The prober
// ---------------------------------------------------------------------------

test("probeTls: the customer's name, the configured timeout, and this domain's proof", async () => {
  const { deps, probeCalls } = build(emptyDb());
  await deps.probeTls({ address: "137.66.10.1", row: stored("d1") });
  assert.deepEqual(probeCalls, [
    {
      address: "137.66.10.1",
      servername: "d1.customer.com",
      timeoutMs: 20_000,
      proof: { path: "/.well-known/wheelsai-domain", expected: computeDomainProof(EDGE.edgeSecret, "d1") },
    },
  ]);
});

test("production deps never pass a custom ca", async () => {
  // Built the way the worker builds them, from a production environment.
  const env = {
    NODE_ENV: "production",
    CUSTOM_DOMAIN_EDGE_HOSTNAME: EDGE.hostname,
    CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
    CUSTOM_DOMAIN_ASK_TOKEN: EDGE.askToken,
    CUSTOM_DOMAIN_EDGE_SECRET: EDGE.edgeSecret,
  };
  const config = loadCustomDomainConfig(env);
  assert.ok(config.edge);
  assert.equal(config.extraCaPem, null);

  const probeCalls: Array<Parameters<typeof probeTlsCertificate>[0]> = [];
  const { prisma } = memoryPrisma(emptyDb());
  const deps = buildCustomDomainCheckTickDeps({
    prisma,
    edge: config.edge!,
    config,
    dns: fakeDns(),
    probe: async (input) => {
      probeCalls.push(input);
      return VALID;
    },
  });
  await deps.probeTls({ address: "137.66.10.1", row: stored("d1") });
  assert.equal("ca" in probeCalls[0]!, false);
  assert.equal("connect" in probeCalls[0]!, false);

  // And a production environment that tries to add one has no edge at all.
  const withCa = loadCustomDomainConfig({
    ...env,
    CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  });
  assert.equal(withCa.edge, null);
  assert.equal(withCa.extraCaPem, null);
});

test("a staging extra CA is added to the public roots, not substituted for them", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nSTAGING\n-----END CERTIFICATE-----";
  const { deps, probeCalls } = build(emptyDb(), { extraCaPem: pem });
  await deps.probeTls({ address: "137.66.10.1", row: stored("d1") });
  const ca = probeCalls[0]!.ca as string[];
  assert.equal(ca.length, tls.rootCertificates.length + 1);
  assert.equal(ca[ca.length - 1], pem);
  assert.equal(ca[0], tls.rootCertificates[0]);
});

test("the CAA diagnostic asks about the edge's certificate authority", async () => {
  const asked: Array<[string, string]> = [];
  const { deps } = build(emptyDb(), {
    dns: fakeDns({
      caaDiagnostic: async (name, issuer) => {
        asked.push([name, issuer]);
        return "no";
      },
    }),
  });
  assert.equal(await deps.caaDiagnostic!("d1.customer.com"), "no");
  assert.deepEqual(asked, [["d1.customer.com", "letsencrypt.org"]]);
});

test("logEvents writes one row per event and nothing for an empty list", async () => {
  const db = emptyDb();
  const { deps } = build(db);
  await deps.logEvents("d1", []);
  assert.deepEqual(db.events, []);
  await deps.logEvents("d1", [
    { eventType: "routing_ok", message: "ok", previousStatus: "pending", newStatus: "ok" },
    { eventType: "ssl_provisioning", message: "waiting" },
  ]);
  assert.deepEqual(db.events, [
    { domainId: "d1", eventType: "routing_ok", message: "ok", previousStatus: "pending", newStatus: "ok" },
    { domainId: "d1", eventType: "ssl_provisioning", message: "waiting" },
  ]);
});

// ---------------------------------------------------------------------------
// End to end: the real tick over the in-memory database
// ---------------------------------------------------------------------------

test("end to end: pending -> verified and provisioning -> active only after a handshake", async () => {
  const db = emptyDb({ domains: [stored("d1")] });
  const { deps, probeCalls } = build(db);

  const first = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(first.updated, 1);
  const d = db.domains[0]!;
  assert.equal(d.verificationStatus, "verified");
  assert.equal(d.verifiedDomain, "d1.customer.com");
  assert.equal(d.routingStatus, "ok");
  assert.equal(d.sslStatus, "provisioning");
  assert.equal(d.isActive, false);
  assert.equal(d.sslExpiresAt, null);
  assert.equal(probeCalls.length, 0);
  assert.equal(d.nextCheckAt!.getTime() - NOW.getTime(), 2 * MINUTE);

  // Not due yet: a tick in between does nothing.
  const between = await runCustomDomainCheckTick({ now: new Date(NOW.getTime() + MINUTE) }, deps);
  assert.equal(between.due, 0);

  const later = new Date(NOW.getTime() + 2 * MINUTE);
  const second = await runCustomDomainCheckTick({ now: later }, deps);
  assert.equal(second.probed, 1);
  assert.equal(probeCalls[0]!.address, "137.66.10.1");
  assert.equal(d.sslStatus, "active");
  assert.equal(d.sslIssuer, "Let's Encrypt R11");
  assert.deepEqual(d.sslExpiresAt, VALID.kind === "valid" ? VALID.certificate.validTo : null);
  assert.equal(d.isActive, true);
  assert.deepEqual(
    db.events.map((e) => e.eventType),
    ["verification_success", "routing_ok", "ssl_provisioning", "ssl_observed", "serving_started"],
  );
});

test("end to end: two organisations claim one name; the first to verify holds it", async () => {
  const db = emptyDb({
    subscriptions: [
      { orgId: "org1", plan: "pro", status: "active" },
      { orgId: "org2", plan: "pro", status: "active" },
    ],
    agents: [{ id: "agent-1", orgId: "org1" }, { id: "agent-1", orgId: "org2" }],
    domains: [
      stored("first", { domain: "shop.customer.com", nextCheckAt: new Date(NOW.getTime() - 2 * MINUTE) }),
      stored("second", { orgId: "org2", domain: "shop.customer.com" }),
    ],
  });
  // Both tokens are published at the same name.
  const dns = fakeDns({ lookupTxt: async () => ({ kind: "found", records: [["token-first"], ["token-second"]] }) });
  const { deps } = build(db, { dns });

  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.updated, 1);
  assert.equal(result.claimedElsewhere, 1);
  const [first, second] = db.domains;
  assert.equal(first!.verificationStatus, "verified");
  assert.equal(first!.verifiedDomain, "shop.customer.com");
  assert.equal(second!.verificationStatus, "pending");
  assert.equal(second!.verifiedDomain, null);
  assert.equal(second!.verificationError, CLAIMED_ELSEWHERE_MESSAGE);
  assert.equal(second!.sslStatus, "pending");
  assert.ok(db.events.some((e) => e.domainId === "second" && e.eventType === "claimed_elsewhere"));
  assert.equal(db.events.some((e) => e.domainId === "second" && e.eventType === "verification_success"), false);
});

test("end to end: a plan that lapses pauses the domain without touching its claim or certificate", async () => {
  const db = emptyDb({
    subscriptions: [{ orgId: "org1", plan: "pro", status: "canceled" }],
    domains: [
      stored("d1", {
        verificationStatus: "verified",
        verifiedDomain: "d1.customer.com",
        verifiedAt: new Date(NOW.getTime() - DAY),
        routingStatus: "ok",
        observedAddresses: ["137.66.10.1"],
        sslStatus: "active",
        sslExpiresAt: new Date(NOW.getTime() + 60 * DAY),
        sslFingerprint256: "AA:BB",
        isActive: true,
      }),
    ],
  });
  const { deps, probeCalls } = build(db);
  await runCustomDomainCheckTick({ now: NOW }, deps);
  const d = db.domains[0]!;
  assert.equal(d.isActive, false);
  assert.equal(d.pausedReason, "plan_inactive");
  assert.equal(d.verifiedDomain, "d1.customer.com");
  assert.equal(d.sslStatus, "active");
  // No handshake for a domain the edge would not serve.
  assert.equal(probeCalls.length, 0);
});
