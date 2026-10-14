// WheelsAI's fee payer at the x402 door: the wallet that pays a payment's
// network fee and adds the last signature, without which the payer's
// transaction can never land.
//
// It is a wallet of its own, derived from WALLET_MASTER_KEY as the payout
// wallet is (services/payoutKeypair.ts) under a salt of its own, so it can
// never be the payout wallet, the treasury or anyone's payTo. It holds SOL
// only and never gets a token account.
//
// The fee payer signs a stranger's transaction, so it signs nothing it has
// not checked itself: signAsFeePayer runs every check of the published
// scheme again on the exact bytes it was handed, never trusting an earlier
// result, and signs that same deserialized object (a recompiled message
// would reorder accounts and could carry something else). This file is the
// only one that signs with the fee payer.
//
// Reads no settings: the master key is handed in.

import { hkdfSync } from "node:crypto";

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { verifyExactSvmTransaction } from "./x402ExactSvm.js";
import { X402_ERROR_REASONS, type PaymentRequirements, type X402ErrorReason } from "./x402Wire.js";

/** The HKDF salt of the fee payer. No other wallet of the master key uses it. */
export const X402_FEE_PAYER_SALT = "wheelsai-x402-fee-payer-v1";

/** The HKDF info of the fee payer. */
export const X402_FEE_PAYER_INFO = "x402-fee-payer";

const MIN_MASTER_KEY_LENGTH = 32;

/** The fee payer of the door, from the master key: the same key always gives the same wallet. */
export function deriveX402FeePayerKeypair(masterKey: string): Keypair {
  if (!masterKey || masterKey.length === 0) {
    throw new Error("WALLET_MASTER_KEY required (empty or missing)");
  }
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(`WALLET_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters`);
  }
  const ikm = Buffer.from(masterKey, "utf8");
  const salt = Buffer.from(X402_FEE_PAYER_SALT, "utf8");
  const info = Buffer.from(X402_FEE_PAYER_INFO, "utf8");
  return Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", ikm, salt, info, 32)));
}

/** A payment the fee payer signed: the bytes that can land, and their id on the chain. */
export interface FeePayerSigned {
  /** Base58 of signature 0, the fee payer's: the transaction's id on the chain. */
  txSignature: string;
  /** The whole transaction, both signatures, base64: what is sent. */
  signedTxB64: string;
  /** The TransferChecked authority, the wallet that pays. */
  payer: string;
  /**
   * Hex sha256 of the message signed: the payment's key. The caller holds it
   * to the row it claimed, so a signed transaction can only ever stand for
   * the payment that row was claimed for.
   */
  messageHash: string;
}

export type FeePayerSignature = FeePayerSigned | { invalidReason: X402ErrorReason };

function allZero(bytes: Uint8Array | undefined): boolean {
  return !bytes || bytes.every((b) => b === 0);
}

/**
 * Sign one payment as the fee payer, only if it passes every check against
 * these requirements, run here on these bytes. Answers the signed
 * transaction, or the reason it was refused and no bytes at all. Never
 * throws.
 */
export function signAsFeePayer(
  transactionB64: string,
  requirements: PaymentRequirements,
  keypair: Keypair,
): FeePayerSignature {
  try {
    const feePayer = keypair.publicKey.toBase58();
    // The requirements name the fee payer the client built for; a keypair
    // that is not it signs nothing.
    if (requirements.extra.feePayer !== feePayer) {
      return { invalidReason: X402_ERROR_REASONS.feePayerNotManaged };
    }
    const checked = verifyExactSvmTransaction(transactionB64, requirements, { feePayer });
    if (!checked.isValid) return { invalidReason: checked.invalidReason };

    // The same bytes the check read (it reads them back exactly), signed in
    // place: the payer's signature is kept byte for byte.
    const tx = VersionedTransaction.deserialize(Buffer.from(transactionB64.trim(), "base64"));
    tx.sign([keypair]);
    const ours = tx.signatures[0];
    const theirs = tx.signatures[1];
    if (allZero(ours) || !ours || !theirs) {
      return { invalidReason: X402_ERROR_REASONS.unexpectedSettleError };
    }
    // Both signatures stand over the one message; anything else is not sent.
    const message = tx.message.serialize();
    const [first, second] = tx.message.staticAccountKeys;
    if (
      !first ||
      !second ||
      !first.equals(keypair.publicKey) ||
      !nacl.sign.detached.verify(message, ours, keypair.publicKey.toBytes()) ||
      !nacl.sign.detached.verify(message, theirs, second.toBytes())
    ) {
      return { invalidReason: X402_ERROR_REASONS.unexpectedSettleError };
    }
    return {
      txSignature: bs58.encode(ours),
      signedTxB64: Buffer.from(tx.serialize()).toString("base64"),
      payer: checked.payer,
      messageHash: checked.messageHash,
    };
  } catch {
    // A step that throws is a payment that is not signed.
    return { invalidReason: X402_ERROR_REASONS.unexpectedSettleError };
  }
}
