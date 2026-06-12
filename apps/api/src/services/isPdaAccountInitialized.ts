/**
 * Shared predicate for both bootstrap CLIs (treasury + reputation):
 * does the program's Account-type PDA already exist on-chain with the
 * expected Anchor discriminator?
 *
 * Idempotency rationale:
 *   The bootstrap scripts are run by an operator and may be re-run after
 *   partial failure. We can't rely on the DB flag alone — a previous
 *   run could have landed the init tx on-chain but crashed before
 *   flipping the flag. Checking the PDA directly + matching the 8-byte
 *   discriminator catches that case cleanly: the script flips the DB
 *   flag and skips the redundant init.
 *
 * Why we check the discriminator (not just account existence): the PDA
 * address is deterministic. Before init, an unrelated program could
 * conceivably airdrop SOL to the same address, creating a system-owned
 * account at that address. Verifying the discriminator is what tells
 * us "this account is our Treasury / AgentReputation struct, not an
 * incidental lamport bag at the same address."
 */

import { PublicKey, type Connection } from "@solana/web3.js";

export const TREASURY_ACCOUNT_DISCRIMINATOR = Buffer.from([
  238, 239, 123, 238, 89, 1, 168, 253,
]);

export const AGENT_REPUTATION_ACCOUNT_DISCRIMINATOR = Buffer.from([
  245, 56, 239, 246, 36, 231, 227, 67,
]);

export const ORACLE_CONFIG_ACCOUNT_DISCRIMINATOR = Buffer.from([
  133, 196, 152, 50, 27, 21, 145, 254,
]);

// sha256("account:TreasuryConfig")[..8] — the agent-treasury program's
// singleton config PDA (seeds [b"config"]) that gates initialize_treasury.
export const TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR = Buffer.from([
  124, 54, 212, 227, 213, 189, 168, 41,
]);

export interface IsPdaAccountInitializedDeps {
  connection: Pick<Connection, "getAccountInfo">;
}

export async function isPdaAccountInitialized(
  input: { pda: PublicKey; expectedDiscriminator: Buffer },
  deps: IsPdaAccountInitializedDeps,
): Promise<boolean> {
  const acc = await deps.connection.getAccountInfo(input.pda);
  if (!acc) return false;
  // Account data shorter than the disc itself can't possibly match.
  if (acc.data.length < 8) return false;
  return Buffer.from(acc.data).subarray(0, 8).equals(input.expectedDiscriminator);
}

/**
 * Read the `platform_authority` field straight out of an on-chain
 * Treasury account (C1/C2 verification).
 *
 * Anchor account layout for Treasury (programs/agent-treasury/src/lib.rs):
 *   bytes 0..8     account discriminator (sha256("account:Treasury")[..8])
 *   bytes 8..40    owner_token_mint:    Pubkey
 *   bytes 40..72   platform_authority:  Pubkey
 *   ...            (totals, bump, pending_authority, padding)
 *
 * Returns null when the account doesn't exist, is too short, or carries
 * a different discriminator (an incidental lamport bag at the PDA is
 * NOT a Treasury). Callers use this to assert that the recorded
 * authority matches the key they derive before signing anything — a
 * mismatch means hijack or master-key misconfiguration.
 */
export async function readTreasuryPlatformAuthority(
  connection: Pick<Connection, "getAccountInfo">,
  treasuryPda: PublicKey,
): Promise<PublicKey | null> {
  const acc = await connection.getAccountInfo(treasuryPda);
  if (!acc) return null;
  const data = Buffer.from(acc.data);
  // Need disc(8) + mint(32) + authority(32) at minimum.
  if (data.length < 72) return null;
  if (!data.subarray(0, 8).equals(TREASURY_ACCOUNT_DISCRIMINATOR)) return null;
  return new PublicKey(data.subarray(40, 72));
}
