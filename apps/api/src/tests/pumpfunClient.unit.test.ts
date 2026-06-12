import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/pumpfun.ts — the hardened PumpFunClient
// HTTP layer (plan D7):
//
//   - AbortController timeout per attempt
//   - retry-with-jitter on 5xx and network/timeout failures
//   - 429 honors Retry-After when present
//   - non-retryable 4xx → immediate throw
//   - getTokenTrades / getTokenHolders THROW on upstream failure — an
//     outage must never be indistinguishable from "no trades" (the old
//     code swallowed everything into [], silently under-routing fees)
//   - getTokenInfo still returns null on failure (best-effort surface)
//
// fetch / sleep / random are all injected so the suite is deterministic
// and never sleeps for real.

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(opts: {
  responses?: Array<Response | Error>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  setupEnv();
  const fetchCalls: Array<{ url: string }> = [];
  const sleeps: number[] = [];
  const queue = [...(opts.responses ?? [])];

  const fetchFn: typeof fetch =
    opts.fetchFn ??
    (async (url) => {
      fetchCalls.push({ url: String(url) });
      const next = queue.shift();
      if (!next) throw new Error("test fetch queue exhausted");
      if (next instanceof Error) throw next;
      return next;
    });

  // Count fetches even when a custom fetchFn is provided.
  const countingFetch: typeof fetch = async (url, init) => {
    if (opts.fetchFn) fetchCalls.push({ url: String(url) });
    return fetchFn(url, init);
  };

  return {
    fetchCalls,
    sleeps,
    clientPromise: import("../services/pumpfun.js").then(
      ({ PumpFunClient }) =>
        new PumpFunClient({
          fetchFn: countingFetch,
          timeoutMs: opts.timeoutMs ?? 10_000,
          maxRetries: opts.maxRetries ?? 2,
          retryBaseMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 0, // deterministic jitter
        }),
    ),
  };
}

// ============================================
// Success path unchanged
// ============================================

test("PumpFunClient.getTokenTrades returns parsed trades on 200", async () => {
  const trades = [
    {
      txSignature: "sig1",
      traderAddress: "T1",
      side: "buy",
      solAmount: 1,
      tokenAmount: 100,
      priceUsd: 0.01,
      timestamp: "2026-06-01T00:00:00Z",
    },
  ];
  const { clientPromise, fetchCalls } = makeClient({
    responses: [jsonResponse({ trades })],
  });
  const client = await clientPromise;
  const result = await client.getTokenTrades("Mint1", 50, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.txSignature, "sig1");
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]!.url, /limit=50&offset=0/);
});

// ============================================
// 5xx → retry with backoff, then throw
// ============================================

test("PumpFunClient retries 5xx and succeeds on a later attempt", async () => {
  const { clientPromise, fetchCalls, sleeps } = makeClient({
    responses: [
      new Response("oops", { status: 502 }),
      jsonResponse({ holders: [{ walletAddress: "W", balance: 1, percentage: 100 }] }),
    ],
  });
  const client = await clientPromise;
  const holders = await client.getTokenHolders("Mint1");
  assert.equal(holders.length, 1);
  assert.equal(fetchCalls.length, 2);
  assert.equal(sleeps.length, 1); // one backoff between the attempts
});

