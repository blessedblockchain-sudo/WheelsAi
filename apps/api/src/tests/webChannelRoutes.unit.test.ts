import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import "./unitEnv.js";
import { createRequireRole } from "../middleware/auth.js";
import { createWebChannelRoutes } from "../routes/webChannel.js";
import { createWidgetRoutes } from "../routes/widget.js";
import { createFailClosedLimiter, createMemoryLimiterStore } from "../services/failClosedLimiter.js";
import { publicChatKeys } from "../services/publicChat.js";
import {
  embedSnippet,
  MAX_KEYS_PER_AGENT,
  type WebChannelDb,
  type WebChannelDeps,
  type WebKeyRow,
} from "../services/webChannel.js";
import { PUBLIC_KEY_PATTERN } from "../services/widgetKeys.js";
import { APP_ORIGIN, brokenStore, DAY, fakeChat, NOW } from "./publicChatHarness.js";

// routes/webChannel.ts and services/webChannel.ts, as HTTP: an owner's web
// chat keys. The database is an in-memory stand-in that applies the same
// `where` the service sends, so "another organization's key is not found" is
// tested as the query, not as a mock's return value.

const ORG = "org-owner";
const OTHER_ORG = "org-other";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

interface StoredKey extends Omit<WebKeyRow, "agent"> {
  orgId: string;
}

function fakeDb() {
  const agents = [
    { id: AGENT, orgId: ORG, name: "Support Bot" },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: "Their Bot" },
  ];
  const keys: StoredKey[] = [];
  let seq = 0;
  const withAgent = (key: StoredKey): WebKeyRow & { orgId: string } => ({
    ...key,
    agent: { name: agents.find((agent) => agent.id === key.agentId)!.name },
  });
  const matches = (key: StoredKey, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => (key as unknown as Record<string, unknown>)[field] === value);

  const db: WebChannelDb = {
    agent: {
      findFirst: async ({ where }) => agents.find((agent) => agent.id === where.id && agent.orgId === where.orgId) ?? null,
    },
    widgetKey: {
      findMany: async ({ where }) =>
        keys
          .filter((key) => matches(key, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(withAgent),
      findFirst: async ({ where }) => {
        const key = keys.find((candidate) => matches(candidate, where));
        return key ? withAgent(key) : null;
      },
      count: async ({ where }) => keys.filter((key) => matches(key, where)).length,
      create: async ({ data }) => {
        seq += 1;
        const key: StoredKey = {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          dailyMessageCap: null,
          perIpPerMinute: null,
          title: null,
          greeting: null,
          primaryColor: null,
          position: "bottom-right",
          storeTranscripts: false,
          hideBranding: false,
          enabled: true,
          revokedAt: null,
          lastUsedAt: null,
          pageOfAgentId: null,
          createdAt: new Date(NOW.getTime() + seq),
          allowedOrigins: [],
          ...data,
        };
        keys.push(key);
        return withAgent(key);
      },
      updateMany: async ({ where, data }) => {
        const hit = keys.filter((key) => matches(key, where));
        for (const key of hit) Object.assign(key, data);
        return { count: hit.length };
      },
    },
  };
  return { db, keys };
}

interface ServerOptions {
  whiteLabel?: boolean;
  snippet?: WebChannelDeps["snippet"];
  limiterDown?: boolean;
  role?: string | null;
}

async function server(options: ServerOptions = {}) {
  const { db, keys } = fakeDb();
  const limiter = createFailClosedLimiter(
    options.limiterDown ? brokenStore : createMemoryLimiterStore(() => NOW.getTime()),
  );
  let n = 0;
  const channel: WebChannelDeps = {
    db,
    limiter,
    whiteLabel: async () => options.whiteLabel ?? false,
    snippet: options.snippet ?? { webUrl: "https://app.wheelsai.test/", apiUrl: "https://api.wheelsai.test" },
    defaultDailyCap: 1000,
    generatePublicKey: () => {
      n += 1;
      return `wpk_${String(n).padStart(32, "0")}`;
    },
    now: () => NOW,
  };

  const app = Fastify();
  app.decorateRequest("auth", null);
  // Stands in for the global auth hook: a test names its caller in headers.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org !== "string") return;
    const apiKey = request.headers["x-test-api-key"] === "1";
    (request as { auth: unknown }).auth = apiKey
      ? { orgId: org, userId: null, type: "api_key", apiKeyId: "key_1" }
      : { orgId: org, userId: "user-1", type: "jwt" };
  });
  const auth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  // The real role guard, over a membership lookup the test controls.
  const requireRole = createRequireRole({
    getMemberRole: async () => (options.role === undefined ? "owner" : options.role),
  });
  await app.register(
    createWebChannelRoutes({
      channel,
      guards: { auth, manage: requireRole("owner", "admin") as preHandlerAsyncHookHandler },
    }),
    { prefix: "/api/channels/web" },
  );

  // The public side, on the same rows: what a rotation or a revocation does
  // to a snippet already out there.
  const chat = fakeChat({
    key: (publicKey) => {
      const key = keys.find((candidate) => candidate.publicKey === publicKey);
      return key ? { ...key, orgId: key.orgId } : null;
    },
  });
  await app.register(
    createWidgetRoutes({
      chat: chat.deps,
      config: {
        limiter: chat.limiter,
        perIpPerMinute: 60,
        loadKeyConfig: async (publicKey) => {
          const key = keys.find((candidate) => candidate.publicKey === publicKey);
          return key ? { ...key, agentName: "Support Bot" } : null;
        },
        whiteLabel: async () => options.whiteLabel ?? false,
      },
    }),
    { prefix: "/api/widget" },
  );
  return { app, keys, limiter };
}

