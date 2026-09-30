/**
 * Credits billing for OpenAI-compatible inference (`/v1`).
 *
 * The route used to admit any org holding >= 10 cents, run the request with
 * an unbounded max_tokens, then decrement the ACTUAL cost unconditionally
 * with a balanceAfter computed from a pre-request read. Concurrent or large
 * requests drove balances negative (the platform paid the GPU) and wrote
 * ledger rows whose balanceAfter was wrong.
 *
 * Now: hold the worst-case cost before proxying (conditional decrement, so
 * concurrent requests cannot jointly overdraw), then settle to the actual
 * cost afterwards, releasing the difference. If the request never reaches
 * a node, the whole hold is released. Every balance change writes a ledger
 * row whose balanceAfter is read inside the same transaction.
 */

export const DEFAULT_COMPLETION_TOKENS = 4096;
export const MAX_COMPLETION_TOKENS = 8192;
/** Prompt tokens are estimated from characters; hold a margin over it. */
export const PROMPT_ESTIMATE_MARGIN = 1.25;

export interface InferenceHoldPrisma {
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
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

export type HoldResult =
  | { ok: true; heldCents: bigint }
  | { ok: false; reason: "insufficient_credits"; requiredCents: bigint };

async function debit(
  tx: InferenceHoldPrisma,
  orgId: string,
  cents: bigint,
): Promise<bigint | null> {
  const claimed = await tx.creditBalance.updateMany({
    where: { orgId, balanceCents: { gte: cents } },
    data: { balanceCents: { decrement: cents } },
  });
  if (claimed.count === 0) return null;
  const after = await tx.creditBalance.findUnique({ where: { orgId } });
  return after?.balanceCents ?? 0n;
}

/** Run inside prisma.$transaction. */
export async function holdInferenceCredits(
  tx: InferenceHoldPrisma,
  args: { orgId: string; holdCents: bigint; requestId: string; description: string },
): Promise<HoldResult> {
  const holdCents = args.holdCents < 1n ? 1n : args.holdCents;
  const balanceAfter = await debit(tx, args.orgId, holdCents);
  if (balanceAfter === null) {
    return { ok: false, reason: "insufficient_credits", requiredCents: holdCents };
  }
  await tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: -holdCents,
      type: "usage",
      description: `${args.description} (hold)`,
      referenceId: args.requestId,
      balanceAfter,
    },
  });
  return { ok: true, heldCents: holdCents };
}

async function credit(
  tx: InferenceHoldPrisma,
  args: { orgId: string; cents: bigint; requestId: string; description: string },
): Promise<void> {
  if (args.cents <= 0n) return;
  const after = await tx.creditBalance.update({
    where: { orgId: args.orgId },
    data: { balanceCents: { increment: args.cents } },
  });
  await tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: args.cents,
      type: "usage_release",
      description: args.description,
      referenceId: args.requestId,
      balanceAfter: after.balanceCents,
    },
  });
}

export type SettleResult = { chargedCents: bigint; shortfallCents: bigint };

/**
 * Settle a hold to the actual cost. Under the hold: release the rest.
 * Over it (the prompt estimate was low): charge the extra only if the
 * balance covers it; otherwise charge the hold and report the shortfall.
 * The balance never goes negative.
 */
export async function settleInferenceHold(
  tx: InferenceHoldPrisma,
  args: {
    orgId: string;
    heldCents: bigint;
    actualCents: bigint;
    requestId: string;
    description: string;
  },
): Promise<SettleResult> {
  const actual = args.actualCents < 0n ? 0n : args.actualCents;
  if (actual <= args.heldCents) {
    await credit(tx, {
      orgId: args.orgId,
      cents: args.heldCents - actual,
      requestId: args.requestId,
      description: `${args.description} (unused hold released)`,
    });
    return { chargedCents: actual, shortfallCents: 0n };
  }
  const extra = actual - args.heldCents;
  const balanceAfter = await debit(tx, args.orgId, extra);
  if (balanceAfter === null) {
    return { chargedCents: args.heldCents, shortfallCents: extra };
  }
  await tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: -extra,
      type: "usage",
      description: `${args.description} (usage above hold)`,
      referenceId: args.requestId,
      balanceAfter,
    },
  });
  return { chargedCents: actual, shortfallCents: 0n };
}

/** The request never produced billable work: give the whole hold back. */
export async function releaseInferenceHold(
  tx: InferenceHoldPrisma,
  args: { orgId: string; heldCents: bigint; requestId: string; reason: string },
): Promise<void> {
  await credit(tx, {
    orgId: args.orgId,
    cents: args.heldCents,
    requestId: args.requestId,
    description: `Inference hold released: ${args.reason}`,
  });
}
