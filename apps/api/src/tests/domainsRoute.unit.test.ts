import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import sensible from "@fastify/sensible";
import Fastify from "fastify";

import { loadCustomDomainConfig, type CustomDomainConfig } from "../config/customDomains.js";
import { installBigIntJsonSerializer } from "../lib/bigintJson.js";
import { globalErrorHandler } from "../lib/errorHandler.js";
import { createRequireRole } from "../middleware/auth.js";
import { acceptEmptyJsonBody } from "../routes/emptyJsonBody.js";
import { createDomainsRoutes } from "../routes/domains.js";
import {
  buildCustomDomainCheckTickDeps,
  type CustomDomainCheckPrisma,
} from "../services/buildCustomDomainCheckTickDeps.js";
import {
  REVERIFY_SPACING_MS,
  type AddressObservation,
  type TlsProbeOutcome,
  type TxtObservation,
} from "../services/customDomainRules.js";
import type { DomainDns } from "../services/domainDns.js";
import { createDomainsService, MANUAL_PROBE_SPACING_MS, type DomainsDb } from "../services/domains.js";
import { limitsFor, type PlanId } from "../services/plans.js";

// /api/domains end to end below HTTP: the route factory over the real service
// and the real check core, with an in-memory database, a scripted DNS and a
// scripted handshake. What is under test is the contract a customer sees:
// honest refusals (501 unconfigured, 403 plan, 409 taken, 503 "DNS did not
// answer"), and that no request can make a certificate look issued.

// As index.ts does before any route can answer: total_requests is a BigInt column.
installBigIntJsonSerializer();

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT = "55555555-5555-4555-8555-555555555555";
const MISSING = "99999999-9999-4999-8999-999999999999";

const NOW = new Date("2026-10-06T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const CONFIGURED = loadCustomDomainConfig({
  CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.example.org",
  CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
  CUSTOM_DOMAIN_EDGE_IPV6: "2a09:8280:1::a:1",
  CUSTOM_DOMAIN_ASK_TOKEN: "ask-token-0123456789abcdef0123456789abcdef",
  CUSTOM_DOMAIN_EDGE_SECRET: "edge-secret-0123456789abcdef0123456789abcdef",
});
const UNCONFIGURED = loadCustomDomainConfig({});

type Row = Record<string, unknown> & { id: string; orgId: string; domain: string };