const owner = { "x-test-org": ORG };
const json = { "content-type": "application/json" };

const create = (app: FastifyInstance, body: Record<string, unknown> = {}, headers: Record<string, string> = owner) =>
  app.inject({
    method: "POST",
    url: "/api/channels/web/keys",
    headers: { ...json, ...headers },
    payload: JSON.stringify({ agentId: AGENT, name: "Main site", ...body }),
  });

test("every route answers 401 without a caller", async () => {
  const { app } = await server();
  const id = "00000000-0000-4000-8000-000000000001";
  const calls: Array<[string, string]> = [
    ["GET", "/api/channels/web/keys"],
    ["POST", "/api/channels/web/keys"],
    ["PATCH", `/api/channels/web/keys/${id}`],
    ["POST", `/api/channels/web/keys/${id}/rotate`],
    ["DELETE", `/api/channels/web/keys/${id}`],
  ];
  for (const [method, url] of calls) {
    const res = await app.inject({ method: method as "GET", url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test("create: a key for the caller's own agent, with canonical origins and a snippet built from this server's addresses", async () => {
  const { app, keys } = await server();
  const res = await create(app, {
    allowedOrigins: ["HTTPS://Shop.Example.com/", "https://shop.example.com", "https://*.example.org", "http://localhost:5173"],
    dailyMessageCap: 500,
    perIpPerMinute: 6,
    appearance: { title: "Ask us", greeting: "Hi!", primaryColor: "#0A84FF", position: "bottom-left" },
    storeTranscripts: true,
  });
  assert.equal(res.statusCode, 201);
  const { key } = res.json();
  assert.match(key.publicKey, PUBLIC_KEY_PATTERN);
  assert.ok(!key.publicKey.startsWith("wheels_"), "never mistaken for a secret API key");
  assert.deepEqual(key.allowedOrigins, ["https://shop.example.com", "https://*.example.org", "http://localhost:5173"]);
  assert.equal(key.agentId, AGENT);
  assert.equal(key.agentName, "Support Bot");
  assert.equal(key.dailyMessageCap, 500);
  assert.equal(key.perIpPerMinute, 6);
  assert.deepEqual(key.appearance, { title: "Ask us", greeting: "Hi!", primaryColor: "#0a84ff", position: "bottom-left" });
  assert.equal(key.storeTranscripts, true);
  assert.equal(key.hideBranding, false);
  assert.equal(key.enabled, true);
  assert.equal(key.revokedAt, null);
  assert.equal(key.usageToday, 0);
  assert.equal(
    key.snippet,
    `<script src="https://app.wheelsai.test/widget.js" data-wheelsai-key="${key.publicKey}" data-api="https://api.wheelsai.test" async></script>`,
  );
  assert.equal(key.snippetUnavailableReason, null);
  assert.equal(keys[0]!.orgId, ORG);
  assert.ok(!res.body.includes("orgId"));
});

test("create: an API key principal may manage channels; a member who is not an owner or admin may not", async () => {
  const asKey = await server();
  const viaApiKey = await create(asKey.app, {}, { ...owner, "x-test-api-key": "1" });
  assert.equal(viaApiKey.statusCode, 201);

  const asMember = await server({ role: "member" });
  const member = await create(asMember.app);
  assert.equal(member.statusCode, 403);
  assert.equal(member.json().error, "insufficient_role");
  assert.equal(asMember.keys.length, 0);
  // A member can still see the keys.
  assert.equal((await asMember.app.inject({ method: "GET", url: "/api/channels/web/keys", headers: owner })).statusCode, 200);

  const removed = await server({ role: null });
  assert.equal((await create(removed.app)).statusCode, 403);
});

test("create: another organization's agent is not found, and no key is made", async () => {
  const { app, keys } = await server();
  const res = await create(app, { agentId: OTHER_AGENT });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "agent_not_found");
  assert.equal(keys.length, 0);
});

test("create: something that is not an origin is a 400 that names it and says why", async () => {
  const cases: Array<[string, string]> = [
    ["https://example.com/pricing", "has_path"],
    ["https://example.com?x=1", "has_query"],
    ["https://user:pw@example.com", "has_userinfo"],
    ["ftp://example.com", "scheme_not_allowed"],
    ["http://example.com", "http_only_for_localhost"],
    ["https://*.com", "wildcard_too_broad"],
    ["https://shop.*.example.com", "bad_wildcard"],
    ["example.com", "malformed"],
  ];
  const { app, keys } = await server();
  for (const [origin, reason] of cases) {
    const res = await create(app, { allowedOrigins: ["https://ok.example.com", origin] });
    assert.equal(res.statusCode, 400, origin);
    const body = res.json();
    assert.equal(body.error, "invalid_origin", origin);
    assert.equal(body.origin, origin);
    assert.equal(body.reason, reason, origin);
    assert.ok(body.message.includes(origin));
  }
  assert.equal(keys.length, 0);
});

test("create: unknown fields and out-of-range limits are refused", async () => {
  const { app } = await server();
  for (const body of [
    { publicKey: "wpk_mine" },
    { orgId: OTHER_ORG },
    { dailyMessageCap: 0 },
    { dailyMessageCap: 100_001 },
    { perIpPerMinute: 61 },
    { appearance: { primaryColor: "red" } },
    { appearance: { position: "top-left" } },
    { name: "" },
    { allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`) },
  ]) {
    const res = await create(app, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "invalid_request");
  }
});

test(`create: an agent has at most ${MAX_KEYS_PER_AGENT} live keys; revoked ones do not count`, async () => {
  const { app, keys } = await server();
  for (let i = 0; i < MAX_KEYS_PER_AGENT; i += 1) {
    assert.equal((await create(app, { name: `Key ${i}` })).statusCode, 201);
  }
  const over = await create(app, { name: "One too many" });
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().error, "too_many_keys");
  assert.equal(over.json().limit, MAX_KEYS_PER_AGENT);
  assert.equal(keys.length, MAX_KEYS_PER_AGENT);

  await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${keys[0]!.id}`, headers: owner });
  assert.equal((await create(app, { name: "Fits again" })).statusCode, 201);
});

test('hiding "Powered by WheelsAI" needs a plan with white-labelling, on create and on update', async () => {
  const starter = await server({ whiteLabel: false });
  const refused = await create(starter.app, { hideBranding: true });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, "plan_limit_reached");
  assert.equal(refused.json().feature, "whiteLabel");
  assert.equal(starter.keys.length, 0);

  const made = (await create(starter.app)).json().key;
  const patch = (app: FastifyInstance, id: string, body: unknown) =>
    app.inject({ method: "PATCH", url: `/api/channels/web/keys/${id}`, headers: { ...json, ...owner }, payload: JSON.stringify(body) });
  assert.equal((await patch(starter.app, made.id, { hideBranding: true })).statusCode, 403);
  assert.equal(starter.keys[0]!.hideBranding, false);
  // Turning it off is always allowed.
  assert.equal((await patch(starter.app, made.id, { hideBranding: false })).statusCode, 200);

  const enterprise = await server({ whiteLabel: true });
  const allowed = await create(enterprise.app, { hideBranding: true });
  assert.equal(allowed.statusCode, 201);
  assert.equal(allowed.json().key.hideBranding, true);
  const list = (await enterprise.app.inject({ method: "GET", url: "/api/channels/web/keys", headers: owner })).json();
  assert.equal(list.whiteLabel, true);
});

test("list: only the caller's organization's keys, newest first, revoked ones on request", async () => {
  const { app, keys } = await server();
  await create(app, { name: "First" });
  await create(app, { name: "Second" });
  // A key of another organization, on its own agent.
  keys.push({ ...keys[0]!, id: "00000000-0000-4000-8000-00000000ffff", orgId: OTHER_ORG, agentId: OTHER_AGENT, publicKey: `wpk_${"z".repeat(32)}`, name: "Theirs" });
  await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${keys[0]!.id}`, headers: owner });

  const list = (await app.inject({ method: "GET", url: "/api/channels/web/keys", headers: owner })).json();
  assert.deepEqual(list.keys.map((key: { name: string }) => key.name), ["Second"]);
  assert.deepEqual(list.defaults, { dailyMessageCap: 1000 });
  assert.equal(list.whiteLabel, false);

  const all = (await app.inject({ method: "GET", url: "/api/channels/web/keys?includeRevoked=true", headers: owner })).json();
  assert.deepEqual(all.keys.map((key: { name: string }) => key.name), ["Second", "First"]);
  assert.ok(!JSON.stringify(all).includes("Theirs"));
  const revoked = all.keys[1];
  assert.equal(revoked.snippet, null);
  assert.equal(revoked.snippetUnavailableReason, "This key was revoked.");

  const theirs = (await app.inject({ method: "GET", url: "/api/channels/web/keys", headers: { "x-test-org": OTHER_ORG } })).json();
  assert.deepEqual(theirs.keys.map((key: { name: string }) => key.name), ["Theirs"]);

  // Filtering by an agent of another organization finds nothing of theirs.
  const filtered = (await app.inject({ method: "GET", url: `/api/channels/web/keys?agentId=${OTHER_AGENT}`, headers: owner })).json();
  assert.deepEqual(filtered.keys, []);
  assert.equal((await app.inject({ method: "GET", url: "/api/channels/web/keys?agentId=nope", headers: owner })).statusCode, 400);
});

test("list: today's usage is the counter the chat counts on, and null - not zero - when it cannot be read", async () => {
  const up = await server();
  const made = (await create(up.app)).json().key;
  for (let i = 0; i < 3; i += 1) {
    await up.limiter.consume([{ scope: "key", key: publicChatKeys.widgetKeyDay(made.id, DAY), limit: 100, windowSeconds: 86_400 }]);
  }
  const list = (await up.app.inject({ method: "GET", url: "/api/channels/web/keys", headers: owner })).json();
  assert.equal(list.keys[0].usageToday, 3);

  const down = await server({ limiterDown: true });
  const res = await create(down.app);
  assert.equal(res.statusCode, 201, "an unreadable counter does not stop an owner managing keys");
  assert.equal(res.json().key.usageToday, null);
});

test("the snippet is null with a calm reason when this server does not know its public addresses", async () => {
  const { app } = await server({ snippet: { webUrl: null, apiUrl: "https://api.wheelsai.test" } });
  const { key } = (await create(app)).json();
  assert.equal(key.snippet, null);
  assert.equal(key.snippetUnavailableReason, "The embed snippet is temporarily unavailable. Try again later.");
  assert.ok(!/PUBLIC_/.test(key.snippetUnavailableReason), "the settings are for the operator's log");

  assert.equal(
    embedSnippet("wpk_x", { webUrl: null, apiUrl: null }).reason,
    "The embed snippet is temporarily unavailable. Try again later.",
  );
  // Whatever the addresses hold, the tag stays one tag.
  const odd = embedSnippet("wpk_x", { webUrl: 'https://a.test/"><script>', apiUrl: "https://b.test" }).snippet ?? "";
  assert.ok(!odd.includes('"><script>'));
});

test("update: origins, limits, look and the enabled switch; null clears a limit; another organization's key is not found", async () => {
  const { app, keys } = await server();
  const made = (await create(app, { dailyMessageCap: 500 })).json().key;
  const patch = (body: unknown, headers: Record<string, string> = owner, id: string = made.id) =>
    app.inject({ method: "PATCH", url: `/api/channels/web/keys/${id}`, headers: { ...json, ...headers }, payload: JSON.stringify(body) });

  const res = await patch({
    name: "Renamed",
    allowedOrigins: ["https://new.example.com"],
    dailyMessageCap: null,
    appearance: { title: null, primaryColor: "#112233" },
    enabled: false,
  });
  assert.equal(res.statusCode, 200);
  const { key } = res.json();
  assert.equal(key.name, "Renamed");
  assert.deepEqual(key.allowedOrigins, ["https://new.example.com"]);
  assert.equal(key.dailyMessageCap, null);
  assert.equal(key.appearance.primaryColor, "#112233");
  assert.equal(key.enabled, false);
  assert.equal(key.publicKey, made.publicKey, "an update never changes the public key");

  assert.equal((await patch({ allowedOrigins: ["https://x.example.com/page"] })).statusCode, 400);
  assert.equal((await patch({ publicKey: "wpk_mine" })).statusCode, 400);
  assert.equal((await patch({ revokedAt: null })).statusCode, 400);

  const other = await patch({ name: "Taken over" }, { "x-test-org": OTHER_ORG });
  assert.equal(other.statusCode, 404);
  assert.equal(other.json().error, "widget_key_not_found");
  assert.equal(keys[0]!.name, "Renamed");
  assert.equal((await patch({ name: "x" }, owner, "not-a-uuid")).statusCode, 400);
});

test("rotate: a new public key at once; the old snippet answers 404 on the widget route and the new one works", async () => {
  const { app } = await server();
  const made = (await create(app, { allowedOrigins: ["https://shop.example.com"] })).json().key;
  const widgetConfig = (publicKey: string) =>
    app.inject({ method: "GET", url: `/api/widget/${publicKey}/config`, headers: { origin: "https://shop.example.com" } });
  assert.equal((await widgetConfig(made.publicKey)).statusCode, 200);

  const res = await app.inject({ method: "POST", url: `/api/channels/web/keys/${made.id}/rotate`, headers: owner });
  assert.equal(res.statusCode, 200);
  const rotated = res.json().key;
  assert.equal(rotated.id, made.id);
  assert.notEqual(rotated.publicKey, made.publicKey);
  assert.match(rotated.publicKey, PUBLIC_KEY_PATTERN);
  assert.ok(rotated.snippet.includes(rotated.publicKey));
  assert.deepEqual(rotated.allowedOrigins, made.allowedOrigins, "everything else is kept");

  const old = await widgetConfig(made.publicKey);
  assert.equal(old.statusCode, 404);
  assert.equal(old.json().error, "widget_key_not_found");
  assert.equal((await widgetConfig(rotated.publicKey)).statusCode, 200);

  const oldChat = await app.inject({
    method: "POST",
    url: `/api/widget/${made.publicKey}/chat`,
    headers: { ...json, origin: "https://shop.example.com" },
    payload: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(oldChat.statusCode, 404);

  const theirs = await app.inject({ method: "POST", url: `/api/channels/web/keys/${made.id}/rotate`, headers: { "x-test-org": OTHER_ORG } });
  assert.equal(theirs.statusCode, 404);
});

test("rotate: compare-and-set on the key that was read - a rotation that lost the race is told, and hands out nothing", async () => {
  const { db } = fakeDb();
  const { rotateWebKey, createWebKey, WebChannelError } = await import("../services/webChannel.js");
  let n = 0;
  const deps: WebChannelDeps = {
    db,
    limiter: createFailClosedLimiter(createMemoryLimiterStore()),
    whiteLabel: async () => false,
    snippet: { webUrl: "https://a.test", apiUrl: "https://b.test" },
    defaultDailyCap: 1000,
    generatePublicKey: () => `wpk_${String((n += 1)).padStart(32, "0")}`,
  };
  const made = await createWebKey(deps, ORG, { agentId: AGENT, name: "k", allowedOrigins: [] });

  // Another rotation lands between this one's read and its write.
  const racing: WebChannelDeps = {
    ...deps,
    db: {
      ...db,
      widgetKey: {
        ...db.widgetKey,
        updateMany: async (args) => {
          if (args.data.publicKey && args.where.publicKey === made.publicKey) {
            await db.widgetKey.updateMany({ where: { id: made.id, orgId: ORG, revokedAt: null }, data: { publicKey: `wpk_${"w".repeat(32)}` } });
          }
          return db.widgetKey.updateMany(args);
        },
      },
    },
  };
  await assert.rejects(rotateWebKey(racing, ORG, made.id), (err: unknown) => {
    assert.ok(err instanceof WebChannelError);
    assert.equal(err.status, 409);
    assert.equal(err.code, "widget_key_changed");
    return true;
  });
});

test("delete: a soft revoke - the row stays, the widget answers 404, and the key cannot be edited or rotated back", async () => {
  const { app, keys } = await server();
  const made = (await create(app, { allowedOrigins: ["https://shop.example.com"] })).json().key;

  const theirs = await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${made.id}`, headers: { "x-test-org": OTHER_ORG } });
  assert.equal(theirs.statusCode, 404);
  assert.equal(keys[0]!.revokedAt, null);

  const res = await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${made.id}`, headers: owner });
  assert.equal(res.statusCode, 204);
  assert.equal(keys.length, 1, "the row is kept");
  assert.deepEqual(keys[0]!.revokedAt, NOW);
  assert.equal(keys[0]!.enabled, false);

  const widget = await app.inject({ method: "GET", url: `/api/widget/${made.publicKey}/config`, headers: { origin: "https://shop.example.com" } });
  assert.equal(widget.statusCode, 404);
  const preview = await app.inject({ method: "GET", url: `/api/widget/${made.publicKey}/config`, headers: { origin: APP_ORIGIN } });
  assert.equal(preview.statusCode, 404);

  // Again: nothing changes, and it is not an error.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${made.id}`, headers: owner })).statusCode, 204);

  const edit = await app.inject({ method: "PATCH", url: `/api/channels/web/keys/${made.id}`, headers: { ...json, ...owner }, payload: JSON.stringify({ enabled: true }) });
  assert.equal(edit.statusCode, 404);
  assert.equal(keys[0]!.enabled, false);
  assert.equal((await app.inject({ method: "POST", url: `/api/channels/web/keys/${made.id}/rotate`, headers: owner })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/channels/web/keys/00000000-0000-4000-8000-00000000dead", headers: owner })).statusCode, 404);
});

