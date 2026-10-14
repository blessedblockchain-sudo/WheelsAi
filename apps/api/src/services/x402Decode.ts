// Reading a signed transaction as an x402 payment.
//
// A payer hands over a transaction their own wallet built and signed. This
// file answers one question about it, from its bytes alone: does it pay
// the treasury at least the amount asked, in the asset asked? It never
// broadcasts and never asks the chain; whether the transaction then lands
// is the chain's to say (services/signatureFate.ts).
//
// Modelled on acceptSignedTopupTransaction (services/walletTopup.ts):
// legacy and version 0 transactions, lookup tables refused, and the token
// library's own decoders instead of byte offsets.
//
// Pure: no settings, no connection, no clock. Never throws.

import {
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  decodeTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import type {
  DecodeX402Refusal,
  DecodeX402Result,
  X402PaymentWanted,
} from "./x402Types.js";

/** USDC has six decimals on every chain this runs on. */
export const X402_USDC_DECIMALS = 6;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function refuse(reason: DecodeX402Refusal): DecodeX402Result {
  return { ok: false, reason };
}

/**
 * The message's instructions with their accounts resolved. An instruction
 * that points outside the message's own accounts cannot be read and is
 * left out: it is not a transfer to us, whatever else it is.
 */
export function instructionsOf(message: VersionedMessage): TransactionInstruction[] {
  const keys = message.staticAccountKeys;
  const out: TransactionInstruction[] = [];
  for (const ix of message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) continue;
    const accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    let readable = true;
    for (const index of ix.accountKeyIndexes) {
      const pubkey = keys[index];
      if (!pubkey) {
        readable = false;
        break;
      }
      accounts.push({
        pubkey,
        isSigner: message.isAccountSigner(index),
        isWritable: message.isAccountWritable(index),
      });
    }
    if (!readable) continue;
    out.push(new TransactionInstruction({ programId, keys: accounts, data: Buffer.from(ix.data) }));
  }
  return out;
}

/**
 * A transaction whose first instruction advances a durable nonce does not
 * expire with its blockhash: the payer could hold it and land it days
 * later. Everything after the decode reasons from "a transaction dies with
 * its blockhash" (services/signatureFate.ts, the blockhash form), which is
 * false for such a transaction, so it is not taken as a payment at all.
 * The instruction is refused wherever it sits, not only first.
 */
export function advancesNonce(ix: TransactionInstruction): boolean {
  if (!ix.programId.equals(SystemProgram.programId)) return false;
  try {
    return SystemInstruction.decodeInstructionType(ix) === "AdvanceNonceAccount";
  } catch {
    return false;
  }
}

/** The lamports a System Program transfer to `payTo` carries, or null. */
function solTransferTo(ix: TransactionInstruction, payTo: PublicKey): bigint | null {
  if (!ix.programId.equals(SystemProgram.programId)) return null;
  try {
    if (SystemInstruction.decodeInstructionType(ix) !== "Transfer") return null;
    const transfer = SystemInstruction.decodeTransfer(ix);
    if (!transfer.toPubkey.equals(payTo)) return null;
    return BigInt(transfer.lamports);
  } catch {
    return null;
  }
}

/**
 * The base units a classic Token Program transfer to `tokenAccount`
 * carries, or null. A plain `transfer` names no mint: the destination is
 * the treasury's account for the USDC mint, and an account holds one mint
 * only, so nothing else can arrive there. A `transferChecked` names its
 * mint and decimals, and both must be USDC's.
 */
function usdcTransferTo(ix: TransactionInstruction, tokenAccount: PublicKey, usdcMint: PublicKey): bigint | null {
  if (!ix.programId.equals(TOKEN_PROGRAM_ID)) return null;
  try {
    const checked = decodeTransferCheckedInstruction(ix, TOKEN_PROGRAM_ID);
    if (!checked.keys.destination.pubkey.equals(tokenAccount)) return null;
    if (!checked.keys.mint.pubkey.equals(usdcMint)) return null;
    if (checked.data.decimals !== X402_USDC_DECIMALS) return null;
    return BigInt(checked.data.amount);
  } catch {
    // Not a checked transfer. A plain one has another length and tag.
  }
  try {
    const plain = decodeTransferInstruction(ix, TOKEN_PROGRAM_ID);
    if (!plain.keys.destination.pubkey.equals(tokenAccount)) return null;
    return BigInt(plain.data.amount);
  } catch {
    return null;
  }
}

