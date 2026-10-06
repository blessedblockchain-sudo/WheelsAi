import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE config/nosanaDeploy (cached) and config/env are first imported.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.ALLOW_LOOPBACK_NODE_URLS = "true";

// The opt-in half of review finding 11: with BOTH a development process and
// ALLOW_LOOPBACK_NODE_URLS=true, a local model server can stand in for a node.
// (The opt-out default is covered in nosanaClient.unit.test.ts.)

test("development + ALLOW_LOOPBACK_NODE_URLS=true lets the health probe reach localhost", async () => {
  const { NosanaClient, nodeUrlAllowlistOptions } = await import("../services/nosana.js");
  assert.deepEqual(nodeUrlAllowlistOptions(), { allowLoopback: true });

  const client = new NosanaClient();
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(url);
    return new Response("ok", { status: 200 });
  }) as never;
  try {
    assert.equal((await client.checkNodeHealth("http://localhost:8000", "vllm")).healthy, true);
    assert.equal((await client.checkNodeHealth("http://127.0.0.1:11434", "ollama")).healthy, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, ["http://localhost:8000/health", "http://127.0.0.1:11434/api/tags"]);
});

test("the opt-in still does not open lookalikes or private ranges", async () => {
  const { isAllowedNodeUrl } = await import("../services/nodeUrlAllowlist.js");
  const { nodeUrlAllowlistOptions } = await import("../services/nosana.js");
  const opts = nodeUrlAllowlistOptions();
  for (const url of ["http://localhost@evil.com", "http://127.0.0.1.evil.com", "http://10.0.0.1", "http://169.254.169.254"]) {
    assert.equal(isAllowedNodeUrl(url, opts), false, url);
  }
});
