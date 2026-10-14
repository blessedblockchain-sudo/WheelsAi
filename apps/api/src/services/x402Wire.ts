// The published x402 format, version 2, as the door speaks it over HTTP.
//
// Three headers, each the base64 of a JSON object: PAYMENT-REQUIRED (server
// to client, with a 402), PAYMENT-SIGNATURE (client to server, the paid
// retry) and PAYMENT-RESPONSE (server to client, on the answer or on a
// failed payment). The requirements are built by the server alone, every
// time, and what the client echoes back is only ever compared with them:
// nothing is priced or addressed from the echo.
//
// The deployment's own wallet payment (services/x402.ts) speaks WheelsAI's
// older wire and is not this.
//
// Pure: no settings, no connection, no clock. Secrets are handed in.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SolanaNetwork } from "../lib/solanaAssets.js";
import { X402_MAX_TIMEOUT_SECONDS } from "./x402DoorRules.js";

/** The version of the format the door speaks. A payment of another version is not read. */
export const X402_VERSION = 2;

/**
 * The label the memo's MAC input starts with. The secret is the one the SOL
 * quote and the address buckets already use, so each use has a label of its
 * own and no MAC can stand for another.
 */
const X402_MEMO_MAC_LABEL = "wheelsai-x402-memo-v1:";

/** The reference strings of version 2 (the reason a payment is refused), written once. */
export const X402_ERROR_REASONS = {
  unsupportedScheme: "unsupported_scheme",
  networkMismatch: "network_mismatch",
  missingFeePayer: "invalid_exact_svm_payload_missing_fee_payer",
  feePayerNotManaged: "fee_payer_not_managed_by_facilitator",
  couldNotBeDecoded: "invalid_exact_svm_payload_transaction_could_not_be_decoded",
  instructionsLength: "invalid_exact_svm_payload_transaction_instructions_length",
  computeLimitInstruction: "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
  computePriceInstruction: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
  computePriceTooHigh: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
  noTransferInstruction: "invalid_exact_svm_payload_no_transfer_instruction",
  feePayerTransferringFunds: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
  mintMismatch: "invalid_exact_svm_payload_mint_mismatch",
  recipientMismatch: "invalid_exact_svm_payload_recipient_mismatch",
  amountMismatch: "invalid_exact_svm_payload_amount_mismatch",
  unknownFourthInstruction: "invalid_exact_svm_payload_unknown_fourth_instruction",
  unknownFifthInstruction: "invalid_exact_svm_payload_unknown_fifth_instruction",
  unknownSixthInstruction: "invalid_exact_svm_payload_unknown_sixth_instruction",
  memoCount: "invalid_exact_svm_payload_memo_count",
  memoMismatch: "invalid_exact_svm_payload_memo_mismatch",
  transactionSimulationFailed: "transaction_simulation_failed",
  duplicateSettlement: "duplicate_settlement",
  transactionFailed: "transaction_failed",
  insufficientFunds: "insufficient_funds",
  invalidNetwork: "invalid_network",
  invalidPayload: "invalid_payload",
  invalidScheme: "invalid_scheme",
  invalidX402Version: "invalid_x402_version",
  invalidTransactionState: "invalid_transaction_state",
  unexpectedVerifyError: "unexpected_verify_error",
  unexpectedSettleError: "unexpected_settle_error",
} as const;

export type X402ErrorReason = (typeof X402_ERROR_REASONS)[keyof typeof X402_ERROR_REASONS];

// ============================================
// Networks
// ============================================

/**
 * The CAIP-2 ids of the two clusters: "solana:" and the first 32 characters
 * of the cluster's genesis hash (a test holds them to lib/solana.ts
 * GENESIS_HASHES, which this file may not import: it reads the settings).
 */
export const X402_CAIP2_NETWORKS = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
} as const satisfies Record<SolanaNetwork, string>;

/**
 * The network as the published format names it. Only on the wire: a
 * payment's row keeps today's network strings (x402NetworkFor), which the
 * settlement worker selects by.
 */
