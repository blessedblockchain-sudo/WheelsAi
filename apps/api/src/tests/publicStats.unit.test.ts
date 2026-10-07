import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import "./unitEnv.js";
import { createPublicStatsRoutes } from "../routes/publicStats.js";
import { summarizePublicLatency } from "../services/publicLatency.js";

const thresholds = { windowHours: 24, minSamples: 50, minOrgs: 3 };
const measuredFigure = summarizePublicLatency(
  {
    windowHours: 24,
    sampleCount: 1284,
    orgCount: 7,
    p50Ms: 612,
    p95Ms: 2140,
    firstTokenSampleCount: 402,
    firstTokenOrgCount: 5,
    firstTokenP50Ms: 380,
    computedAt: new Date("2026-10-07T09:00:00.000Z"),
  },
  thresholds,
);
const latency = {
  figure: async () => measuredFigure,
  unavailableFigure: () => summarizePublicLatency(null, thresholds),
};

// The landing page's stats come from here. These pin them to the product
// constants so a stat cannot drift from what the product actually does.

test("public stats report the product's own constants", async () => {
  const app = Fastify();
  await app.register(createPublicStatsRoutes({ countPublishedListings: async () => 12, latency }), { prefix: "/api" });
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
    createPublicStatsRoutes({ countPublishedListings: async () => { throw new Error("db down"); }, latency }),
    { prefix: "/api" },
  );
  const res = await app.inject({ method: "GET", url: "/api/public/stats" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().publishedListings, null);
  assert.equal(res.json().latency.status, "measured", "the latency figure is read independently");
});

test("the latency block is the reader's figure, passed through whole", async () => {
  const app = Fastify();
  await app.register(createPublicStatsRoutes({ countPublishedListings: async () => 12, latency }), { prefix: "/api" });
  const res = await app.inject({ method: "GET", url: "/api/public/stats" });
  assert.match(String(res.headers["cache-control"]), /public, max-age=300/);
  assert.deepEqual(res.json().latency, JSON.parse(JSON.stringify(measuredFigure)));
  assert.equal(res.json().latency.p50Ms, 612);
});

test("a latency reader that throws still answers 200: unavailable, no number, other stats intact", async () => {
  const app = Fastify();
  await app.register(
    createPublicStatsRoutes({
      countPublishedListings: async () => 12,
      latency: {
        figure: async () => {
          throw new Error("db down");
        },
        unavailableFigure: latency.unavailableFigure,
      },
    }),
    { prefix: "/api" },
  );
  const res = await app.inject({ method: "GET", url: "/api/public/stats" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.latency.status, "unavailable");
  assert.deepEqual(
    [body.latency.p50Ms, body.latency.p95Ms, body.latency.firstTokenP50Ms, body.latency.sampleCount],
    [null, null, null, null],
  );
  assert.equal(body.frameworks, 6);
  assert.equal(body.publishedListings, 12);
});

test("below the publication thresholds the block says so and carries no latency", async () => {
  const app = Fastify();
  const thin = summarizePublicLatency(
    {
      windowHours: 24,
      sampleCount: 12,
      orgCount: 1,
      p50Ms: 40,
      p95Ms: 90,
      firstTokenSampleCount: 0,
      firstTokenOrgCount: 0,
      firstTokenP50Ms: null,
      computedAt: new Date("2026-10-07T09:00:00.000Z"),
    },
    thresholds,
  );
  await app.register(
    createPublicStatsRoutes({
      countPublishedListings: async () => 12,
      latency: { figure: async () => thin, unavailableFigure: latency.unavailableFigure },
    }),
    { prefix: "/api" },
  );
  const body = (await app.inject({ method: "GET", url: "/api/public/stats" })).json();
  assert.equal(body.latency.status, "insufficient_data");
  assert.equal(body.latency.sampleCount, 12);
  assert.equal(body.latency.p50Ms, null);
  assert.deepEqual([body.latency.p95Ms, body.latency.firstTokenP50Ms], [null, null]);
});
