import assert from "node:assert/strict";
import test from "node:test";

import helmet from "@fastify/helmet";
import Fastify from "fastify";

import { loadCustomDomainConfig } from "../config/customDomains.js";
import type { AskDomainRow } from "../services/buildCustomDomainEdgeDeps.js";
import {
  computeDomainProof,
  type EdgeRoute,
  type IssuanceBudgetDecision,
} from "../services/customDomainRules.js";
import {
  createCustomDomainRouteTable,
  createDomainRequestCounter,
  createEdgeRewriteUrl,
  type DomainRequestCount,
} from "../services/customDomainRouteTable.js";
import { createCustomDomainEdgeRoutes, installCustomDomainEdgeHooks } from "../routes/customDomainEdge.js";

// routes/customDomainEdge.ts over a real Fastify instance built the way
// index.ts builds it: rewriteUrl, helmet, an auth hook, the edge hooks, then
// the routes. Two things are under test. The certificate question says yes
// only for a domain that would be served, and refuses on every failure. And a
// request on a customer hostname reaches its owner's target and nothing else.

const ASK_TOKEN = "ask-token-0123456789abcdef0123456789abcdef";
const EDGE_SECRET = "edge-secret-0123456789abcdef0123456789abcdef";

const CONFIGURED = loadCustomDomainConfig({
  CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.example.org",
  CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
  CUSTOM_DOMAIN_ASK_TOKEN: ASK_TOKEN,
  CUSTOM_DOMAIN_EDGE_SECRET: EDGE_SECRET,
});
const UNCONFIGURED = loadCustomDomainConfig({});

function askRow(over: Partial<AskDomainRow> = {}): AskDomainRow {
  return {
    id: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    targetType: "deployment",
    targetId: "dep-1",
    verificationStatus: "verified",
    routingStatus: "ok",
    sslStatus: "pending",
    enabled: true,
    ...over,
  };
}

function edgeRoute(over: Partial<EdgeRoute> = {}): EdgeRoute {
  return {
    domainId: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    targetType: "deployment",
    targetSlug: "llama-prod",
    serving: true,
    headers: {},
    ...over,
  };
}

interface World {
  config: typeof CONFIGURED;
  rows: AskDomainRow[];
  entitled: boolean | Error;
  targetExists: boolean;
  findThrows: boolean;
  /** What the issuance budget answers; an Error is a count that failed. */
  budget: IssuanceBudgetDecision | Error;
  routes: EdgeRoute[];
  now: number;
}

