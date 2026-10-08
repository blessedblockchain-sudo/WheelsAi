import assert from "node:assert/strict";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify from "fastify";

import {
  APP_EXPOSED_HEADERS,
  corsOptionsFor,
  isWidgetPath,
  WIDGET_PREFLIGHT_MAX_AGE_SECONDS,
} from "../lib/corsPolicy.js";
import { sseHeaders } from "../services/sseReply.js";

// lib/corsPolicy.ts: the API has two CORS policies. The web app's origin,
// with credentials, everywhere - and any origin WITHOUT credentials on the
// two public widget paths, where the route itself enforces the key's allowed
// origins. What must never happen is the two mixing: credentials on a path
// that reflects any origin.

const PROD = { corsOrigin: "https://app.wheelsai.test", isDev: false };
const DEV = { corsOrigin: "http://localhost:3000", isDev: true };
const KEY = `wpk_${"a".repeat(32)}`;
const SHOP = "https://shop.example.com";

test("only the three widget routes are widget paths", () => {
  assert.equal(isWidgetPath(`/api/widget/${KEY}/config`), true);
  assert.equal(isWidgetPath(`/api/widget/${KEY}/chat`), true);
  assert.equal(isWidgetPath(`/api/widget/${KEY}/chat?x=1`), true);
  // A task run from an agent's public page.
  assert.equal(isWidgetPath(`/api/widget/${KEY}/run`), true);
  assert.equal(isWidgetPath(`/api/widget/${KEY}/run?x=1`), true);

  for (const url of [
    undefined,
    "",
    "/api/widget",
    "/api/widget/",
    `/api/widget/${KEY}`,
    `/api/widget/${KEY}/other`,
    `/api/widget/${KEY}/chat/extra`,
    // Nothing else can be moved under the widget's policy by a crafted URL.
    "/api/widget/../auth/login",
    "/api/widget/..%2Fauth/chat",
    "/api/widget/a/b/chat",
    "/api/widgets/x/chat",
    "/api/channels/web/keys",
    "/api/marketplace/listings/support-pro/try/chat",
    `/v1/api/widget/${KEY}/chat`,
    "/api/auth/login?next=/api/widget/x/chat",
  ]) {
    assert.equal(isWidgetPath(url), false, String(url));
  }
});

test("widget paths: any origin is echoed, credentials are never allowed", () => {
  for (const config of [PROD, DEV]) {
    const options = corsOptionsFor({ url: `/api/widget/${KEY}/chat` }, config);
    assert.equal(options.origin, true);
    assert.equal(options.credentials, false);
    assert.deepEqual(options.methods, ["GET", "POST"]);
    assert.deepEqual(options.allowedHeaders, ["content-type"]);
    assert.equal(options.maxAge, WIDGET_PREFLIGHT_MAX_AGE_SECONDS);
    assert.deepEqual(options.exposedHeaders, ["X-Request-Id", "Retry-After"]);
  }
});

test("every other path keeps the app's policy: one origin with credentials, any origin only in development", () => {
  const prod = corsOptionsFor({ url: "/api/agents" }, PROD);
  assert.equal(prod.origin, "https://app.wheelsai.test");
  assert.equal(prod.credentials, true);
  assert.deepEqual(prod.exposedHeaders, [...APP_EXPOSED_HEADERS]);

  const dev = corsOptionsFor({ url: "/api/agents" }, DEV);
  assert.equal(dev.origin, true);
  assert.equal(dev.credentials, true);

  // Try it is called by the web app, with its cookie: the app's policy.
  assert.equal(corsOptionsFor({ url: "/api/marketplace/listings/x/try/chat" }, PROD).credentials, true);
});

async function server(config: typeof PROD) {
  const app = Fastify();
  // Registered exactly as index.ts registers it.
  await app.register(cors, {
    delegator: (request, callback) => callback(null, corsOptionsFor(request, config)),
  });
  app.get("/api/widget/:publicKey/config", async () => ({ ok: true }));
  app.post("/api/widget/:publicKey/chat", async (_request, reply) => {
    // A stream, written the way services/sseReply.ts writes one.
    reply.raw.writeHead(200, sseHeaders(reply));
    reply.raw.end("data: [DONE]\n\n");
  });
  app.get("/api/agents", async () => ({ ok: true }));
  return app;
}

