import assert from "node:assert/strict";
import test from "node:test";

import {
  assertUrlAllowed,
  classifyIp,
  safeFetch,
  SsrfBlockedError,
} from "../lib/ssrfGuard.js";

// Drives apps/api/src/lib/ssrfGuard.ts. The guard this replaced compared
// HOSTNAMES against a short blocklist, which three things walked past:
// DNS (a public name resolving to 127.0.0.1), encodings
// (http://2130706433/), and redirects (a public URL 302ing inward).
// Each of those is a test below.

// ============================================
// IP classification
// ============================================

test("loopback is blocked in every encoding, not just 127.0.0.1", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.equal(classifyIp(ip), "blocked", ip);
  }
  assert.equal(classifyIp("::1"), "blocked", "IPv6 loopback");
  assert.equal(classifyIp("::ffff:127.0.0.1"), "blocked", "IPv4-mapped loopback");
});

test("cloud metadata and link-local are blocked", () => {
  assert.equal(classifyIp("169.254.169.254"), "blocked", "AWS/GCP metadata");
  assert.equal(classifyIp("169.254.0.1"), "blocked");
  assert.equal(classifyIp("fe80::1"), "blocked", "IPv6 link-local");
});

test("private ranges are blocked, including CGNAT", () => {
  for (const ip of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "fc00::1",
    "fd12:3456::1",
  ]) {
    assert.equal(classifyIp(ip), "blocked", ip);
  }
});

test("the old check's over-block is corrected: 172.32+ is public", () => {
  // The previous guard used hostname.startsWith("172."), blocking the
  // whole /8 — 172.32.0.0+ is ordinary public space.
  assert.equal(classifyIp("172.32.0.1"), "public");
  assert.equal(classifyIp("172.15.255.255"), "public");
});

test("ordinary public addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(classifyIp(ip), "public", ip);
  }
});

test("multicast and reserved space is blocked", () => {
  assert.equal(classifyIp("224.0.0.1"), "blocked");
  assert.equal(classifyIp("255.255.255.255"), "blocked");
  assert.equal(classifyIp("ff02::1"), "blocked");
});

// ============================================
// URL validation
// ============================================

const publicDns = async () => ["93.184.216.34"];

test("non-http schemes are refused — file:// is a classic escalation", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
    const verdict = await assertUrlAllowed(url, { resolveHost: publicDns });
    assert.equal(verdict.ok, false, url);
  }
});