/** Prisma's `where`, for the operators these modules use. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
      const op = expected as { not?: unknown; in?: unknown[]; lte?: Date };
      if ("not" in op) return actual !== op.not;
      if ("in" in op) return op.in!.includes(actual);
      if ("lte" in op) return actual instanceof Date && actual.getTime() <= op.lte!.getTime();
      throw new Error(`unsupported where operator on ${key}`);
    }
    return actual === expected;
  });
}

const COLUMN_DEFAULTS = {
  verifiedDomain: null,
  verificationStatus: "pending",
  verificationMethod: "dns_txt",
  verifiedAt: null,
  lastCheckedAt: null,
  verificationError: null,
  verificationLostAt: null,
  routingStatus: "pending",
  routingFailures: 0,
  routingCheckedAt: null,
  routingError: null,
  observedAddresses: [],
  isApex: null,
  sslStatus: "pending",
  sslProvider: null,
  sslExpiresAt: null,
  sslError: null,
  sslCheckedAt: null,
  sslValidFrom: null,
  sslIssuer: null,
  sslFingerprint256: null,
  sslFailures: 0,
  sslProvisioningSince: null,
  // Columns no query may ever select.
  customCert: Buffer.from("CERT"),
  customKey: Buffer.from("PRIVATE KEY MATERIAL"),
  customCertChain: Buffer.from("CHAIN"),
  routingMode: "proxy",
  forceHttps: true,
  headers: null,
  enabled: true,
  isActive: false,
  pausedReason: null,
  isPrimary: false,
  nextCheckAt: null,
  totalRequests: 0n,
  lastRequestAt: null,
};

interface World {
  config: CustomDomainConfig;
  plan: PlanId;
  role: string | null;
  authed: boolean;
  txt: (name: string) => TxtObservation;
  addresses: AddressObservation;
  probe: TlsProbeOutcome;
  now: Date;
  subscriptionsFail: boolean;
}

async function makeApp(over: Partial<World> = {}) {
  const world: World = {
    config: CONFIGURED,
    plan: "pro",
    role: "owner",
    authed: true,
    txt: () => ({ kind: "absent" }),
    addresses: { kind: "found", addresses: ["137.66.10.1"] },
    probe: { kind: "unreachable", code: "ECONNREFUSED", message: "refused" },
    now: NOW,
    subscriptionsFail: false,
    ...over,
  };
  const db = {
    domains: [] as Row[],
    events: [] as Array<Record<string, unknown>>,
    agents: [
      { id: AGENT, orgId: ORG },
      { id: OTHER_AGENT, orgId: OTHER_ORG },
    ],
    deployments: [{ id: DEPLOYMENT, orgId: ORG }],
  };
  const selects: Array<Record<string, unknown>> = [];
  const probes: Array<{ address: string; servername: string }> = [];
  const dropped: string[] = [];
  const locks = new Map<string, Promise<void>>();
  const lockOrder: string[] = [];
  let refreshes = 0;
  let nextId = 0;

  const project = (row: Row, select: Record<string, unknown>) => {
    selects.push(select);
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) as never;
  };
  const uniqueViolation = (target: string) =>
    Object.assign(new Error(`Unique constraint failed on the fields: (\`${target}\`)`), {
      code: "P2002",
      meta: { target: [target] },
    });

  const prisma = {
    customDomain: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
        const row = db.domains.find((d) => matches(d, where));
        return row ? project(row, select) : null;
      },
      findMany: async (args: { where: Record<string, unknown>; select: Record<string, unknown>; take?: number; skip?: number }) =>
        db.domains
          .filter((d) => matches(d, args.where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1000))
          .map((d) => project(d, args.select)),
      count: async ({ where }: { where: Record<string, unknown> }) => db.domains.filter((d) => matches(d, where)).length,
      create: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) => {
        if (db.domains.some((d) => d.orgId === data.orgId && d.domain === data.domain)) {
          throw uniqueViolation("org_id_domain");
        }
        nextId += 1;
        const createdAt = new Date(world.now.getTime() + nextId);
        const row = {
          ...structuredClone(COLUMN_DEFAULTS),
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(nextId).padStart(12, "0")}`,
          createdAt,
          updatedAt: createdAt,
          ...data,
        } as unknown as Row;
        db.domains.push(row);
        return project(row, select);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.domains.filter((d) => matches(d, where));
        const claim = data.verifiedDomain;
        if (typeof claim === "string" && hit.length > 0) {
          if (db.domains.some((d) => d.verifiedDomain === claim && !hit.includes(d))) {
            throw uniqueViolation("verified_domain");
          }
        }
        for (const d of hit) Object.assign(d, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.domains.length;
        db.domains = db.domains.filter((d) => !matches(d, where));
        return { count: before - db.domains.length };
      },
    },
    domainEvent: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        db.events.push(...data.map((event) => ({ ...event, createdAt: world.now })));
      },
      findMany: async ({ where, take, skip }: { where: { domainId: string }; take: number; skip: number }) =>
        db.events.filter((e) => e.domainId === where.domainId).slice(skip, skip + take),
      count: async ({ where }: { where: { domainId: string } }) =>
        db.events.filter((e) => e.domainId === where.domainId).length,
      deleteMany: async ({ where }: { where: { domainId: string } }) => {
        db.events = db.events.filter((e) => e.domainId !== where.domainId);
      },
    },
    orgSubscription: {
      findMany: async ({ where }: { where: { orgId: { in: string[] } } }) => {
        if (world.subscriptionsFail) throw new Error("subscriptions unavailable");
        return where.orgId.in.includes(ORG) && world.plan !== "starter"
          ? [{ orgId: ORG, plan: world.plan, status: "active" }]
          : [];
      },
    },
    agent: {
      count: async ({ where }: { where: { id: string; orgId: string } }) =>
        db.agents.filter((a) => a.id === where.id && a.orgId === where.orgId).length,
    },
    deployment: {
      count: async ({ where }: { where: { id: string; orgId: string } }) =>
        db.deployments.filter((a) => a.id === where.id && a.orgId === where.orgId).length,
    },
  };

  const dns: DomainDns = {
    lookupTxt: async (name) => world.txt(name),
    lookupAddresses: async () => world.addresses,
    isZoneApex: async () => false,
    lookupCaa: async () => ({ kind: "absent" }),
    caaDiagnostic: async () => null,
  };

  const service = createDomainsService({
    db: prisma as unknown as DomainsDb,
    getConfig: () => world.config,
    reservedHosts: () => ["api.wheelsai.example.org", "edge.wheelsai.example.org"],
    buildCheckDeps: (edge) =>
      buildCustomDomainCheckTickDeps({
        prisma: prisma as unknown as CustomDomainCheckPrisma,
        edge,
        config: world.config,
        dns,
        probe: async (input) => {
          probes.push({ address: input.address, servername: input.servername });
          return world.probe;
        },
      }),
    routes: { drop: (domain) => void dropped.push(domain), refresh: () => void (refreshes += 1) },
    // Stands in for the advisory lock: one holder per organization at a time.
    withOrgLock: async (orgId, run) => {
      const before = locks.get(orgId) ?? Promise.resolve();
      let release!: () => void;
      locks.set(orgId, new Promise<void>((resolve) => (release = resolve)));
      await before;
      lockOrder.push(orgId);
      try {
        return await run(prisma as unknown as DomainsDb);
      } finally {
        release();
      }
    },
    now: () => world.now,
  });

  const app = Fastify();
  await app.register(sensible);
  app.setErrorHandler(globalErrorHandler);
  acceptEmptyJsonBody(app);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (world.authed) request.auth = { userId: "u1", orgId: ORG, type: "jwt" } as never;
  });
  await app.register(
    createDomainsRoutes({
      service,
      getConfig: () => world.config,
      getPlan: async () => ({ plan: world.plan, limits: limitsFor(world.plan) }),
      requireRole: createRequireRole({ getMemberRole: async () => world.role }),
    }),
    { prefix: "/api/domains" },
  );

  const create = (body: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { domain: "api.customer.com", targetType: "agent", targetId: AGENT, ...body },
    });
  const post = (path: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url: `/api/domains${path}`, payload: payload as never });
  /** The TXT answer in which the domain's current token is published. */
  const publishToken = () => {
    world.txt = (name) => {
      const row = db.domains.find((d) => `_wheels-verification.${d.domain}` === name && d.orgId === ORG);
      return row ? { kind: "found", records: [[row.verificationToken as string]] } : { kind: "absent" };
    };
  };
  const stats = () => ({ dropped, refreshes });

  return { app, world, db, selects, probes, create, post, publishToken, stats, lockOrder };
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** Creates a domain and verifies it with the record published and DNS on the edge. */
async function verified(t: App): Promise<string> {
  const id = (await t.create()).json().data.id as string;
  t.publishToken();
  const res = await t.post(`/${id}/verify`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.verified, true);
  return id;
}

const VALID: TlsProbeOutcome = {
  kind: "valid",
  proof: "ok",
  certificate: {
    issuer: "Let's Encrypt R11",
    validFrom: new Date(NOW.getTime() - DAY),
    validTo: new Date(NOW.getTime() + 89 * DAY),
    fingerprint256: "AA:BB:CC",
    altNames: ["api.customer.com"],
  },
};

// ============================================
// Access
// ============================================