export function x402Caip2Network(network: SolanaNetwork): string {
  return network === "mainnet-beta" ? X402_CAIP2_NETWORKS["mainnet-beta"] : X402_CAIP2_NETWORKS.devnet;
}

// ============================================
// The objects
// ============================================

/** What the door asks for one use. Always with a fee payer and a memo. */
export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2. */
  network: string;
  /** Atomic units of the asset, as a string: "50000" for 5 cents of USDC. */
  amount: string;
  /** The mint. */
  asset: string;
  /** The wallet paid (never its token account). */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    /** The address that pays the fee and adds the last signature: WheelsAI's fee payer. */
    feePayer: string;
    /** The exact text the payment's one Memo must carry. */
    memo: string;
  };
}

export interface PaymentResource {
  url: string;
  description?: string;
  mimeType?: string;
}

/** The object of the PAYMENT-REQUIRED header. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: X402ErrorReason;
  resource: PaymentResource;
  accepts: PaymentRequirements[];
}

/** The parts of a PAYMENT-SIGNATURE the door reads. `accepted` is the client's echo: untrusted. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  accepted: unknown;
  payload: { transaction: string };
}

/** The object of the PAYMENT-RESPONSE header. `network` is required, on a failure too. */
export interface SettlementResponse {
  success: boolean;
  errorReason?: X402ErrorReason;
  payer?: string;
  /** The transaction's signature, base58, or "" when nothing went through. */
  transaction: string;
  /** CAIP-2. */
  network: string;
  amount?: string;
}

// ============================================
// Building the 402
// ============================================

/** One cent of USDC in atomic units (6 decimals). */
const USDC_ATOMIC_PER_CENT = 10_000n;

export interface ListingRequirementsInput {
  network: SolanaNetwork;
  /** The listing's price for one use, in whole cents. */
  priceCents: bigint;
  /** The USDC mint of the network. */
  asset: string;
  /** The treasury wallet. */
  payTo: string;
  /** WheelsAI's fee payer. */
  feePayer: string;
  memo: string;
}

/** The requirements of one use of a listing, every value from the server. */
export function listingRequirements(input: ListingRequirementsInput): PaymentRequirements {
  if (typeof input.priceCents !== "bigint" || input.priceCents <= 0n) {
    throw new Error("x402: a price of at least one cent is required");
  }
  return {
    scheme: "exact",
    network: x402Caip2Network(input.network),
    amount: (input.priceCents * USDC_ATOMIC_PER_CENT).toString(),
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: { feePayer: input.feePayer, memo: input.memo },
  };
}