async function makeApp(over: Partial<World> = {}) {
  const world: World = {
    config: CONFIGURED,
    rows: [askRow()],
    entitled: true,
    targetExists: true,
    findThrows: false,
    budget: { granted: true },
    routes: [edgeRoute()],
    now: 1_000_000,
    ...over,
  };
  const lookups: string[] = [];
  const grantsAsked: Array<{ orgId: string; domain: string; now: Date }> = [];
  const logs: string[] = [];
  const counted: DomainRequestCount[] = [];

  const table = createCustomDomainRouteTable({ load: async () => world.routes, now: () => world.now });
  await table.refresh();
  const counter = createDomainRequestCounter({ increment: async (entry) => void counted.push(entry) });
  let installed = false;

  const app = Fastify({
    logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
    rewriteUrl: createEdgeRewriteUrl({
      table,
      edgeSecret: world.config.edge?.edgeSecret ?? null,
      guardInstalled: () => installed,
    }),
  });
  await app.register(helmet, { contentSecurityPolicy: false });

  // Stands in for middleware/auth.ts: "Bearer <orgId>" is that organization's key.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    request.auth = header?.startsWith("Bearer ")
      ? ({ type: "api_key", orgId: header.slice(7) } as never)
      : null;
  });

  installCustomDomainEdgeHooks(app, { counter });
  installed = true;

  await app.register(
    createCustomDomainEdgeRoutes({
      getConfig: () => world.config,
      findVerifiedDomain: async (domain) => {
        lookups.push(domain);
        if (world.findThrows) throw new Error("connection refused at /srv/app/db.ts:12");
        return world.rows.find((row) => row.domain === domain) ?? null;
      },
      isEntitled: async () => {
        if (world.entitled instanceof Error) throw world.entitled;
        return world.entitled;
      },
      targetExists: async () => world.targetExists,
      grantIssuance: async (grant) => {
        grantsAsked.push(grant);
        if (world.budget instanceof Error) throw world.budget;
        return world.budget;
      },
      now: () => world.now,
    }),
  );

  // Stand-ins for the canonical routes, guarded the way the real ones are.
  const handled: Array<{ route: string; orgId: string; params: unknown; url: string }> = [];
  const guard = async (request: { auth: unknown }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!request.auth) return reply.status(401).send({ error: { code: "invalid_api_key" } });
  };
  // What a handler would copy into a stream it starts (services/sseReply.ts).
  const headersAtHandler: Array<Record<string, unknown>> = [];
  const record =
    (route: string) =>
    async (
      request: { auth: unknown; params: unknown; url: string },
      reply: { getHeaders: () => Record<string, unknown> },
    ) => {
      handled.push({ route, orgId: (request.auth as { orgId: string }).orgId, params: request.params, url: request.url });
      headersAtHandler.push(reply.getHeaders());
      return { served: route, params: request.params };
    };
  app.post("/v1/:deploymentSlug/chat/completions", { preHandler: [guard as never] }, record("deployment") as never);
  app.post("/v1/agents/:agentSlug/chat/completions", { preHandler: [guard as never] }, record("agent") as never);
  app.get("/v1/models", { preHandler: [guard as never] }, record("models") as never);
  app.post("/api/auth/login", async () => ({ served: "login" }));

  const edgeHeaders = (host: string, extra: Record<string, string> = {}) => ({
    "x-wheels-edge-token": EDGE_SECRET,
    "x-wheels-custom-host": host,
    "x-wheels-edge-proto": "https",
    ...extra,
  });
  const ask = (query: string) => app.inject({ method: "GET", url: `/internal/edge/ask${query}` });

  return { app, world, lookups, grantsAsked, logs, counted, counter, table, handled, headersAtHandler, edgeHeaders, ask };
}

const q = (domain: string, token = ASK_TOKEN) =>
  `?domain=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}`;

// ============================================
// The certificate question
// ============================================

test("ask: 200 only for a verified, enabled, routed domain on an entitled plan with a target", async () => {
  const { app, ask } = await makeApp();
  const res = await ask(q("api.customer.com"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { allowed: true });
  await app.close();
});

test("ask: 501 with the reason while custom domains are not configured, before anything is read", async () => {
  const { app, ask, lookups } = await makeApp({ config: UNCONFIGURED });
  for (const query of [q("api.customer.com"), q("api.customer.com", "wrong"), ""]) {
    const res = await ask(query);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, "custom_domains_not_configured");
    assert.match(res.json().message, /not configured on this server/);
  }
  assert.equal(lookups.length, 0);
  await app.close();
});

test("ask: 403 forbidden for a missing or wrong token, and nothing is looked up", async () => {
  const { app, ask, lookups } = await makeApp();
  const sameLength = ASK_TOKEN.slice(0, -1) + "0";
  for (const query of [
    "?domain=api.customer.com",
    q("api.customer.com", ""),
    q("api.customer.com", "short"),
    q("api.customer.com", sameLength),
    q("api.customer.com", `${ASK_TOKEN}x`),
    // The forwarding secret is not the ask token.
    q("api.customer.com", EDGE_SECRET),
    `?domain=api.customer.com&token=${ASK_TOKEN}&token=${ASK_TOKEN}`,
  ]) {
    const res = await ask(query);
    assert.equal(res.statusCode, 403, query);
    assert.deepEqual(res.json(), { error: "forbidden" });
  }
  assert.equal(lookups.length, 0);
  await app.close();
});

