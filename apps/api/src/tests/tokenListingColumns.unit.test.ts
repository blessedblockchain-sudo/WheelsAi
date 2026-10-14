import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";

// A token's reads are public (GET /api/tokens, /trending and /:id), and each
// joins the token's listing. They send the columns the token pages show and
// never the whole row, which also holds what only the listing's owner reads:
// the switch for paying from a wallet, the tools a buyer may use, when the
// listing was paused, what its uses cost on the platform's model keys.

type Row = Record<string, any>;

const ORG = "org_pub";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

test("a token's public reads send the columns of its listing the token pages show, never the whole row", async () => {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const tokens = await import("../services/agentToken.js");
  // A listing with a token and the switch on, joined as Prisma joins it:
  // `true` sends the whole row, a select sends what it names.
  const listing = {
    id: LISTING_ID,
    agentId: AGENT_ID,
    publisherId: ORG,
    title: "Research Analyst",
    slug: "research-analyst",
    shortDescription: "Reads filings and answers questions.",
    iconUrl: null,
    publisherName: "Pub Org",
    category: "research",
    avgRating: 4.5,
    totalInstalls: 3,
    totalRequests: 7n,
    sells: "use",
    pricingModel: "tokenized",
    pricePerRequestCents: 5n,
    x402Enabled: true,
    useAllowedTools: ["calculator"],
    pausedSince: null,
    useModelCostMicros: 1234n,
  };
  const joined = (include: Row | undefined) => {
    const asked = include?.agentListing;
    if (asked === true) return { ...listing };
    return Object.fromEntries(Object.keys(asked.select).map((k) => [k, (listing as Row)[k]]));
  };
  const token = { id: "tok_1", agentListingId: LISTING_ID, mintAddress: "Mint1111", name: "Analyst", symbol: "ANL" };
  const original = prisma.agentToken;
  prisma.agentToken = {
    findUnique: async (args: Row) => ({ ...token, agentListing: joined(args.include) }),
    findMany: async (args: Row) => [{ ...token, agentListing: joined(args.include) }],
    count: async () => 1,
  };
  try {
    const listingsRead = [
      (await tokens.getToken("tok_1"))!.agentListing,
      (await tokens.getTokenByMint("Mint1111"))!.agentListing,
      (await tokens.listTokens()).tokens[0]!.agentListing,
      (await tokens.getTrendingTokens())[0]!.agentListing,
    ];
    for (const read of listingsRead) {
      assert.deepEqual(Object.keys(read).sort(), [
        "avgRating",
        "category",
        "id",
        "slug",
        "title",
        "totalInstalls",
        "totalRequests",
      ]);
    }
    const [board] = await tokens.getLeaderboard();
    assert.equal("x402Enabled" in (board!.agentListing as Row), false);
  } finally {
    prisma.agentToken = original;
  }

  // createToken has no caller (its route answers 410), so its read is held
  // by the source: no read in the file joins the whole listing row.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../services/agentToken.ts"), "utf8");
  assert.doesNotMatch(source, /agentListing: true/);
});
