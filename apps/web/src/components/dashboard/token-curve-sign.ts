import { VersionedTransaction } from "@solana/web3.js";

import { base64ToBytes, bytesToBase64 } from "@/lib/token-curve";

/** `signTransaction` as the wallet adapter gives it. */
export type SignTransaction = <T extends VersionedTransaction>(transaction: T) => Promise<T>;

/**
 * Hands a transaction the server built to the wallet and answers it signed,
 * as base64 again. The wallet fills its own slot only: a signature the
 * server already made (a fresh mint, a position keypair) stays where it is.
 */
export async function signPreparedTransaction(
  signTransaction: SignTransaction,
  transactionBase64: string
): Promise<string> {
  const transaction = VersionedTransaction.deserialize(base64ToBytes(transactionBase64));
  const signed = await signTransaction(transaction);
  return bytesToBase64(signed.serialize());
}