test("through @fastify/cors: a widget response echoes the Origin, varies by it and carries no credentials header", async () => {
  const app = await server(PROD);
  const res = await app.inject({ method: "GET", url: `/api/widget/${KEY}/config`, headers: { origin: SHOP } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], SHOP);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assert.match(String(res.headers.vary), /Origin/);
  assert.match(String(res.headers["access-control-expose-headers"]), /Retry-After/);
});

test("through @fastify/cors: the widget's preflight allows GET and POST with content-type, for ten minutes", async () => {
  const app = await server(PROD);
  const res = await app.inject({
    method: "OPTIONS",
    url: `/api/widget/${KEY}/chat`,
    headers: {
      origin: SHOP,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], SHOP);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assert.equal(res.headers["access-control-allow-methods"], "GET, POST");
  assert.equal(res.headers["access-control-allow-headers"], "content-type");
  assert.equal(res.headers["access-control-max-age"], "600");
});

test("through @fastify/cors: a streamed widget answer keeps its CORS headers", async () => {
  const app = await server(PROD);
  const res = await app.inject({ method: "POST", url: `/api/widget/${KEY}/chat`, headers: { origin: SHOP } });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  assert.equal(res.headers["access-control-allow-origin"], SHOP);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assert.match(String(res.headers.vary), /Origin/);
});

test("through @fastify/cors: the rest of the API answers only the app's origin, with credentials", async () => {
  const app = await server(PROD);
  const own = await app.inject({ method: "GET", url: "/api/agents", headers: { origin: PROD.corsOrigin } });
  assert.equal(own.headers["access-control-allow-origin"], PROD.corsOrigin);
  assert.equal(own.headers["access-control-allow-credentials"], "true");
  assert.match(String(own.headers.vary), /Origin/);

  // Another site is never named as allowed, so its page cannot read the
  // answer however the request was sent.
  const other = await app.inject({ method: "GET", url: "/api/agents", headers: { origin: SHOP } });
  assert.notEqual(other.headers["access-control-allow-origin"], SHOP);
});

test("through @fastify/cors: development reflects any origin on app paths, and still gives the widget no credentials", async () => {
  const app = await server(DEV);
  const appPath = await app.inject({ method: "GET", url: "/api/agents", headers: { origin: "http://localhost:5173" } });
  assert.equal(appPath.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(appPath.headers["access-control-allow-credentials"], "true");

  const widget = await app.inject({
    method: "GET",
    url: `/api/widget/${KEY}/config`,
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(widget.headers["access-control-allow-credentials"], undefined);
});

test("the run path has the widget's policy: any origin echoed, never credentials; the signed-in run routes keep the app's", () => {
  for (const config of [PROD, DEV]) {
    const options = corsOptionsFor({ url: `/api/widget/${KEY}/run` }, config);
    assert.equal(options.origin, true);
    assert.equal(options.credentials, false);
    assert.deepEqual(options.methods, ["GET", "POST"]);
    assert.deepEqual(options.allowedHeaders, ["content-type"]);
    assert.deepEqual(options.exposedHeaders, ["X-Request-Id", "Retry-After"]);
  }

  for (const url of [
    `/api/widget/${KEY}/run/extra`,
    `/api/widget/${KEY}/runs`,
    `/api/widget/${KEY}/rerun`,
    "/api/widget/a/b/run",
    // The owner's run and a paying user's run are called with a session.
    "/api/agents/3f0c0a8e-0000-4000-8000-000000000000/run",
    "/api/a/support-bot/run",
    "/api/a/support-bot",
  ]) {
    assert.equal(isWidgetPath(url), false, url);
    const options = corsOptionsFor({ url }, PROD);
    assert.equal(options.origin, "https://app.wheelsai.test", url);
    assert.equal(options.credentials, true, url);
  }
});
