import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import type { EdgeRoute } from "../services/customDomainRules.js";
import {
  constantTimeEqual,
  createCustomDomainRouteTable,
  createDomainRequestCounter,
  createEdgeRewriteUrl,
  EDGE_RESPOND_PATH,
  getEdgeContext,
  type DomainRequestCount,
} from "../services/customDomainRouteTable.js";

// services/customDomainRouteTable.ts - host routing for custom domains. The
// properties under test: a request that did not come through the edge is not
// touched; a request that did is routed by its hostname alone and reaches
// either one fixed canonical route or nothing; and whenever the table cannot
// be trusted, nothing is routed.

const SECRET = "edge-secret-0123456789abcdef0123456789abcdef";

function route(over: Partial<EdgeRoute> = {}): EdgeRoute {
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

function request(
  url: string,
  headers: Record<string, string | string[]> = {},
  method = "POST",
): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

const viaEdge = (host: string, extra: Record<string, string | string[]> = {}) => ({
  "x-wheels-edge-token": SECRET,
  "x-wheels-custom-host": host,
  "x-wheels-edge-proto": "https",
  ...extra,
});

async function loaded(routes: EdgeRoute[] = [route()]) {
  const clock = { now: 1_000_000 };
  const state = { routes, fail: false, loads: 0 };
  const table = createCustomDomainRouteTable({
    load: async () => {
      state.loads += 1;
      if (state.fail) throw new Error("database down");
      return state.routes;
    },
    now: () => clock.now,
    maxStaleMs: 60_000,
  });
  await table.refresh();
  const rewrite = createEdgeRewriteUrl({ table, edgeSecret: SECRET, guardInstalled: () => true });
  return { table, rewrite, clock, state };
}

// ---- the rewrite ----

test("a request without the edge header is not touched, whatever else it carries", async () => {
  const { rewrite } = await loaded();
  for (const req of [
    request("/v1/chat/completions"),
    request("/api/auth/login?next=/x"),
    // The host header alone proves nothing and routes nothing.
    request("/v1/chat/completions", { "x-wheels-custom-host": "api.customer.com", host: "api.customer.com" }),
  ]) {
    const before = req.url;
    assert.equal(rewrite(req), before);
    assert.equal(getEdgeContext(req), undefined);
  }
});

test("a verified, serving hostname is rewritten to its target's canonical route", async () => {
  const { rewrite } = await loaded();
  const req = request("/v1/chat/completions?x=1", viaEdge("api.customer.com"));
  assert.equal(rewrite(req), "/v1/llama-prod/chat/completions?x=1");
  const context = getEdgeContext(req)!;
  assert.equal(context.action.kind, "forward");
  assert.equal(context.host, "api.customer.com");
  assert.equal(context.route!.orgId, "org1");
});

test("the path the client sent never chooses the route", async () => {
  const { rewrite } = await loaded();
  for (const url of ["/api/auth/login", "/v1/other/chat/completions", "/internal/edge/ask", "/health", "/"]) {
    const req = request(url, viaEdge("api.customer.com"));
    assert.equal(rewrite(req), EDGE_RESPOND_PATH, url);
    assert.equal(getEdgeContext(req)!.action.kind, "not_found");
  }
});

test("a wrong token routes nowhere: same length, different length, empty, repeated", async () => {
  const { rewrite } = await loaded();
  const sameLength = SECRET.slice(0, -1) + (SECRET.endsWith("f") ? "e" : "f");
  assert.equal(sameLength.length, SECRET.length);
  for (const token of [sameLength, "short", `${SECRET}x`, "", [SECRET, SECRET]]) {
    const req = request("/v1/chat/completions", { ...viaEdge("api.customer.com"), "x-wheels-edge-token": token });
    assert.equal(rewrite(req), EDGE_RESPOND_PATH, String(token));
    const context = getEdgeContext(req)!;
    assert.equal(context.action.kind, "unrouted");
    assert.equal(context.route, null, "a wrong token learns nothing about the hostname");
  }
});

test("with no edge configured, a request claiming to come from one routes nowhere", async () => {
  const { table } = await loaded();
  const rewrite = createEdgeRewriteUrl({ table, edgeSecret: null, guardInstalled: () => true });
  for (const token of ["", "anything", SECRET]) {
    const req = request("/v1/chat/completions", { ...viaEdge("api.customer.com"), "x-wheels-edge-token": token });
    assert.equal(rewrite(req), EDGE_RESPOND_PATH);
    assert.equal(getEdgeContext(req)!.action.kind, "unrouted");
  }
  // And the canonical host is still untouched.
  assert.equal(rewrite(request("/v1/models")), "/v1/models");
});

test("the hostname is normalised: port, case, trailing dot", async () => {
  const { rewrite } = await loaded();
  for (const host of ["API.Customer.COM", "api.customer.com:443", "api.customer.com.", "Api.Customer.com.:8443"]) {
    const req = request("/v1/chat/completions", viaEdge(host));
    assert.equal(rewrite(req), "/v1/llama-prod/chat/completions", host);
  }
});

test("an unknown, missing or malformed hostname routes nowhere", async () => {
  const { rewrite } = await loaded();
  for (const host of ["other.customer.com", "customer.com", "sub.api.customer.com", "", "10.0.0.1", "api.customer.com/x", ["api.customer.com", "api.customer.com"]]) {
    const req = request("/v1/chat/completions", viaEdge(host as string));
    assert.equal(rewrite(req), EDGE_RESPOND_PATH, String(host));
    assert.equal(getEdgeContext(req)!.action.kind, "unrouted");
  }
  const noHost = request("/v1/chat/completions", { "x-wheels-edge-token": SECRET });
  assert.equal(rewrite(noHost), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(noHost)!.action.kind, "unrouted");
});

test("anything but an explicit https is plain HTTP and is redirected", async () => {
  const { rewrite } = await loaded();
  for (const proto of ["http", "", "ws", ["https", "https"]]) {
    const req = request("/v1/chat/completions", viaEdge("api.customer.com", { "x-wheels-edge-proto": proto }));
    assert.equal(rewrite(req), EDGE_RESPOND_PATH);
    assert.deepEqual(getEdgeContext(req)!.action, {
      kind: "redirect",
      location: "https://api.customer.com/v1/chat/completions",
    });
  }
  const missing = request("/v1/models", { "x-wheels-edge-token": SECRET, "x-wheels-custom-host": "api.customer.com" }, "GET");
  rewrite(missing);
  assert.equal(getEdgeContext(missing)!.action.kind, "redirect");
});

test("a domain that is not serving routes nowhere, but still answers the prober", async () => {
  const { rewrite } = await loaded([route({ serving: false })]);
  const chat = request("/v1/chat/completions", viaEdge("api.customer.com"));
  assert.equal(rewrite(chat), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(chat)!.action.kind, "unrouted");

  const proof = request("/.well-known/wheelsai-domain", viaEdge("api.customer.com"), "GET");
  assert.equal(rewrite(proof), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(proof)!.action.kind, "proof");
  assert.equal(getEdgeContext(proof)!.route!.domainId, "d1");
});

test("nothing is forwarded until the organization guard is installed", async () => {
  const { table } = await loaded();
  let installed = false;
  const rewrite = createEdgeRewriteUrl({ table, edgeSecret: SECRET, guardInstalled: () => installed });
  const before = request("/v1/chat/completions", viaEdge("api.customer.com"));
  assert.equal(rewrite(before), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(before)!.action.kind, "unavailable");

  installed = true;
  assert.equal(rewrite(request("/v1/chat/completions", viaEdge("api.customer.com"))), "/v1/llama-prod/chat/completions");
});

test("the rewrite never throws: a failing lookup is 'unavailable'", () => {
  const rewrite = createEdgeRewriteUrl({
    table: {
      lookup: () => {
        throw new Error("boom");
      },
      refresh: async () => true,
      drop: () => {},
      size: () => 0,
    },
    edgeSecret: SECRET,
    guardInstalled: () => true,
  });
  const req = request("/v1/chat/completions", viaEdge("api.customer.com"));
  assert.equal(rewrite(req), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(req)!.action.kind, "unavailable");
});

test("constantTimeEqual agrees with ===, for any lengths", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("", "a"), false);
});

