/**
 * A payment returned, once (payments pass, batch 8).
 *
 * A request paid by x402 whose payment landed and which was then not
 * answered gets its payment back as credits. One transaction:
 *
 *   1. the organization's `x402RefundCarryMicroUsd` grows by what was
 *      actually sent. This is the FIRST write, so two returns for one
 *      organization queue on its balance row;
 *   2. the payment goes to "refunded" by compare-and-set on
 *      `servedAt IS NULL AND refundedAt IS NULL`, with `refundedAt` and
 *      `refundMicroUsd`. A lost compare-and-set rolls step 1 back and
 *      returns nothing;
 *   3. whole cents in the carry (10,000 micro-dollars a cent) move to the
 *      balance with ONE ledger row of type `x402_refund`, and the carry
 *      keeps the rest.
 *
 * What is returned is what the transfer carried, which may be more than
 * the request asked for:
 *   USDC  the base units, which are micro-dollars;
 *   SOL   the lamports at the rate on the payment's row, rounded down.
 *
 * A payment at a listing's x402 door is never returned: its payer has no
 * account, and its row names the SELLER's organization, whose credits it
 * would land in. Such a row is refused before anything is written.
 *
 * Whole numbers only. Pure: the database is an argument.
 */

import { LAMPORTS_PER_SOL_BIGINT } from "./solPrice.js";

export const MICRO_USD_PER_CENT = 10_000n;

export const X402_REFUND_LEDGER_TYPE = "x402_refund";
export const X402_REFUND_LEDGER_DESCRIPTION = "Paid request returned as credits";

/** What a returned payment's row says in `failureReason`. Our own words. */
export const X402_REFUNDED_REASON =
  "The request was not answered. The payment was returned to the credit balance.";

/** The statuses a payment can be returned from. */
export type X402RefundableStatus = "submitted" | "verified";

/** The columns of a payment the return reads. */
export interface X402RefundPaymentRow {
  id: string;
  orgId: string;
  /** Set on a payment at a listing's door, which is never returned. */
  listingId: string | null;
  asset: string;
  amountReceivedRaw: string | null;
  solMicroUsdPerSol: bigint | null;
}

export interface X402RefundTx {
  x402Payment: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        orgId: true;
        listingId: true;
        asset: true;
        amountReceivedRaw: true;
        solMicroUsdPerSol: true;
      };
    }): Promise<X402RefundPaymentRow | null>;
    updateMany(args: {
      where: {
        id: string;
        status: { in: X402RefundableStatus[] };
        servedAt: null;
        refundedAt: null;
      };
      data: {
        status: "refunded";
        refundedAt: Date;
        refundMicroUsd: bigint;
        failureReason: string;
      };
    }): Promise<{ count: number }>;
  };
  creditBalance: {
    upsert(args: {
      where: { orgId: string };
      create: { orgId: string; balanceCents: bigint; x402RefundCarryMicroUsd: bigint };
      update: { x402RefundCarryMicroUsd: { increment: bigint } };
    }): Promise<{ balanceCents: bigint; x402RefundCarryMicroUsd: bigint }>;
    update(args: {
      where: { orgId: string };
      data: {
        balanceCents: { increment: bigint };
        x402RefundCarryMicroUsd: { decrement: bigint };
      };
    }): Promise<{ balanceCents: bigint; x402RefundCarryMicroUsd: bigint }>;
  };
  creditTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
}

/** A database that runs a function in one transaction, rolled back on a throw. */
export interface X402RefundDb {
  $transaction<T>(fn: (tx: X402RefundTx) => Promise<T>): Promise<T>;
}

export interface X402RefundInput {
  paymentId: string;
  /** The statuses the payment may be in. Anything else returns nothing. */
  from: X402RefundableStatus[];
  now: Date;
}

export type X402RefundResult =
  | {
      returned: true;
      orgId: string;
      /** What went back, in micro-dollars. */
      refundMicroUsd: bigint;
      /** Whole cents that moved to the balance with this return. */
      creditedCents: bigint;
      /** What the carry holds after it. Under a cent. */
      carryMicroUsd: bigint;
    }
  | {
      returned: false;
      reason:
        /** No such payment. */
        | "not_found"
        /** The row does not say what was sent. Nothing is guessed. */
        | "no_amount"
        /** Already served, already returned, or not in a status to return from. */
        | "already_ended"
        /** A payment at a listing's door: never returned as credits. */
        | "not_refundable";
    };

