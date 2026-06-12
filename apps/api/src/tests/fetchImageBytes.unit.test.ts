import assert from "node:assert/strict";
import test from "node:test";

import { fetchImageBytes } from "../services/fetchImageBytes.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngResponse(headers: Record<string, string> = {}): Response {
  return new Response(PNG, {
    status: 200,
    headers: { "content-type": "image/png", ...headers },
  });
}

test("returns bytes + mime + filename for a valid png", async () => {
  const out = await fetchImageBytes("https://cdn.example.com/icon.png", {
    fetchFn: async () => pngResponse(),
  });
  assert.deepEqual([...out.bytes], [...PNG]);
  assert.equal(out.mime, "image/png");
  assert.equal(out.filename, "icon.png");
});

test("infers mime from the URL extension when content-type is generic", async () => {
  const out = await fetchImageBytes("https://cdn.example.com/a/icon.webp", {
    fetchFn: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
  });
  assert.equal(out.mime, "image/webp");
  assert.equal(out.filename, "icon.webp");
});

test("rejects an unsupported image type", async () => {
  await assert.rejects(
    fetchImageBytes("https://cdn.example.com/icon", {
      fetchFn: async () =>
        new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
    }),
    /unsupported image type/,
  );
});

test("rejects a non-2xx response", async () => {
  await assert.rejects(
    fetchImageBytes("https://cdn.example.com/missing.png", {
      fetchFn: async () => new Response("nope", { status: 404 }),
    }),
    /returned 404/,
  );
});

test("enforces the size cap", async () => {
  const big = new Uint8Array(1024);
  await assert.rejects(
    fetchImageBytes(
      "https://cdn.example.com/big.png",
      { fetchFn: async () => new Response(big, { headers: { "content-type": "image/png" } }) },
      { maxBytes: 512 },
    ),
    /exceeds 512b cap/,
  );
});

test("rejects an empty url", async () => {
  await assert.rejects(
    fetchImageBytes("", { fetchFn: async () => pngResponse() }),
    /url is required/,
  );
});