test("embedded credentials are refused", async () => {
  const verdict = await assertUrlAllowed("http://user:pass@example.com/", {
    resolveHost: publicDns,
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /credentials/);
});

test("THE DNS BYPASS: a public hostname resolving to loopback is refused", async () => {
  // This is the bypass the hostname-only guard could not see.
  const verdict = await assertUrlAllowed("http://totally-innocent.com/", {
    resolveHost: async () => ["127.0.0.1"],
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /127\.0\.0\.1/);
});

test("a hostname with ANY internal address is refused, even alongside public ones", async () => {
  // We cannot control which record the socket picks, so one bad answer
  // poisons the name.
  const verdict = await assertUrlAllowed("http://split-horizon.com/", {
    resolveHost: async () => ["93.184.216.34", "10.0.0.5"],
  });
  assert.equal(verdict.ok, false);
});

test("THE ENCODING BYPASS: integer and short-form loopback literals are refused", async () => {
  // http://127.1/ is loopback; a prefix check for "127.0.0.1" misses it.
  const short = await assertUrlAllowed("http://127.1/", { resolveHost: publicDns });
  assert.equal(short.ok, false);
  const v6 = await assertUrlAllowed("http://[::1]/", { resolveHost: publicDns });
  assert.equal(v6.ok, false, "bracketed IPv6 loopback");
});

test("localhost and metadata hostnames are refused without DNS", async () => {
  for (const host of [
    "http://localhost:6379/",
    "http://metadata.google.internal/",
    "http://app.localhost/",
  ]) {
    const verdict = await assertUrlAllowed(host, {
      resolveHost: async () => {
        throw new Error("DNS must not be consulted for known-internal names");
      },
    });
    assert.equal(verdict.ok, false, host);
  }
});

test("an unresolvable host is refused rather than attempted", async () => {
  const verdict = await assertUrlAllowed("http://nope.invalid/", {
    resolveHost: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(verdict.ok, false);
});

test("a genuinely public URL is allowed", async () => {
  const verdict = await assertUrlAllowed("https://example.com/webhook", {
    resolveHost: publicDns,
  });
  assert.equal(verdict.ok, true);
});

// ============================================
// safeFetch — redirects
// ============================================

function jsonOk(body = "ok"): Response {
  return new Response(body, { status: 200 });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

test("safeFetch never auto-follows: redirect mode is manual", async () => {
  let sawInit: RequestInit | undefined;
  await safeFetch("https://example.com/", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (_u: string, init: RequestInit) => {
      sawInit = init;
      return jsonOk();
    }) as unknown as typeof fetch,
  });
  assert.equal(sawInit?.redirect, "manual");
});

test("THE REDIRECT BYPASS: a public URL 302ing to metadata is blocked at the hop", async () => {
  let hops = 0;
  await assert.rejects(
    safeFetch("https://example.com/", {
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () => {
        hops += 1;
        return redirectTo("http://169.254.169.254/latest/meta-data/");
      }) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof SsrfBlockedError &&
      /169\.254\.169\.254/.test(err.detail) &&
      !/169\.254/.test(err.message),
  );
  assert.equal(hops, 1, "the internal hop was never actually requested");
});

test("a redirect to another public URL is followed and re-validated", async () => {
  const requested: string[] = [];
  const res = await safeFetch("https://example.com/a", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (u: string) => {
      requested.push(u);
      return requested.length === 1
        ? redirectTo("https://example.com/b")
        : jsonOk("final");
    }) as unknown as typeof fetch,
  });
  assert.equal(await res.text(), "final");
  assert.deepEqual(requested, ["https://example.com/a", "https://example.com/b"]);
});

test("a redirect loop is capped rather than spinning", async () => {
  await assert.rejects(
    safeFetch("https://example.com/", {
      maxRedirects: 2,
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () =>
        redirectTo("https://example.com/again")) as unknown as typeof fetch,
    }),
    /too many redirects/,
  );
});

test("a relative redirect is resolved against the current URL before validation", async () => {
  const requested: string[] = [];
  await safeFetch("https://example.com/a/b", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (u: string) => {
      requested.push(u);
      return requested.length === 1 ? redirectTo("/c") : jsonOk();
    }) as unknown as typeof fetch,
  });
  assert.equal(requested[1], "https://example.com/c");
});

// ============================================
// Caller cancellation (signal)
// ============================================

test("an already-aborted signal stops safeFetch before any request is made", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    safeFetch("https://example.com/", {
      signal: controller.signal,
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () => {
        called = true;
        return jsonOk();
      }) as unknown as typeof fetch,
    }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
  assert.equal(called, false);
});

test("the caller's signal is passed to fetch, combined with the timeout", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  await safeFetch("https://example.com/", {
    signal: controller.signal,
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (_u: string, init: RequestInit) => {
      received = init.signal as AbortSignal;
      return jsonOk();
    }) as unknown as typeof fetch,
  });
  assert.ok(received);
  assert.equal(received!.aborted, false);
  controller.abort();
  assert.equal(received!.aborted, true, "aborting the caller's signal aborts the in-flight request");
});

// ============================================
// THE IPv6 BYPASS: the URL parser normalises bracketed literals
// ============================================
//
// `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`. The
// old classifier only unwrapped the DOTTED form, so the hex form the parser
// actually produces was classed public and reached loopback-only services.
// These drive the whole URL path, not just classifyIp on hand-written text.

