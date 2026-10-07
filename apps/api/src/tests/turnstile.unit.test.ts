import assert from "node:assert/strict";
import test from "node:test";

import { TURNSTILE_VERIFY_URL, verifyTurnstile, type TurnstileInput } from "../services/turnstile.js";

// Drives services/turnstile.ts with an injected fetch. It fails closed: only
// Cloudflare's own "success" for this action, site and listing is a pass.

const SECRET = "0x4AAAAAAA-turnstile-secret";

const input = (over: Partial<TurnstileInput> = {}): TurnstileInput => ({
  token: "tok_abc",
  remoteIp: "203.0.113.7",
  expectedAction: "try_it",
  expectedHostname: "app.wheelsai.test",
  expectedCdata: "listing-1",
  ...over,
});

const GOOD = { success: true, action: "try_it", hostname: "app.wheelsai.test", cdata: "listing-1" };

function fetchOf(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("posts secret, response and remoteip form-encoded to siteverify, and passes a good token", async () => {
  const { fetchImpl, calls } = fetchOf(() => json(GOOD));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl }), { status: "ok" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, TURNSTILE_VERIFY_URL);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0]!.init.redirect, "error");
  const form = new URLSearchParams(String(calls[0]!.init.body));
  assert.deepEqual(Object.fromEntries(form), { secret: SECRET, response: "tok_abc", remoteip: "203.0.113.7" });
});

test("no token is 'required', and nothing is asked of Cloudflare", async () => {
  for (const token of [undefined, null, "", "   "]) {
    const { fetchImpl, calls } = fetchOf(() => json(GOOD));
    assert.deepEqual(await verifyTurnstile(input({ token }), { secret: SECRET, fetchImpl }), { status: "required" });
    assert.equal(calls.length, 0);
  }
  const { fetchImpl, calls } = fetchOf(() => json(GOOD));
  const huge = await verifyTurnstile(input({ token: "x".repeat(3000) }), { secret: SECRET, fetchImpl });
  assert.equal(huge.status, "failed");
  assert.equal(calls.length, 0);
});

test("success:false is 'failed' with Cloudflare's codes", async () => {
  const { fetchImpl } = fetchOf(() => json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl }), {
    status: "failed",
    codes: ["timeout-or-duplicate"],
  });
  const bare = fetchOf(() => json({ success: false }));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: bare.fetchImpl }), {
    status: "failed",
    codes: ["verification-failed"],
  });
});

test("a real token for another action, site or listing is 'failed'", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...GOOD, action: "login" }, "action-mismatch"],
    [{ ...GOOD, action: undefined }, "action-mismatch"],
    [{ ...GOOD, hostname: "evil.test" }, "hostname-mismatch"],
    [{ ...GOOD, hostname: undefined }, "hostname-mismatch"],
    [{ ...GOOD, cdata: "listing-2" }, "cdata-mismatch"],
    [{ ...GOOD, cdata: undefined }, "cdata-mismatch"],
  ];
  for (const [body, code] of cases) {
    const { fetchImpl } = fetchOf(() => json(body));
    assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl }), { status: "failed", codes: [code] });
  }
  // The hostname compares case-insensitively; nothing else is loosened.
  const upper = fetchOf(() => json({ ...GOOD, hostname: "APP.WheelsAI.test" }));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: upper.fetchImpl }), { status: "ok" });
});

test("a check that could not be made is 'unavailable', never a pass", async () => {
  const thrown = fetchOf(() => {
    throw new Error(`connect ECONNREFUSED (secret=${SECRET})`);
  });
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: thrown.fetchImpl }), {
    status: "unavailable",
    reason: "network",
  });

  const fiveHundred = fetchOf(() => json(GOOD, 503));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: fiveHundred.fetchImpl }), {
    status: "unavailable",
    reason: "upstream_error",
  });

  const notJson = fetchOf(() => new Response("<html>oops</html>", { status: 200 }));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: notJson.fetchImpl }), {
    status: "unavailable",
    reason: "bad_response",
  });

  for (const body of [null, [], "true", { success: "true" }, {}]) {
    const odd = fetchOf(() => json(body));
    const result = await verifyTurnstile(input(), { secret: SECRET, fetchImpl: odd.fetchImpl });
    assert.deepEqual(result, { status: "unavailable", reason: "bad_response" }, JSON.stringify(body));
  }

  const internal = fetchOf(() => json({ success: false, "error-codes": ["internal-error"] }));
  assert.deepEqual(await verifyTurnstile(input(), { secret: SECRET, fetchImpl: internal.fetchImpl }), {
    status: "unavailable",
    reason: "upstream_error",
  });
});

test("a siteverify that hangs times out as 'unavailable'", async () => {
  const hung = fetchOf(
    (_url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  // AbortSignal.timeout does not hold the event loop open; a server's
  // sockets do, and here this timer does.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const result = await verifyTurnstile(input(), { secret: SECRET, fetchImpl: hung.fetchImpl, timeoutMs: 20 });
    assert.deepEqual(result, { status: "unavailable", reason: "timeout" });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the secret appears in no result", async () => {
  const responders = [
    () => json(GOOD),
    () => json({ success: false, "error-codes": ["invalid-input-secret", SECRET] }),
    () => {
      throw new Error(SECRET);
    },
    () => new Response(SECRET, { status: 200 }),
  ];
  for (const respond of responders) {
    const { fetchImpl } = fetchOf(respond as never);
    const result = await verifyTurnstile(input(), { secret: SECRET, fetchImpl });
    if (result.status === "failed") {
      // Cloudflare's codes are passed on as they are; ours never add the secret.
      assert.ok(result.codes.includes("invalid-input-secret"));
      continue;
    }
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});