/** The use address as the published format names it: PUBLIC_API_URL and the path. */
export function x402ResourceUrl(publicApiUrl: string, path: string): string {
  return `${publicApiUrl.trim().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The PaymentRequired of one use, built field by field. */
export function paymentRequired(input: {
  url: string;
  description: string;
  requirements: PaymentRequirements;
  error?: X402ErrorReason;
}): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(input.error !== undefined ? { error: input.error } : {}),
    resource: { url: input.url, description: input.description, mimeType: "application/json" },
    accepts: [input.requirements],
  };
}

function toBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The PAYMENT-REQUIRED header's value. */
export function encodePaymentRequired(value: PaymentRequired): string {
  return toBase64Json(value);
}

/** The PAYMENT-RESPONSE header's value. */
export function encodePaymentResponse(value: SettlementResponse): string {
  // Field by field, in the published order: nothing else reaches the payer.
  return toBase64Json({
    success: value.success,
    ...(value.errorReason !== undefined ? { errorReason: value.errorReason } : {}),
    ...(value.payer !== undefined ? { payer: value.payer } : {}),
    transaction: value.transaction,
    network: value.network,
    ...(value.amount !== undefined ? { amount: value.amount } : {}),
  });
}

// ============================================
// Reading the paid retry
// ============================================

/** The header the paid retry carries. There is no X-PAYMENT fallback. */
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";

/**
 * The longest header read. A Solana transaction is at most 1,232 bytes, so a
 * real payment is far under this; anything longer is not read at all.
 */
const MAX_PAYMENT_HEADER_CHARS = 16_384;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PaymentSignatureRead =
  | { kind: "none" }
  | { kind: "unreadable"; reason: typeof X402_ERROR_REASONS.invalidPayload | typeof X402_ERROR_REASONS.invalidX402Version }
  | { kind: "payment"; payment: PaymentPayload };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The paid retry's PAYMENT-SIGNATURE: none, unreadable (a header that does
 * not decode, or of another version, counts as no payment and says why), or
 * the payload. Headers as Node gives them, names in lower case.
 */
export function readPaymentSignature(
  headers: Record<string, string | string[] | undefined>,
): PaymentSignatureRead {
  const raw = headers[PAYMENT_SIGNATURE_HEADER];
  if (raw === undefined) return { kind: "none" };
  const unreadable = { kind: "unreadable", reason: X402_ERROR_REASONS.invalidPayload } as const;
  // Two of them cannot be told apart.
  if (typeof raw !== "string") return unreadable;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_PAYMENT_HEADER_CHARS || !BASE64.test(text)) return unreadable;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
  } catch {
    return unreadable;
  }
  if (!isPlainObject(parsed)) return unreadable;
  if (parsed.x402Version !== X402_VERSION) {
    return { kind: "unreadable", reason: X402_ERROR_REASONS.invalidX402Version };
  }
  const payload = parsed.payload;
  if (!isPlainObject(payload) || typeof payload.transaction !== "string" || payload.transaction.length === 0) {
    return unreadable;
  }
  if (!isPlainObject(parsed.accepted)) return unreadable;
  return {
    kind: "payment",
    payment: { x402Version: X402_VERSION, accepted: parsed.accepted, payload: { transaction: payload.transaction } },
  };
}

// ============================================
// The memo
// ============================================

/** The random bytes of a memo's nonce. */
export const X402_MEMO_NONCE_BYTES = 6;
/** The bytes of the MAC a memo keeps: 96 bits. */
const X402_MEMO_MAC_BYTES = 12;
/** A memo's length: the base64url of the nonce and the MAC, 18 bytes. */
export const X402_MEMO_CHARS = 24;
const MEMO_TEXT = /^[A-Za-z0-9_-]{24}$/;

function memoMac(secret: string, listingId: string, nonce: string, amount: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${X402_MEMO_MAC_LABEL}${listingId}:${nonce}:${amount}`)
    .digest()
    .subarray(0, X402_MEMO_MAC_BYTES);
}

/**
 * The memo of one challenge: the base64url of a nonce of 6 random bytes and
 * 12 bytes of a MAC over the listing, the nonce and the amount, 24
 * characters in all. It binds a payment to this listing and this amount,
 * and nothing is written for it: the MAC is what the paid retry is checked
 * by. The nonce becomes the payment row's requestId.
 *
 * Short on purpose. The reference client sets a limit of 20,000 compute
 * units, and the Memo program costs about 350 units a byte: on the local
 * test validator a TransferChecked with a 32-byte memo used 19,249 units,
 * and with the 96-byte memo this door first asked for, 41,848, which no
 * standard client could pay. 24 characters leave room under the limit.
 */
export function makeX402Memo(input: {
  listingId: string;
  amount: string;
  secret: string;
  /** X402_MEMO_NONCE_BYTES bytes; random unless a test hands them in. */
  nonceBytes?: Uint8Array;
}): { memo: string; nonce: string } {
  if (typeof input.secret !== "string" || input.secret.length === 0) throw new Error("x402: a memo needs a secret");
  const bytes = input.nonceBytes ?? randomBytes(X402_MEMO_NONCE_BYTES);
  if (bytes.length !== X402_MEMO_NONCE_BYTES) throw new Error(`x402: a memo's nonce is ${X402_MEMO_NONCE_BYTES} bytes`);
  const nonce = Buffer.from(bytes).toString("base64url");
  const mac = memoMac(input.secret, input.listingId, nonce, input.amount);
  return { memo: Buffer.concat([Buffer.from(bytes), mac]).toString("base64url"), nonce };
}