const EMBEDDED_INTERNAL_V6 = [
  // IPv4-mapped, written both ways (the parser turns the first into the second)
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "::ffff:10.0.0.1",
  "::ffff:c0a8:101",
  "0:0:0:0:0:ffff:7f00:1",
  // NAT64 well-known prefix
  "64:ff9b::a9fe:a9fe",
  "64:ff9b::169.254.169.254",
  "64:ff9b::7f00:1",
  // IPv4-compatible (deprecated) and the rest of ::/96
  "::7f00:1",
  "::127.0.0.1",
  "::a9fe:a9fe",
  // IPv4-translated (SIIT)
  "::ffff:0:7f00:1",
  "::ffff:0:a9fe:a9fe",
  // 6to4: 2002:<IPv4>::/48
  "2002:7f00:1::",
  "2002:7f00:1::1",
  "2002:a9fe:a9fe::1",
  "2002:c0a8:101::1",
  // local-use NAT64, Teredo, documentation, discard
  "64:ff9b:1::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "2001:db8::1",
  "100::1",
  // site-local (deprecated) and zoned link-local
  "fec0::1",
  "fe80::1%eth0",
];

test("IPv6 forms that carry an internal IPv4 address are blocked, in every spelling", () => {
  for (const ip of EMBEDDED_INTERNAL_V6) {
    assert.equal(classifyIp(ip), "blocked", ip);
  }
  assert.equal(classifyIp("::"), "blocked");
  assert.equal(classifyIp("::1"), "blocked");
});

test("the same wrappers around a PUBLIC IPv4 address stay public (no over-blocking)", () => {
  for (const ip of [
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "::ffff:0:808:808",
    "2606:4700::1111",
    "2a00:1450:4001:81b::200e",
  ]) {
    assert.equal(classifyIp(ip), "public", ip);
  }
});

test("URL level: every bracketed internal literal is refused by assertUrlAllowed", async () => {
  for (const ip of EMBEDDED_INTERNAL_V6.filter((i) => !i.includes("%"))) {
    const verdict = await assertUrlAllowed(`http://[${ip}]:8080/`, { resolveHost: publicDns });
    assert.equal(verdict.ok, false, `http://[${ip}]:8080/`);
  }
  const ok = await assertUrlAllowed("http://[::ffff:8.8.8.8]/", { resolveHost: publicDns });
  assert.equal(ok.ok, true);
});

test("a hostname whose DNS answer is an IPv4-mapped hex address is refused", async () => {
  const verdict = await assertUrlAllowed("http://innocent.example/", {
    resolveHost: async () => ["::ffff:7f00:1"],
  });
  assert.equal(verdict.ok, false);
});

test("safeFetch never reaches a loopback-only server through [::ffff:127.0.0.1]", async () => {
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("internal secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::"]) {
      // The REAL fetch: if the guard let it through, the server would see it.
      await assert.rejects(
        safeFetch(`http://[${host}]:${port}/`, { timeoutMs: 1_000 }),
        SsrfBlockedError,
        host,
      );
    }
    assert.equal(hits, 0, "the loopback server was never contacted");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================
// Redirect hygiene: credentials, method and body
// ============================================

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripts a chain of responses and records what each hop was sent. */
function redirectChain(responses: Array<Response | (() => Response)>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      method: String(init.method),
      headers: { ...((init.headers as Record<string, string>) ?? {}) },
      body: init.body as string | undefined,
    });
    const next = responses[seen.length - 1];
    if (!next) throw new Error("more hops than scripted");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

const CREDENTIALS = {
  Authorization: "Bearer secret",
  Cookie: "session=abc",
  "Proxy-Authorization": "Basic xyz",
  "X-Api-Key": "key-123",
  "x-auth-token": "tok",
  Accept: "application/json",
  "Content-Type": "application/json",
};

