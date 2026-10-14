import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// What counts against a plan's monthly API calls (middleware/auth.ts).
// requireAuth used to count every API-key request, so status polling and
// listing spent the allowance: a CLI waiting ten minutes at one poll every
// three seconds burned 200 of Starter's 1,000 calls. The rule: a request
// counts when it is not a read (GET, HEAD, OPTIONS) and is made with an API
// key or to /v1, however it is authenticated. So a chat completion counts
// once, and an OpenAI client listing /v1/models spends nothing.
//
// Paid use of someone else's agent is the one write that is not counted: the
// caller pays the agent's creator for it, and their own allowance is for what
// they run themselves.

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const { countsAsApiCall, requireAuth } = await import("../middleware/auth.js");
const { createOpenAiAuth } = await import("../middleware/openaiAuth.js");
const { prisma } = await import("@wheelsai/db");

const CASES: Array<{
  authType: "jwt" | "api_key";
  method: string;
  url: string;
  body?: unknown;
  counts: boolean;
}> = [
  { authType: "api_key", method: "GET", url: "/api/deployments/d1", counts: false },
  { authType: "api_key", method: "GET", url: "/api/agents?limit=20", counts: false },
  { authType: "api_key", method: "HEAD", url: "/api/agents", counts: false },
  { authType: "api_key", method: "OPTIONS", url: "/api/agents", counts: false },
  { authType: "api_key", method: "get", url: "/api/agents", counts: false },
  { authType: "api_key", method: "POST", url: "/api/agents", counts: true },
  { authType: "api_key", method: "PUT", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "PATCH", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "DELETE", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "POST", url: "/api/agents/a1/playground/chat", counts: true },
  // A /v1 call that does work counts however it is authenticated...
  { authType: "api_key", method: "POST", url: "/v1/chat/completions", counts: true },
  { authType: "jwt", method: "POST", url: "/v1/chat/completions", counts: true },
  { authType: "api_key", method: "POST", url: "/v1/agents/support-bot/chat/completions", counts: true },
  { authType: "jwt", method: "POST", url: "/v1/agents/support-bot/chat/completions", counts: true },
  // ...and a /v1 read is free, like every other read.
  { authType: "api_key", method: "GET", url: "/v1/models", counts: false },
  { authType: "jwt", method: "GET", url: "/v1/models", counts: false },
  { authType: "api_key", method: "GET", url: "/v1/agents/support-bot/models", counts: false },
  // The dashboard session is never metered outside /v1.
  { authType: "jwt", method: "GET", url: "/api/agents", counts: false },
  { authType: "jwt", method: "POST", url: "/api/agents", counts: false },
  // Only the /v1 API itself, not a path that merely starts with the letters.
  { authType: "jwt", method: "POST", url: "/v1beta/thing", counts: false },
];

for (const c of CASES) {
  test(`${c.authType} ${c.method} ${c.url} ${c.counts ? "counts" : "is free"}`, () => {
    assert.equal(countsAsApiCall({ ...c, body: c.body }), c.counts);
  });
}

const PAID_BODY = { model: "a/support-bot", messages: [{ role: "user", content: "Hi" }] };

test("paid use of someone else's agent is not one of the caller's own API calls", () => {
  for (const authType of ["api_key", "jwt"] as const) {
    for (const url of [
      "/api/a/support-bot/chat",
      "/api/a/support-bot/run",
      "/api/a/support-bot/chat?stream=1",
      "/api/a/support-bot/run?x=/y",
    ]) {
      assert.equal(countsAsApiCall({ authType, method: "POST", url, body: {} }), false, `${authType} ${url}`);
      // The path says it: the body is not read for these two.
      assert.equal(countsAsApiCall({ authType, method: "post", url, body: undefined }), false, `${authType} ${url}`);
    }
    for (const url of ["/v1/chat/completions", "/v1/chat/completions?x=1"]) {
      assert.equal(countsAsApiCall({ authType, method: "POST", url, body: PAID_BODY }), false, `${authType} ${url}`);
    }
  }
});

