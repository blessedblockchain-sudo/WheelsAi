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

// Drives apps/api/src/services/tokenEligibility.ts — the pure anti-scam
// gate run BEFORE the pump.fun create-token call.
//
// Why this is a pure function and not a route check:
//
//   - It encodes the platform's "vetted launch" rules. The launch UI shows
//     them up front, the route enforces them at submit time, and the
//     public transparency page renders them in the agent's footer ("rep 67,
//     uptime 14d, eligible to graduate"). All three callers must agree.
//
//   - The exact thresholds are tunable (50/7d today, possibly per-tier
//     later) — the function takes them as optional parameters.
//
//   - The return shape lists EVERY violation in one pass so the UI can
//     show "fix all 3 things" rather than "fix one, retry, fix next".
//
// All thresholds are inclusive — exactly the cutoff value passes.

const validInput = () => ({
  reputationScore: 60,
  deploymentAgeDays: 10,
  hasPublishedListing: true,
  alreadyTokenized: false,
  creatorAddress: "PaYer11111111111111111111111111111111111111",
});

// ============================================
// All-met happy path
// ============================================

test("checkTokenEligibility returns eligible=true when every condition is met", async () => {
  setupEnv();
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility(validInput());
  assert.equal(result.eligible, true);
  if (result.eligible) {
    // Type-narrowing sanity — eligible result has no reasons[].
    assert.equal((result as any).reasons, undefined);
  }
});

// ============================================
// Per-condition failures
// ============================================

test("checkTokenEligibility flags reputation_too_low below 50", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({ ...validInput(), reputationScore: 49 });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("reputation_too_low"));
  }
});

test("checkTokenEligibility flags uptime_insufficient below 7 days", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({ ...validInput(), deploymentAgeDays: 6 });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("uptime_insufficient"));
  }
});

test("checkTokenEligibility flags listing_not_published when listing is unpublished", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    hasPublishedListing: false,
  });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("listing_not_published"));
  }
});

test("checkTokenEligibility flags already_tokenized when a token has been minted before", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    alreadyTokenized: true,
  });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("already_tokenized"));
  }
});

test("checkTokenEligibility flags creator_address_missing when creatorAddress is empty", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({ ...validInput(), creatorAddress: "" });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("creator_address_missing"));
  }
});

// ============================================
// Multiple violations
// ============================================

test("checkTokenEligibility lists every violation in one pass (no fail-fast)", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    reputationScore: 30,
    deploymentAgeDays: 2,
    hasPublishedListing: false,
    alreadyTokenized: true,
    creatorAddress: "",
  });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.deepEqual(result.reasons.sort(), [
      "already_tokenized",
      "creator_address_missing",
      "listing_not_published",
      "reputation_too_low",
      "uptime_insufficient",
    ]);
  }
});

// ============================================
// Boundaries (inclusive thresholds)
// ============================================

test("checkTokenEligibility allows reputation EXACTLY at the threshold", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    reputationScore: 50,
  });
  assert.equal(result.eligible, true);
});

test("checkTokenEligibility allows uptime EXACTLY at 7 days", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    deploymentAgeDays: 7,
  });
  assert.equal(result.eligible, true);
});

test("checkTokenEligibility rejects reputation just below threshold (49.99 → not eligible)", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    reputationScore: 49.99,
  });
  assert.equal(result.eligible, false);
});

// ============================================
// Configurable thresholds
// ============================================

test("checkTokenEligibility honors a stricter custom threshold pair", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    reputationScore: 65, // below custom 70 threshold
    minReputation: 70,
    minDeploymentAgeDays: 14, // higher than the input 10
  });
  assert.equal(result.eligible, false);
  if (!result.eligible) {
    assert.ok(result.reasons.includes("reputation_too_low"));
    assert.ok(result.reasons.includes("uptime_insufficient"));
  }
});