test("a cross-origin redirect drops Authorization, Cookie and every caller-supplied credential", async () => {
  const chain = redirectChain([redirect(302, "https://other.example.net/next"), jsonOk()]);
  await safeFetch("https://api.example.com/start", {
    method: "GET",
    headers: CREDENTIALS,
    guardDeps: { resolveHost: publicDns },
    fetchImpl: chain.fetchImpl,
  });
  assert.equal(chain.seen[0]!.headers.Authorization, "Bearer secret", "the first hop carries them");
  const second = chain.seen[1]!.headers;
  assert.deepEqual(Object.keys(second).sort(), ["Accept", "Content-Type"].sort());
});

test("a change of port or scheme is a different origin too", async () => {
  for (const location of ["https://api.example.com:8443/x", "http://api.example.com/x"]) {
    const chain = redirectChain([redirect(302, location), jsonOk()]);
    await safeFetch("https://api.example.com/start", {
      headers: { Authorization: "Bearer secret", Cookie: "s=1" },
      guardDeps: { resolveHost: publicDns },
      fetchImpl: chain.fetchImpl,
    });
    assert.deepEqual(chain.seen[1]!.headers, {}, location);
  }
});

test("a same-origin redirect keeps the caller's headers", async () => {
  const chain = redirectChain([redirect(302, "/elsewhere"), jsonOk()]);
  await safeFetch("https://api.example.com/start", {
    headers: { Authorization: "Bearer secret" },
    guardDeps: { resolveHost: publicDns },
    fetchImpl: chain.fetchImpl,
  });
  assert.equal(chain.seen[1]!.headers.Authorization, "Bearer secret");
});

test("303, and 301/302 after POST, become a bodiless GET", async () => {
  for (const status of [301, 302, 303]) {
    const chain = redirectChain([redirect(status, "/done"), jsonOk()]);
    await safeFetch("https://api.example.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: '{"a":1}',
      guardDeps: { resolveHost: publicDns },
      fetchImpl: chain.fetchImpl,
    });
    assert.equal(chain.seen[0]!.method, "POST");
    assert.equal(chain.seen[1]!.method, "GET", String(status));
    assert.equal(chain.seen[1]!.body, undefined, `${status}: body dropped`);
    assert.equal(chain.seen[1]!.headers["Content-Type"], undefined, `${status}: no Content-Type without a body`);
    assert.equal(chain.seen[1]!.headers.Authorization, "Bearer t", "same origin keeps credentials");
  }
  // 303 after PUT is a GET as well; HEAD stays HEAD.
  const put = redirectChain([redirect(303, "/done"), jsonOk()]);
  await safeFetch("https://a.example/x", { method: "PUT", body: "x", guardDeps: { resolveHost: publicDns }, fetchImpl: put.fetchImpl });
  assert.equal(put.seen[1]!.method, "GET");
  const head = redirectChain([redirect(303, "/done"), jsonOk()]);
  await safeFetch("https://a.example/x", { method: "HEAD", guardDeps: { resolveHost: publicDns }, fetchImpl: head.fetchImpl });
  assert.equal(head.seen[1]!.method, "HEAD");
});

test("307/308 keep the method and body same-origin, but never resend a body cross-origin", async () => {
  const same = redirectChain([redirect(307, "/retry"), jsonOk()]);
  await safeFetch("https://api.example.com/submit", {
    method: "POST",
    body: '{"a":1}',
    guardDeps: { resolveHost: publicDns },
    fetchImpl: same.fetchImpl,
  });
  assert.equal(same.seen[1]!.method, "POST");
  assert.equal(same.seen[1]!.body, '{"a":1}');

  for (const status of [307, 308]) {
    const cross = redirectChain([redirect(status, "https://other.example.net/steal"), jsonOk()]);
    await assert.rejects(
      safeFetch("https://api.example.com/submit", {
        method: "POST",
        body: '{"secret":1}',
        guardDeps: { resolveHost: publicDns },
        fetchImpl: cross.fetchImpl,
      }),
      /would resend the request body/,
    );
    assert.equal(cross.seen.length, 1, "the body was never sent to the second origin");
  }

  // A bodiless 307 across origins is fine - with the credentials stripped.
  const bodiless = redirectChain([redirect(307, "https://other.example.net/x"), jsonOk()]);
  await safeFetch("https://api.example.com/get", {
    headers: { Authorization: "Bearer t", Accept: "text/plain" },
    guardDeps: { resolveHost: publicDns },
    fetchImpl: bodiless.fetchImpl,
  });
  assert.deepEqual(bodiless.seen[1]!.headers, { Accept: "text/plain" });
});