test("every route requires authentication", async () => {
  const t = await makeApp({ authed: false });
  for (const [method, url] of [
    ["GET", "/api/domains"],
    ["GET", "/api/domains/config"],
    ["GET", "/api/domains/stats"],
    ["POST", "/api/domains"],
    ["GET", `/api/domains/${MISSING}`],
    ["PATCH", `/api/domains/${MISSING}`],
    ["DELETE", `/api/domains/${MISSING}`],
    ["POST", `/api/domains/${MISSING}/verify`],
    ["POST", `/api/domains/${MISSING}/reverify`],
    ["POST", `/api/domains/${MISSING}/toggle`],
    ["GET", `/api/domains/${MISSING}/ssl`],
    ["POST", `/api/domains/${MISSING}/ssl/renew`],
    ["GET", `/api/domains/${MISSING}/events`],
  ] as const) {
    const res = await t.app.inject({ method, url, ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }) });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  await t.app.close();
});

test("writes need the owner or admin role; a member can read", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id as string;

  t.world.role = "member";
  for (const [method, url, payload] of [
    ["POST", "/api/domains", { domain: "b.customer.com", targetType: "agent", targetId: AGENT }],
    ["PATCH", `/api/domains/${id}`, { isPrimary: true }],
    ["DELETE", `/api/domains/${id}`, undefined],
    ["POST", `/api/domains/${id}/verify`, {}],
    ["POST", `/api/domains/${id}/reverify`, {}],
    ["POST", `/api/domains/${id}/toggle`, { isActive: false }],
    ["POST", `/api/domains/${id}/ssl/renew`, {}],
  ] as const) {
    const res = await t.app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.json().error, "insufficient_role");
  }
  assert.equal(t.db.domains.length, 1);
  for (const url of [`/api/domains`, `/api/domains/${id}`, `/api/domains/${id}/ssl`, `/api/domains/${id}/events`, "/api/domains/config"]) {
    assert.equal((await t.app.inject({ method: "GET", url })).statusCode, 200, url);
  }

  t.world.role = "admin";
  assert.equal((await t.post(`/${id}/toggle`, { isActive: false })).statusCode, 200);
  await t.app.close();
});

// ============================================
// Configuration
// ============================================

test("GET /config says whether custom domains work on this server and on this plan", async () => {
  const t = await makeApp();
  const body = (await t.app.inject({ method: "GET", url: "/api/domains/config" })).json();
  assert.deepEqual(body.data, {
    configured: true,
    unavailableReason: null,
    edge: { hostname: "edge.wheelsai.example.org", ipv4: ["137.66.10.1"], ipv6: ["2a09:8280:1::a:1"] },
    verification: { recordPrefix: "_wheels-verification", type: "TXT" },
    plan: {
      plan: "pro",
      entitled: true,
      upgradeUrl: "/dashboard/billing?upgrade=pro",
      includedIn: ["pro", "enterprise"],
    },
    limits: { maxDomainsPerOrganization: 25 },
    policy: { httpsEnforced: true, verificationGraceHours: 72, pendingExpiryDays: 14 },
  });
  // The shared secrets are configuration, not something a customer is shown.
  const text = JSON.stringify(body);
  assert.equal(text.includes("ask-token"), false);
  assert.equal(text.includes("edge-secret"), false);

  t.world.config = UNCONFIGURED;
  t.world.plan = "starter";
  const off = (await t.app.inject({ method: "GET", url: "/api/domains/config" })).json().data;
  assert.equal(off.configured, false);
  assert.equal(off.edge, null);
  assert.equal(off.unavailableReason, "Custom domains are temporarily unavailable. Try again later.");
  assert.equal(off.plan.entitled, false);
  assert.equal(off.plan.plan, "starter");
  await t.app.close();
});

test("unconfigured: everything that needs the edge answers 501 with the reason; reads and 'off' still work", async () => {
  const t = await makeApp();
  const id = await verified(t);
  t.world.config = UNCONFIGURED;

  for (const res of [
    await t.create({ domain: "b.customer.com" }),
    await t.post(`/${id}/verify`),
    await t.post(`/${id}/reverify`),
    await t.post(`/${id}/ssl/renew`),
    await t.post(`/${id}/toggle`, { isActive: true }),
  ]) {
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, "custom_domains_not_configured");
    assert.equal(res.json().message, "Custom domains are temporarily unavailable. Try again later.");
  }
  assert.equal(t.db.domains.length, 1);

  // A misconfigured server gives the customer the same sentence; the variable is for the operator's log.
  t.world.config = loadCustomDomainConfig({ CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.example.org" });
  const partial = await t.create({ domain: "b.customer.com" });
  assert.equal(partial.statusCode, 501);
  assert.equal(partial.json().message, "Custom domains are temporarily unavailable. Try again later.");
  assert.ok(!/CUSTOM_DOMAIN_/.test(partial.json().message));

  // The organization can still see and stop what it has.
  t.world.config = UNCONFIGURED;
  const shown = (await t.app.inject({ method: "GET", url: `/api/domains/${id}` })).json().data;
  assert.equal(shown.dnsRecords.cnameRecord, null, "no routing record is invented without an edge");
  assert.equal(shown.dnsRecords.txtRecord.name, "_wheels-verification.api.customer.com");
  assert.equal((await t.post(`/${id}/toggle`, { isActive: false })).statusCode, 200);
  assert.equal(t.db.domains[0]!.enabled, false);
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/domains/${id}` })).statusCode, 200);
  await t.app.close();
});

// ============================================
// Plan
// ============================================

test("the Starter plan cannot add, check, enable or re-check a domain: 403 plan_limit_reached", async () => {
  const t = await makeApp();
  const id = await verified(t);
  await t.post(`/${id}/toggle`, { isActive: false });
  t.world.plan = "starter"; // the plan lapsed

  for (const res of [
    await t.create({ domain: "b.customer.com" }),
    await t.post(`/${id}/verify`),
    await t.post(`/${id}/ssl/renew`),
    await t.post(`/${id}/toggle`, { isActive: true }),
  ]) {
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), {
      error: "plan_limit_reached",
      message: "Custom domains are included in the Pro plan and above.",
      plan: "starter",
      limit: "customDomains",
      upgradeUrl: "/dashboard/billing?upgrade=pro",
    });
  }
  assert.equal(t.db.domains[0]!.enabled, false);

  // Switching off and deleting never need a plan.
  t.world.plan = "pro";
  await t.post(`/${id}/toggle`, { isActive: true });
  t.world.plan = "starter";
  assert.equal((await t.post(`/${id}/toggle`, { isActive: false })).statusCode, 200);
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/domains/${id}` })).statusCode, 200);
  await t.app.close();
});