/**
 * The nonce of a memo this server made for this listing and this amount, or
 * null for any other text.
 */
export function readX402Memo(
  memo: unknown,
  expected: { listingId: string; amount: string; secret: string },
): { nonce: string } | null {
  if (typeof memo !== "string" || !MEMO_TEXT.test(memo)) return null;
  if (typeof expected.secret !== "string" || expected.secret.length === 0) return null;
  const bytes = Buffer.from(memo, "base64url");
  // The text must be exactly what its bytes encode to.
  if (bytes.length !== X402_MEMO_NONCE_BYTES + X402_MEMO_MAC_BYTES || bytes.toString("base64url") !== memo) return null;
  const nonce = bytes.subarray(0, X402_MEMO_NONCE_BYTES).toString("base64url");
  const want = memoMac(expected.secret, expected.listingId, nonce, expected.amount);
  if (!timingSafeEqual(bytes.subarray(X402_MEMO_NONCE_BYTES), want)) return null;
  return { nonce };
}

// ============================================
// The client's echo against ours
// ============================================

export type AcceptedComparison =
  | { ok: true; requirements: PaymentRequirements; nonce: string }
  | { ok: false; reason: X402ErrorReason };

/**
 * The paid retry's `accepted` against the requirements as built NOW for this
 * listing: scheme, network, amount, asset, payTo, maxTimeoutSeconds and the
 * fee payer exactly, and the memo by its prefix, its listing and its MAC
 * (it carries the nonce of the 402 the client answered, not of ours). A
 * price change between the 402 and the retry is a mismatch.
 *
 * Answers the requirements the transaction must meet (ours, with the memo
 * the client was given) and the memo's nonce, or the reference string.
 */
export function compareAccepted(
  accepted: unknown,
  ours: PaymentRequirements,
  memoCheck: { listingId: string; secret: string },
): AcceptedComparison {
  const refuse = (reason: X402ErrorReason): AcceptedComparison => ({ ok: false, reason });
  if (!isPlainObject(accepted)) return refuse(X402_ERROR_REASONS.invalidPayload);
  if (accepted.scheme !== ours.scheme) return refuse(X402_ERROR_REASONS.unsupportedScheme);
  if (accepted.network !== ours.network) return refuse(X402_ERROR_REASONS.networkMismatch);
  if (accepted.amount !== ours.amount) return refuse(X402_ERROR_REASONS.amountMismatch);
  if (accepted.asset !== ours.asset) return refuse(X402_ERROR_REASONS.mintMismatch);
  if (accepted.payTo !== ours.payTo) return refuse(X402_ERROR_REASONS.recipientMismatch);
  // The notes give no string of their own for this one.
  if (accepted.maxTimeoutSeconds !== ours.maxTimeoutSeconds) return refuse(X402_ERROR_REASONS.invalidPayload);
  const extra = accepted.extra;
  if (!isPlainObject(extra) || typeof extra.feePayer !== "string" || extra.feePayer.length === 0) {
    return refuse(X402_ERROR_REASONS.missingFeePayer);
  }
  if (extra.feePayer !== ours.extra.feePayer) return refuse(X402_ERROR_REASONS.feePayerNotManaged);
  const memo = extra.memo;
  const read = readX402Memo(memo, { listingId: memoCheck.listingId, amount: ours.amount, secret: memoCheck.secret });
  if (read === null || typeof memo !== "string") return refuse(X402_ERROR_REASONS.memoMismatch);
  return {
    ok: true,
    requirements: { ...ours, extra: { feePayer: ours.extra.feePayer, memo } },
    nonce: read.nonce,
  };
}
