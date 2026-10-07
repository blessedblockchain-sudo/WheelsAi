import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import "./unitEnv.js";
import { createPublicStatsRoutes } from "../routes/publicStats.js";

// The landing page's stats come from here. These pin them to the product
// constants so a stat cannot drift from what the product actually does.

test("public stats report the product's own constants", async () => {
  const app = Fastify();
  await app.register(createPublicStatsRoutes({ countPublishedListings: async () => 12 }), { prefix: "/api" });
  const res = await app.inject({ method: "GET", url: "/api/public/stats" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["cache-control"]), /max-age=300/);
  const body = res.json();
  assert.equal(body.frameworks, 6);
  assert.equal(body.pricingModels, 4); // free, per-request, monthly, tokenized
  // The web chat widget is the fourth: it is served by routes/widget.ts.
  assert.deepEqual(body.channelPlatforms, ["discord", "telegram", "slack", "web"]);
  assert.equal(body.channels, 4);
  assert.equal(typeof body.models, "number");
  assert.ok(body.models > 0);
  assert.equal(body.publishedListings, 12);
});

test("a failing listing count does not take the stats down", async () => {
  const app = Fastify();
  await app.register(
    createPublicStatsRoutes({ countPublishedListings: async () => { throw new Error("db down"); } }),
    { prefix: "/api" },
  );
  const res = await app.inject({ method: "GET", url: "/api/public/stats" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().publishedListings, null);
});