test("unconfigured is said before the plan: 501, not an upgrade prompt for something that cannot work", async () => {
  const t = await makeApp({ config: UNCONFIGURED, plan: "starter" });
  assert.equal((await t.create()).statusCode, 501);
  await t.app.close();
});

// ============================================
// Create
// ============================================

test("create stores the normalised name, pending, with real DNS instructions and nothing fabricated", async () => {
  const t = await makeApp();
  const res = await t.create({ domain: "  API.Customer.COM. " });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.domain, "api.customer.com");
  assert.equal(data.verificationStatus, "pending");
  assert.equal(data.routingStatus, "pending");
  assert.equal(data.sslStatus, "pending");
  assert.equal(data.sslProvider, null);
  assert.equal(data.sslExpiresAt, null);
  assert.equal(data.isActive, false);
  assert.equal(data.forceHttps, true);
  assert.match(data.verificationToken, /^wheels-verify-[0-9a-f]{32}$/);
  assert.deepEqual(data.dnsRecords, {
    txtRecord: { name: "_wheels-verification.api.customer.com", type: "TXT", value: data.verificationToken },
    cnameRecord: { name: "api.customer.com", type: "CNAME", value: "edge.wheelsai.example.org" },
    aRecords: [{ name: "api.customer.com", type: "A", value: "137.66.10.1" }],
    aaaaRecords: [{ name: "api.customer.com", type: "AAAA", value: "2a09:8280:1::a:1" }],
    recommended: "cname",
  });
  assert.deepEqual(data.certificate, {
    status: "pending",
    provider: null,
    issuer: null,
    validFrom: null,
    expiresAt: null,
    fingerprint256: null,
    checkedAt: null,
    error: null,
  });
  // The checker picks it up without anyone pressing a button.
  assert.equal(new Date(data.nextCheckAt).getTime(), NOW.getTime() + 2 * MINUTE);
  assert.equal(t.db.events[0]!.eventType, "created");

  const apex = (await t.create({ domain: "customer.com" })).json().data;
  assert.equal(apex.dnsRecords.recommended, "a");
  await t.app.close();
});

test("create: invalid and reserved names are 400 with the reason", async () => {
  const t = await makeApp();
  for (const [domain, code] of [
    ["localhost", "invalid_domain"],
    ["10.0.0.1", "invalid_domain"],
    ["*.customer.com", "invalid_domain"],
    ["https://api.customer.com", "invalid_domain"],
    ["api_x.customer.com", "invalid_domain"],
    ["api.wheelsai.example.org", "reserved_domain"],
    ["x.edge.wheelsai.example.org", "reserved_domain"],
    ["my-app.fly.dev", "reserved_domain"],
    ["db.internal", "reserved_domain"],
  ] as const) {
    const res = await t.create({ domain });
    assert.equal(res.statusCode, 400, domain);
    assert.equal(res.json().error, code, domain);
    assert.equal(typeof res.json().message, "string");
  }
  assert.equal(t.db.domains.length, 0);
  await t.app.close();
});

test("create: a malformed body is 400 validation_failed, never a 500", async () => {
  const t = await makeApp();
  for (const body of [
    { targetId: "not-a-uuid" },
    { targetType: "workflow" },
    { targetType: undefined },
    { domain: "" },
    { domain: 5 },
    { headers: "X-A: 1" },
    { headers: { "X-A": 5 } },
    { orgId: OTHER_ORG },
    { isActive: true },
    { sslStatus: "active" },
  ]) {
    const res = await t.create(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "validation_failed", JSON.stringify(body));
  }
  const empty = await t.app.inject({ method: "POST", url: "/api/domains", payload: {} });
  assert.equal(empty.statusCode, 400);
  assert.equal(t.db.domains.length, 0);
  await t.app.close();
});

test("create: headers the platform owns are 400 invalid_headers", async () => {
  const t = await makeApp();
  for (const headers of [
    { "Set-Cookie": "a=b" },
    { Location: "https://evil.example" },
    { "Strict-Transport-Security": "max-age=1; includeSubDomains" },
    { "X-A": "a\r\nInjected: 1" },
    { "bad name": "x" },
  ]) {
    const res = await t.create({ headers });
    assert.equal(res.statusCode, 400, JSON.stringify(headers));
    assert.equal(res.json().error, "invalid_headers");
  }
  const ok = await t.create({ headers: { "X-Robots-Tag": "noindex" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().data.headers, { "X-Robots-Tag": "noindex" });
  await t.app.close();
});

test("create: HTTPS cannot be switched off", async () => {
  const t = await makeApp();
  const res = await t.create({ forceHttps: false });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "https_required");
  assert.equal(t.db.domains.length, 0);

  const id = (await t.create({ forceHttps: true })).json().data.id;
  const patch = await t.app.inject({ method: "PATCH", url: `/api/domains/${id}`, payload: { forceHttps: false } });
  assert.equal(patch.statusCode, 400);
  assert.equal(patch.json().error, "https_required");
  assert.equal(t.db.domains[0]!.forceHttps, true);
  await t.app.close();
});

test("create: the target must exist in the caller's organization", async () => {
  const t = await makeApp();
  for (const body of [
    { targetId: MISSING },
    { targetId: OTHER_AGENT }, // another organization's agent
    { targetType: "deployment", targetId: AGENT }, // an agent id is not a deployment
  ]) {
    const res = await t.create(body);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "target_not_found");
  }
  assert.equal((await t.create({ targetType: "deployment", targetId: DEPLOYMENT })).statusCode, 200);
  await t.app.close();
});

test("create: 409 domain_exists for this organization's own duplicate, however it is spelled", async () => {
  const t = await makeApp();
  assert.equal((await t.create()).statusCode, 200);
  for (const domain of ["api.customer.com", "API.customer.com."]) {
    const res = await t.create({ domain });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "domain_exists");
  }
  assert.equal(t.db.domains.length, 1);
  await t.app.close();
});