test("a key says whether it is an agent's page key, and revoking one clears the mark in the same write", async () => {
  const { app, keys } = await server();
  const ordinary = (await create(app)).json().key;
  assert.equal(ordinary.pageOfAgentId, null);

  // The page key is made by the public link switch (services/agentPublicLink.ts); here it is a row.
  const page = (await create(app, { name: "Public page" })).json().key;
  keys.find((key) => key.id === page.id)!.pageOfAgentId = AGENT;

  const list = (await app.inject({ method: "GET", url: "/api/channels/web/keys", headers: owner })).json();
  assert.deepEqual(
    list.keys.map((key: { id: string; pageOfAgentId: string | null }) => [key.id, key.pageOfAgentId]).sort(),
    [[ordinary.id, null], [page.id, AGENT]].sort(),
  );
  const paused = await app.inject({ method: "PATCH", url: `/api/channels/web/keys/${page.id}`, headers: { ...json, ...owner }, payload: JSON.stringify({ enabled: false }) });
  assert.equal(paused.json().key.pageOfAgentId, AGENT, "an edit leaves the mark alone");
  assert.equal((await app.inject({ method: "POST", url: `/api/channels/web/keys/${page.id}/rotate`, headers: owner })).json().key.pageOfAgentId, AGENT);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${page.id}`, headers: owner })).statusCode, 204);
  const stored = keys.find((key) => key.id === page.id)!;
  assert.deepEqual(stored.revokedAt, NOW);
  assert.equal(stored.enabled, false);
  assert.equal(stored.pageOfAgentId, null, "so the agent can be given a new page key");

  const all = (await app.inject({ method: "GET", url: "/api/channels/web/keys?includeRevoked=true", headers: owner })).json();
  assert.equal(all.keys.find((key: { id: string }) => key.id === page.id).pageOfAgentId, null);

  // An ordinary key is revoked exactly as before.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/channels/web/keys/${ordinary.id}`, headers: owner })).statusCode, 204);
  const plain = keys.find((key) => key.id === ordinary.id)!;
  assert.deepEqual([plain.revokedAt, plain.enabled, plain.pageOfAgentId], [NOW, false, null]);
});