test("ask: 400 for a name that could never be a custom domain", async () => {
  const { app, ask, lookups } = await makeApp();
  for (const domain of ["", "localhost", "10.0.0.1", "*.customer.com", "a_b.customer.com", "wheelsai-api.internal", "x.fly.dev"]) {
    const res = await ask(q(domain));
    assert.equal(res.statusCode, 400, domain);
    assert.deepEqual(res.json(), { error: "invalid_domain" });
  }
  const missing = await ask(`?token=${ASK_TOKEN}`);
  assert.equal(missing.statusCode, 400);
  assert.equal(lookups.length, 0);
  await app.close();
});

test("ask: 404 for a name nobody has verified, remembered for a minute and no longer", async () => {
  const { app, ask, lookups, world } = await makeApp();
  const first = await ask(q("unknown.example.org"));
  assert.equal(first.statusCode, 404);
  assert.deepEqual(first.json(), { allowed: false, reason: "unknown_domain" });
  assert.equal(lookups.length, 1);

  // A scan of the same name costs no further query...
  for (let i = 0; i < 5; i++) assert.equal((await ask(q("UNKNOWN.example.org."))).statusCode, 404);
  assert.equal(lookups.length, 1);

  // ...and a domain verified in the meantime is found once the minute is over.
  world.rows.push(askRow({ id: "d9", domain: "unknown.example.org" }));
  world.now += 59_000;
  assert.equal((await ask(q("unknown.example.org"))).statusCode, 404);
  world.now += 1_001;
  assert.equal((await ask(q("unknown.example.org"))).statusCode, 200);
  assert.equal(lookups.length, 2);
  await app.close();
});

test("ask: each reason a known domain is refused, 403 with the reason", async () => {
  const cases: Array<[Partial<World>, string]> = [
    [{ rows: [askRow({ verificationStatus: "pending" })] }, "not_verified"],
    [{ rows: [askRow({ verificationStatus: "expired" })] }, "not_verified"],
    [{ rows: [askRow({ enabled: false })] }, "disabled"],
    [{ rows: [askRow({ routingStatus: "misrouted" })] }, "dns_not_routed"],
    [{ rows: [askRow({ routingStatus: "pending" })] }, "dns_not_routed"],
    [{ entitled: false }, "plan_inactive"],
    [{ targetExists: false }, "target_missing"],
  ];
  for (const [over, reason] of cases) {
    const { app, ask } = await makeApp(over);
    const res = await ask(q("api.customer.com"));
    assert.equal(res.statusCode, 403, reason);
    assert.deepEqual(res.json(), { allowed: false, reason });
    await app.close();
  }
});

test("ask: a name with no observed certificate takes one unit of the issuance budget per yes", async () => {
  const { app, ask, grantsAsked, world } = await makeApp();
  assert.equal((await ask(q("api.customer.com"))).statusCode, 200);
  assert.equal((await ask(q("API.Customer.com."))).statusCode, 200);
  // Every yes is an order the edge may open, so every yes is counted.
  assert.deepEqual(grantsAsked, [
    { orgId: "org1", domain: "api.customer.com", now: new Date(world.now) },
    { orgId: "org1", domain: "api.customer.com", now: new Date(world.now) },
  ]);
  await app.close();
});

test("ask: 429 naming whose budget is spent, and the edge is not told yes", async () => {
  for (const reason of [
    "issuance_budget_domain",
    "issuance_budget_organization",
    "issuance_budget_platform",
  ] as const) {
    const { app, ask, logs } = await makeApp({ budget: { granted: false, reason } });
    const res = await ask(q("api.customer.com"));
    assert.equal(res.statusCode, 429, reason);
    assert.deepEqual(res.json(), { allowed: false, reason });
    // The platform's budget running out stops every organization: it is an error.
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.reason === reason);
    assert.equal(line.level, reason === "issuance_budget_platform" ? 50 : 40);
    assert.equal(line.orgId, "org1");
    await app.close();
  }
});

test("ask: a budget that cannot be counted refuses with 503", async () => {
  const { app, ask } = await makeApp({ budget: new Error("database gone") });
  const res = await ask(q("api.customer.com"));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { allowed: false, reason: "lookup_failed" });
  await app.close();
});

