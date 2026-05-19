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