// ---- the table ----

test("a table that was never loaded routes nothing", () => {
  const table = createCustomDomainRouteTable({ load: async () => [route()] });
  assert.deepEqual(table.lookup("api.customer.com"), { kind: "unavailable" });
  const rewrite = createEdgeRewriteUrl({ table, edgeSecret: SECRET, guardInstalled: () => true });
  const req = request("/v1/chat/completions", viaEdge("api.customer.com"));
  assert.equal(rewrite(req), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(req)!.action.kind, "unavailable");
});

test("a failed refresh keeps the last good table until maxStale, then routes nothing", async () => {
  const { table, clock, state } = await loaded();
  state.fail = true;

  clock.now += 30_000;
  assert.equal(await table.refresh(), false);
  assert.equal(table.lookup("api.customer.com").kind, "hit", "30s old: still trusted");
  assert.equal(table.lookup("nobody.example.com").kind, "miss");

  clock.now += 30_001;
  assert.equal(await table.refresh(), false);
  assert.deepEqual(table.lookup("api.customer.com"), { kind: "unavailable" });
  assert.deepEqual(table.lookup("nobody.example.com"), { kind: "unavailable" }, "unknown is not 'not found' on a stale table");

  // The database is back: the next refresh restores routing.
  state.fail = false;
  assert.equal(await table.refresh(), true);
  assert.equal(table.lookup("api.customer.com").kind, "hit");
});

