/**
 * SPL Memo v2 program id — env-free leaf module so pure services can
 * import it without dragging in config/env.
 *
 * Shared by the attestation worker (JSON payload memos) and the wallet
 * top-up rail (row-id attribution memos); proven on devnet by the D10
 * attestation run.
 */

import { PublicKey } from "@solana/web3.js";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
