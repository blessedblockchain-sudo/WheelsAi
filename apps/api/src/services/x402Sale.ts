// The sale a payment at a listing's x402 door becomes, once the chain has
// confirmed it.
//
// A caller with no account paid one use of an agent from its own wallet; its
// answer was made, checked and held, and the payment was signed, sent and
// confirmed. Now, in ONE database transaction, in this order:
//
//   1. the payment goes from "submitted" to "verified" and served, by
//      compare-and-set: a second run for the same payment writes nothing;
//   2. the price is the one PAID (its atomic units over 10,000, never a
//      partial cent), split 90 and 10 as every sale is;
//   3. one marketplace_revenue row with no buyer: the paying wallet and the
//      payment instead (a payment is one sale at most, held by a database
//      unique), type "x402", settled;
//   4. the model cost of the use, taken as a settled use's is (only the whole
//      cents the listing's running total crosses, never more than the
//      creator's amount);
//   5. contributors' shares, then the publisher's amount through the
//      earnings ledger: no profile throws, and everything rolls back;
//   6. the listing's count of requests.
//
// No licence, no install, no credit row and no credit balance: a payment
// from a wallet is never anyone's credits. The caller writes the sale only
// for an answer it will release, and releases the answer only once the sale
// is written.
//
// services/marketplaceMetering.ts is not changed: the model-cost block of
// settleMarketplaceRequest is followed here.
//
// Pure: the transaction is an argument.

import { splitCreatorRevenue, type ContributorSplitTx } from "./contributorSplits.js";
import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";
import { centsCrossed, splitRevenue, type RevenueSplit } from "./marketplaceMetering.js";

/** The revenue type of a sale paid from a wallet at the door. */
export const X402_SALE_TYPE = "x402";

/** One cent of USDC in atomic units (6 decimals). */
const USDC_ATOMIC_PER_CENT = 10_000n;

const WHOLE_ATOMIC_UNITS = /^[1-9][0-9]{0,29}$/;

/** What the sale's transaction needs. Prisma's transaction client satisfies it. */
export interface X402SaleTx extends EarningsLedgerTx {
  x402Payment: {
    updateMany(args: {
      where: {
        id: string;
        status: "submitted";
        listingId: string;
        orgId: string;
        payerAddress: string;
        amountRaw: string;
        servedAt: null;
      };
      data: {
        status: "verified";
        verifiedAt: Date;
        servedAt: Date;
        amountReceivedRaw: string;
        failureReason: null;
      };
    }): Promise<{ count: number }>;
  };
  marketplaceRevenue: {
    create(args: {
      data: {
        listingId: string;
        publisherId: string;
        buyerId: null;
        installId: null;
        payerWallet: string;
        x402PaymentId: string;
        type: typeof X402_SALE_TYPE;
        grossAmountCents: bigint;
        platformFeeCents: bigint;
        creatorAmountCents: bigint;
        requestCount: 1;
        status: "settled";
        settledAt: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: { platformFeeCents: { increment: bigint }; creatorAmountCents: { decrement: bigint } };
    }): Promise<unknown>;
  };
  agentListing: {
    /**
     * Both of the listing's counters. updateMany, because the listing may be
     * gone (its agent deleted while the payment waited for the chain): a
     * count of 0 is an answer, and the sale is still written.
     */
    updateMany(
      args:
        | { where: { id: string }; data: { useModelCostMicros: { increment: bigint } } }
        | { where: { id: string }; data: { totalRequests: { increment: bigint } } },
    ): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { useModelCostMicros: true };
    }): Promise<{ useModelCostMicros: bigint } | null>;
  };
}

export interface X402SaleInput {
  /** The payment's row, "submitted". */
  paymentId: string;
  listingId: string;
  /** For the earnings statement: "Sale: <title>". */
  listingTitle: string;
  /** The listing's publisher, the payment row's organization. */
  publisherId: string;
  /** The wallet that paid: the row's payer. */
  payerWallet: string;
  /** What was paid, in USDC atomic units: the row's amount, which the transfer carried exactly. */
  amountRaw: string;
  /** What the use cost on the platform's model keys, in millionths of a cent. */
  modelCostMicros?: bigint;
  now: Date;
}

export type X402SaleResult =
  | {
      written: true;
      revenueId: string;
      /** The amounts as the revenue row holds them, the model cost moved to the platform. */
      split: RevenueSplit & { modelCostCents: bigint };
    }
  /** The payment was not "submitted" and unserved for this listing, payer and amount: nothing was written. */
  | { written: false };

