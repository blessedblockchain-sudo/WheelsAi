/**
 * pump.fun create-token submission orchestrator (plan A1, side-effect side).
 *
 * Composes:
 *   1. POST pumpportal /api/trade-local with the request body
 *   2. Read response as bytes
 *   3. Deserialize → unsigned VersionedTransaction
 *   4. Sign with creator + mint keypairs
 *   5. Submit via injected sendRawTransaction → tx signature
 *
 * IO is fully injected (fetchFn + sendRawTransaction) so tests can drive
 * every branch without hitting pumpportal or a real Solana RPC.
 *
 * Validates body↔keypair pubkey alignment up front to catch the easy
 * route-level wiring bug ("we generated a fresh mint but forgot to update
 * the body") before the network round-trip.
 */

import type { Keypair } from "@solana/web3.js";

import {
  deserializePumpfunUnsignedTx,
  type PumpfunCreateRequestBody,
} from "./pumpfunTxBuilder.js";

const PUMPPORTAL_LOCAL_ENDPOINT = "https://pumpportal.fun/api/trade-local";

export interface SubmitPumpfunCreateInput {
  body: PumpfunCreateRequestBody;
  creatorKeypair: Keypair;
  mintKeypair: Keypair;
}

export interface SubmitPumpfunCreateDeps {
  fetchFn: typeof fetch;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitPumpfunCreateResult {
  mintAddress: string;
  txSignature: string;
}

export async function submitPumpfunCreate(
  input: SubmitPumpfunCreateInput,
  deps: SubmitPumpfunCreateDeps,
): Promise<SubmitPumpfunCreateResult> {
  // Catch route-wiring bugs before the network round-trip.
  if (input.creatorKeypair.publicKey.toBase58() !== input.body.publicKey) {
    throw new Error(
      "submitPumpfunCreate: creator keypair/body publicKey mismatch",
    );
  }
  if (input.mintKeypair.publicKey.toBase58() !== input.body.mint) {
    throw new Error(
      "submitPumpfunCreate: mint keypair/body mint mismatch",
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

  // pumpportal returns the message; we sign with creator (fee payer +
  // primary signer) AND mint (the new mint must sign its own creation).
  tx.sign([input.creatorKeypair, input.mintKeypair]);

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
    mintAddress: input.body.mint,
    txSignature,
  };
}