test("header names are matched case-insensitively when stripping", async () => {
  const chain = redirectChain([redirect(302, "https://other.example.net/"), jsonOk()]);
  await safeFetch("https://api.example.com/", {
    headers: { aUtHoRiZaTiOn: "x", COOKIE: "y", ACCEPT: "z" },
    guardDeps: { resolveHost: publicDns },
    fetchImpl: chain.fetchImpl,
  });
  assert.deepEqual(chain.seen[1]!.headers, { ACCEPT: "z" });
});

test("a redirect into the internal network is still refused after the header logic", async () => {
  const chain = redirectChain([redirect(302, "http://[::ffff:a9fe:a9fe]/latest/meta-data/"), jsonOk()]);
  await assert.rejects(
    safeFetch("https://api.example.com/", {
      guardDeps: { resolveHost: publicDns },
      fetchImpl: chain.fetchImpl,
    }),
    SsrfBlockedError,
  );
  assert.equal(chain.seen.length, 1);
});

// ============================================
// The error text is safe by default
// ============================================

test("SsrfBlockedError.message never carries the resolved address; `detail` does, for logs", async () => {
  const err = await safeFetch("http://redis.corp.internal/", {
    guardDeps: { resolveHost: async () => ["10.0.3.7"] },
    fetchImpl: (async () => jsonOk()) as unknown as typeof fetch,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SsrfBlockedError);
  // Every way a caller might surface the error without thinking about it.
  for (const surfaced of [err.message, String(err), err.publicMessage, err.stack ?? ""]) {
    assert.ok(!surfaced.includes("10.0.3.7"), surfaced);
  }
  assert.match(err.detail, /resolves to 10\.0\.3\.7/);
});

test("a host that does not resolve reads the same as one that resolves internally (no DNS oracle)", async () => {
  const refuse = (resolveHost: () => Promise<string[]>) =>
    safeFetch("http://some-host.corp.internal/", {
      guardDeps: { resolveHost },
      fetchImpl: (async () => jsonOk()) as unknown as typeof fetch,
    }).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
  const internal = await refuse(async () => ["10.0.3.7"]);
  const missing = await refuse(async () => {
    throw new Error("ENOTFOUND");
  });
  assert.ok(internal.length > 0);
  assert.equal(internal, missing);
});

// ============================================
// A refused redirect releases its connection
// ============================================

/** A 302 whose body never ends, recording whether anyone cancelled it. */
function trickling302(location: string): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([46]));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 302, headers: { location } }),
    cancelled: () => cancelled,
  };
}

test("the body of a redirect refused by the hop limit is cancelled (maxRedirects 0)", async () => {
  const hop = trickling302("https://example.com/next");
  await assert.rejects(
    safeFetch("https://example.com/", {
      maxRedirects: 0,
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () => hop.response) as unknown as typeof fetch,
    }),
    /too many redirects/,
  );
  assert.equal(hop.cancelled(), true, "the refused redirect's socket was released");
});

test("every hop of a capped redirect loop is cancelled, the last one included", async () => {
  const hops: Array<() => boolean> = [];
  await assert.rejects(
    safeFetch("https://example.com/", {
      maxRedirects: 2,
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () => {
        const hop = trickling302("https://example.com/again");
        hops.push(hop.cancelled);
        return hop.response;
      }) as unknown as typeof fetch,
    }),
    /too many redirects/,
  );
  assert.equal(hops.length, 3);
  assert.deepEqual(hops.map((c) => c()), [true, true, true]);
});
