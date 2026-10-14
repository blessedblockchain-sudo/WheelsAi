// The checks of one payment in the published x402 "exact" scheme on Solana.
//
// The payer's x402 client builds a transaction whose fee payer is WheelsAI's
// fee payer and signs it with its own key only: [SetComputeUnitLimit,
// SetComputeUnitPrice, TransferChecked, Memo], with at most two Lighthouse
// instructions a wallet may add. It cannot land until the fee payer signs
// it too, and the fee payer signs only what passes every check below,
// checked again on the exact bytes it signs (services/x402FeePayer.ts).
//
// The deployment's decoder (services/x402Decode.ts) answers another
// question, of a transaction already fully signed, and is not used here;
// two of its helpers are.
//
// Pure: no settings, no connection, no clock, no byte offsets. Never throws.

import { createHash } from "node:crypto";

import { TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

import { MEMO_PROGRAM_ID } from "../lib/memoProgram.js";
import { X402_USDC_DECIMALS, advancesNonce, instructionsOf, x402UsdcTokenAccount } from "./x402Decode.js";
import { X402_ERROR_REASONS, type PaymentRequirements, type X402ErrorReason } from "./x402Wire.js";

/** The most compute units a payment may ask for. The reference client asks for 20,000. */
export const X402_MAX_COMPUTE_UNIT_LIMIT = 200_000;

/**
 * The most a payment may bid per compute unit, in microlamports. The fee
 * payer pays it, so it is far stricter than the published 5,000,000; the
 * reference client bids 1.
 */
export const X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 50_000n;

/** A program some wallets (Phantom one, Solflare two) add after the transfer. */
export const LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const LIGHTHOUSE = new PublicKey(LIGHTHOUSE_PROGRAM_ID);

/** SetComputeUnitLimit: a tag and a u32. Web3's decoder ignores bytes after them. */
const COMPUTE_LIMIT_DATA_BYTES = 5;
/** SetComputeUnitPrice: a tag and a u64. */
const COMPUTE_PRICE_DATA_BYTES = 9;

const MIN_INSTRUCTIONS = 3;
const MAX_INSTRUCTIONS = 6;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A payment that passes every check. */
export interface ExactSvmPayment {
  isValid: true;
  /** The TransferChecked authority: the wallet that pays (never the fee payer). */
  payer: string;
  /** Hex sha256 of the message both signatures sign: the payment's one key. */
  messageHash: string;
  /** The payer's token account. */
  source: string;
  /** The payTo's associated token account for the asset. */
  destination: string;
  recentBlockhash: string;
}

export type ExactSvmVerification = ExactSvmPayment | { isValid: false; invalidReason: X402ErrorReason };

function refuse(invalidReason: X402ErrorReason): ExactSvmVerification {
  return { isValid: false, invalidReason };
}

function isComputeBudget(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId);
}

/** The units of a SetComputeUnitLimit whose data is exactly its layout, or null. */
function computeUnitLimit(ix: TransactionInstruction): number | null {
  if (!isComputeBudget(ix) || ix.data.length !== COMPUTE_LIMIT_DATA_BYTES || ix.keys.length !== 0) return null;
  try {
    if (ComputeBudgetInstruction.decodeInstructionType(ix) !== "SetComputeUnitLimit") return null;
    return ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
  } catch {
    return null;
  }
}

/** The microlamports of a SetComputeUnitPrice whose data is exactly its layout, or null. */
function computeUnitPrice(ix: TransactionInstruction): bigint | null {
  if (!isComputeBudget(ix) || ix.data.length !== COMPUTE_PRICE_DATA_BYTES || ix.keys.length !== 0) return null;
  try {
    if (ComputeBudgetInstruction.decodeInstructionType(ix) !== "SetComputeUnitPrice") return null;
    return BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
  } catch {
    return null;
  }
}

function isMemo(ix: TransactionInstruction): boolean {
  return ix.programId.equals(MEMO_PROGRAM_ID);
}

function isLighthouse(ix: TransactionInstruction): boolean {
  return ix.programId.equals(LIGHTHOUSE);
}