test("create: another organization's VERIFIED claim blocks (409 domain_claimed); its pending claim does not", async () => {
  const t = await makeApp();
  const theirs = {
    ...structuredClone(COLUMN_DEFAULTS),
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    orgId: OTHER_ORG,
    domain: "api.customer.com",
    verificationToken: "wheels-verify-theirs",
    createdAt: NOW,
  } as Row;
  t.db.domains.push(theirs);

  // A squatter's unverified claim cannot keep the real owner out.
  const pending = await t.create();
  assert.equal(pending.statusCode, 200);
  await t.app.inject({ method: "DELETE", url: `/api/domains/${pending.json().data.id}` });

  Object.assign(theirs, { verificationStatus: "verified", verifiedDomain: "api.customer.com" });
  const claimed = await t.create();
  assert.equal(claimed.statusCode, 409);
  assert.equal(claimed.json().error, "domain_claimed");
  await t.app.close();
});

// ============================================
// Reads
// ============================================

test("no response and no query ever carries certificate key material", async () => {
  const t = await makeApp();
  const id = await verified(t);
  const responses = [
    await t.app.inject({ method: "GET", url: "/api/domains" }),
    await t.app.inject({ method: "GET", url: `/api/domains/${id}` }),
    await t.app.inject({ method: "PATCH", url: `/api/domains/${id}`, payload: { isPrimary: true } }),
    await t.post(`/${id}/verify`),
    await t.post(`/${id}/toggle`, { isActive: false }),
    await ((t.world.now = new Date(NOW.getTime() + REVERIFY_SPACING_MS)), t.post(`/${id}/reverify`)),
    await t.app.inject({ method: "GET", url: `/api/domains/${id}/ssl` }),
  ];
  for (const res of responses) {
    assert.equal(res.statusCode, 200);
    for (const forbidden of ["customKey", "customCert", "customCertChain", "PRIVATE KEY MATERIAL"]) {
      assert.equal(res.payload.includes(forbidden), false, `${forbidden} in ${res.payload.slice(0, 80)}`);
    }
  }
  assert.ok(t.selects.length > 10);
  for (const select of t.selects) {
    assert.equal("customKey" in select, false);
    assert.equal("customCert" in select, false);
    assert.equal("customCertChain" in select, false);
  }
  await t.app.close();
});

test("another organization's domain is 404 on every route, and is not changed", async () => {
  const t = await makeApp();
  const theirs = {
    ...structuredClone(COLUMN_DEFAULTS),
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    orgId: OTHER_ORG,
    domain: "theirs.example.org",
    verificationToken: "wheels-verify-theirs",
    createdAt: NOW,
  } as Row;
  t.db.domains.push(theirs);
  const before = structuredClone(theirs);

  for (const [method, path, payload] of [
    ["GET", "", undefined],
    ["PATCH", "", { isPrimary: true }],
    ["DELETE", "", undefined],
    ["POST", "/verify", {}],
    ["POST", "/reverify", {}],
    ["POST", "/toggle", { isActive: false }],
    ["GET", "/ssl", undefined],
    ["POST", "/ssl/renew", {}],
    ["GET", "/events", undefined],
  ] as const) {
    const res = await t.app.inject({ method, url: `/api/domains/${theirs.id}${path}`, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 404, `${method} ${path}`);
  }
  assert.deepEqual(theirs, before);
  const list = (await t.app.inject({ method: "GET", url: "/api/domains" })).json().data;
  assert.equal(list.total, 0);
  await t.app.close();
});

test("ids and queries are validated: 400, not 500", async () => {
  const t = await makeApp();
  for (const [method, url] of [
    ["GET", "/api/domains/not-a-uuid"],
    ["DELETE", "/api/domains/not-a-uuid"],
    ["GET", "/api/domains/not-a-uuid/events"],
    ["GET", "/api/domains?limit=101"],
    ["GET", "/api/domains?limit=0"],
    ["GET", "/api/domains?limit=abc"],
    ["GET", "/api/domains?offset=-1"],
    ["GET", "/api/domains?isActive=yes"],
    ["GET", "/api/domains?targetId=nope"],
    ["GET", "/api/domains?targetType=workflow"],
    ["GET", "/api/domains?orgId=x"],
  ] as const) {
    const res = await t.app.inject({ method, url });
    assert.equal(res.statusCode, 400, `${method} ${url}`);
  }
  assert.equal((await t.app.inject({ method: "GET", url: "/api/domains?limit=100&offset=0&isActive=false" })).statusCode, 200);
  await t.app.close();
});

// ============================================
// Check now
// ============================================

test("verify: the record is published and DNS is on the edge -> verified, routed, waiting for a certificate", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  t.publishToken();

  const res = await t.post(`/${id}/verify`);
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.verified, true);
  assert.equal(data.verificationStatus, "verified");
  assert.equal(data.routingStatus, "ok");
  // Verified and routed is NOT a certificate: nothing was observed yet.
  assert.equal(data.sslStatus, "provisioning");
  assert.equal(data.isActive, false);
  assert.deepEqual(data.observed, { txtFound: true, addresses: ["137.66.10.1"], addressesChecked: true });
  assert.match(data.message, /certificate is checked automatically/);

  const row = t.db.domains[0]!;
  assert.equal(row.verifiedDomain, "api.customer.com");
  assert.equal(row.sslExpiresAt, null);
  assert.equal(row.sslIssuer, null);
  // "Check now" looks at DNS only; it never makes a handshake.
  assert.equal(t.probes.length, 0);
  await t.app.close();
});

test("verify: no record -> 200 not verified, still pending, with the instructions", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  const res = await t.post(`/${id}/verify`);
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.verified, false);
  assert.equal(data.verificationStatus, "pending");
  assert.equal(data.observed.txtFound, false);
  assert.match(data.message, /No TXT record was found at _wheels-verification\.api\.customer\.com/);
  assert.equal(data.dnsRecords.txtRecord.value, t.db.domains[0]!.verificationToken);
  await t.app.close();
});