/** The price paid, in whole cents. A remainder is a mistake upstream, never a partial cent. */
export function x402PricePaidCents(amountRaw: string): bigint {
  if (!WHOLE_ATOMIC_UNITS.test(amountRaw)) throw new Error("x402 sale: the amount paid is not a whole number of atomic units");
  const atomic = BigInt(amountRaw);
  if (atomic % USDC_ATOMIC_PER_CENT !== 0n) throw new Error("x402 sale: the amount paid is not a whole number of cents");
  return atomic / USDC_ATOMIC_PER_CENT;
}

/**
 * Write the sale of one confirmed door payment, in the six steps above.
 * Run INSIDE one prisma.$transaction: a throw rolls every step back and
 * leaves the payment "submitted".
 */
export async function recordX402Sale(tx: X402SaleTx, input: X402SaleInput): Promise<X402SaleResult> {
  // 1. The payment, once, and only as it was claimed.
  const claimed = await tx.x402Payment.updateMany({
    where: {
      id: input.paymentId,
      status: "submitted",
      listingId: input.listingId,
      orgId: input.publisherId,
      payerAddress: input.payerWallet,
      amountRaw: input.amountRaw,
      servedAt: null,
    },
    data: {
      status: "verified",
      verifiedAt: input.now,
      servedAt: input.now,
      amountReceivedRaw: input.amountRaw,
      failureReason: null,
    },
  });
  if (claimed.count !== 1) return { written: false };

  // 2. The price paid, split as every sale is.
  const split = splitRevenue(x402PricePaidCents(input.amountRaw), 1);

  // 3. The sale, with no buyer.
  const revenue = await tx.marketplaceRevenue.create({
    data: {
      listingId: input.listingId,
      publisherId: input.publisherId,
      buyerId: null,
      installId: null,
      payerWallet: input.payerWallet,
      x402PaymentId: input.paymentId,
      type: X402_SALE_TYPE,
      grossAmountCents: split.grossCents,
      platformFeeCents: split.platformFeeCents,
      creatorAmountCents: split.creatorCents,
      requestCount: 1,
      status: "settled",
      settledAt: input.now,
    },
    select: { id: true },
  });

  // 4. The model cost, as settleMarketplaceRequest takes it: the use's
  // millionths join the listing's running total, and only the whole cents
  // that total has just crossed move from the creator to the platform,
  // never more than the creator has on this row. The increment comes
  // first, so the row is locked before its total is read: two sales of
  // one listing at once each see a total that includes the other or not.
  let creatorCents = split.creatorCents;
  let modelCostCents = 0n;
  const modelCostMicros = input.modelCostMicros ?? 0n;
  if (modelCostMicros > 0n) {
    const added = await tx.agentListing.updateMany({
      where: { id: input.listingId },
      data: { useModelCostMicros: { increment: modelCostMicros } },
    });
    // A listing that is gone has no running total: nothing is taken.
    const listing =
      added.count === 1
        ? await tx.agentListing.findUnique({ where: { id: input.listingId }, select: { useModelCostMicros: true } })
        : null;
    if (listing) {
      const crossed = centsCrossed(listing.useModelCostMicros, modelCostMicros);
      modelCostCents = crossed > creatorCents ? creatorCents : crossed;
      if (modelCostCents > 0n) {
        await tx.marketplaceRevenue.update({
          where: { id: revenue.id },
          data: {
            platformFeeCents: { increment: modelCostCents },
            creatorAmountCents: { decrement: modelCostCents },
          },
        });
        creatorCents -= modelCostCents;
      }
    }
  }

  // 5. Contributors' shares, then the publisher's amount, through the ledger.
  // The same structural cast as settleMarketplaceRequest: a Prisma
  // transaction has every table the split reads.
  const { publisherCents } = await splitCreatorRevenue(tx as unknown as Partial<ContributorSplitTx>, {
    revenueId: revenue.id,
    listingId: input.listingId,
    publisherId: input.publisherId,
    creatorCents,
  });
  const credited = await moveEarnings(tx, {
    orgId: input.publisherId,
    amountCents: publisherCents,
    type: "sale",
    referenceId: revenue.id,
    description: `Sale: ${input.listingTitle}`,
  });
  // Thrown, so the transaction rolls back and the payment stays "submitted".
  if (!credited.moved) {
    throw new Error(`No publisher profile to credit a sale to (organization ${input.publisherId})`);
  }

  // 6. The listing's count, if the listing is still there.
  await tx.agentListing.updateMany({
    where: { id: input.listingId },
    data: { totalRequests: { increment: 1n } },
  });

  return {
    written: true,
    revenueId: revenue.id,
    split: {
      grossCents: split.grossCents,
      platformFeeCents: split.platformFeeCents + modelCostCents,
      creatorCents,
      modelCostCents,
    },
  };
}
