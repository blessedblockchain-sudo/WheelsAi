/**
 * Pure pump.fun create-token transaction helpers (plan A1).
 *
 * Wraps pumpportal.fun's `/api/trade-local` protocol so the orchestrator
 * (services/pumpfun.ts) stays a thin shell over network + signing.
 *
 *   buildPumpfunCreateRequest(...)         → JSON body for /api/trade-local
 *   deserializePumpfunUnsignedTx(bytes)    → VersionedTransaction (unsigned)
 *   extractMintFromCreateRequest(body)     → mint pubkey base58
 *
 * No fetch, no signing, no Connection. Validation throws up front so a
 * misbehaving caller can't quietly produce a tx that pumpportal will
 * reject after a network round-trip.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

const SYMBOL_MIN = 1;
const SYMBOL_MAX = 10;
const DEFAULT_SLIPPAGE = 10;
const DEFAULT_PRIORITY_FEE_SOL = 0.00005;

// ============================================
// Types
// ============================================

export interface PumpfunCreateInput {
  creatorPubkey: string;
  mintPubkey: string;
  name: string;
  symbol: string;
  uri: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /** Creator's optional initial buy in SOL. Defaults to 0 (no buy). */
  initialBuySol?: number;
  /** Slippage tolerance in percent. Defaults to 10. */
  slippage?: number;
  /** Priority fee in SOL. Defaults to 0.00005. */
  priorityFee?: number;
}

export interface PumpfunCreateRequestBody {
  action: "create";
  publicKey: string;
  mint: string;
  tokenMetadata: {
    name: string;
    symbol: string;
    uri: string;
    twitter?: string;
    telegram?: string;
    website?: string;
  };
  denominatedInSol: "true";
  amount: number;
  slippage: number;
  priorityFee: number;
  pool: "pump";
}

// ============================================
// Validation helpers
// ============================================

function parsePubkey(label: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`buildPumpfunCreateRequest: invalid pubkey for ${label}`);
  }
}

// ============================================
// buildPumpfunCreateRequest
// ============================================

export function buildPumpfunCreateRequest(
  input: PumpfunCreateInput,
): PumpfunCreateRequestBody {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("buildPumpfunCreateRequest: name is required");
  }
  if (
    typeof input.symbol !== "string" ||
    input.symbol.length < SYMBOL_MIN ||
    input.symbol.length > SYMBOL_MAX
  ) {
    throw new Error(
      `buildPumpfunCreateRequest: symbol must be ${SYMBOL_MIN}-${SYMBOL_MAX} characters`,
    );
  }
  if (!input.uri || input.uri.trim().length === 0) {
    throw new Error("buildPumpfunCreateRequest: uri is required (upload metadata to IPFS first)");
  }
  if (input.initialBuySol !== undefined && input.initialBuySol < 0) {
    throw new Error(
      `buildPumpfunCreateRequest: initialBuySol must be >= 0, got ${input.initialBuySol}`,
    );
  }

  // Validate the pubkeys parse — throws a helpful error early instead of
  // a confusing pumpportal 400 ten seconds later.
  parsePubkey("creatorPubkey", input.creatorPubkey);
  parsePubkey("mintPubkey", input.mintPubkey);

  const tokenMetadata: PumpfunCreateRequestBody["tokenMetadata"] = {
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
  };
  if (input.twitter) tokenMetadata.twitter = input.twitter;
  if (input.telegram) tokenMetadata.telegram = input.telegram;
  if (input.website) tokenMetadata.website = input.website;

  return {
    action: "create",
    publicKey: input.creatorPubkey,
    mint: input.mintPubkey,
    tokenMetadata,
    denominatedInSol: "true",
    amount: input.initialBuySol ?? 0,
    slippage: input.slippage ?? DEFAULT_SLIPPAGE,
    priorityFee: input.priorityFee ?? DEFAULT_PRIORITY_FEE_SOL,
    pool: "pump",
  };
}

// ============================================
// deserializePumpfunUnsignedTx
// ============================================

export function deserializePumpfunUnsignedTx(
  bytes: Uint8Array,
): VersionedTransaction {
  if (!bytes || bytes.length === 0) {
    throw new Error("pumpfun deserialize: empty buffer");
  }
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (err) {
    throw new Error(
      `pumpfun deserialize: failed to parse transaction (${(err as Error).message})`,
    );
  }
}

// ============================================
// extractMintFromCreateRequest
// ============================================

export function extractMintFromCreateRequest(
  body: PumpfunCreateRequestBody,
): string {
  return body.mint;
}
