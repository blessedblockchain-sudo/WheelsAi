/**
 * Marketplace per-request metering proof (W2 money keystone, money-IN).
 *
 * Runs the production charge / settle / refund path — the exact
 * `withMarketplaceMetering` the playground route, the scheduler executor
 * and the graph runner call — against the real dev Postgres. Nothing in
 * the billing code is substituted; the ONE substitution is the callback
 * standing in for the model call, so the proof does not need a provider
 * key. What that callback returns or throws is what a real inference
 * would return or throw at the same seam.
 *
 *   npx tsx apps/api/scripts/run-marketplace-metering-proof.ts
 *
 * The script is idempotent: it tears its fixtures down at the end and
 * asserts every balance it touches.
 */

import assert from "node:assert/strict";

import { prisma } from "../src/lib/prisma.js";
import { withMarketplaceMetering } from "../src/services/marketplaceMeteringProduction.js";

const RUN = `metering-proof-${Date.now()}`;

function usd(cents: bigint | number): string {
  return `$${(Number(cents) / 100).toFixed(4)}`;
}

async function main() {
  console.log(`\n=== marketplace metering proof (${RUN}) ===\n`);

  // ---------- fixtures ----------
  const publisherOwner = await prisma.user.create({
    data: { email: `${RUN}-pub@example.test`, passwordHash: "x" },
  });
  const publisherOrg = await prisma.organization.create({
    data: { name: `${RUN}-publisher`, ownerId: publisherOwner.id },
  });
  const buyerOwner = await prisma.user.create({
    data: { email: `${RUN}-buy@example.test`, passwordHash: "x" },
  });
  const buyerOrg = await prisma.organization.create({
    data: { name: `${RUN}-buyer`, ownerId: buyerOwner.id },
  });

  await prisma.publisherProfile.create({
    data: {
      orgId: publisherOrg.id,
      displayName: "Proof Publisher",
      slug: `${RUN}-profile`,
    },
  });

  const originalAgent = await prisma.agent.create({
    data: {
      orgId: publisherOrg.id,
      name: "Support Triage",
      slug: `${RUN}-original`,
      framework: "mastra",
      sourceType: "inline",
      sourceCode: "// published agent",
      modelConfig: { externalModel: "llama-3.1-8b" },
    },
  });

  const listing = await prisma.agentListing.create({
    data: {
      agentId: originalAgent.id,
      title: "Support Triage",
      slug: `${RUN}-listing`,
      shortDescription: "Proof listing",
      category: "customer-support",
      pricingModel: "per_request",
      pricePerRequestCents: 250n,
      publisherId: publisherOrg.id,
      publisherName: "Proof Publisher",
      status: "published",
      publishedAt: new Date(),
    },
  });

  const clone = await prisma.agent.create({
    data: {
      orgId: buyerOrg.id,
      name: "Support Triage (Marketplace)",
      slug: `${RUN}-clone`,
      framework: "mastra",
      sourceType: "inline",
      sourceCode: "// published agent",
      modelConfig: { externalModel: "llama-3.1-8b" },
    },
  });

  const install = await prisma.agentInstall.create({
    data: {
      listingId: listing.id,
      buyerId: buyerOrg.id,
      clonedAgentId: clone.id,
      status: "active",
      // What installAgent records: the pricing this buyer agreed to.
      acceptedPricingModel: listing.pricingModel,
      acceptedPricePerRequestCents: listing.pricePerRequestCents,
      pricingAcceptedAt: new Date(),
    },
  });

  await prisma.creditBalance.create({
    data: { orgId: buyerOrg.id, balanceCents: 1000n },
  });

  console.log(`buyer org      ${buyerOrg.id}`);
  console.log(`publisher org  ${publisherOrg.id}`);
  console.log(`listing        ${listing.id} @ ${usd(250n)}/request`);
  console.log(`cloned agent   ${clone.id}`);
  console.log(`opening balance ${usd(1000n)}\n`);

  const balance = async () =>
    (await prisma.creditBalance.findUnique({ where: { orgId: buyerOrg.id } }))!
      .balanceCents;
  const publisherPending = async () =>
    (await prisma.publisherProfile.findUnique({ where: { orgId: publisherOrg.id } }))!
      .pendingPayoutCents;

  try {
    // ---------- 1. delivered request: charge + settle ----------
    const answer = await withMarketplaceMetering(
      { agentId: clone.id, orgId: buyerOrg.id },
      async () => "the model's answer",
    );
    assert.equal(answer, "the model's answer");

    const afterSettle = await balance();
    const pendingAfterSettle = await publisherPending();
    assert.equal(afterSettle, 750n, "buyer should have been debited 250");
    assert.equal(pendingAfterSettle, 225n, "publisher should have accrued 90%");
    console.log(
      `1. delivered   balance ${usd(1000n)} -> ${usd(afterSettle)} · publisher pending ${usd(
        pendingAfterSettle,
      )} (10% platform fee retained)`,
    );

    // ---------- 2. failed request: charge + refund ----------
    await assert.rejects(
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => {
        throw new Error("model provider 503");
      }),
      /model provider 503/,
    );
    const afterRefund = await balance();
    assert.equal(afterRefund, 750n, "a failed request must cost nothing");
    assert.equal(await publisherPending(), 225n, "a failed request must not accrue");
    console.log(
      `2. failed      balance stays ${usd(afterRefund)} · publisher pending stays ${usd(
        await publisherPending(),
      )}`,
    );

    // ---------- 3. concurrency: real conditional decrement ----------
    // Three parallel requests against a balance that covers exactly three,
    // then a fourth that must be refused. The guard is the SQL
    // `WHERE balance_cents >= 250` — this is the part a fake cannot prove.
    const outcomes = await Promise.allSettled([
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => "a"),
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => "b"),
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => "c"),
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => "d"),
    ]);
    const served = outcomes.filter((o) => o.status === "fulfilled").length;
    const refused = outcomes.filter((o) => o.status === "rejected").length;
    const afterRace = await balance();
    assert.equal(served, 3, `expected exactly 3 served, got ${served}`);
    assert.equal(refused, 1, `expected exactly 1 refused, got ${refused}`);
    assert.equal(afterRace, 0n, "balance must land exactly on zero, never negative");
    console.log(
      `3. concurrency 4 parallel requests on ${usd(750n)}: ${served} served, ${refused} refused, balance ${usd(
        afterRace,
      )} (never negative)`,
    );

    // ---------- 4. exhausted buyer is refused ----------
    await assert.rejects(
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => {
        throw new Error("the agent must not have run");
      }),
      /billed per request/,
    );
    console.log(`4. exhausted   refused before the agent ran (402 shape)`);

    // ---------- 5. uninstall revokes the clone ----------
    await prisma.agentInstall.update({
      where: { id: install.id },
      data: { status: "uninstalled", uninstalledAt: new Date() },
    });
    await prisma.creditBalance.update({
      where: { orgId: buyerOrg.id },
      data: { balanceCents: 10_000n },
    });
    await assert.rejects(
      withMarketplaceMetering({ agentId: clone.id, orgId: buyerOrg.id }, async () => {
        throw new Error("the agent must not have run");
      }),
      /stopped working when you uninstalled it/,
    );
    assert.equal(
      await balance(),
      10_000n,
      "a revoked clone must not be charged either",
    );
    console.log(
      `5. revoked     uninstalled clone refuses to run even with ${usd(10_000n)} available`,
    );

    // ---------- ledger + revenue audit ----------
    const revenue = await prisma.marketplaceRevenue.findMany({
      where: { listingId: listing.id },
      orderBy: { createdAt: "asc" },
    });
    const settled = revenue.filter((r) => r.status === "settled");
    const refundedRows = revenue.filter((r) => r.status === "refunded");
    const ledger = await prisma.creditTransaction.findMany({
      where: { orgId: buyerOrg.id },
      orderBy: { createdAt: "asc" },
    });

    const collected = settled.reduce((s, r) => s + r.grossAmountCents, 0n);
    const accrued = settled.reduce((s, r) => s + r.creatorAmountCents, 0n);
    assert.equal(settled.length, 4, "4 delivered requests");
    assert.equal(refundedRows.length, 1, "1 refunded request");
    assert.equal(await publisherPending(), accrued);
    // THE invariant: every cent the publisher can withdraw came out of a
    // buyer's balance. This is what the deleted recordMarketplaceUsage
    // violated by design.
    assert.equal(collected, 1000n);
    assert.equal(accrued, 900n);

    console.log(`\nrevenue rows   ${revenue.length} (${settled.length} settled, ${refundedRows.length} refunded)`);
    console.log(`ledger rows    ${ledger.length}`);
    console.log(`collected      ${usd(collected)} from the buyer`);
    console.log(`accrued        ${usd(accrued)} to the publisher (${usd(collected - accrued)} platform fee)`);
    console.log(
      `\nINVARIANT OK   publisher pendingPayoutCents (${usd(await publisherPending())}) is exactly the creator share of money actually taken from a buyer.`,
    );

    for (const r of ledger) {
      console.log(
        `  ledger  ${r.type.padEnd(20)} ${String(r.amountCents).padStart(6)}c  balanceAfter ${String(
          r.balanceAfter,
        ).padStart(6)}c  ref ${r.referenceId}`,
      );
    }
  } finally {
    // ---------- teardown ----------
    await prisma.marketplaceRevenue.deleteMany({ where: { listingId: listing.id } });
    await prisma.creditTransaction.deleteMany({ where: { orgId: buyerOrg.id } });
    await prisma.creditBalance.deleteMany({ where: { orgId: buyerOrg.id } });
    await prisma.agentInstall.deleteMany({ where: { id: install.id } });
    await prisma.agentListing.deleteMany({ where: { id: listing.id } });
    await prisma.publisherProfile.deleteMany({ where: { orgId: publisherOrg.id } });
    await prisma.agent.deleteMany({ where: { id: { in: [clone.id, originalAgent.id] } } });
    await prisma.organization.deleteMany({
      where: { id: { in: [buyerOrg.id, publisherOrg.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [buyerOwner.id, publisherOwner.id] } },
    });
    await prisma.$disconnect();
    console.log(`\nfixtures torn down.\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
