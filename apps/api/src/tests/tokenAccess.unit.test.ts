import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import {
  licenceRevokedMessage,
  resolveInstallBilling,
} from "../services/marketplaceMetering.js";
import { normalizeListingPricing } from "../services/marketplace.js";
import { orgHoldsToken, TokenRequiredError } from "../services/tokenAccess.js";

// Token-gated ("Tokenized") marketplace listings (claims ledger M1). A
// buyer org runs the agent while one of its members' linked wallets holds
// the listing's token; before the token launches the listing is free.

const TOKEN = { id: "tok_1", symbol: "RSRCH", mintAddress: "MintRsrch1111111111111111111111111111111111" };

function holdingDb(opts: { wallets: Array<string | null>; holders: Record<string, bigint> }) {
  const queries: unknown[] = [];
  return {
    queries,
    db: {
      orgMember: {
        findMany: async () => opts.wallets.map((walletAddress) => ({ user: { walletAddress } })),
      },
      agentTokenHolder: {
        findFirst: async (args: {
          where: { tokenId: string; walletAddress: { in: string[] }; balanceRaw: { gte: bigint } };
        }) => {
          queries.push(args.where);
          const hit = args.where.walletAddress.in.find(
            (w) => (opts.holders[w] ?? 0n) >= args.where.balanceRaw.gte,
          );
          return hit ? { walletAddress: hit } : null;
        },
      },
    },
  };
}

test("an org holds the token when any member's linked wallet has at least one whole token", async () => {
  const { db, queries } = holdingDb({ wallets: ["WalletA", null, "WalletB"], holders: { WalletB: 1_000_000n } });
  assert.equal(await orgHoldsToken(db, { orgId: "org_buyer", tokenId: TOKEN.id }), true);
  // Compared in raw units (6 decimals), over the members' wallets only.
  assert.deepEqual(queries[0], {
    tokenId: TOKEN.id,
    walletAddress: { in: ["WalletA", "WalletB"] },
    balanceRaw: { gte: 1_000_000n },
  });
});

test("a fraction of a token, or no linked wallet at all, is not enough", async () => {
  assert.equal(
    await orgHoldsToken(holdingDb({ wallets: ["WalletA"], holders: { WalletA: 999_999n } }).db, {
      orgId: "o",
      tokenId: TOKEN.id,
    }),
    false,
  );
  const noWallets = holdingDb({ wallets: [null], holders: {} });
  assert.equal(await orgHoldsToken(noWallets.db, { orgId: "o", tokenId: TOKEN.id }), false);
  assert.equal(noWallets.queries.length, 0);
});

function tokenizedLookup(opts: {
  token: typeof TOKEN | null;
  holds?: boolean;
  withHolderTables?: boolean;
  installStatus?: string;
}) {
  const holding = holdingDb({ wallets: ["WalletA"], holders: opts.holds ? { WalletA: 5_000_000n } : {} });
  return {
    agentInstall: {
      findFirst: async () => ({
        id: "ins_1",
        listingId: "lst_1",
        buyerId: "org_buyer",
        status: opts.installStatus ?? "active",
        acceptedPricingModel: "tokenized",
        acceptedPricePerRequestCents: null,
        listing: {
          title: "Research Analyst",
          status: "published",
          publisherId: "org_pub",
          pricingModel: "tokenized",
          pricePerRequestCents: null,
          agentToken: opts.token,
        },
      }),
    },
    ...(opts.withHolderTables === false ? {} : holding.db),
  };
}

const ARGS = { agentId: "agent_clone", orgId: "org_buyer" };

test("a token-gated install is free before its token launches", async () => {
  assert.deepEqual(await resolveInstallBilling(tokenizedLookup({ token: null }) as never, ARGS), { kind: "free" });
});

test("once the token exists, holders run the agent and everyone else is refused with the token to buy", async () => {
  assert.deepEqual(await resolveInstallBilling(tokenizedLookup({ token: TOKEN, holds: true }) as never, ARGS), {
    kind: "free",
  });
  assert.deepEqual(await resolveInstallBilling(tokenizedLookup({ token: TOKEN, holds: false }) as never, ARGS), {
    kind: "revoked",
    listingTitle: "Research Analyst",
    reason: "token_required",
    token: { symbol: TOKEN.symbol, mintAddress: TOKEN.mintAddress },
  });
});

test("a lookup surface without holder tables fails closed once a token exists", async () => {
  const billing = await resolveInstallBilling(
    tokenizedLookup({ token: TOKEN, holds: true, withHolderTables: false }) as never,
    ARGS,
  );
  assert.equal(billing.kind, "revoked");
});

test("a suspended install is not reported as an uninstall: on a listing that left monthly it waits for the new pricing to be accepted", async () => {
  // Only a subscription suspends an install, and this listing is now
  // token-gated: "resubscribe" would be the wrong thing to tell the buyer.
  assert.deepEqual(
    await resolveInstallBilling(tokenizedLookup({ token: null, installStatus: "suspended" }) as never, ARGS),
    { kind: "revoked", listingTitle: "Research Analyst", reason: "pricing_changed" },
  );
});

test("each revocation reason tells the buyer what to do", () => {
  assert.match(licenceRevokedMessage("A", "uninstalled"), /uninstalled it\. Reinstall/);
  assert.match(licenceRevokedMessage("A", "subscription_lapsed"), /not paid up\. Resubscribe/);
  const tokenMessage = licenceRevokedMessage("A", "token_required", TOKEN);
  assert.match(tokenMessage, /at least 1 RSRCH/);
  assert.ok(tokenMessage.includes(TOKEN.mintAddress));
  assert.equal(new TokenRequiredError("A", TOKEN).message, tokenMessage);
});

test("listing pricing keeps exactly the price its model needs", () => {
  assert.deepEqual(normalizeListingPricing("per_request", { pricePerRequestCents: 5, monthlyPriceCents: 900 }), {
    pricePerRequestCents: 5n,
    monthlyPriceCents: null,
  });
  assert.deepEqual(normalizeListingPricing("monthly", { pricePerRequestCents: 5, monthlyPriceCents: 900 }), {
    pricePerRequestCents: null,
    monthlyPriceCents: 900n,
  });
  for (const model of ["free", "tokenized"] as const) {
    assert.deepEqual(normalizeListingPricing(model, { pricePerRequestCents: 5, monthlyPriceCents: 900 }), {
      pricePerRequestCents: null,
      monthlyPriceCents: null,
    });
  }
  assert.throws(() => normalizeListingPricing("monthly", { monthlyPriceCents: null }), /Monthly price is required/);
  assert.throws(() => normalizeListingPricing("per_request", {}), /Price per request is required/);
});