test("ask: a name whose certificate was observed needs no budget, and a refused name spends none", async () => {
  // The edge already holds this certificate; an edge restart asking about
  // every live name at once must not be refused or drain anyone's budget.
  const live = await makeApp({
    rows: [askRow({ sslStatus: "active" })],
    budget: { granted: false, reason: "issuance_budget_platform" },
  });
  assert.equal((await live.ask(q("api.customer.com"))).statusCode, 200);
  assert.deepEqual(live.grantsAsked, []);
  await live.app.close();

  for (const over of [
    { rows: [askRow({ routingStatus: "misrouted" })] },
    { entitled: false },
    { rows: [] },
  ] as Array<Partial<World>>) {
    const refused = await makeApp(over);
    assert.notEqual((await refused.ask(q("api.customer.com"))).statusCode, 200);
    assert.notEqual((await refused.ask(q("api.customer.com", "wrong"))).statusCode, 200);
    assert.deepEqual(refused.grantsAsked, []);
    await refused.app.close();
  }
});

test("ask: a refusal about a known domain is never remembered", async () => {
  const { app, ask, world } = await makeApp({ entitled: false });
  assert.equal((await ask(q("api.customer.com"))).statusCode, 403);
  world.entitled = true; // the organization upgraded
  assert.equal((await ask(q("api.customer.com"))).statusCode, 200);
  await app.close();
});

test("ask: any lookup failure refuses with 503, without leaking the error", async () => {
  for (const over of [{ findThrows: true }, { entitled: new Error("redis gone") }] as Array<Partial<World>>) {
    const { app, ask } = await makeApp(over);
    const res = await ask(q("api.customer.com"));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { allowed: false, reason: "lookup_failed" });
    assert.equal(res.payload.includes("/srv/app"), false);
    // And a failure is not remembered as "unknown".
    await app.close();
  }
  const { app, ask, world } = await makeApp({ findThrows: true });
  assert.equal((await ask(q("api.customer.com"))).statusCode, 503);
  world.findThrows = false;
  assert.equal((await ask(q("api.customer.com"))).statusCode, 200);
  await app.close();
});

test("ask: the route is exempt from the shared rate limit and logs below 'warn' are off", async () => {
  const seen: Array<{ url: string; config: unknown; logLevel: string }> = [];
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    seen.push({ url: route.url, config: route.config, logLevel: route.logLevel as string });
  });
  await app.register(
    createCustomDomainEdgeRoutes({
      getConfig: () => CONFIGURED,
      findVerifiedDomain: async () => null,
      isEntitled: async () => true,
      targetExists: async () => true,
      grantIssuance: async () => ({ granted: true }),
    }),
  );
  await app.ready();
  const askRoute = seen.find((route) => route.url === "/internal/edge/ask")!;
  assert.deepEqual(askRoute.config, { rateLimit: false });
  assert.equal(askRoute.logLevel, "warn");
  const respond = seen.find((route) => route.url === "/__edge/respond")!;
  assert.deepEqual(respond.config, { rateLimit: false });
  await app.close();
});

test("ask: the token never reaches the logs, on success, refusal or failure", async () => {
  const { app, ask, logs, world } = await makeApp();
  await ask(q("api.customer.com"));
  await ask(q("api.customer.com", "a-wrong-token-that-must-not-be-logged"));
  await ask(q("unknown.example.org"));
  world.findThrows = true;
  await ask(q("failing.example.org"));

  // Another route logs its request line, so the capture itself works.
  await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
  const all = logs.join("");
  assert.match(all, /\/api\/auth\/login/);
  assert.match(all, /Certificate question failed/);
  assert.equal(all.includes(ASK_TOKEN), false);
  assert.equal(all.includes("a-wrong-token-that-must-not-be-logged"), false);
  assert.equal(all.includes("/internal/edge/ask"), false);
  await app.close();
});

// ============================================
// Requests on a customer hostname
// ============================================

test("a request on a serving hostname reaches its owner's deployment", async () => {
  const { app, edgeHeaders, handled } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
    payload: { messages: [] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { served: "deployment", params: { deploymentSlug: "llama-prod" } });
  assert.deepEqual(handled, [
    { route: "deployment", orgId: "org1", params: { deploymentSlug: "llama-prod" }, url: "/v1/llama-prod/chat/completions" },
  ]);
  await app.close();
});