/** The order of the ed25519 group: a signature's S must be below it. */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/** S, the second half of a signature, as the little-endian number it is. */
function signatureS(signature: Uint8Array): bigint {
  let s = 0n;
  for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(signature[i] ?? 0);
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Check one payment, from its bytes, against the requirements of the use it
 * pays for and the fee payer WheelsAI manages. Every check of the published
 * scheme, and stricter ones where the fee payer's money is at stake, in this
 * order; the first that fails answers its reference string:
 *
 *   1. the bytes are one legacy or version 0 transaction, read back exactly;
 *      no lookup tables (accounts loaded from one are invisible to check 6);
 *   2. two required signatures: slot 0 is OUR fee payer and is still empty,
 *      slot 1 verifies over the message;
 *   3. every instruction resolves from the message's own accounts and none
 *      runs as the fee payer; no durable nonce;
 *   4. 3 to 6 instructions: SetComputeUnitLimit and SetComputeUnitPrice (each
 *      exactly its layout, each at most its cap), a TransferChecked of the
 *      classic Token program with no multisig signers and 6 decimals, then
 *      only Memo or Lighthouse at [3], [4] and [5] (a wallet appends its
 *      Lighthouse instructions after the client's Memo, and the published
 *      scheme must admit Solflare's two, so a Lighthouse at [5] passes, as
 *      the reference facilitator lets it);
 *   5. exactly one Memo, whose text is the memo asked for;
 *   6. the fee payer is in no instruction's accounts;
 *   7. the transfer's authority is the signer of slot 1;
 *   8. the mint, the destination (payTo's associated token account) and the
 *      amount are exactly the requirements'.
 *
 * A valid signature does not make a payment unique (a signer chooses its
 * nonce): the message hash is the key a payment is held by.
 */
export function verifyExactSvmTransaction(
  transactionB64: string,
  requirements: PaymentRequirements,
  options: { feePayer: string },
): ExactSvmVerification {
  try {
    return verify(transactionB64, requirements, options);
  } catch {
    // A check that throws is a check that did not pass.
    return refuse(X402_ERROR_REASONS.unexpectedVerifyError);
  }
}

function verify(
  transactionB64: string,
  requirements: PaymentRequirements,
  options: { feePayer: string },
): ExactSvmVerification {
  const undecodable = () => refuse(X402_ERROR_REASONS.couldNotBeDecoded);

  // 1. The bytes.
  if (typeof transactionB64 !== "string") return undecodable();
  const text = transactionB64.trim();
  if (text.length === 0 || !BASE64.test(text)) return undecodable();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length > PACKET_DATA_SIZE) return undecodable();
  let tx: VersionedTransaction;
  let messageBytes: Uint8Array;
  try {
    tx = VersionedTransaction.deserialize(bytes);
    messageBytes = tx.message.serialize();
    // Read back byte for byte: what is checked is exactly what was handed in.
    if (!sameBytes(tx.serialize(), bytes)) return undecodable();
  } catch {
    return undecodable();
  }
  const message = tx.message;
  // The notes give no string of their own for a lookup table.
  if (message.addressTableLookups.length > 0) return undecodable();

  // 2. The signatures.
  const keys = message.staticAccountKeys;
  if (message.header.numRequiredSignatures !== 2 || tx.signatures.length !== 2 || keys.length < 2) {
    return refuse(X402_ERROR_REASONS.missingFeePayer);
  }
  let ourFeePayer: PublicKey;
  try {
    ourFeePayer = new PublicKey(options.feePayer);
  } catch {
    return refuse(X402_ERROR_REASONS.feePayerNotManaged);
  }
  const feePayer = keys[0];
  const signer = keys[1];
  if (!feePayer || !signer) return refuse(X402_ERROR_REASONS.missingFeePayer);
  if (!feePayer.equals(ourFeePayer) || requirements.extra.feePayer !== ourFeePayer.toBase58()) {
    return refuse(X402_ERROR_REASONS.feePayerNotManaged);
  }
  const feePayerSlot = tx.signatures[0];
  const payerSignature = tx.signatures[1];
  // Slot 0 is the fee payer's to fill, and only after the answer: a
  // transaction that arrives with it filled is not one this door made.
  if (!feePayerSlot || feePayerSlot.some((b) => b !== 0)) {
    return refuse(X402_ERROR_REASONS.invalidTransactionState);
  }
  // The reference answers a payer signature the chain would refuse when its
  // simulation fails; there is no string of its own.
  if (!payerSignature || payerSignature.length !== 64 || !nacl.sign.detached.verify(messageBytes, payerSignature, signer.toBytes())) {
    return refuse(X402_ERROR_REASONS.transactionSimulationFailed);
  }
  // tweetnacl also accepts an S at or above the group's order, which the
  // chain refuses: such a payment could never land, so no answer is made for
  // it (a simulation run without checking signatures would not catch it).
  if (signatureS(payerSignature) >= ED25519_ORDER) {
    return refuse(X402_ERROR_REASONS.transactionSimulationFailed);
  }

  // 3. The instructions, resolved from the message's own accounts.
  const compiled = message.compiledInstructions;
  if (compiled.some((ix) => ix.programIdIndex === 0)) return undecodable();
  const instructions = instructionsOf(message);
  if (instructions.length !== compiled.length) return undecodable();
  // A transaction on a durable nonce does not die with its blockhash. The
  // layout below has no room for one either; the refusal stays explicit.
  if (instructions.some(advancesNonce)) return refuse(X402_ERROR_REASONS.invalidTransactionState);

  // 4. The layout.
  if (instructions.length < MIN_INSTRUCTIONS || instructions.length > MAX_INSTRUCTIONS) {
    return refuse(X402_ERROR_REASONS.instructionsLength);
  }
  const [limitIx, priceIx, transferIx, ...rest] = instructions as [
    TransactionInstruction,
    TransactionInstruction,
    TransactionInstruction,
    ...TransactionInstruction[],
  ];
  const units = computeUnitLimit(limitIx);
  if (units === null || units > X402_MAX_COMPUTE_UNIT_LIMIT) {
    return refuse(X402_ERROR_REASONS.computeLimitInstruction);
  }
  const microLamports = computeUnitPrice(priceIx);
  if (microLamports === null) return refuse(X402_ERROR_REASONS.computePriceInstruction);
  if (microLamports > X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
    return refuse(X402_ERROR_REASONS.computePriceTooHigh);
  }
  if (!transferIx.programId.equals(TOKEN_PROGRAM_ID)) return refuse(X402_ERROR_REASONS.noTransferInstruction);
  let transfer: ReturnType<typeof decodeTransferCheckedInstruction>;
  try {
    transfer = decodeTransferCheckedInstruction(transferIx, TOKEN_PROGRAM_ID);
  } catch {
    return refuse(X402_ERROR_REASONS.noTransferInstruction);
  }
  if (transfer.keys.multiSigners.length > 0 || transfer.data.decimals !== X402_USDC_DECIMALS) {
    return refuse(X402_ERROR_REASONS.noTransferInstruction);
  }
  const unknownAt = [
    X402_ERROR_REASONS.unknownFourthInstruction,
    X402_ERROR_REASONS.unknownFifthInstruction,
    X402_ERROR_REASONS.unknownSixthInstruction,
  ] as const;
  for (const [i, ix] of rest.entries()) {
    if (!isMemo(ix) && !isLighthouse(ix)) return refuse(unknownAt[i] ?? X402_ERROR_REASONS.instructionsLength);
  }

  // 5. The memo.
  const memos = rest.filter(isMemo);
  if (memos.length !== 1) return refuse(X402_ERROR_REASONS.memoCount);
  const [memo] = memos as [TransactionInstruction];
  // Bytes, not decoded text: a decoder drops a leading byte-order mark, and
  // what lands on the chain must be exactly the memo the door asked for.
  if (!sameBytes(memo.data, Buffer.from(requirements.extra.memo, "utf8"))) {
    return refuse(X402_ERROR_REASONS.memoMismatch);
  }

  // 6. The fee payer moves nothing: it is in no instruction's accounts, so it
  // is neither the transfer's authority nor its source.
  const touchesFeePayer = (ix: TransactionInstruction) => ix.keys.some((meta) => meta.pubkey.equals(feePayer));
  if (
    instructions.some(touchesFeePayer) ||
    transfer.keys.owner.pubkey.equals(feePayer) ||
    transfer.keys.source.pubkey.equals(feePayer)
  ) {
    return refuse(X402_ERROR_REASONS.feePayerTransferringFunds);
  }

  // 7. The wallet that signed is the wallet that pays.
  if (!transfer.keys.owner.pubkey.equals(signer)) return refuse(X402_ERROR_REASONS.noTransferInstruction);

  // 8. What is paid, to whom.
  if (transfer.keys.mint.pubkey.toBase58() !== requirements.asset) return refuse(X402_ERROR_REASONS.mintMismatch);
  // A transfer from payTo's own account to itself pays nothing; the chain
  // would refuse it too, but nothing is left to a simulation that can be.
  if (transfer.keys.source.pubkey.equals(transfer.keys.destination.pubkey)) {
    return refuse(X402_ERROR_REASONS.recipientMismatch);
  }
  let destination: string;
  try {
    destination = x402UsdcTokenAccount(requirements.payTo, requirements.asset);
  } catch {
    return refuse(X402_ERROR_REASONS.recipientMismatch);
  }
  if (transfer.keys.destination.pubkey.toBase58() !== destination) {
    return refuse(X402_ERROR_REASONS.recipientMismatch);
  }
  if (!/^[1-9][0-9]*$/.test(requirements.amount) || transfer.data.amount !== BigInt(requirements.amount)) {
    return refuse(X402_ERROR_REASONS.amountMismatch);
  }

  return {
    isValid: true,
    payer: signer.toBase58(),
    messageHash: createHash("sha256").update(messageBytes).digest("hex"),
    source: transfer.keys.source.pubkey.toBase58(),
    destination,
    recentBlockhash: message.recentBlockhash,
  };
}