const WHOLE_NUMBER = /^[0-9]{1,30}$/;

/**
 * What a payment is worth in micro-dollars when it goes back: what was
 * actually sent. null when the row does not say.
 */
export function x402RefundMicroUsd(row: {
  asset: string;
  amountReceivedRaw: string | null;
  solMicroUsdPerSol: bigint | null;
}): bigint | null {
  const raw = row.amountReceivedRaw;
  if (typeof raw !== "string" || !WHOLE_NUMBER.test(raw)) return null;
  const amount = BigInt(raw);
  if (row.asset === "USDC") return amount;
  if (row.asset === "SOL") {
    const rate = row.solMicroUsdPerSol;
    if (typeof rate !== "bigint" || rate <= 0n) return null;
    return (amount * rate) / LAMPORTS_PER_SOL_BIGINT;
  }
  return null;
}

/** Thrown inside the transaction to roll the carry back. Never leaves this file. */
class RefundLost extends Error {}

/**
 * Return a payment to its organization's credits. At most once per
 * payment, whoever calls and however often. A database error is thrown to
 * the caller with nothing written.
 */
export async function returnX402Payment(
  db: X402RefundDb,
  input: X402RefundInput,
): Promise<X402RefundResult> {
  try {
    return await db.$transaction(async (tx): Promise<X402RefundResult> => {
      const row = await tx.x402Payment.findUnique({
        where: { id: input.paymentId },
        select: {
          id: true,
          orgId: true,
          listingId: true,
          asset: true,
          amountReceivedRaw: true,
          solMicroUsdPerSol: true,
        },
      });
      if (!row) return { returned: false, reason: "not_found" };
      // Before any write: the carry is the first one. (!= on purpose: the
      // column is selected, so only a row from before the door reads it
      // as anything but a string or null.)
      if (row.listingId != null) return { returned: false, reason: "not_refundable" };
      const refundMicroUsd = x402RefundMicroUsd(row);
      if (refundMicroUsd === null) return { returned: false, reason: "no_amount" };

      // 1. The carry, first: the lock on the organization's balance row.
      const grown = await tx.creditBalance.upsert({
        where: { orgId: row.orgId },
        create: { orgId: row.orgId, balanceCents: 0n, x402RefundCarryMicroUsd: refundMicroUsd },
        update: { x402RefundCarryMicroUsd: { increment: refundMicroUsd } },
      });

      // 2. The payment, once.
      const claimed = await tx.x402Payment.updateMany({
        where: {
          id: row.id,
          status: { in: input.from },
          servedAt: null,
          refundedAt: null,
        },
        data: {
          status: "refunded",
          refundedAt: input.now,
          refundMicroUsd,
          failureReason: X402_REFUNDED_REASON,
        },
      });
      if (claimed.count !== 1) throw new RefundLost();

      // 3. Whole cents move to the balance, with their one ledger row.
      const cents = grown.x402RefundCarryMicroUsd / MICRO_USD_PER_CENT;
      if (cents <= 0n) {
        return {
          returned: true,
          orgId: row.orgId,
          refundMicroUsd,
          creditedCents: 0n,
          carryMicroUsd: grown.x402RefundCarryMicroUsd,
        };
      }
      const after = await tx.creditBalance.update({
        where: { orgId: row.orgId },
        data: {
          balanceCents: { increment: cents },
          x402RefundCarryMicroUsd: { decrement: cents * MICRO_USD_PER_CENT },
        },
      });
      await tx.creditTransaction.create({
        data: {
          orgId: row.orgId,
          amountCents: cents,
          type: X402_REFUND_LEDGER_TYPE,
          description: X402_REFUND_LEDGER_DESCRIPTION,
          referenceId: row.id,
          balanceAfter: after.balanceCents,
        },
      });
      return {
        returned: true,
        orgId: row.orgId,
        refundMicroUsd,
        creditedCents: cents,
        carryMicroUsd: after.x402RefundCarryMicroUsd,
      };
    });
  } catch (err) {
    if (err instanceof RefundLost) return { returned: false, reason: "already_ended" };
    throw err;
  }
}
