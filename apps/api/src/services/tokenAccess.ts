/**
 * Token-gated access (the "Tokenized" pricing model) for an organization.
 *
 * A buyer org may run a token-gated marketplace agent while at least one
 * of its members has a linked wallet holding the minimum balance of the
 * listing's token. Balances come from AgentTokenHolder, kept current by
 * the token indexer, and are compared in integer raw units (D9).
 *
 * Checked per org rather than per request because agents also run
 * without a person in the loop (scheduler, workflows, test runs).
 */
import { tokensToRaw } from "../lib/tokenUnits.js";

/** Whole tokens a buyer org must hold to run a token-gated agent. */
export const TOKEN_GATE_MIN_TOKENS = 1;

export interface TokenAccessDb {
  orgMember: {
    findMany(args: {
      where: { orgId: string };
      select: { user: { select: { walletAddress: true } } };
    }): Promise<Array<{ user: { walletAddress: string | null } }>>;
  };
  agentTokenHolder: {
    findFirst(args: {
      where: { tokenId: string; walletAddress: { in: string[] }; balanceRaw: { gte: bigint } };
      select: { walletAddress: true };
    }): Promise<{ walletAddress: string } | null>;
  };
}

export async function orgHoldsToken(
  db: TokenAccessDb,
  args: { orgId: string; tokenId: string; minTokens?: number },
): Promise<boolean> {
  const members = await db.orgMember.findMany({
    where: { orgId: args.orgId },
    select: { user: { select: { walletAddress: true } } },
  });
  const wallets = members
    .map((m) => m.user.walletAddress)
    .filter((w): w is string => typeof w === "string" && w.length > 0);
  if (wallets.length === 0) return false;

  const holder = await db.agentTokenHolder.findFirst({
    where: {
      tokenId: args.tokenId,
      walletAddress: { in: wallets },
      balanceRaw: { gte: tokensToRaw(args.minTokens ?? TOKEN_GATE_MIN_TOKENS) },
    },
    select: { walletAddress: true },
  });
  return holder !== null;
}

export class TokenRequiredError extends Error {
  readonly code = "token_required";
  constructor(
    readonly listingTitle: string,
    readonly token: { symbol: string; mintAddress: string },
    readonly minTokens: number = TOKEN_GATE_MIN_TOKENS,
  ) {
    super(tokenRequiredMessage(listingTitle, token, minTokens));
    this.name = "TokenRequiredError";
  }
}

export function tokenRequiredMessage(
  listingTitle: string,
  token: { symbol: string; mintAddress: string },
  minTokens: number = TOKEN_GATE_MIN_TOKENS,
): string {
  return `"${listingTitle}" is token-gated: a wallet linked to someone in your organization must hold at least ${minTokens} ${token.symbol} (mint ${token.mintAddress}). Link a wallet in Settings, or buy ${token.symbol}.`;
}