/**
 * Read a signed transaction as a payment of `want`.
 *
 * Accepted when ALL of:
 *   - it is a legacy or version 0 transaction that loads no addresses from
 *     lookup tables (every account it touches is written in it);
 *   - every signature it requires is present and verifies over the bytes
 *     that were signed;
 *   - it does not run on a durable nonce (it dies with its blockhash);
 *   - ONE instruction is a transfer of the asset to the right destination
 *     carrying at least `want.minAmountRaw`. Two smaller transfers do not
 *     add up.
 * Other instructions (a wallet's compute budget, a memo) are not judged.
 *
 * The amount answered is what that one instruction carries, which may be
 * more than was asked. With several transfers to us, the largest is the
 * one read.
 */
export function decodeX402Payment(signedTxBase64: string, want: X402PaymentWanted): DecodeX402Result {
  try {
    return decode(signedTxBase64, want);
  } catch {
    // Bytes that cannot be read are not a payment.
    return refuse("not_a_transaction");
  }
}

function decode(signedTxBase64: string, want: X402PaymentWanted): DecodeX402Result {
  if (typeof signedTxBase64 !== "string") return refuse("not_a_transaction");
  const text = signedTxBase64.trim();
  if (text.length === 0 || !BASE64.test(text)) return refuse("not_a_transaction");

  let vtx: VersionedTransaction;
  let messageBytes: Uint8Array;
  try {
    vtx = VersionedTransaction.deserialize(Buffer.from(text, "base64"));
    messageBytes = vtx.message.serialize();
  } catch {
    return refuse("not_a_transaction");
  }
  const message = vtx.message;

  if (message.addressTableLookups.length > 0) return refuse("uses_lookup_tables");

  // Every required signature, over the message as it was signed.
  const required = message.header.numRequiredSignatures;
  const keys = message.staticAccountKeys;
  if (required < 1 || vtx.signatures.length !== required || keys.length < required) {
    return refuse("bad_signature");
  }
  for (let i = 0; i < required; i += 1) {
    const signature = vtx.signatures[i];
    const signer = keys[i];
    if (!signature || !signer || signature.length !== 64 || signature.every((b) => b === 0)) {
      return refuse("bad_signature");
    }
    let verified = false;
    try {
      verified = nacl.sign.detached.verify(messageBytes, signature, signer.toBytes());
    } catch {
      verified = false;
    }
    if (!verified) return refuse("bad_signature");
  }
  const firstSignature = vtx.signatures[0];
  const feePayer = keys[0];
  if (!firstSignature || !feePayer) return refuse("bad_signature");

  // What we were told to look for. These come from our own settings; if
  // they cannot be read, nothing can pay them.
  if (typeof want.minAmountRaw !== "bigint" || want.minAmountRaw <= 0n) return refuse("no_payment");
  let payTo: PublicKey;
  let usdcMint: PublicKey;
  let usdcAccount: PublicKey;
  try {
    payTo = new PublicKey(want.payTo);
    usdcMint = new PublicKey(want.usdcMint);
    usdcAccount = getAssociatedTokenAddressSync(usdcMint, payTo, true);
  } catch {
    return refuse("no_payment");
  }
  if (want.asset !== "SOL" && want.asset !== "USDC") return refuse("no_payment");

  const instructions = instructionsOf(message);
  // Every instruction must be readable from the message's own accounts,
  // or what the transaction does cannot be said.
  if (instructions.length !== message.compiledInstructions.length) return refuse("no_payment");
  if (instructions.some(advancesNonce)) return refuse("no_payment");

  let best: bigint | null = null;
  for (const ix of instructions) {
    const carried =
      want.asset === "SOL" ? solTransferTo(ix, payTo) : usdcTransferTo(ix, usdcAccount, usdcMint);
    if (carried !== null && (best === null || carried > best)) best = carried;
  }
  if (best === null) return refuse("no_payment");
  if (best < want.minAmountRaw) return refuse("amount_too_low");

  return {
    ok: true,
    payment: {
      signature: bs58.encode(firstSignature),
      payer: feePayer.toBase58(),
      asset: want.asset,
      amountRaw: best,
      recentBlockhash: message.recentBlockhash,
      // The bytes that were verified above, as the chain will be sent them.
      signedTxB64: Buffer.from(vtx.serialize()).toString("base64"),
    },
  };
}

/**
 * Where a USDC payment must go: the treasury wallet's associated token
 * account for the USDC mint. The 402 names it as `payToTokenAccount`, and
 * the decode above accepts a transfer to it and to nothing else.
 */
export function x402UsdcTokenAccount(payTo: string, usdcMint: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(usdcMint), new PublicKey(payTo), true).toBase58();
}
