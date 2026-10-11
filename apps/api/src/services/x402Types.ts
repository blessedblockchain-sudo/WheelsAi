// What the two halves of x402 share: the pure half that prices a request,
// locks a SOL rate and reads a payment (services/x402Price.ts, x402Quote.ts,
// x402Decode.ts), and the half that carries a payment from "handed over" to
// "served" or "returned" (services/x402Payments.ts). Types only: no I/O.

/** The assets a request can be paid for in. NOS has no live price. */
export type X402Asset = "USDC" | "SOL";

/** What one request costs, in the asset it is asked for in. */
export interface X402Price {
  asset: X402Asset;
  /** The request's price in millionths of a dollar. Above zero. */
  amountMicroUsd: bigint;
  /** The same in base units: USDC base units, or lamports. Above zero. */
  amountRaw: bigint;
  /** SOL only: the rate it was worked out at, in micro-dollars per SOL. */
  solMicroUsdPerSol: bigint | null;
}

/** What a paid retry is checked against. */
export interface X402PaymentWanted {
  asset: X402Asset;
  /** The treasury wallet. SOL goes to it; USDC goes to its token account. */
  payTo: string;
  /** The USDC mint of the configured chain. */
  usdcMint: string;
  /** The least the transfer may carry, in base units. */
  minAmountRaw: bigint;
}

/** A signed transaction read as a payment. */
export interface DecodedX402Payment {
  /** The transaction's first signature, base58: what the chain knows it by. */
  signature: string;
  /** The fee payer. Recorded, never judged. */
  payer: string;
  asset: X402Asset;
  /** What the matching transfer actually carries, in base units. */
  amountRaw: bigint;
  /** The blockhash the transaction was built on. */
  recentBlockhash: string;
  /** The signed bytes exactly as they were handed over, base64. */
  signedTxB64: string;
}

export type DecodeX402Refusal =
  /** Not base64, or not a Solana transaction. */
  | "not_a_transaction"
  /** A version 0 transaction that loads addresses from lookup tables. */
  | "uses_lookup_tables"
  /** A required signature is missing or does not verify. */
  | "bad_signature"
  /** No transfer of the asset to the right destination. */
  | "no_payment"
  /** A transfer to the right destination that carries too little. */
  | "amount_too_low";

export type DecodeX402Result =
  | { ok: true; payment: DecodedX402Payment }
  | { ok: false; reason: DecodeX402Refusal };

/** Why a presented payment was not taken. The only reasons a payer reads. */
export type X402RefusalReason =
  | "quote_expired"
  | "payment_invalid"
  | "payment_failed_on_chain"
  | "payment_not_confirmed";

/** What a SOL rate lock holds once it has been read back and checked. */
export interface X402QuoteReading {
  asset: X402Asset;
  /** Micro-dollars per SOL, as the challenge priced it. */
  solMicroUsdPerSol: bigint;
}