test("a paid run of someone else's workflow is not one of the caller's own API calls; the owner's own workflow call is", () => {
  const PAID_WORKFLOW_BODY = { model: "w/launch-brief", messages: [{ role: "user", content: "Hi" }] };
  for (const authType of ["api_key", "jwt"] as const) {
    for (const url of ["/api/w/launch-brief/run", "/api/w/launch-brief/run?x=/y"]) {
      assert.equal(countsAsApiCall({ authType, method: "POST", url, body: {} }), false, `${authType} ${url}`);
      assert.equal(countsAsApiCall({ authType, method: "post", url, body: undefined }), false, `${authType} ${url}`);
    }
    for (const url of ["/v1/chat/completions", "/v1/chat/completions?x=1"]) {
      assert.equal(countsAsApiCall({ authType, method: "POST", url, body: PAID_WORKFLOW_BODY }), false, `${authType} ${url}`);
    }
    // The owner's own `workflow/<slug>` starts with neither paid prefix: counted.
    assert.equal(
      countsAsApiCall({ authType, method: "POST", url: "/v1/chat/completions", body: { model: "workflow/launch-brief" } }),
      true,
      authType,
    );
  }
  // A path that only looks like a paid run is counted.
  for (const url of [
    "/api/w/x/run/",
    "/api/w/x/run/extra",
    "/api/w/x/chat",
    "/api/w//run",
    "/api/w/x/y/run",
    "/api/W/x/run",
    "/api/workflows/x/run",
    "/api/w/x/access",
    "/v1/workflows/x/chat/completions",
  ]) {
    assert.equal(countsAsApiCall({ authType: "api_key", method: "POST", url, body: PAID_WORKFLOW_BODY }), true, url);
  }
  for (const model of ["W/x", " w/x", "wf/x", "w"]) {
    assert.equal(
      countsAsApiCall({ authType: "api_key", method: "POST", url: "/v1/chat/completions", body: { model } }),
      true,
      model,
    );
  }
});

test("everything else on /v1 is counted as before, whatever it is named", () => {
  const url = "/v1/chat/completions";
  for (const model of ["agent/support-bot", "workflow/a", "llama-prod", "a", "A/support-bot", " a/support-bot", "agent/a/x", ""]) {
    for (const authType of ["api_key", "jwt"] as const) {
      assert.equal(countsAsApiCall({ authType, method: "POST", url, body: { model } }), true, JSON.stringify(model));
    }
  }
  // The routes that name their target in the path count whatever the body says.
  for (const other of [
    "/v1/agents/support-bot/chat/completions",
    "/v1/workflows/a/chat/completions",
    "/v1/llama-prod/chat/completions",
    "/v1/chat/completions/",
    "/v1/chat/completions/extra",
    "/v1/chat",
  ]) {
    assert.equal(countsAsApiCall({ authType: "api_key", method: "POST", url: other, body: PAID_BODY }), true, other);
    assert.equal(countsAsApiCall({ authType: "jwt", method: "POST", url: other, body: PAID_BODY }), true, other);
  }
});

test("a body that cannot be read as an object with a string model is counted", () => {
  const url = "/v1/chat/completions";
  const bodies: unknown[] = [
    undefined,
    null,
    "",
    '{"model":"a/support-bot"}',
    Buffer.from('{"model":"a/support-bot"}'),
    ["a/support-bot"],
    42,
    {},
    { model: null },
    { model: 7 },
    { model: ["a/support-bot"] },
    { model: { toString: () => "a/support-bot", startsWith: () => true } },
    { Model: "a/support-bot" },
  ];
  for (const body of bodies) {
    assert.equal(countsAsApiCall({ authType: "api_key", method: "POST", url, body }), true, JSON.stringify(body));
    assert.equal(countsAsApiCall({ authType: "jwt", method: "POST", url, body }), true, JSON.stringify(body));
  }
});

