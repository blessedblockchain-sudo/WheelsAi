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

// Drives the A3 fixes — the token-eligibility gate must be PASSABLE and
// HONEST:
//
//   1. Reputation recalc fires automatically on review + install. Before,
//     updatePublisherReputation's only caller was a manual recalc route,
//     so every publisher sat at the score default (0) against a gate
//     requiring ≥50 — structurally unpassable.
//   2. Preview (agentToken.checkTokenEligibility) counts RUNNING
//     deployments only, matching enforcement (loadEligibilityState) —
//     any-status counting made the preview promise what the gate refused.
//   3. The production launch binding wires readOnChainReputation. The dep
//     is optional on the loader, so dropping it compiles fine while
//     silently pinning launches to the off-chain mirror.
//
// Prisma is the @wheelsai/db singleton (no DI on these services); tests
// monkey-patch its delegates and restore them, the same pattern as
// versioningTenancy.unit.test.ts.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function getPrisma(): Promise<any> {
  setupEnv();
  const { prisma } = await import("@wheelsai/db");
  return prisma;
}

function snapshot(p: any) {
  return {
    agentListing: { ...p.agentListing },
    agentReview: { ...p.agentReview },
    agentInstall: { ...p.agentInstall },
    agent: { ...p.agent },
    publisherProfile: { ...p.publisherProfile },
    $transaction: p.$transaction,
  };
}

function restore(p: any, orig: ReturnType<typeof snapshot>) {
  Object.assign(p.agentListing, orig.agentListing);
  Object.assign(p.agentReview, orig.agentReview);
  Object.assign(p.agentInstall, orig.agentInstall);
  Object.assign(p.agent, orig.agent);
  Object.assign(p.publisherProfile, orig.publisherProfile);
  p.$transaction = orig.$transaction;
}

// ============================================
// Auto-recalc on review
// ============================================

test("createReview fires a reputation recalc at the listing's publisher — and a recalc failure does not fail the review", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const reputationReads: string[] = [];
  try {
    p.agentListing.findUnique = async () => ({ publisherId: "org_pub" });
    p.agentReview.findUnique = async () => null;
    p.agentInstall.findUnique = async () => null;
    p.agentReview.create = async (args: any) => ({ id: "rev_1", ...args.data });
    p.agentReview.aggregate = async () => ({
      _avg: { rating: 5 },
      _count: { id: 1 },
    });
    p.agentListing.update = async () => ({});
    // First read inside updatePublisherReputation → record, then blow up:
    // one stub proves both that the recalc FIRED and that its failure is
    // swallowed by the fire-and-forget catch.
    p.publisherProfile.findUnique = async (args: any) => {
      reputationReads.push(args.where.orgId);
      throw new Error("recalc intentionally stopped by test");
    };

    const { createReview } = await import("../services/marketplace.js");
    const review = await createReview("lst_1", "org_reviewer", { rating: 5 });
    assert.equal(review.id, "rev_1");

    await tick();
    assert.deepEqual(reputationReads, ["org_pub"]);
  } finally {
    restore(p, orig);
  }
});

test("createReview against a missing listing fails fast and fires no recalc", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const reputationReads: string[] = [];
  try {
    p.agentListing.findUnique = async () => null;
    p.publisherProfile.findUnique = async (args: any) => {
      reputationReads.push(args.where.orgId);
      return null;
    };

    const { createReview } = await import("../services/marketplace.js");
    await assert.rejects(
      createReview("lst_missing", "org_reviewer", { rating: 5 }),
      /Listing not found/,
    );

    await tick();
    assert.deepEqual(reputationReads, []);
  } finally {
    restore(p, orig);
  }
});

// ============================================
// Auto-recalc on install
// ============================================

test("installAgent fires a reputation recalc at the listing's publisher", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const reputationReads: string[] = [];
  try {
    p.agentListing.findUnique = async () => ({
      id: "lst_1",
      status: "published",
      publisherId: "org_pub",
      agent: {
        name: "Agent",
        slug: "agent",
        description: null,
        framework: "custom",
        systemPrompt: null,
        tools: null,
        modelConfig: null,
        sourceType: "github",
        sourceUrl: null,
        sourceCode: null,
        env: null,
        version: "1.0.0",
        tags: [],
      },
    });
    p.agentInstall.findUnique = async () => null;
    // installAgent writes the clone, install and counters in one
    // transaction; run it against the same stubs.
    p.$transaction = async (fn: (tx: any) => unknown) => fn(p);
    p.agent.create = async (args: any) => ({
      id: "agent_clone",
      name: args.data.name,
      slug: args.data.slug,
    });
    p.agentInstall.create = async () => ({ id: "inst_1" });
    p.agentListing.update = async () => ({});
    p.agentListing.aggregate = async () => ({
      _count: { id: 1 },
      _sum: { totalInstalls: 1 },
    });
    p.publisherProfile.update = async () => ({});
    p.publisherProfile.findUnique = async (args: any) => {
      reputationReads.push(args.where.orgId);
      throw new Error("recalc intentionally stopped by test");
    };

    const { installAgent } = await import("../services/marketplace.js");
    const result = await installAgent("lst_1", "org_buyer");
    assert.equal(result.clonedAgent.id, "agent_clone");

    await tick();
    assert.deepEqual(reputationReads, ["org_pub"]);
  } finally {
    restore(p, orig);
  }
});

// ============================================
// Preview/enforcement divergence — running-only
// ============================================

test("checkTokenEligibility counts RUNNING deployments only, matching the enforcement path", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    let captured: any;
    p.agentListing.findUnique = async (args: any) => {
      captured = args;
      return null; // early return path — the query shape is what's pinned
    };

    const { checkTokenEligibility } = await import("../services/agentToken.js");
    const result = await checkTokenEligibility("lst_1", "org_1");
    assert.equal(result.eligible, false);
    assert.deepEqual(captured.include.agent.include.deployments.where, {
      status: "running",
    });
  } finally {
    restore(p, orig);
  }
});

// ============================================
// Binding wires the on-chain reputation reader
// ============================================

test("the production launch binding includes readOnChainReputation in its eligibility deps", async () => {
  setupEnv();
  const { buildEligibilityDeps } = await import(
    "../routes/tokenLaunchPartialSignBindings.js"
  );
  const deps = buildEligibilityDeps();
  // The dep is OPTIONAL on the loader — presence here is the whole fix.
  assert.equal(typeof deps.readOnChainReputation, "function");
  assert.equal(typeof deps.getCreatorAddress, "function");
});