test("a key of another organization is refused before the target's handler runs", async () => {
  // org2 owns a deployment with the SAME slug: without the guard this request
  // would be served by org2's deployment through org1's hostname.
  const { app, edgeHeaders, handled, counted, counter } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org2" },
    payload: { messages: [] },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "wrong_organization");
  assert.equal(handled.length, 0);
  await counter.flush();
  assert.equal(counted.length, 0, "a refused request is not a request the domain served");
  await app.close();
});

test("no credentials on a customer hostname is the canonical route's own 401", async () => {
  const { app, edgeHeaders, handled } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: edgeHeaders("api.customer.com"),
    payload: {},
  });
  assert.equal(res.statusCode, 401);
  assert.equal(handled.length, 0);
  await app.close();
});

test("an agent hostname reaches that agent, and a models listing its own model", async () => {
  const { app, edgeHeaders, handled } = await makeApp({
    routes: [edgeRoute({ targetType: "agent", targetSlug: "support-bot" }), edgeRoute({ domainId: "d2", domain: "llm.customer.com" })],
  });
  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
    payload: {},
  });
  assert.deepEqual(chat.json(), { served: "agent", params: { agentSlug: "support-bot" } });

  const models = await app.inject({
    method: "GET",
    url: "/v1/models?deployment=someone-elses",
    headers: { ...edgeHeaders("llm.customer.com"), authorization: "Bearer org1" },
  });
  assert.equal(models.statusCode, 200);
  assert.equal(handled[1]!.url, "/v1/models?deployment=llama-prod");
  await app.close();
});

test("the platform's own routes are not reachable through a customer hostname", async () => {
  const { app, edgeHeaders } = await makeApp();
  for (const [method, url] of [
    ["POST", "/api/auth/login"],
    ["POST", "/v1/other-deployment/chat/completions"],
    ["POST", "/v1/agents/other-agent/chat/completions"],
    ["GET", `/internal/edge/ask${q("api.customer.com")}`],
    ["GET", "/"],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json().error, "not_found");
    assert.match(res.json().message, /POST \/v1\/chat\/completions and GET \/v1\/models/);
  }
  // The same paths on the API's own host are unaffected.
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
  assert.deepEqual(login.json(), { served: "login" });
  await app.close();
});

test("an unknown, paused or wrongly-authenticated edge request is 404 custom_domain_not_active", async () => {
  const { app, edgeHeaders } = await makeApp({ routes: [edgeRoute({ serving: false })] });
  for (const headers of [
    edgeHeaders("api.customer.com"),
    edgeHeaders("nobody.example.org"),
    { ...edgeHeaders("api.customer.com"), "x-wheels-edge-token": "wrong" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...headers, authorization: "Bearer org1" }, payload: {} });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "custom_domain_not_active");
  }
  await app.close();
});

test("a routing table that is too old answers 503, not a guess", async () => {
  const { app, edgeHeaders, world, handled } = await makeApp();
  world.now += 61_000;
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
    payload: {},
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "custom_domain_unavailable");
  assert.equal(res.headers["retry-after"], "5");
  assert.equal(handled.length, 0);
  await app.close();
});

test("/__edge/respond means nothing on the API's own host", async () => {
  const { app } = await makeApp();
  for (const method of ["GET", "POST", "DELETE"] as const) {
    const res = await app.inject({ method, url: "/__edge/respond" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "not_found", message: "Not found" });
  }
  await app.close();
});

