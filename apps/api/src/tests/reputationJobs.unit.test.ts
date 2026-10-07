import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { isVerifiedReviewer } from "../services/marketplace.js";
import { blendRatings, calculateReputationScore, recordDispute, type ReputationDb } from "../services/reputation.js";

// How paid jobs reach a publisher's reputation.

function db(opts: {
  reviews?: number[];
  jobAvg?: number | null;
  jobCount?: number;
  outcomes?: Record<string, number>;
  disputes?: [number, number];
}): ReputationDb {
  return {
    publisherProfile: {
      findUnique: async () => ({
        createdAt: new Date(),
        isVerified: false,
        avgResponseTimeMs: null,
        successfulPayouts: 0,
        disputeCount: opts.disputes?.[0] ?? 0,
        disputeResolvedCount: opts.disputes?.[1] ?? 0,
      }),
    },
    agentListing: {
      findMany: async () => [{ totalInstalls: 0, reviews: (opts.reviews ?? []).map((rating) => ({ rating })) }],
    },
    job: {
      aggregate: async () => ({ _avg: { rating: opts.jobAvg ?? null }, _count: { _all: opts.jobCount ?? 0 } }),
      groupBy: async () =>
        Object.entries(opts.outcomes ?? {}).map(([status, count]) => ({ status, _count: { _all: count } })),
    },
  };
}

test("job ratings and listing reviews make one average, weighted by how many of each there are", () => {
  assert.deepEqual(blendRatings([5, 5], { avg: 2, count: 2 }), { avgRating: 3.5, ratingCount: 4 });
  assert.deepEqual(blendRatings([4], { avg: null, count: 0 }), { avgRating: 4, ratingCount: 1 });
  assert.deepEqual(blendRatings([], { avg: 4.5, count: 6 }), { avgRating: 4.5, ratingCount: 6 });
  assert.deepEqual(blendRatings([], { avg: null, count: 0 }), { avgRating: 0, ratingCount: 0 });
});

test("a publisher who sells only offerings is rated by their jobs", async () => {
  const unrated = await calculateReputationScore("org_pub", db({}));
  const rated = await calculateReputationScore("org_pub", db({ jobAvg: 5, jobCount: 12, outcomes: { completed: 12, rejected: 1, failed: 2 } }));

  assert.equal(unrated.breakdown.avgRating.value, 0);
  assert.equal(rated.breakdown.avgRating.value, 5);
  assert.ok(rated.score > unrated.score);
  assert.deepEqual(rated.jobs, { completed: 12, rejected: 1, failed: 2, expired: 0, ratingCount: 12 });
  // Twelve five-star jobs count toward the badge the way reviews do.
  assert.ok(rated.badges.includes("top-rated"));
});

test("job ratings are blended into a listed publisher's average", async () => {
  const score = await calculateReputationScore("org_pub", db({ reviews: [5, 5, 5], jobAvg: 1, jobCount: 3 }));
  assert.equal(score.breakdown.avgRating.value, 3);
});

test("a rejection is recorded as a dispute, resolved by the refund, and never throws for a missing profile", async () => {
  const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const fake = {
    publisherProfile: {
      updateMany: async (args: { where: { orgId: string }; data: Record<string, unknown> }) => {
        writes.push(args);
        return { count: 0 };
      },
    },
  };
  await recordDispute("org_pub", true, fake);
  assert.deepEqual(writes, [
    {
      where: { orgId: "org_pub" },
      data: { disputeCount: { increment: 1 }, disputeResolvedCount: { increment: 1 } },
    },
  ]);
  // Any dispute costs the zero-disputes badge.
  const disputed = await calculateReputationScore("org_pub", db({ disputes: [1, 1] }));
  assert.ok(!disputed.badges.includes("zero-disputes"));
});

test("a review is verified by an install, or by a completed job on one of the listing's offerings", async () => {
  const jobQueries: unknown[] = [];
  const fake = (install: unknown, job: unknown) => ({
    agentInstall: { findUnique: async () => install },
    job: {
      findFirst: async (query: unknown) => {
        jobQueries.push(query);
        return job;
      },
    },
  });
  assert.equal(await isVerifiedReviewer("lst_1", "org_buyer", fake({ id: "inst" }, null)), true);
  assert.equal(await isVerifiedReviewer("lst_1", "org_buyer", fake(null, { id: "job" })), true);
  assert.equal(await isVerifiedReviewer("lst_1", "org_buyer", fake(null, null)), false);
  // Only the reviewer's own completed job on this listing counts.
  assert.deepEqual(jobQueries[0], {
    where: { buyerId: "org_buyer", status: "completed", offering: { listingId: "lst_1" } },
    select: { id: true },
  });
});
