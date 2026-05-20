/**
 * Phase 1.5: browser-partial-sign for pump.fun create.
 *
 * Split of submitPumpfunCreate into two stateless halves so the creator
 * signature can come from the user's browser wallet (Solana wallet
 * adapter) instead of a server-held custodial keypair:
 *
 *   preparePumpfunCreate(input, deps)
 *     1. POST pumpportal /api/trade-local with request body
 *     2. Deserialize response → unsigned VersionedTransaction
 *     3. Sign with the ephemeral mint keypair only (creator slot empty)
 *     4. Return serialized partial-signed tx bytes + mint pubkey
 *
 *   broadcastSignedPumpfunCreate(input, deps)
 *     1. Accept fully-signed VersionedTransaction bytes from the client
 *     2. Verify the expected mint pubkey appears in the signers list
 *        (catches the easy "client swapped the tx" tampering case)
 *     3. Submit via sendRawTransaction → tx signature
 *
 * Both halves are pure with respect to dependencies: fetchFn,
 * sendRawTransaction. The route layer is responsible for any state
 * stitching across the two requests (e.g. caching the mint keypair).
 *
 * The existing submitPumpfunCreate in submitPumpfunCreate.ts stays as
 * the all-in-one custodial path used by services/agentToken.createToken.
 * Once browser-partial-sign is the only writer, the custodial helper
 * can retire.
 */

import { PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";

import {
  deserializePumpfunUnsignedTx,
  type PumpfunCreateRequestBody,
} from "./pumpfunTxBuilder.js";

const PUMPPORTAL_LOCAL_ENDPOINT = "https://pumpportal.fun/api/trade-local";

// ============================================
// preparePumpfunCreate
// ============================================

export interface PreparePumpfunCreateInput {
  body: PumpfunCreateRequestBody;
  mintKeypair: Keypair;
}

export interface PreparePumpfunCreateDeps {
  fetchFn: typeof fetch;
}

export interface PreparePumpfunCreateResult {
  /** Base64-encoded partially-signed VersionedTransaction. */
  partialSignedTxBase64: string;
  /** Mint pubkey base58 (matches body.mint by construction). */
  mintAddress: string;
  /** Creator pubkey base58 (matches body.publicKey by construction). */
  creatorPubkey: string;
}

export async function preparePumpfunCreate(
  input: PreparePumpfunCreateInput,
  deps: PreparePumpfunCreateDeps,
): Promise<PreparePumpfunCreateResult> {
  if (input.mintKeypair.publicKey.toBase58() !== input.body.mint) {
    throw new Error(
      "preparePumpfunCreate: mint keypair/body mint mismatch",
    );
  }

  const res = await deps.fetchFn(PUMPPORTAL_LOCAL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.body),
  });

  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `pumpportal_local: returned ${res.status} (${snippet.slice(0, 200)})`,
    );
  }

  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);

  const tx = deserializePumpfunUnsignedTx(bytes);
  // Sign only the mint slot — the creator slot stays unsigned for the
  // client's wallet adapter to fill in. VersionedTransaction.sign fills
  // matching signer slots and leaves others untouched.
  tx.sign([input.mintKeypair]);

  return {
    partialSignedTxBase64: Buffer.from(tx.serialize()).toString("base64"),
    mintAddress: input.body.mint,
    creatorPubkey: input.body.publicKey,
  };
}

// ============================================
// broadcastSignedPumpfunCreate
// ============================================

export interface BroadcastSignedPumpfunCreateInput {
  /** Base64-encoded fully-signed VersionedTransaction from the client. */
  signedTxBase64: string;
  /** Mint pubkey the server prepared this tx for; tampering check. */
  expectedMintAddress: string;
  /** Creator pubkey the server expects to have signed; tampering check. */
  expectedCreatorPubkey: string;
}

export interface BroadcastSignedPumpfunCreateDeps {
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface BroadcastSignedPumpfunCreateResult {
  mintAddress: string;
  txSignature: string;
}

export async function broadcastSignedPumpfunCreate(
  input: BroadcastSignedPumpfunCreateInput,
  deps: BroadcastSignedPumpfunCreateDeps,
): Promise<BroadcastSignedPumpfunCreateResult> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(Buffer.from(input.signedTxBase64, "base64"));
  } catch (err) {
    throw new Error(
      `broadcastSignedPumpfunCreate: signedTxBase64 not valid base64 (${(err as Error).message})`,
    );
  }
  if (raw.length === 0) {
    throw new Error("broadcastSignedPumpfunCreate: signed tx is empty");
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch (err) {
    throw new Error(
      `broadcastSignedPumpfunCreate: failed to deserialize signed tx (${(err as Error).message})`,
    );
  }

  // Verify the static-account-key list contains the mint + creator we
  // prepared this tx for. Catches client-side swapping the entire tx
  // payload for something unrelated.
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  let expectedMint: PublicKey;
  let expectedCreator: PublicKey;
  try {
    expectedMint = new PublicKey(input.expectedMintAddress);
    expectedCreator = new PublicKey(input.expectedCreatorPubkey);
  } catch (err) {
    throw new Error(
      `broadcastSignedPumpfunCreate: invalid expected pubkey (${(err as Error).message})`,
    );
  }
  if (!staticKeys.includes(expectedMint.toBase58())) {
    throw new Error(
      "broadcastSignedPumpfunCreate: signed tx does not reference expected mint",
    );
  }
  if (!staticKeys.includes(expectedCreator.toBase58())) {
    throw new Error(
      "broadcastSignedPumpfunCreate: signed tx does not reference expected creator",
    );
  }

  // Ensure both required signer slots are populated. The signatures array
  // mirrors message.staticAccountKeys for the first numRequiredSignatures
  // entries; an empty 64-byte zero-buffer indicates an unsigned slot.
  const sigCount = tx.message.header.numRequiredSignatures;
  for (let i = 0; i < sigCount; i++) {
    const sig = tx.signatures[i];
    if (!sig || sig.every((b) => b === 0)) {
      const slot = staticKeys[i];
      throw new Error(
        `broadcastSignedPumpfunCreate: signer slot ${i} (${slot}) is unsigned`,
      );
    }
  }

  let txSignature: string;
  try {
    txSignature = await deps.sendRawTransaction(tx.serialize());
  } catch (err) {
    throw new Error(
      `rpc_submit: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  return {
    mintAddress: input.expectedMintAddress,
    txSignature,
  };
}
