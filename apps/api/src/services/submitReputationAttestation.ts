/**
 * Reputation attestation submission orchestrator (plan A4 — issuer side
 * complete).
 *
 * Until the Anchor reputation oracle program ships (which will accept a
 * signed-account write), attestations live in memo-program transactions.
 * The memo data is JSON containing both the canonical payload AND the
 * attester's ed25519 signature over it:
 *
 *   { payload: ReputationAttestationPayload, signatureBase58: string }
 *
 * Why store the signature in the memo rather than rely on the tx
 * signature: the platform's fee-payer signs the *transaction*. The
 * attester signs the *payload bytes*. Those are two different statements
 * about two different things — keeping them separate means a future
 * Anchor migration only needs to swap "memo" for "oracle PDA write"
 * without touching the verifier semantics.
 *
 * IO is fully injected (fetchLatestBlockhash + sendRawTransaction) so
 * unit tests run without an RPC.
 */

import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ReputationAttestationPayload } from "./reputationAttestation.js";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

// Solana caps tx size to ~1232 bytes; instruction overhead leaves ~566
// bytes for memo data in a single-ix tx. Stay under that.
const MEMO_MAX_BYTES = 566;

const REQUIRED_PAYLOAD_FIELDS: ReadonlyArray<keyof ReputationAttestationPayload> = [
  "agentId",
  "agentSlug",
  "attester",
  "errorCount",
  "issuedAt",
  "periodEnd",
  "periodStart",
  "reputationScore",
  "schema",
  "totalRequestCount",
  "uptimeSeconds",
];

export interface SubmitReputationAttestationInput {
  payload: ReputationAttestationPayload;
  signatureBase58: string;
}

export interface SubmitReputationAttestationDeps {
  feePayerKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitReputationAttestationResult {
  txSignature: string;
  memoData: string;
}

function validateInput(input: SubmitReputationAttestationInput): void {
  if (!input.signatureBase58 || input.signatureBase58.length === 0) {
    throw new Error(
      "submitReputationAttestation: signatureBase58 is required",
    );
  }
  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    if (
      input.payload[field] === undefined ||
      input.payload[field] === null
    ) {
      throw new Error(
        `submitReputationAttestation: payload missing required field '${field}'`,
      );
    }
  }
}

export async function submitReputationAttestation(
  input: SubmitReputationAttestationInput,
  deps: SubmitReputationAttestationDeps,
): Promise<SubmitReputationAttestationResult> {
  validateInput(input);

  const memoData = JSON.stringify({
    payload: input.payload,
    signatureBase58: input.signatureBase58,
  });
  const memoBytes = new TextEncoder().encode(memoData);
  if (memoBytes.length > MEMO_MAX_BYTES) {
    throw new Error(
      `submitReputationAttestation: memo_too_large (${memoBytes.length} > ${MEMO_MAX_BYTES} bytes)`,
    );
  }

  let blockhash: string;
  try {
    const fetched = await deps.fetchLatestBlockhash();
    blockhash = fetched.blockhash;
  } catch (err) {
    throw new Error(
      `blockhash_unavailable: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memoBytes),
  });

  const message = new TransactionMessage({
    payerKey: deps.feePayerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [memoIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([deps.feePayerKeypair]);

  let txSignature: string;
  try {
    txSignature = await deps.sendRawTransaction(tx.serialize());
  } catch (err) {
    throw new Error(
      `rpc_submit: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  return { txSignature, memoData };
}