test("a path that only looks like paid use is counted", () => {
  for (const url of [
    "/api/agents/x/chat",
    "/api/a/x/chat/extra",
    "/api/a2/x/chat",
    "/api/a/x/chat/",
    "/api/a/x/y/chat",
    "/api/a//chat",
    "/api/a/x/chats",
    "/api/a/x/running",
    "/api/a/x/access",
    "/api/a/x/results",
    "/api/a/chat",
    "/api/A/x/chat",
    "/x/api/a/x/chat",
    "/api/agents/a/x/chat",
    "/api/other?next=/api/a/x/chat",
  ]) {
    assert.equal(countsAsApiCall({ authType: "api_key", method: "POST", url, body: PAID_BODY }), true, url);
  }
  // Only the POST is one use: any other write to the same path is counted.
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(countsAsApiCall({ authType: "api_key", method, url: "/api/a/x/chat", body: {} }), true, method);
    assert.equal(
      countsAsApiCall({ authType: "api_key", method, url: "/v1/chat/completions", body: PAID_BODY }),
      true,
      method,
    );
  }
});

// requireAuth -> meterApiCall -> getOrgPlan. An enterprise plan has no call
// cap, so no Redis is needed; the plan lookup count shows whether the request
// was metered.
async function meteredApp(principal: unknown) {
  const p = prisma as any;
  const original = p.orgSubscription;
  const state = { planLookups: 0 };
  p.orgSubscription = {
    findUnique: async () => {
      state.planLookups += 1;
      return { plan: "enterprise", status: "active" };
    },
  };
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  app.route({
    method: ["GET", "HEAD", "POST", "DELETE"],
    url: "/api/deployments/:id",
    preHandler: requireAuth,
    handler: async () => ({ ok: true }),
  });
  app.route({
    method: ["GET", "POST"],
    url: "/v1/models",
    preHandler: requireAuth,
    handler: async () => ({ ok: true }),
  });
  for (const url of ["/api/a/:handle/chat", "/api/a/:handle/run", "/api/a/:handle/chat/extra", "/api/agents/:id/chat", "/api/a2/:handle/chat"]) {
    app.post(url, { preHandler: requireAuth }, async () => ({ ok: true }));
  }
  await app.ready();
  return {
    app,
    state,
    restore: async () => {
      p.orgSubscription = original;
      await app.close();
    },
  };
}

const KEY = { userId: null, orgId: "org-1", type: "api_key", scopes: ["*"] };
const SESSION = { userId: "u1", orgId: "org-1", type: "jwt", role: "owner" };

test("polling a deployment 200 times with an API key spends no API calls", async () => {
  const { app, state, restore } = await meteredApp(KEY);
  try {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: "GET", url: "/api/deployments/d1" });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(state.planLookups, 0);
  } finally {
    await restore();
  }
});

test("an API-key write is metered once per request", async () => {
  const { app, state, restore } = await meteredApp(KEY);
  try {
    await app.inject({ method: "POST", url: "/api/deployments/d1" });
    await app.inject({ method: "DELETE", url: "/api/deployments/d1" });
    await app.inject({ method: "HEAD", url: "/api/deployments/d1" });
    assert.equal(state.planLookups, 2);
  } finally {
    await restore();
  }
});

test("a /v1 write is metered for keys and sessions alike; a /v1 read is free", async () => {
  const key = await meteredApp(KEY);
  try {
    await key.app.inject({ method: "GET", url: "/v1/models" });
    assert.equal(key.state.planLookups, 0, "listing models spends nothing");
    await key.app.inject({ method: "POST", url: "/v1/models" });
    assert.equal(key.state.planLookups, 1);
  } finally {
    await key.restore();
  }
  const session = await meteredApp(SESSION);
  try {
    await session.app.inject({ method: "GET", url: "/v1/models" });
    await session.app.inject({ method: "POST", url: "/api/deployments/d1" });
    assert.equal(session.state.planLookups, 0, "a session read of /v1 and a session write outside it are free");
    await session.app.inject({ method: "POST", url: "/v1/models" });
    assert.equal(session.state.planLookups, 1, "a session write to /v1 counts");
  } finally {
    await session.restore();
  }
});