test("verify: a resolver error is 503 dns_unavailable; the status and the token are untouched", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  const token = t.db.domains[0]!.verificationToken;

  for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"]) {
    t.world.txt = () => ({ kind: "transient", code });
    const res = await t.post(`/${id}/verify`);
    assert.equal(res.statusCode, 503, code);
    assert.equal(res.json().error, "dns_unavailable");
    assert.equal(res.json().retryable, true);
  }
  const row = t.db.domains[0]!;
  assert.equal(row.verificationStatus, "pending", "never 'failed'");
  assert.equal(row.verificationToken, token);
  assert.equal(row.verificationError, null);

  // The same error on a VERIFIED domain does not unverify it either.
  t.publishToken();
  await t.post(`/${id}/verify`);
  t.world.txt = () => ({ kind: "transient", code: "ESERVFAIL" });
  assert.equal((await t.post(`/${id}/verify`)).statusCode, 503);
  assert.equal(t.db.domains[0]!.verificationStatus, "verified");
  assert.equal(t.db.domains[0]!.verificationLostAt, null);
  await t.app.close();
});

test("verify: the record matches but another organization holds the name -> 409 domain_claimed, stays pending", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  t.publishToken();
  // The other organization verified the name after this claim was added.
  t.db.domains.push({
    ...structuredClone(COLUMN_DEFAULTS),
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    orgId: OTHER_ORG,
    domain: "api.customer.com",
    verificationToken: "wheels-verify-theirs",
    verificationStatus: "verified",
    verifiedDomain: "api.customer.com",
    createdAt: NOW,
  } as Row);

  const res = await t.post(`/${id}/verify`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "domain_claimed");
  const mine = t.db.domains.find((d) => d.id === id)!;
  assert.equal(mine.verificationStatus, "pending");
  assert.equal(mine.verifiedDomain, null);
  assert.match(String(mine.verificationError), /another organization/);
  await t.app.close();
});

test("verify: DNS that points elsewhere is reported, and no certificate is waited for", async () => {
  const t = await makeApp({ addresses: { kind: "found", addresses: ["203.0.113.9"] } });
  const id = (await t.create()).json().data.id;
  t.publishToken();
  const data = (await t.post(`/${id}/verify`)).json().data;
  assert.equal(data.verified, true);
  assert.equal(data.routingStatus, "misrouted");
  assert.equal(data.sslStatus, "pending");
  assert.match(data.message, /203\.0\.113\.9, which is not the edge/);
  await t.app.close();
});

test("verify: when the plan cannot be read nothing is checked or written (503)", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  t.publishToken();
  t.world.subscriptionsFail = true;
  const res = await t.post(`/${id}/verify`);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "plan_unavailable");
  assert.equal(t.db.domains[0]!.verificationStatus, "pending");
  await t.app.close();
});

// ============================================
// The certificate
// ============================================

test("no route can make a certificate active: only an observed handshake does", async () => {
  const t = await makeApp(); // the edge is unreachable in this world
  const id = await verified(t);

  await t.post(`/${id}/verify`);
  await t.post(`/${id}/toggle`, { isActive: false });
  await t.post(`/${id}/toggle`, { isActive: true });
  const renew = await t.post(`/${id}/ssl/renew`);
  assert.equal(renew.statusCode, 200);
  assert.equal(renew.json().data.probed, true);
  assert.match(renew.json().data.message, /edge could not be reached \(ECONNREFUSED\); nothing was changed/);
  await t.app.inject({ method: "PATCH", url: `/api/domains/${id}`, payload: { isPrimary: true } });

  const row = t.db.domains[0]!;
  assert.equal(row.sslStatus, "provisioning");
  assert.equal(row.isActive, false);
  assert.equal(row.sslExpiresAt, null);
  assert.equal(row.sslIssuer, null);
  assert.equal(row.sslProvider, null);
  const ssl = (await t.app.inject({ method: "GET", url: `/api/domains/${id}/ssl` })).json().data;
  assert.deepEqual(ssl, {
    sslStatus: "provisioning",
    sslProvider: null,
    sslIssuer: null,
    sslValidFrom: null,
    sslExpiresAt: null,
    sslFingerprint256: null,
    sslCheckedAt: null,
    sslError: null,
    needsRenewal: false,
  });
  await t.app.close();
});

test("ssl/renew records exactly the certificate the handshake presented, and the domain serves", async () => {
  const t = await makeApp();
  const id = await verified(t);
  t.world.probe = VALID;

  const res = await t.post(`/${id}/ssl/renew`);
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.sslStatus, "active");
  assert.equal(data.sslIssuer, "Let's Encrypt R11");
  assert.equal(data.sslExpiresAt, VALID.kind === "valid" ? VALID.certificate.validTo.toISOString() : "");
  assert.equal(data.isActive, true);
  assert.equal(data.message, "A valid certificate was observed.");
  // The handshake went to the configured edge address, for this hostname.
  assert.deepEqual(t.probes, [{ address: "137.66.10.1", servername: "api.customer.com" }]);

  const shown = (await t.app.inject({ method: "GET", url: `/api/domains/${id}` })).json().data;
  assert.deepEqual(shown.certificate, {
    status: "active",
    provider: "edge_acme",
    issuer: "Let's Encrypt R11",
    validFrom: new Date(NOW.getTime() - DAY).toISOString(),
    expiresAt: new Date(NOW.getTime() + 89 * DAY).toISOString(),
    fingerprint256: "AA:BB:CC",
    checkedAt: NOW.toISOString(),
    error: null,
  });
  assert.deepEqual(shown.routing, {
    status: "ok",
    checkedAt: NOW.toISOString(),
    error: null,
    observedAddresses: ["137.66.10.1"],
  });
  await t.app.close();
});