test("a refresh picks up what changed: new domains, removed domains, paused domains", async () => {
  const { table, state } = await loaded();
  state.routes = [route({ serving: false }), route({ domainId: "d2", domain: "new.customer.com" })];
  await table.refresh();
  const hit = table.lookup("api.customer.com");
  assert.equal(hit.kind === "hit" && hit.route.serving, false);
  assert.equal(table.lookup("new.customer.com").kind, "hit");

  state.routes = [];
  await table.refresh();
  assert.equal(table.lookup("api.customer.com").kind, "miss");
  assert.equal(table.size(), 0);
});

test("drop stops routing a hostname immediately, without waiting for the database", async () => {
  const { table, rewrite } = await loaded();
  table.drop("api.customer.com");
  // Synchronously: no await between the drop and the lookup.
  assert.equal(table.lookup("api.customer.com").kind, "miss");
  const req = request("/v1/chat/completions", viaEdge("api.customer.com"));
  assert.equal(rewrite(req), EDGE_RESPOND_PATH);
  assert.equal(getEdgeContext(req)!.action.kind, "unrouted");
});

test("a reload that started before a drop cannot bring the dropped hostname back", async () => {
  let release: (routes: EdgeRoute[]) => void = () => {};
  const answers: Array<EdgeRoute[] | "wait"> = [[route()], "wait", []];
  const table = createCustomDomainRouteTable({
    load: () => {
      const next = answers.shift()!;
      if (next !== "wait") return Promise.resolve(next);
      return new Promise<EdgeRoute[]>((resolve) => {
        release = resolve;
      });
    },
  });
  await table.refresh();

  const slow = table.refresh(); // reads the database BEFORE the owner's change
  table.drop("api.customer.com"); // the owner disables the domain
  release([route()]); // the slow read still says "serving"
  await slow;

  assert.equal(table.lookup("api.customer.com").kind, "miss");
  assert.equal(answers.length, 0, "the drop asked for one more reload, which read the new state");
});

test("concurrent refreshes share one load", async () => {
  const { table, state } = await loaded();
  const before = state.loads;
  await Promise.all([table.refresh(), table.refresh(), table.refresh()]);
  // One running load, plus one more for the calls that arrived during it.
  assert.equal(state.loads - before, 2);
});

// ---- request counts ----

function counting(failFor: Set<string> = new Set()) {
  const written: DomainRequestCount[] = [];
  const errors: unknown[] = [];
  const counter = createDomainRequestCounter({
    increment: async (entry) => {
      if (failFor.has(entry.domainId)) throw new Error("write failed");
      written.push(entry);
    },
    onError: (error) => errors.push(error),
  });
  return { counter, written, errors, failFor };
}

test("the counter writes exactly what was recorded, as one increment per domain", async () => {
  const { counter, written } = counting();
  const t1 = new Date("2026-10-06T12:00:00Z");
  const t2 = new Date("2026-10-06T12:00:05Z");
  counter.record("d1", t1);
  counter.record("d1", t2);
  counter.record("d2", t1);
  assert.equal(counter.pending(), 3);

  await counter.flush();
  assert.deepEqual(written, [
    { domainId: "d1", count: 2, lastRequestAt: t2 },
    { domainId: "d2", count: 1, lastRequestAt: t1 },
  ]);
  assert.equal(counter.pending(), 0);

  // Nothing recorded, nothing written: a flush never invents a request.
  await counter.flush();
  assert.equal(written.length, 2);
});

test("a count that could not be written is kept and written once, later", async () => {
  const { counter, written, errors, failFor } = counting(new Set(["d1"]));
  const t1 = new Date("2026-10-06T12:00:00Z");
  const t2 = new Date("2026-10-06T12:01:00Z");
  counter.record("d1", t1);
  counter.record("d2", t1);

  await counter.flush(); // never throws
  assert.deepEqual(written, [{ domainId: "d2", count: 1, lastRequestAt: t1 }]);
  assert.equal(errors.length, 1);
  assert.equal(counter.pending(), 1);

  counter.record("d1", t2);
  failFor.clear();
  await counter.flush();
  assert.deepEqual(written[1], { domainId: "d1", count: 2, lastRequestAt: t2 });
  assert.equal(written.length, 2, "d2 was not written a second time");
});

test("requests recorded while a flush is running are not lost", async () => {
  const written: DomainRequestCount[] = [];
  const counter: ReturnType<typeof createDomainRequestCounter> = createDomainRequestCounter({
    increment: async (entry) => {
      // A request arrives while the write is in flight.
      if (written.length === 0) counter.record("d1", new Date("2026-10-06T12:00:09Z"));
      written.push(entry);
    },
  });
  counter.record("d1", new Date("2026-10-06T12:00:00Z"));
  await counter.flush();
  assert.equal(written[0]!.count, 1);
  assert.equal(counter.pending(), 1);
  await counter.flush();
  assert.equal(written[1]!.count, 1);
});

test("the buffer is bounded: beyond the cap new domains are not counted", () => {
  const counter = createDomainRequestCounter({ increment: async () => {}, maxDomains: 2 });
  const at = new Date();
  counter.record("d1", at);
  counter.record("d2", at);
  counter.record("d3", at);
  counter.record("d1", at);
  assert.equal(counter.pending(), 3);
});
