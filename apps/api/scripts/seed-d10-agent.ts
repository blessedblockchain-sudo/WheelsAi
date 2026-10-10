/**
 * D10 seeder: provision the WheelsHelper dogfood agent's full row chain
 * for the first end-to-end closed-loop run on devnet:
 *
 *   Agent (isPublic — so /a/wheels-helper renders)
 *     → AgentListing (published, tokenized)
 *       → AgentToken   (a REAL devnet SPL mint, passed as argv)
 *         → AgentTreasury (treasuryPdaAddress = the agent-treasury
 *           program PDA derived from the mint; programInitialized=false —
 *           bootstrap-treasury.ts flips it after initialize_treasury lands)
 *
 * Idempotent: re-running with the same mint returns the existing rows.
 *
 * Usage:
 *   tsx scripts/seed-d10-agent.ts <mintAddress> <creatorAddress> [orgId]
 *
 * Env: DATABASE_URL (source apps/api/.env first).
 */

import { PublicKey } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { deriveTreasuryPda } from "../src/lib/programs/agentTreasury.js";

const AGENT_SLUG = "wheels-helper";

async function main() {
  const [, , mintArg, creatorArg, orgArg] = process.argv;
  if (!mintArg || !creatorArg) {
    console.error(
      "usage: tsx scripts/seed-d10-agent.ts <mintAddress> <creatorAddress> [orgId]",
    );
    process.exit(2);
  }
  const mint = new PublicKey(mintArg); // throws on invalid address

  const existingToken = await prisma.agentToken.findUnique({
    where: { mintAddress: mint.toBase58() },
    select: { id: true, treasury: { select: { id: true, treasuryPdaAddress: true } } },
  });
  if (existingToken) {
    console.log("Already seeded:");
    console.log(JSON.stringify(existingToken, null, 2));
    await prisma.$disconnect();
    return;
  }

  const org = orgArg
    ? await prisma.organization.findUnique({ where: { id: orgArg } })
    : await prisma.organization.findFirst({ where: { name: "blessedbiello" } });
  if (!org) {
    console.error("Organization not found");
    process.exit(1);
  }

  const [treasuryPda, treasuryBump] = deriveTreasuryPda(mint);

  const result = await prisma.$transaction(async (tx) => {
    const agent = await tx.agent.upsert({
      where: {
        // Agent.slug is not globally unique; scope by org via findFirst
        // semantics — upsert needs a unique, so emulate:
        id:
          (
            await tx.agent.findFirst({
              where: { orgId: org.id, slug: AGENT_SLUG },
              select: { id: true },
            })
          )?.id ?? "00000000-0000-0000-0000-000000000000",
      },
      update: { isPublic: true },
      create: {
        orgId: org.id,
        name: "WheelsHelper",
        slug: AGENT_SLUG,
        description:
          "WheelsAI's dogfood reference agent — answers platform questions and pays for its own compute.",
        framework: "elizaos",
        modelConfig: { model: "llama-3.3-70b-versatile", temperature: 0.6 },
        sourceType: "github",
        sourceUrl: "https://gitlab.com/Bprime/WheelsAi/-/tree/main/examples/reference-agents/wheels-helper",
        isPublic: true,
        tags: ["dogfood", "reference"],
      },
    });

    const listing = await tx.agentListing.upsert({
      where: { agentId: agent.id },
      update: { status: "published" },
      create: {
        agentId: agent.id,
        title: "WheelsHelper",
        slug: AGENT_SLUG,
        shortDescription:
          "The WheelsAI reference agent. Tokenized on devnet; every compute payment it makes is publicly verifiable.",
        category: "other",
        sells: "copies",
        pricingModel: "tokenized",
        publisherId: org.id,
        publisherName: org.name,
        status: "published",
        publishedAt: new Date(),
      },
    });

    const token = await tx.agentToken.create({
      data: {
        agentListingId: listing.id,
        mintAddress: mint.toBase58(),
        creatorAddress: creatorArg,
        name: "WheelsHelper",
        symbol: "WHLS",
        status: "BONDING",
        treasuryAddress: treasuryPda.toBase58(),
      },
    });

    const treasury = await tx.agentTreasury.create({
      data: {
        tokenId: token.id,
        treasuryPdaAddress: treasuryPda.toBase58(),
        authorityBump: treasuryBump,
        solBalanceLamports: 0n,
        programInitialized: false,
      },
    });

    return { agent, listing, token, treasury };
  });

  console.log(
    JSON.stringify(
      {
        agentId: result.agent.id,
        agentSlug: result.agent.slug,
        listingId: result.listing.id,
        tokenId: result.token.id,
        mintAddress: mintArg,
        treasuryId: result.treasury.id,
        treasuryPdaAddress: result.treasury.treasuryPdaAddress,
        authorityBump: result.treasury.authorityBump,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
