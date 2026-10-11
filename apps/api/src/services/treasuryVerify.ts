/**
 * Proving the treasury (payments pass, batch 6). The sweep sends money to
 * TREASURY_WALLET_ADDRESS only once somebody has shown they hold its key:
 * a transfer of at least 0.1 SOL from that address to the hot wallet,
 * signed by it. An address typed wrong, or an exchange's deposit address,
 * can never pass, because nobody can sign for it.
 *
 * Pure: the setting, the node and the database are arguments
 * (scripts/treasury-verify.ts binds them). It reads the hot wallet's
 * finalized history, newest first, up to 1,000 signatures, for a
 * transaction that
 *   - did not fail,
 *   - the treasury address SIGNED, and
 *   - left the hot wallet with at least 100,000,000 lamports more.
 * Found: the platform_wallets row for this chain is written (role
 * "treasury", the address, now, that signature), replacing a row for an
 * older address. Not found: nothing is written. `dryRun` writes nothing.
 */

import type { TransactionFacts } from "./depositScan.js";
import type { ChainLabel } from "./depositTypes.js";
import { readTreasuryAddress, type TreasuryRefusal } from "./sweepPlan.js";

/** 0.1 SOL: what the proof transfer must leave the hot wallet with. */
export const TREASURY_PROOF_MIN_LAMPORTS = 100_000_000n;
/** How far back the hot wallet's history is read. */
export const TREASURY_PROOF_MAX_SIGNATURES = 1_000;

/**
 * Is this transaction the proof? It did not fail, the treasury address is
 * one of its signers, and the hot wallet ended it with at least 0.1 SOL
 * more than it began with.
 */
export function isTreasuryProof(
  facts: TransactionFacts,
  wallets: { treasury: string; hotWallet: string },
): boolean {
  if (facts.failed) return false;
  if (wallets.treasury === wallets.hotWallet) return false;
  if (!facts.signers.includes(wallets.treasury)) return false;
  const index = facts.accountKeys.indexOf(wallets.hotWallet);
  if (index < 0) return false;
  const before = facts.preLamports[index];
  const after = facts.postLamports[index];
  if (typeof before !== "bigint" || typeof after !== "bigint") return false;
  return after - before >= TREASURY_PROOF_MIN_LAMPORTS;
}

export interface TreasuryVerifyDeps {
  network: ChainLabel;
  /** `{ ok: true }` only when the node is on the configured cluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** TREASURY_WALLET_ADDRESS. */
  treasurySetting: string | null | undefined;
  /** The hot wallet's address. May throw (no master key). */
  hotWalletAddress: () => string;
  /** Is this a deposit address of an organization? */
  isDepositAddress: (address: string) => Promise<boolean>;
  /** The row with role "treasury" for this chain, or null. */
  loadProof: () => Promise<{ address: string; proofSignature: string } | null>;
  /** The hot wallet's signatures at "finalized", newest first. */
  listHotWalletSignatures: (args: {
    limit: number;
  }) => Promise<Array<{ signature: string; failed: boolean }>>;
  /** One finalized transaction's facts; null when it cannot be loaded. */
  loadTransaction: (signature: string) => Promise<TransactionFacts | null>;
  /** Writes the row for this chain, replacing one that is there. */
  saveProof: (proof: {
    address: string;
    proofSignature: string;
    verifiedAt: Date;
  }) => Promise<void>;
  now?: () => Date;
}

export type TreasuryVerifyResult =
  /** The address can never be a treasury. Nothing was read or written. */
  | { outcome: "refused"; reason: TreasuryRefusal | "chain_unavailable" | "no_hot_wallet"; message: string }
  /** The row already proves this address. Nothing was written. */
  | { outcome: "already_proven"; address: string; proofSignature: string; message: string }
  /** The proof was found. `written` is false on a dry run. */
  | { outcome: "proven"; address: string; proofSignature: string; written: boolean; replaced: string | null; message: string }
  /** No proof in the hot wallet's history. Nothing was written. */
  | { outcome: "not_found"; address: string; hotWallet: string; looked: number; unreadable: number; message: string };