test("the proof is this domain's HMAC and is served before the domain serves", async () => {
  const { app, edgeHeaders } = await makeApp({ routes: [edgeRoute({ serving: false })] });
  const res = await app.inject({
    method: "GET",
    url: "/.well-known/wheelsai-domain",
    headers: edgeHeaders("API.customer.com:443"),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    domain: "api.customer.com",
    proof: computeDomainProof(EDGE_SECRET, "d1"),
  });
  assert.notEqual(res.json().proof, computeDomainProof(EDGE_SECRET, "d2"));
  assert.notEqual(res.json().proof, computeDomainProof(ASK_TOKEN, "d1"));

  // Not for a hostname nobody verified, and not on the API's own host.
  const unknownHost = await app.inject({ method: "GET", url: "/.well-known/wheelsai-domain", headers: edgeHeaders("nobody.example.org") });
  assert.equal(unknownHost.statusCode, 404);
  const canonical = await app.inject({ method: "GET", url: "/.well-known/wheelsai-domain" });
  assert.equal(canonical.statusCode, 404);
  await app.close();
});

test("plain HTTP is redirected to HTTPS on the customer's own host", async () => {
  const { app, edgeHeaders, handled } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions?x=1",
    headers: { ...edgeHeaders("api.customer.com", { "x-wheels-edge-proto": "http" }), authorization: "Bearer org1", host: "wheelsai-api.internal:4000" },
    payload: {},
  });
  assert.equal(res.statusCode, 308);
  assert.equal(res.headers.location, "https://api.customer.com/v1/chat/completions?x=1");
  assert.equal(handled.length, 0);
  await app.close();
});

test("edge responses pin HTTPS for the one hostname and carry the owner's headers", async () => {
  const { app, edgeHeaders } = await makeApp({
    routes: [edgeRoute({ headers: { "X-Robots-Tag": "noindex", "X-Team": "support" } })],
  });
  const forwarded = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
    payload: {},
  });
  assert.equal(forwarded.headers["strict-transport-security"], "max-age=15552000");
  assert.equal(forwarded.headers["x-robots-tag"], "noindex");
  assert.equal(forwarded.headers["x-team"], "support");

  const notFound = await app.inject({ method: "GET", url: "/nope", headers: edgeHeaders("api.customer.com") });
  assert.equal(notFound.headers["strict-transport-security"], "max-age=15552000");
  assert.equal(notFound.headers["x-robots-tag"], "noindex");

  // An unknown hostname is somebody's too: never includeSubDomains through the edge.
  const unknown = await app.inject({ method: "GET", url: "/", headers: edgeHeaders("nobody.example.org") });
  assert.equal(unknown.headers["strict-transport-security"], "max-age=15552000");
  assert.equal(unknown.headers["x-robots-tag"], undefined);

  // The API's own host keeps the platform default.
  const canonical = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
  assert.match(String(canonical.headers["strict-transport-security"]), /includeSubDomains/);
  assert.equal(canonical.headers["x-robots-tag"], undefined);
  await app.close();
});

test("the HSTS override is already in place when a handler starts a stream", async () => {
  // A streamed answer never passes through onSend: it copies the headers
  // present when the stream starts. So the override must be there by then.
  const { app, edgeHeaders, headersAtHandler } = await makeApp({
    routes: [edgeRoute({ headers: { "X-Team": "support" } })],
  });
  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" },
    payload: {},
  });
  assert.equal(headersAtHandler.length, 1);
  assert.equal(headersAtHandler[0]!["strict-transport-security"], "max-age=15552000");
  assert.equal(headersAtHandler[0]!["x-team"], "support");
  await app.close();
});

test("only requests the owner's credentials made through the hostname are counted", async () => {
  const { app, edgeHeaders, counted, counter } = await makeApp();
  const send = (headers: Record<string, string>, url = "/v1/chat/completions") =>
    app.inject({ method: "POST", url, headers, payload: {} });

  await send({ ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" });
  await send({ ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" });
  await send(edgeHeaders("api.customer.com")); // 401
  await send({ ...edgeHeaders("api.customer.com"), authorization: "Bearer org2" }); // 403
  await send({ ...edgeHeaders("api.customer.com"), authorization: "Bearer org1" }, "/nope"); // 404
  await send({ authorization: "Bearer org1" }, "/v1/llama-prod/chat/completions"); // canonical host

  await counter.flush();
  assert.equal(counted.length, 1);
  assert.equal(counted[0]!.domainId, "d1");
  assert.equal(counted[0]!.count, 2);
  await app.close();
});