test("ssl/renew: 400 before the domain is verified or routed", async () => {
  const t = await makeApp({ addresses: { kind: "found", addresses: ["203.0.113.9"] } });
  const id = (await t.create()).json().data.id;
  const unverified = await t.post(`/${id}/ssl/renew`);
  assert.equal(unverified.statusCode, 400);
  assert.equal(unverified.json().error, "not_verified");

  t.publishToken();
  await t.post(`/${id}/verify`);
  const unrouted = await t.post(`/${id}/ssl/renew`);
  assert.equal(unrouted.statusCode, 400);
  assert.equal(unrouted.json().error, "dns_not_routed");
  assert.equal(t.probes.length, 0);
  await t.app.close();
});

test("ssl/renew: while no certificate is active, an owner's handshakes are spaced out (429)", async () => {
  const t = await makeApp({
    probe: { kind: "handshake_refused", code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", message: "alert" },
  });
  const id = await verified(t);

  const first = await t.post(`/${id}/ssl/renew`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().data.sslStatus, "provisioning");
  assert.match(first.json().data.message, /no certificate for this domain yet/);

  // Each handshake can start an issuance attempt, and failed attempts are rate limited.
  const again = await t.post(`/${id}/ssl/renew`);
  assert.equal(again.statusCode, 429);
  assert.equal(again.json().error, "checked_recently");
  assert.equal(again.headers["retry-after"], String(MANUAL_PROBE_SPACING_MS / 1000));
  assert.equal(t.probes.length, 1);

  t.world.now = new Date(NOW.getTime() + MANUAL_PROBE_SPACING_MS);
  assert.equal((await t.post(`/${id}/ssl/renew`)).statusCode, 200);
  assert.equal(t.probes.length, 2);
  await t.app.close();
});

// ============================================
// Switch, new token, update, delete
// ============================================

test("toggle: a body without a boolean isActive is 400, not a TypeError", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  for (const payload of [{}, { isActive: "yes" }, { enabled: true }, { isActive: true, extra: 1 }]) {
    const res = await t.post(`/${id}/toggle`, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, "validation_failed");
  }
  const none = await t.app.inject({ method: "POST", url: `/api/domains/${id}/toggle` });
  assert.equal(none.statusCode, 400);
  await t.app.close();
});

test("toggle: off stops serving at once and drops the route; on serves again from what was observed", async () => {
  const t = await makeApp();
  const id = await verified(t);
  t.world.probe = VALID;
  await t.post(`/${id}/ssl/renew`);
  assert.equal(t.db.domains[0]!.isActive, true);

  const off = await t.post(`/${id}/toggle`, { isActive: false });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().data.enabled, false);
  assert.equal(off.json().data.isActive, false);
  assert.equal(off.json().data.pausedReason, "disabled");
  assert.deepEqual(t.stats().dropped, ["api.customer.com"]);
  // The observed certificate is still what was observed.
  assert.equal(off.json().data.sslStatus, "active");

  // Idempotent: off again changes and logs nothing.
  const events = t.db.events.length;
  assert.equal((await t.post(`/${id}/toggle`, { isActive: false })).statusCode, 200);
  assert.equal(t.db.events.length, events);

  const on = await t.post(`/${id}/toggle`, { isActive: true });
  assert.equal(on.json().data.enabled, true);
  assert.equal(on.json().data.isActive, true);
  assert.equal(on.json().data.pausedReason, null);
  assert.match(on.json().message, /it is serving/);
  await t.app.close();
});

test("toggle: switching on a domain that is not verified yet does not serve it", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id;
  await t.post(`/${id}/toggle`, { isActive: false });
  const on = await t.post(`/${id}/toggle`, { isActive: true });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().data.enabled, true);
  assert.equal(on.json().data.isActive, false);
  assert.match(on.json().message, /serves as soon as ownership, DNS and the certificate are all observed/);
  await t.app.close();
});