test("an unauthenticated request is refused before any metering", async () => {
  const { app, state, restore } = await meteredApp(null);
  try {
    const res = await app.inject({ method: "POST", url: "/v1/models" });
    assert.equal(res.statusCode, 401);
    assert.equal(state.planLookups, 0);
  } finally {
    await restore();
  }
});

test("requireAuth does not meter the two paid-use requests, and meters the ones beside them", async () => {
  const { app, state, restore } = await meteredApp(KEY);
  try {
    for (const url of ["/api/a/support-bot/chat", "/api/a/support-bot/run", "/api/a/support-bot/run?x=1"]) {
      const res = await app.inject({ method: "POST", url, payload: { messages: [] } });
      assert.equal(res.statusCode, 200, url);
    }
    assert.equal(state.planLookups, 0, "paid use spends none of the caller's own calls");
    for (const url of ["/api/a/support-bot/chat/extra", "/api/agents/a1/chat", "/api/a2/support-bot/chat", "/api/deployments/d1"]) {
      const res = await app.inject({ method: "POST", url, payload: { model: "a/support-bot" } });
      assert.equal(res.statusCode, 200, url);
    }
    assert.equal(state.planLookups, 4);
  } finally {
    await restore();
  }
});

// The /v1 guard on its own meter, behind the three shapes of route /v1 has.
async function v1App(principal: unknown) {
  const metered: string[] = [];
  const guard = createOpenAiAuth({ meter: async (orgId) => void metered.push(orgId) });
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => done(null, body));
  for (const url of ["/v1/chat/completions", "/v1/agents/:slug/chat/completions", "/v1/:deploymentSlug/chat/completions"]) {
    app.post(url, { preHandler: [guard] }, async () => ({ ok: true }));
  }
  await app.ready();
  return { app, metered };
}

test("the /v1 guard does not meter a/<handle>, and meters an agent, a workflow and a deployment", async () => {
  for (const principal of [KEY, SESSION]) {
    const { app, metered } = await v1App(principal);
    try {
      const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
      assert.equal((await post("/v1/chat/completions", PAID_BODY)).statusCode, 200);
      assert.equal((await post("/v1/chat/completions?x=1", PAID_BODY)).statusCode, 200);
      assert.deepEqual(metered, [], "paid use spends none of the caller's own calls");

      await post("/v1/chat/completions", { ...PAID_BODY, model: "agent/support-bot" });
      await post("/v1/chat/completions", { ...PAID_BODY, model: "workflow/weekly" });
      await post("/v1/chat/completions", { ...PAID_BODY, model: "llama-prod" });
      assert.deepEqual(metered, ["org-1", "org-1", "org-1"]);

      // A route that names its own target is never paid use, whatever the body says.
      await post("/v1/agents/support-bot/chat/completions", PAID_BODY);
      await post("/v1/llama-prod/chat/completions", PAID_BODY);
      assert.equal(metered.length, 5);
    } finally {
      await app.close();
    }
  }
});

test("the /v1 guard counts a body it cannot read a model from", async () => {
  const { app, metered } = await v1App(KEY);
  try {
    const url = "/v1/chat/completions";
    await app.inject({ method: "POST", url });
    await app.inject({ method: "POST", url, payload: {} });
    await app.inject({ method: "POST", url, payload: { model: 7 } });
    await app.inject({ method: "POST", url, payload: ["a/support-bot"] });
    await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(PAID_BODY),
    });
    assert.equal(metered.length, 5);
  } finally {
    await app.close();
  }
});
