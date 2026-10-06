import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";

import { acceptEmptyJsonBody, replaceJsonBodyParser } from "../routes/emptyJsonBody.js";

// A JSON content type with no body is what a fetch wrapper or `curl -H
// 'Content-Type: application/json' -X POST` sends for an action that takes
// no input. Fastify refuses it while parsing (400), before authentication
// and the handler. The parser that accepts it was registered inside two
// route plugins only; it is now registered once at the root.

const JSON_HEADERS = { "content-type": "application/json" };

async function rootApp() {
  const app = Fastify();
  acceptEmptyJsonBody(app);
  await app.register(
    async (plugin) => {
      plugin.post("/act", async (request) => ({ body: request.body ?? null }));
      await plugin.register(async (nested) => {
        nested.post("/nested", async (request) => ({ body: request.body ?? null }));
      });
    },
    { prefix: "/api" },
  );
  return app;
}

test("registered at the root, every plugin's routes accept a JSON content type with no body", async () => {
  const app = await rootApp();
  for (const url of ["/api/act", "/api/nested"]) {
    const res = await app.inject({ method: "POST", url, headers: JSON_HEADERS });
    assert.equal(res.statusCode, 200, url);
    assert.deepEqual(res.json(), { body: null });
  }
  await app.close();
});

test("without it Fastify answers 400 before the handler", async () => {
  const app = Fastify();
  let reached = false;
  app.post("/act", async () => {
    reached = true;
    return {};
  });
  const res = await app.inject({ method: "POST", url: "/act", headers: JSON_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "FST_ERR_CTP_EMPTY_JSON_BODY");
  assert.equal(reached, false);
  await app.close();
});

test("a body that is present still goes through Fastify's own parser", async () => {
  const app = await rootApp();
  const ok = await app.inject({ method: "POST", url: "/api/act", headers: JSON_HEADERS, payload: '{"a":1}' });
  assert.deepEqual(ok.json(), { body: { a: 1 } });

  const malformed = await app.inject({ method: "POST", url: "/api/act", headers: JSON_HEADERS, payload: "{not json" });
  assert.equal(malformed.statusCode, 400);
  const poisoned = await app.inject({
    method: "POST",
    url: "/api/act",
    headers: JSON_HEADERS,
    payload: '{"__proto__":{"isAdmin":true}}',
  });
  assert.equal(poisoned.statusCode, 400);
  const charset = await app.inject({
    method: "POST",
    url: "/api/act",
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(charset.statusCode, 200);
  await app.close();
});

test("the body limit still applies", async () => {
  const app = Fastify({ bodyLimit: 64 });
  acceptEmptyJsonBody(app);
  app.post("/act", async () => ({}));
  const res = await app.inject({
    method: "POST",
    url: "/act",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ text: "x".repeat(200) }),
  });
  assert.equal(res.statusCode, 413);
  await app.close();
});

// Fastify refuses a second custom parser for a content type that has one,
// so a signature-verifying webhook plugin would throw at startup under the
// root parser unless it replaces it in its own scope.
test("a plugin with its own JSON parser replaces the root one in its scope only", async () => {
  const app = Fastify();
  acceptEmptyJsonBody(app);

  await assert.rejects(
    async () => {
      const probe = Fastify();
      acceptEmptyJsonBody(probe);
      await probe.register(async (plugin) => {
        plugin.addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body));
      });
      await probe.ready();
    },
    (err: { code?: string }) => err.code === "FST_ERR_CTP_ALREADY_PRESENT",
  );

  await app.register(async (plugin) => {
    replaceJsonBodyParser(plugin);
    plugin.addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) =>
      done(null, { raw: body }),
    );
    plugin.post("/webhook", async (request) => request.body);
  });
  await app.register(async (plugin) => {
    plugin.post("/sibling", async (request) => ({ body: request.body ?? null }));
  });

  const raw = await app.inject({ method: "POST", url: "/webhook", headers: JSON_HEADERS, payload: '{"a": 1}' });
  assert.deepEqual(raw.json(), { raw: '{"a": 1}' });
  const sibling = await app.inject({ method: "POST", url: "/sibling", headers: JSON_HEADERS });
  assert.deepEqual(sibling.json(), { body: null });
  await app.close();
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("index.ts registers it once at the root, before the first route plugin", () => {
  const index = read("../index.ts");
  const calls = index.match(/acceptEmptyJsonBody\(app\)/g) ?? [];
  assert.equal(calls.length, 1);
  assert.ok(index.indexOf("acceptEmptyJsonBody(app)") < index.indexOf("await app.register(healthRoutes"));
});

test("no route plugin registers it for itself, and each raw-body plugin replaces it", () => {
  for (const file of ["orchestration.ts", "scheduler.ts"]) {
    assert.doesNotMatch(read(`../routes/${file}`), /acceptEmptyJsonBody/, file);
  }
  for (const file of ["stripeWebhook.ts", "githubApp.ts", "channelWebhooks.ts", "slackEvents.ts"]) {
    const source = read(`../routes/${file}`);
    const replace = source.indexOf("replaceJsonBodyParser(app)");
    assert.ok(replace >= 0, file);
    assert.ok(replace < source.indexOf('app.addContentTypeParser('), file);
  }
});
