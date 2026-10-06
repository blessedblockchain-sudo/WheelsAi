import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { buildUptimeProberTickDeps } from "../services/buildUptimeProberTickDeps.js";
import type { DueMonitorRow } from "../services/runUptimeProberTick.js";

// Custom-URL uptime monitors are user input. These pin that a monitor can
// neither reach nor read internal addresses, and that what it reports does
// not name the address a host resolved to.

function monitor(over: Partial<DueMonitorRow> = {}): DueMonitorRow {
  return {
    id: "mon_1",
    targetType: "custom_url",
    targetId: null,
    targetUrl: "https://status.example.com/health",
    timeoutSeconds: 5,
    httpMethod: "GET",
    expectedStatus: 200,
    expectedBody: null,
    headers: null,
    ...over,
  };
}

test("a monitor pointed at a loopback service is refused before any request is made", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("internal secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const deps = buildUptimeProberTickDeps();
    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://localhost:${port}/`,
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const outcome = await deps.probe(monitor({ targetUrl: url, expectedBody: "secret" }), url);
      assert.equal(outcome.status, "error", url);
      assert.match(outcome.errorMessage ?? "", /blocked outbound request/, url);
      assert.doesNotMatch(outcome.errorMessage ?? "", /127\.0\.0\.1|169\.254|::ffff/, url);
    }
    assert.equal(hits, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a public target is probed, with routing headers stripped and the body check applied", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("all systems operational", { status: 200 });
  }) as unknown as typeof fetch;
  const deps = buildUptimeProberTickDeps({
    fetchFn,
    guardDeps: { resolveHost: async () => ["93.184.216.34"] },
  });

  const up = await deps.probe(
    monitor({ expectedBody: "operational", headers: { Host: "internal.svc", "X-Check": "1" } }),
    "https://status.example.com/health",
  );
  assert.equal(up.status, "up");
  assert.equal(seen.length, 1);
  const names = Object.keys(seen[0]!.headers).map((h) => h.toLowerCase());
  assert.ok(names.includes("x-check"));
  assert.ok(!names.includes("host"));

  const down = await deps.probe(monitor({ expectedBody: "degraded" }), "https://status.example.com/health");
  assert.equal(down.status, "down");
});