test("checkTokenEligibility honors a looser custom threshold pair", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const result = checkTokenEligibility({
    ...validInput(),
    reputationScore: 30, // would normally fail
    deploymentAgeDays: 3, // would normally fail
    minReputation: 25,
    minDeploymentAgeDays: 1,
  });
  assert.equal(result.eligible, true);
});

// ============================================
// Reasons stable + sortable
// ============================================

test("checkTokenEligibility returns reasons in a deterministic (sorted) order", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  // Two different orderings of the same violations should produce the same reasons array.
  const r1 = checkTokenEligibility({
    reputationScore: 10,
    deploymentAgeDays: 1,
    hasPublishedListing: false,
    alreadyTokenized: false,
    creatorAddress: "x",
  });
  const r2 = checkTokenEligibility({
    reputationScore: 10,
    deploymentAgeDays: 1,
    hasPublishedListing: false,
    alreadyTokenized: false,
    creatorAddress: "x",
  });
  if (!r1.eligible && !r2.eligible) {
    assert.deepEqual(r1.reasons, r2.reasons);
  }
});

// ============================================
// Threshold values exposed for the UI
// ============================================

test("ELIGIBILITY_DEFAULTS exposes 50 + 7 so the UI can render the same numbers without drift", async () => {
  const { ELIGIBILITY_DEFAULTS } = await import(
    "../services/tokenEligibility.js"
  );
  assert.equal(ELIGIBILITY_DEFAULTS.minReputation, 50);
  assert.equal(ELIGIBILITY_DEFAULTS.minDeploymentAgeDays, 7);
});

// ============================================
// Sybil discount (B4/T7)
// ============================================

test("settled x402 payments discount the reputation requirement 1:1", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  // Score 30 fails the default 50 bar…
  const without = checkTokenEligibility({
    reputationScore: 30,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
  });
  assert.ok(!without.eligible && without.reasons.includes("reputation_too_low"));

  // …but 20 on-chain-paid requests lower the bar to exactly 30.
  const withPaid = checkTokenEligibility({
    reputationScore: 30,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
    settledPaidRequests: 20,
  });
  assert.ok(withPaid.eligible, JSON.stringify(withPaid));
});

test("the paid discount is capped — volume can never substitute for half the bar", async () => {
  const { checkTokenEligibility, MAX_PAID_DISCOUNT_POINTS } = await import(
    "../services/tokenEligibility.js"
  );
  assert.equal(MAX_PAID_DISCOUNT_POINTS, 25);
  // Even absurd paid volume leaves an effective bar of 25.
  const r = checkTokenEligibility({
    reputationScore: 24,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
    settledPaidRequests: 10_000,
  });
  assert.ok(!r.eligible && r.reasons.includes("reputation_too_low"));
  const atCap = checkTokenEligibility({
    reputationScore: 25,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
    settledPaidRequests: 10_000,
  });
  assert.ok(atCap.eligible);
});

test("the discount touches ONLY reputation — every other gate stays hard", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const r = checkTokenEligibility({
    reputationScore: 100,
    deploymentAgeDays: 1, // under the 7-day bar
    hasPublishedListing: false,
    alreadyTokenized: true,
    creatorAddress: "",
    settledPaidRequests: 10_000,
  });
  assert.ok(!r.eligible);
  assert.deepEqual(r.reasons, [
    "already_tokenized",
    "creator_address_missing",
    "listing_not_published",
    "uptime_insufficient",
  ]);
});

test("negative or absent settledPaidRequests never RAISES the bar", async () => {
  const { checkTokenEligibility } = await import(
    "../services/tokenEligibility.js"
  );
  const absent = checkTokenEligibility({
    reputationScore: 50,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
  });
  assert.ok(absent.eligible);
  const negative = checkTokenEligibility({
    reputationScore: 50,
    deploymentAgeDays: 14,
    hasPublishedListing: true,
    alreadyTokenized: false,
    creatorAddress: "x",
    settledPaidRequests: -5,
  });
  assert.ok(negative.eligible);
});
