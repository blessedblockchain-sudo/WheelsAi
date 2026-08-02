/**
 * The ONE way credits come into existence (B2/T1).
 *
 * Every rail that grants credits — Stripe webhook, wallet top-up
 * confirmation, the dev mock path — funnels through here, so the
 * invariant "balance moved ⇔ a ledger row explains it, with the right
 * balanceAfter" is enforced in exactly one place instead of being
 * re-implemented per rail.
 *
 * Contract:
 *   - Runs INSIDE the caller's transaction. Callers that also write a
 *     purchase-intent row (StripePurchase, WalletTopUp) must commit the
 *     status flip and the grant together, or a crash between them
 *     double-grants on retry.
 *   - The purchase row and the optional bonus row are separate ledger
 *     entries, each carrying the balance AFTER it applied — the running
 *     balance is reconstructable from the ledger alone.
 *   - referenceId is the rail's own idempotency anchor (Stripe session
 *     id, top-up row id). It is what makes a double-delivered webhook
 *     auditable after the fact.
 *
 * The prisma surface is a structural stub (mirroring
 * deploymentCreditGate.ts) so this is unit-testable without a database.
 */

export interface CreditGrantTxClient {
  creditBalance: {
    upsert: (args: {
      where: { orgId: string };
      update: { balanceCents: { increment: bigint } };
      create: { orgId: string; balanceCents: bigint };
    }) => Promise<{ balanceCents: bigint }>;
    update: (args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }) => Promise<{ balanceCents: bigint }>;
  };
  creditTransaction: {
    create: (args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }) => Promise<unknown>;
  };
}

export interface GrantCreditsInput {
  orgId: string;
  /** Paid amount in CENTS. Must be > 0. */
  amountCents: bigint;
  /** Bonus amount in CENTS. 0 or omitted for none. */
  bonusCents?: bigint;
  /** The rail's idempotency anchor (Stripe session id, top-up row id). */
  referenceId: string;
  /** Human description prefix, e.g. "Credit purchase" / "USDC top-up". */
  description: string;
  /** Optional prefix for non-production rails, e.g. "[devnet-test] ". */
  labelPrefix?: string;
}

export interface GrantCreditsResult {
  balanceAfterCents: bigint;
  grantedCents: bigint;
}

export async function grantCredits(
  tx: CreditGrantTxClient,
  input: GrantCreditsInput,
): Promise<GrantCreditsResult> {
  if (input.amountCents <= 0n) {
    throw new Error("grantCredits: amountCents must be positive");
  }
  const bonusCents = input.bonusCents ?? 0n;
  if (bonusCents < 0n) {
    throw new Error("grantCredits: bonusCents cannot be negative");
  }
  if (!input.referenceId) {
    throw new Error("grantCredits: referenceId is required for auditability");
  }

  const prefix = input.labelPrefix ?? "";

  const afterPurchase = await tx.creditBalance.upsert({
    where: { orgId: input.orgId },
    update: { balanceCents: { increment: input.amountCents } },
    create: { orgId: input.orgId, balanceCents: input.amountCents },
  });

  await tx.creditTransaction.create({
    data: {
      orgId: input.orgId,
      amountCents: input.amountCents,
      type: "purchase",
      description: `${prefix}${input.description}`,
      referenceId: input.referenceId,
      balanceAfter: afterPurchase.balanceCents,
    },
  });

  let balanceAfterCents = afterPurchase.balanceCents;

  if (bonusCents > 0n) {
    const afterBonus = await tx.creditBalance.update({
      where: { orgId: input.orgId },
      data: { balanceCents: { increment: bonusCents } },
    });
    await tx.creditTransaction.create({
      data: {
        orgId: input.orgId,
        amountCents: bonusCents,
        type: "bonus",
        description: `${prefix}Bonus credits`,
        referenceId: input.referenceId,
        balanceAfter: afterBonus.balanceCents,
      },
    });
    balanceAfterCents = afterBonus.balanceCents;
  }

  return {
    balanceAfterCents,
    grantedCents: input.amountCents + bonusCents,
  };
}