const REFUSALS: Record<string, string> = {
  not_set:
    "TREASURY_WALLET_ADDRESS is not set (it is still the default, the System Program address, which nobody holds a key for). Set it to the treasury wallet's address and run this again.",
  not_a_wallet:
    "TREASURY_WALLET_ADDRESS is not an ordinary wallet address. A token account or a program's address has no key that could move what is sent to it.",
  is_hot_wallet:
    "TREASURY_WALLET_ADDRESS is the hot wallet. The treasury must be a wallet whose key is not in the product.",
  is_deposit_address:
    "TREASURY_WALLET_ADDRESS is a deposit address of an organization. The treasury must be a wallet whose key is not in the product.",
};

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export async function verifyTreasury(
  input: { dryRun: boolean },
  deps: TreasuryVerifyDeps,
): Promise<TreasuryVerifyResult> {
  let hotWallet: string;
  try {
    hotWallet = deps.hotWalletAddress();
  } catch (err) {
    return {
      outcome: "refused",
      reason: "no_hot_wallet",
      message: `The hot wallet could not be derived (${errorText(err)}). Nothing was checked.`,
    };
  }

  // The checks that need no read first, then the one that reads.
  const plain = readTreasuryAddress({
    setting: deps.treasurySetting,
    hotWalletAddress: hotWallet,
    isDepositAddress: () => false,
  });
  if (!plain.ok) {
    return { outcome: "refused", reason: plain.reason, message: REFUSALS[plain.reason] ?? plain.reason };
  }
  const treasury = plain.address;
  if (await deps.isDepositAddress(treasury)) {
    return {
      outcome: "refused",
      reason: "is_deposit_address",
      message: REFUSALS.is_deposit_address as string,
    };
  }

  const existing = await deps.loadProof();
  if (existing && existing.address === treasury) {
    return {
      outcome: "already_proven",
      address: treasury,
      proofSignature: existing.proofSignature,
      message: `The treasury ${treasury} is already proven on ${deps.network}, by transaction ${existing.proofSignature}. Nothing was written.`,
    };
  }

  let cluster: { ok: boolean; reason?: string };
  try {
    cluster = await deps.checkCluster();
  } catch {
    cluster = { ok: false, reason: "unreachable" };
  }
  if (!cluster.ok) {
    return {
      outcome: "refused",
      reason: "chain_unavailable",
      message: `The Solana node is not on the configured cluster, or cannot be reached (${cluster.reason ?? "unknown"}). Nothing was checked.`,
    };
  }

  const entries = (
    await deps.listHotWalletSignatures({ limit: TREASURY_PROOF_MAX_SIGNATURES })
  ).slice(0, TREASURY_PROOF_MAX_SIGNATURES);

  let looked = 0;
  let unreadable = 0;
  for (const entry of entries) {
    if (entry.failed) continue;
    looked += 1;
    let facts: TransactionFacts | null;
    try {
      facts = await deps.loadTransaction(entry.signature);
    } catch {
      facts = null;
    }
    if (!facts) {
      unreadable += 1;
      continue;
    }
    if (!isTreasuryProof(facts, { treasury, hotWallet })) continue;

    const replaced = existing ? existing.address : null;
    if (!input.dryRun) {
      await deps.saveProof({
        address: treasury,
        proofSignature: entry.signature,
        verifiedAt: (deps.now ?? (() => new Date()))(),
      });
    }
    const what = input.dryRun
      ? "Dry run: nothing was written."
      : replaced
        ? `The row for ${deps.network} was replaced (it named ${replaced}).`
        : `The row for ${deps.network} was written.`;
    return {
      outcome: "proven",
      address: treasury,
      proofSignature: entry.signature,
      written: !input.dryRun,
      replaced,
      message: `The treasury ${treasury} is proven: it signed transaction ${entry.signature}, which left the hot wallet ${hotWallet} with at least 0.1 SOL more. ${what}`,
    };
  }

  return {
    outcome: "not_found",
    address: treasury,
    hotWallet,
    looked,
    unreadable,
    message:
      `No proof found for ${treasury} in the last ${entries.length} transactions of the hot wallet` +
      (unreadable > 0 ? ` (${unreadable} of them could not be loaded)` : "") +
      `. Nothing was written. Send 0.1 SOL from the treasury wallet to ${hotWallet}, then run this again.`,
  };
}
