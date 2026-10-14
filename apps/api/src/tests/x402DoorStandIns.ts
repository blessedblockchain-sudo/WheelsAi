// What a real x402 client does at the door, made offline: the transaction a
// version 2 "exact" client builds on Solana, signed by the payer only, and
// the three headers as base64 JSON. Shared by the door's tests; not a test
// file. Keys are made in memory.
//
// The client (notes, section 4): [SetComputeUnitLimit, SetComputeUnitPrice,
// TransferChecked(source, mint, destination, owner = payer, amount, 6),
// Memo], then the Lighthouse instructions a wallet appends, compiled with the
// fee payer named in the requirements as the fee payer and signed with the
// payer's own key only. Slot 0, the fee payer's, stays all zeros.

import { createHash } from "node:crypto";

import { ExtendedPoint, CURVE } from "@noble/ed25519";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";

import { MEMO_PROGRAM_ID } from "../lib/memoProgram.js";

// Written out, not taken from the checker: a wrong id there must turn the
// wallets' Lighthouse tests red, as a real wallet's payment would be refused.
export const LIGHTHOUSE = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

/** A fixed key for a test that needs the same wallet twice. */
export function keypairOf(seedByte: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(seedByte));
}

/** A blockhash as the chain hands one out: 32 bytes in base58. */
export function aBlockhash(): string {
  return Keypair.generate().publicKey.toBase58();
}

export interface ExactPaymentInput {
  payer: Keypair;
  feePayer: PublicKey;
  /** The wallet paid. The transfer goes to its associated token account. */
  payTo: PublicKey;
  mint: PublicKey;
  /** Atomic units. */
  amount: bigint;
  memo: string;
  blockhash: string;
  unitLimit?: number;
  microLamports?: bigint;
  /** Phantom adds one, Solflare two. */
  lighthouse?: 0 | 1 | 2;
  legacy?: boolean;
  /** Alters the instruction list before it is compiled (refusal tests). */
  change?: (instructions: TransactionInstruction[]) => TransactionInstruction[];
  /** Alters the compiled message before it is signed (version 0 only). */
  compiled?: (message: VersionedMessage) => void;
  /** Loads these accounts from a lookup table (version 0 only). */
  lookupAddresses?: PublicKey[];
  /** Who signs. Default: the payer only. */
  signers?: Keypair[];
}

/** The instructions a real client builds, before a wallet adds its own. */
export function exactInstructions(input: ExactPaymentInput): TransactionInstruction[] {
  const source = getAssociatedTokenAddressSync(input.mint, input.payer.publicKey);
  const destination = getAssociatedTokenAddressSync(input.mint, input.payTo, true);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.unitLimit ?? 20_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.microLamports ?? 1n }),
    createTransferCheckedInstruction(source, input.mint, destination, input.payer.publicKey, input.amount, 6),
  ];
  instructions.push(memoInstruction(input.memo));
  // A wallet appends its Lighthouse instructions to the transaction the client
  // built, so they come after the Memo: Phantom adds one and Solflare two,
  // which puts a Lighthouse at [5].
  for (let i = 0; i < (input.lighthouse ?? 0); i += 1) {
    instructions.push(lighthouseInstruction(source, i));
  }
  return instructions;
}

export function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, "utf8") });
}

/** A wallet's assertion on the payer's token account: its data is the wallet's business. */
export function lighthouseInstruction(account: PublicKey, n = 0, extraKeys: TransactionInstruction["keys"] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: LIGHTHOUSE,
    keys: [{ pubkey: account, isSigner: false, isWritable: false }, ...extraKeys],
    data: Buffer.from([0x0d, n, 1, 2, 3, 4]),
  });
}

/** The transaction, partially signed: what payload.transaction carries. */
export function exactPaymentTransaction(input: ExactPaymentInput): VersionedTransaction {
  const base = exactInstructions(input);
  const instructions = input.change ? input.change(base) : base;
  const draft = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash: input.blockhash,
    instructions,
  });
  let message: VersionedMessage;
  if (input.legacy) {
    message = draft.compileToLegacyMessage();
  } else {
    const tables = input.lookupAddresses
      ? [
          new AddressLookupTableAccount({
            key: Keypair.generate().publicKey,
            state: {
              deactivationSlot: BigInt("18446744073709551615"),
              lastExtendedSlot: 0,
              lastExtendedSlotStartIndex: 0,
              addresses: input.lookupAddresses,
            },
          }),
        ]
      : undefined;
    message = draft.compileToV0Message(tables);
    input.compiled?.(message);
  }
  const tx = new VersionedTransaction(message);
  tx.sign(input.signers ?? [input.payer]);
  return tx;
}

/** The base64 wire transaction a real client sends. */
export function exactPayment(input: ExactPaymentInput): string {
  return Buffer.from(exactPaymentTransaction(input).serialize()).toString("base64");
}

// ============================================
// The same message under other valid signatures
// ============================================

const L = CURVE.n;

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) + BigInt(bytes[i] ?? 0);
  return n;
}

function bigIntToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * An Ed25519 signature of `message` by `signer` made with a nonce of the
 * signer's choosing: valid, and not the one a deterministic signer makes.
 */
export function signWithNonce(message: Uint8Array, signer: Keypair, nonce: bigint): Uint8Array {
  const head = createHash("sha512").update(signer.secretKey.subarray(0, 32)).digest().subarray(0, 32);
  head[0] = (head[0] ?? 0) & 248;
  head[31] = ((head[31] ?? 0) & 127) | 64;
  const scalar = leToBigInt(head) % L;
  const r = ((nonce % L) + L) % L || 1n;
  const R = ExtendedPoint.BASE.multiply(r).toRawBytes();
  const k = leToBigInt(createHash("sha512").update(R).update(signer.publicKey.toBytes()).update(message).digest()) % L;
  const S = (r + k * scalar) % L;
  const signature = new Uint8Array(64);
  signature.set(R, 0);
  signature.set(bigIntToLe32(S), 32);
  return signature;
}

/** The same signature with L added to S: tweetnacl still accepts it. */
export function withSPlusL(signature: Uint8Array): Uint8Array {
  const out = new Uint8Array(signature);
  out.set(bigIntToLe32(leToBigInt(signature.subarray(32)) + L), 32);
  return out;
}

/** The same transaction with the signature in slot `index` replaced. */
export function withSignature(transactionB64: string, index: number, signature: Uint8Array): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionB64, "base64"));
  tx.signatures[index] = signature;
  return Buffer.from(tx.serialize()).toString("base64");
}

// ============================================
// The headers
// ============================================

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** PAYMENT-SIGNATURE as a version 2 client sends it. */
export function paymentSignatureHeader(accepted: unknown, transactionB64: string, x402Version: number = 2): string {
  return base64Json({ x402Version, accepted, payload: { transaction: transactionB64 } });
}

export function readPaymentRequired(value: string): Record<string, any> {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export function readPaymentResponse(value: string): Record<string, any> {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