test("create: an organization has a bounded number of domains, and every row counts", async () => {
  const t = await makeApp({ config: { ...CONFIGURED, limits: { ...CONFIGURED.limits, maxDomainsPerOrg: 3 } } });
  for (const name of ["a", "b", "c"]) {
    assert.equal((await t.create({ domain: `${name}.customer.com` })).statusCode, 200);
  }
  // Unverified, expired, switched off: all still rows the checker and the edge may be asked about.
  Object.assign(t.db.domains[0]!, { verificationStatus: "expired", nextCheckAt: null });
  Object.assign(t.db.domains[1]!, { enabled: false, pausedReason: "disabled" });

  const res = await t.create({ domain: "d.customer.com" });
  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error, "domain_limit_reached");
  assert.equal(body.limit, 3);
  assert.equal(body.count, 3);
  assert.match(body.message, /at most 3 custom domains/);
  assert.equal(t.db.domains.length, 3);

  // Another organization's rows do not count against this one.
  t.db.domains.push({ ...t.db.domains[0]!, id: "other", orgId: OTHER_ORG, domain: "x.example.net" });
  // Deleting one makes room for one.
  const gone = t.db.domains[0]!.id;
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/domains/${gone}` })).statusCode, 200);
  assert.equal((await t.create({ domain: "d.customer.com" })).statusCode, 200);
  assert.equal((await t.create({ domain: "e.customer.com" })).statusCode, 403);
  await t.app.close();
});

test("create: requests arriving together cannot each see room for one more", async () => {
  const t = await makeApp({ config: { ...CONFIGURED, limits: { ...CONFIGURED.limits, maxDomainsPerOrg: 5 } } });
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, i) => t.create({ domain: `a${i}.customer.com` })),
  );
  assert.equal(responses.filter((r) => r.statusCode === 200).length, 5);
  assert.equal(responses.filter((r) => r.json().error === "domain_limit_reached").length, 35);
  assert.equal(t.db.domains.length, 5);
  // The count and the insert ran under the organization's lock.
  assert.equal(t.lockOrder.length, 40);
  assert.ok(t.lockOrder.every((orgId) => orgId === ORG));
  await t.app.close();
});

test("create: a duplicate name under the lock is still 409 domain_exists, not a limit or a 500", async () => {
  const t = await makeApp();
  const [first, second] = await Promise.all([t.create(), t.create()]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
  assert.equal(t.db.domains.length, 1);
  await t.app.close();
});

test("reverify is spaced per domain: 429 with Retry-After, and nothing is reset", async () => {
  const t = await makeApp();
  const id = (await t.create()).json().data.id as string;
  const before = structuredClone(t.db.domains[0]!);

  // Straight after the domain was added, and again and again: the token,
  // the 14-day clock and the checker's schedule all stay as they were.
  for (const elapsed of [0, MINUTE, REVERIFY_SPACING_MS - 1000]) {
    t.world.now = new Date(NOW.getTime() + elapsed);
    const res = await t.post(`/${id}/reverify`);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, "reverified_recently");
    assert.equal(res.headers["retry-after"], String((REVERIFY_SPACING_MS - elapsed) / 1000));
  }
  assert.deepEqual(t.db.domains[0], before);
  assert.deepEqual(t.stats().dropped, []);

  t.world.now = new Date(NOW.getTime() + REVERIFY_SPACING_MS);
  assert.equal((await t.post(`/${id}/reverify`)).statusCode, 200);
  assert.notEqual(t.db.domains[0]!.verificationToken, before.verificationToken);
  // The new token starts the spacing again.
  t.world.now = new Date(t.world.now.getTime() + MINUTE);
  assert.equal((await t.post(`/${id}/reverify`)).statusCode, 429);
  await t.app.close();
});

test("reverify rotates the token, releases the claim, stops serving and restarts the 14 days", async () => {
  const t = await makeApp();
  const id = await verified(t);
  t.world.probe = VALID;
  await t.post(`/${id}/ssl/renew`);
  const oldToken = t.db.domains[0]!.verificationToken;
  t.world.now = new Date(NOW.getTime() + 20 * DAY);

  const res = await t.post(`/${id}/reverify`);
  assert.equal(res.statusCode, 200);
  const row = t.db.domains[0]!;
  assert.notEqual(row.verificationToken, oldToken);
  assert.equal(res.json().data.dnsRecords.txtRecord.value, row.verificationToken);
  assert.equal(row.verificationStatus, "pending");
  assert.equal(row.verifiedDomain, null, "the name is free for whoever can prove it now");
  assert.equal(row.isActive, false);
  assert.equal(row.sslStatus, "pending");
  assert.equal(row.sslIssuer, null);
  assert.equal((row.verificationStartedAt as Date).getTime(), t.world.now.getTime());
  assert.deepEqual(t.stats().dropped, ["api.customer.com"]);

  // The old record no longer verifies; the pending claim is not expired by its age.
  t.world.txt = () => ({ kind: "found", records: [[oldToken as string]] });
  const check = (await t.post(`/${id}/verify`)).json().data;
  assert.equal(check.verified, false);
  assert.equal(check.verificationStatus, "pending");
  assert.match(check.message, /does not match the verification token/);
  await t.app.close();
});

test("update: strict body; isPrimary moves the flag within the target only", async () => {
  const t = await makeApp();
  const a = (await t.create({ domain: "a.customer.com" })).json().data.id;
  const b = (await t.create({ domain: "b.customer.com" })).json().data.id;
  const other = (await t.create({ domain: "c.customer.com", targetType: "deployment", targetId: DEPLOYMENT })).json().data.id;
  const patch = (id: string, payload: unknown) =>
    t.app.inject({ method: "PATCH", url: `/api/domains/${id}`, payload: payload as never });

  await patch(a, { isPrimary: true });
  await patch(other, { isPrimary: true });
  await patch(b, { isPrimary: true });
  const primary = Object.fromEntries(t.db.domains.map((d) => [d.domain, d.isPrimary]));
  assert.deepEqual(primary, { "a.customer.com": false, "b.customer.com": true, "c.customer.com": true });

  for (const payload of [{ enabled: false }, { isActive: true }, { sslStatus: "active" }, { verificationStatus: "verified" }, { domain: "x.customer.com" }, { targetId: MISSING }]) {
    const res = await patch(a, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  const bad = await patch(a, { headers: { "Set-Cookie": "a=b" } });
  assert.equal(bad.json().error, "invalid_headers");
  const good = await patch(a, { headers: { "X-Team": "support" } });
  assert.deepEqual(good.json().data.headers, { "X-Team": "support" });
  await t.app.close();
});

test("delete removes the row, its events and its route; the name can be added again", async () => {
  const t = await makeApp();
  const id = await verified(t);
  assert.ok(t.db.events.length > 0);
  const res = await t.app.inject({ method: "DELETE", url: `/api/domains/${id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(t.db.domains.length, 0);
  assert.equal(t.db.events.length, 0);
  assert.deepEqual(t.stats().dropped, ["api.customer.com"]);
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/domains/${id}` })).statusCode, 404);
  assert.equal((await t.create()).statusCode, 200);
  await t.app.close();
});

test("stats count what is stored: serving, paused, and observed certificates near expiry", async () => {
  const t = await makeApp();
  const id = await verified(t);
  t.world.probe = {
    ...VALID,
    certificate: { ...(VALID as Extract<TlsProbeOutcome, { kind: "valid" }>).certificate, validTo: new Date(NOW.getTime() + 10 * DAY) },
  } as TlsProbeOutcome;
  await t.post(`/${id}/ssl/renew`);
  const b = (await t.create({ domain: "b.customer.com" })).json().data.id;
  await t.post(`/${b}/toggle`, { isActive: false });
  await t.create({ domain: "c.customer.com" });

  const stats = (await t.app.inject({ method: "GET", url: "/api/domains/stats" })).json().data;
  assert.deepEqual(stats, { total: 3, verified: 1, active: 1, pending: 2, paused: 1, sslExpiringSoon: 1 });
  const ssl = (await t.app.inject({ method: "GET", url: `/api/domains/${id}/ssl` })).json().data;
  assert.equal(ssl.needsRenewal, true);

  const events = (await t.app.inject({ method: "GET", url: `/api/domains/${id}/events?limit=100` })).json().data;
  const types = events.events.map((e: { eventType: string }) => e.eventType);
  for (const expected of ["created", "verification_success", "routing_ok", "ssl_provisioning", "ssl_observed", "serving_started"]) {
    assert.ok(types.includes(expected), expected);
  }
  await t.app.close();
});
