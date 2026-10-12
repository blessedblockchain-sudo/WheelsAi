import assert from "node:assert/strict";
import test from "node:test";

import { fetchImageBytes } from "../services/fetchImageBytes.js";
import { LaunchRefusal } from "../services/launchpad/launchRefusal.js";

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

test("a body that never ends is dropped once it is over the size cap, not read whole", async () => {
  let pieces = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pieces += 1;
      controller.enqueue(new Uint8Array(256));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchImageBytes(
      "https://cdn.example.com/endless.png",
      { fetchFn: async () => new Response(endless, { headers: { "content-type": "image/png" } }) },
      { maxBytes: 512 },
    ),
    /exceeds 512b cap/,
  );
  assert.ok(cancelled, "the rest of the body was let go");
  assert.ok(pieces <= 5, `only what the cap needed was read (${pieces} pieces)`);
});

test("rejects an empty url", async () => {
  await assert.rejects(
    fetchImageBytes("", { fetchFn: async () => pngResponse() }),
    /url is required/,
  );
});

// ============================================
// A link a user typed
// ============================================
//
// No test here touches a network: the fetch is a fake, and where a host's
// name would be looked up the lookup is a fake too.

const PUBLIC_IP = "93.184.216.34";

function isPictureLinkRefused(err: unknown): boolean {
  assert.ok(err instanceof LaunchRefusal, String(err));
  assert.equal(err.code, "picture_link_refused");
  assert.equal(err.status, 400);
  return true;
}

test("a link that is not http or https is refused before any request, in development too", async () => {
  for (const link of ["file:///etc/passwd", "ftp://cdn.example.com/icon.png", "data:image/png;base64,AAAA", "not a link"]) {
    for (const allowLocal of [true, false]) {
      let requests = 0;
      await assert.rejects(
        fetchImageBytes(
          link,
          {
            fetchFn: async () => {
              requests += 1;
              return pngResponse();
            },
          },
          { allowLocal },
        ),
        isPictureLinkRefused,
        `${link} (allowLocal ${allowLocal})`,
      );
      assert.equal(requests, 0, `${link}: nothing was requested`);
    }
  }
});

test("outside development a link to this machine or a private network is refused before any request", async () => {
  const links = [
    "http://localhost:3100/icon.png",
    "http://127.0.0.1:4000/icon.png",
    "http://[::1]/icon.png",
    "http://10.0.0.8/icon.png",
    "http://192.168.1.20/icon.png",
    "http://169.254.169.254/latest/meta-data/icon.png",
    "http://2130706433/icon.png",
  ];
  for (const link of links) {
    let requests = 0;
    await assert.rejects(
      fetchImageBytes(
        link,
        {
          fetchFn: async () => {
            requests += 1;
            return pngResponse();
          },
          resolveHost: async () => ["127.0.0.1"],
        },
        { allowLocal: false },
      ),
      isPictureLinkRefused,
      link,
    );
    assert.equal(requests, 0, `${link}: nothing was requested`);
  }
});

test("outside development a public name that resolves to a private address is refused, and the address is not repeated", async () => {
  let requests = 0;
  await assert.rejects(
    fetchImageBytes(
      "https://pictures.example.com/icon.png",
      {
        fetchFn: async () => {
          requests += 1;
          return pngResponse();
        },
        resolveHost: async () => ["10.1.2.3"],
      },
      { allowLocal: false },
    ),
    (err: unknown) => {
      isPictureLinkRefused(err);
      assert.ok(!(err as Error).message.includes("10.1.2.3"));
      return true;
    },
  );
  assert.equal(requests, 0);
});

test("outside development a redirect to a private host is not followed", async () => {
  const requested: string[] = [];
  await assert.rejects(
    fetchImageBytes(
      "https://cdn.example.com/icon.png",
      {
        fetchFn: (async (input: any, init: any) => {
          requested.push(String(input));
          assert.equal(init.redirect, "manual", "redirects are followed by hand");
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:4000/icon.png" },
          });
        }) as unknown as typeof fetch,
        resolveHost: async () => [PUBLIC_IP],
      },
      { allowLocal: false },
    ),
    isPictureLinkRefused,
  );
  assert.deepEqual(requested, ["https://cdn.example.com/icon.png"]);
});

test("outside development a public link is fetched, and a redirect to another public host is followed", async () => {
  const requested: string[] = [];
  const out = await fetchImageBytes(
    "https://cdn.example.com/icon.png",
    {
      fetchFn: (async (input: any) => {
        requested.push(String(input));
        if (requested.length === 1) {
          return new Response(null, {
            status: 301,
            headers: { location: "https://img.example.org/a/icon.png" },
          });
        }
        return pngResponse();
      }) as unknown as typeof fetch,
      resolveHost: async () => [PUBLIC_IP],
    },
    { allowLocal: false },
  );
  assert.deepEqual(requested, [
    "https://cdn.example.com/icon.png",
    "https://img.example.org/a/icon.png",
  ]);
  assert.deepEqual([...out.bytes], [...PNG]);
  assert.equal(out.filename, "icon.png");
});

test("in development a local link is allowed: the demo uses the app's own icon", async () => {
  const out = await fetchImageBytes(
    "http://localhost:3100/icon.png",
    { fetchFn: async () => pngResponse() },
    { allowLocal: true },
  );
  assert.equal(out.mime, "image/png");
});

test("whether a local link is allowed follows NODE_ENV when the caller does not say", async () => {
  const before = process.env.NODE_ENV;
  const attempt = () =>
    fetchImageBytes("http://127.0.0.1:3100/icon.png", { fetchFn: async () => pngResponse() });
  try {
    for (const mode of ["development", "test"]) {
      process.env.NODE_ENV = mode;
      assert.equal((await attempt()).mime, "image/png", mode);
    }
    for (const mode of ["production", "staging"]) {
      process.env.NODE_ENV = mode;
      await assert.rejects(attempt(), isPictureLinkRefused, mode);
    }
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});