test("PumpFunClient throws PumpFunApiError after exhausting 5xx retries", async () => {
  const { clientPromise, fetchCalls, sleeps } = makeClient({
    maxRetries: 2,
    responses: [
      new Response("", { status: 500 }),
      new Response("", { status: 500 }),
      new Response("", { status: 500 }),
    ],
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenTrades("Mint1"),
    (err: unknown) =>
      err instanceof PumpFunApiError && err.status === 500,
  );
  assert.equal(fetchCalls.length, 3); // maxRetries=2 → 3 attempts total
  assert.equal(sleeps.length, 2);
});

test("PumpFunClient backoff grows exponentially with deterministic jitter", async () => {
  const { clientPromise, sleeps } = makeClient({
    maxRetries: 2,
    responses: [
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      jsonResponse({ trades: [] }),
    ],
  });
  const client = await clientPromise;
  await client.getTokenTrades("Mint1");
  // retryBaseMs=100, random()=0: attempt0 → 100, attempt1 → 200.
  assert.deepEqual(sleeps, [100, 200]);
});

// ============================================
// 429 → Retry-After honored
// ============================================

test("PumpFunClient honors Retry-After (delta-seconds) on 429", async () => {
  const { clientPromise, sleeps } = makeClient({
    responses: [
      new Response("", { status: 429, headers: { "retry-after": "7" } }),
      jsonResponse({ trades: [] }),
    ],
  });
  const client = await clientPromise;
  await client.getTokenTrades("Mint1");
  assert.deepEqual(sleeps, [7000]);
});

test("PumpFunClient falls back to backoff when 429 has no Retry-After", async () => {
  const { clientPromise, sleeps } = makeClient({
    responses: [
      new Response("", { status: 429 }),
      jsonResponse({ trades: [] }),
    ],
  });
  const client = await clientPromise;
  await client.getTokenTrades("Mint1");
  assert.deepEqual(sleeps, [100]); // backoff(attempt=0) with zero jitter
});

test("PumpFunClient throws after exhausting 429 retries", async () => {
  const { clientPromise } = makeClient({
    maxRetries: 1,
    responses: [
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ],
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenHolders("Mint1"),
    (err: unknown) =>
      err instanceof PumpFunApiError && err.status === 429,
  );
});

// ============================================
// Non-retryable 4xx → immediate throw
// ============================================

test("PumpFunClient does NOT retry a 404 — one attempt, immediate throw", async () => {
  const { clientPromise, fetchCalls, sleeps } = makeClient({
    responses: [new Response("not found", { status: 404 })],
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenTrades("MintMissing"),
    (err: unknown) =>
      err instanceof PumpFunApiError && err.status === 404,
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(sleeps.length, 0);
});

// ============================================
// Network failure → retry, then throw with undefined status
// ============================================

test("PumpFunClient retries network errors then throws transport-level PumpFunApiError", async () => {
  const { clientPromise, fetchCalls } = makeClient({
    maxRetries: 1,
    responses: [new Error("ECONNRESET"), new Error("ECONNRESET")],
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenTrades("Mint1"),
    (err: unknown) =>
      err instanceof PumpFunApiError && err.status === undefined,
  );
  assert.equal(fetchCalls.length, 2);
});

// ============================================
// Timeout — the AbortController fires and the attempt is aborted
// ============================================

test("PumpFunClient aborts a hung request via the per-attempt timeout", async () => {
  // fetchFn never resolves on its own; it only rejects when the
  // client's AbortController fires. timeoutMs=5 keeps the test fast —
  // the abort timer is the real production mechanism, not a stub.
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () =>
        reject(new Error("operation aborted")),
      );
    });
  const { clientPromise } = makeClient({
    fetchFn: hangingFetch,
    timeoutMs: 5,
    maxRetries: 0,
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenTrades("Mint1"),
    (err: unknown) =>
      err instanceof PumpFunApiError &&
      err.status === undefined &&
      /aborted/.test(err.message),
  );
});

// ============================================
// Money-path methods throw; info path stays best-effort
// ============================================

test("getTokenTrades and getTokenHolders THROW on upstream failure (no silent [])", async () => {
  // The legacy client swallowed failures into [] — fee routing then
  // treated an outage as "no trades" and permanently skipped volume.
  const make = () =>
    makeClient({ maxRetries: 0, responses: [new Response("", { status: 500 })] });

  const a = await make().clientPromise;
  await assert.rejects(a.getTokenTrades("Mint1"));

  const b = await make().clientPromise;
  await assert.rejects(b.getTokenHolders("Mint1"));
});

test("getTokenInfo returns null on upstream failure (best-effort stats surface)", async () => {
  const { clientPromise } = makeClient({
    maxRetries: 0,
    responses: [new Response("", { status: 500 })],
  });
  const client = await clientPromise;
  assert.equal(await client.getTokenInfo("Mint1"), null);
});

test("PumpFunClient throws on invalid JSON in an OK response", async () => {
  const { clientPromise } = makeClient({
    responses: [new Response("<html>gateway</html>", { status: 200 })],
  });
  const client = await clientPromise;
  const { PumpFunApiError } = await import("../services/pumpfun.js");
  await assert.rejects(
    client.getTokenTrades("Mint1"),
    (err: unknown) => err instanceof PumpFunApiError,
  );
});
