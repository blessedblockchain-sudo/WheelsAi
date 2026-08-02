import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives the platform-curation endpoint (Wave 1): PATCH
// /listings/:id/featured. Nothing ever wrote isFeatured before — every
// "Featured" section was permanently empty. Operator-key gated: curation
// must not be publisher-reachable.

const ADMIN_KEY = "test-admin-key-0123456789";
const LISTING_ID = "3b1f8f2e-6c1d-4c8a-9b6e-2f9d3a7c5e10";

async function buildApp(p: any) {
  setupEnv();
  const [{ marketplaceRoutes }, sensible] = await Promise.all([
    import("../routes/marketplace.js"),
    import("@fastify/sensible"),
  ]);
  const app = Fastify();
  await app.register(sensible.default);
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    reply.status(status).send({ error: err.message });
  });
  await app.register(marketplaceRoutes);
  void p;
  return app;
}

test("curation endpoint 503s honestly when no admin key is configured", async () => {
  setupEnv();
  const saved = process.env.PLATFORM_ADMIN_KEY;
  delete process.env.PLATFORM_ADMIN_KEY;
  try {
    const app = await buildApp(null);
    const res = await app.inject({
      method: "PATCH",
      url: `/listings/${LISTING_ID}/featured`,
      payload: { isFeatured: true },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "curation_not_configured");
  } finally {
    if (saved === undefined) delete process.env.PLATFORM_ADMIN_KEY;
    else process.env.PLATFORM_ADMIN_KEY = saved;
  }
});

test("a wrong or missing admin key is 401 — never touches the DB", async () => {
  process.env.PLATFORM_ADMIN_KEY = ADMIN_KEY;
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const orig = { ...p.agentListing };
  const writes: unknown[] = [];
  try {
    p.agentListing.updateMany = async (args: unknown) => {
      writes.push(args);
      return { count: 1 };
    };
    const app = await buildApp(p);

    for (const headers of [
      {},
      { "x-admin-key": "wrong-key" },
    ] as Array<Record<string, string>>) {
      const res = await app.inject({
        method: "PATCH",
        url: `/listings/${LISTING_ID}/featured`,
        payload: { isFeatured: true },
        headers,
      });
      assert.equal(res.statusCode, 401);
    }
    assert.equal(writes.length, 0);
  } finally {
    Object.assign(p.agentListing, orig);
    delete process.env.PLATFORM_ADMIN_KEY;
  }
});

test("a valid key toggles isFeatured; an unknown listing is 404", async () => {
  process.env.PLATFORM_ADMIN_KEY = ADMIN_KEY;
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const orig = { ...p.agentListing };
  try {
    const writes: Array<{ where: { id: string }; data: { isFeatured: boolean } }> = [];
    p.agentListing.updateMany = async (args: any) => {
      writes.push(args);
      return { count: args.where.id === LISTING_ID ? 1 : 0 };
    };
    const app = await buildApp(p);

    const ok = await app.inject({
      method: "PATCH",
      url: `/listings/${LISTING_ID}/featured`,
      payload: { isFeatured: true },
      headers: { "x-admin-key": ADMIN_KEY },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), {
      listing: { id: LISTING_ID, isFeatured: true },
    });
    assert.deepEqual(writes[0], {
      where: { id: LISTING_ID },
      data: { isFeatured: true },
    });

    const missing = await app.inject({
      method: "PATCH",
      url: "/listings/9c0a1b2d-3e4f-4a5b-8c7d-6e5f4a3b2c1d/featured",
      payload: { isFeatured: false },
      headers: { "x-admin-key": ADMIN_KEY },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    Object.assign(p.agentListing, orig);
    delete process.env.PLATFORM_ADMIN_KEY;
  }
});
