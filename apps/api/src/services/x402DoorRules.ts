// The rules of the x402 door: one use of an agent, paid from a Solana wallet
// by a caller with no account, in the published x402 format (version 2).
//
// The door answers first and is paid second: the answer is made and checked
// before WheelsAI signs the payer's transaction as its fee payer and sends
// it, and the answer is released only once the chain confirms. Every number
// that order depends on is here, once, with the one test of whether the door
// is open, the one test of whether it serves a listing, and every sentence a
// caller at the door can be told.
//
// Pure: no settings, no connection, no clock. The settings are handed in.

import { MIN_PRICE_PER_USE_CENTS } from "./useListing.js";

// ============================================
// Time
// ============================================

/** From the request's arrival to the answer made and checked. */
export const X402_ANSWER_DEADLINE_MS = 30_000;

/**
 * No payment is signed or sent later than this after the request arrived.
 * A blockhash lives 60 to 90 seconds from when the CLIENT fetched it, so a
 * payment sent later would mostly expire on the way.
 */
export const X402_SEND_BY_MS = 45_000;

/** The longest the request waits for the chain after the send. */
export const X402_DOOR_CONFIRM_MAX_MS = 120_000;

/**
 * A "dead" fate read sooner than this after the send is not believed: a
 * brand-new blockhash reads not valid at finalized for about 13 seconds.
 */
export const X402_DOOR_DEAD_TRUSTED_AFTER_MS = 20_000;

/**
 * The settlement worker touches a door payment only once it is this old, so
 * it never races the request that is still waiting for it.
 */
export const X402_DOOR_FINISH_AFTER_MS = 5 * 60_000;

/**
 * Sent as maxTimeoutSeconds: the longest a call may take, the send-by bound
 * plus the confirm wait, rounded up.
 */
export const X402_MAX_TIMEOUT_SECONDS = 180;

// ============================================
// Limits and money
// ============================================

/**
 * Answers made for a wallet's (or an address's) payments that then did not
 * go through, a day. An answer costs the model; a payment that never lands
 * costs the caller nothing, so this many and no more.
 */
export const X402_UNPAID_ANSWERS_PER_DAY = 3;

/** Under this the fee payer pays no more fees, and the door says it is not available (0.01 SOL). */
export const X402_FEE_PAYER_MIN_LAMPORTS = 10_000_000n;

/** Mainnet only on the founder's word, in a commit of its own. */
export const X402_DOOR_ON_MAINNET = false;

// ============================================
// When the door is open
// ============================================

/** The settings the door depends on, read by the caller and handed in. */
export interface X402DoorSettings {
  /** X402_ENABLED. */
  x402Enabled: boolean;
  /** X402_SUBMIT_TRANSACTIONS. */
  submitTransactions: boolean;
  /**
   * X402_SETTLEMENT_WORKER_ENABLED. Without the worker a payment left
   * unconfirmed, and every verified door payment, is never finished.
   */
  settlementWorkerEnabled: boolean;
  /** PUBLIC_API_URL: it makes the resource url of every 402, a required field. */
  publicApiUrl: string | null | undefined;
  /** WALLET_MASTER_KEY: the fee payer is derived from it. */
  walletMasterKey: string | null | undefined;
  /** SOLANA_NETWORK. */
  solanaNetwork: string;
}

/** The fewest characters of a master key a wallet may be derived from (services/payoutKeypair.ts). */
const MIN_MASTER_KEY_LENGTH = 32;

function isHttpUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * True when the door can take a payment: every setting it needs is on and
 * the chain is devnet (the local chain runs as devnet in development).
 * Anything missing closes it; nothing is ever asked for, and a closed door
 * leaves every address exactly as it was.
 */
export function x402DoorOpen(settings: X402DoorSettings): boolean {
  if (settings.x402Enabled !== true) return false;
  if (settings.submitTransactions !== true) return false;
  if (settings.settlementWorkerEnabled !== true) return false;
  if (!isHttpUrl(settings.publicApiUrl)) return false;
  if (typeof settings.walletMasterKey !== "string" || settings.walletMasterKey.length < MIN_MASTER_KEY_LENGTH) {
    return false;
  }
  if (settings.solanaNetwork === "devnet") return true;
  return X402_DOOR_ON_MAINNET && settings.solanaNetwork === "mainnet-beta";
}

// ============================================
// What a listing needs
// ============================================

/** The listing's fields the door reads, as they are at that moment. */
export interface X402DoorListing {
  agentId: string | null;
  /** Set on a listing that sells a workflow, which the door never serves. */
  orchestrationId: string | null;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  /** The creator's switch, agent_listings.x402_enabled. */
  x402Enabled: boolean;
}

/** The agent's fields the door reads. */
export interface X402DoorAgent {
  isPublic: boolean;
  agentKind: string;
  entrypoint: string;
}

/** The kinds of agent that answer when they are called. A scheduled one runs on its own. */
const X402_AGENT_KINDS: ReadonlySet<string> = new Set(["conversation", "task"]);

/**
 * True when the door serves this listing: an agent's listing, published,
 * selling use per request at a price of at least the floor, with the
 * creator's switch on, whose agent is public, answers when it is called and
 * does not answer through its graph. The one test, so a page never offers a
 * door that would answer 401.
 */
export function x402ListingServed(listing: X402DoorListing, agent: X402DoorAgent): boolean {
  if (listing.agentId === null || listing.orchestrationId !== null) return false;
  if (listing.status !== "published") return false;
  if (listing.sells !== "use") return false;
  if (listing.pricingModel !== "per_request") return false;
  if (listing.pricePerRequestCents === null || listing.pricePerRequestCents < MIN_PRICE_PER_USE_CENTS) return false;
  if (listing.x402Enabled !== true) return false;
  if (agent.isPublic !== true) return false;
  if (!X402_AGENT_KINDS.has(agent.agentKind)) return false;
  if (agent.entrypoint === "graph") return false;
  return true;
}

// ============================================
// Words
// ============================================

/** What one payment at the door buys: a chat answer or a task's run. */
export type X402DoorUnit = "message" | "run";

/** The price as paid use writes it: "$0.05". */
const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;

const ANSWER_DEADLINE_SECONDS = X402_ANSWER_DEADLINE_MS / 1000;

/**
 * What a caller at the door is told. Plain words, no em dashes, no code
 * names: the version 2 reason goes in the PAYMENT-REQUIRED or
 * PAYMENT-RESPONSE header, and our code in the body's error. Never "nothing
 * was charged" after the chain took a payment, and never a word of a refund
 * or a credit balance: the payer has no account.
 */
export const X402_DOOR_MESSAGES = {
  paymentRequired: (price: bigint, unit: X402DoorUnit) =>
    `Pay ${dollars(price)} in USDC from a Solana wallet for one ${unit}, as the PAYMENT-REQUIRED header of this answer says, or send an API key.`,
  paymentInvalid:
    "This payment cannot be accepted, so it was not sent and nothing was charged. The PAYMENT-REQUIRED header of this answer says why, and how to pay.",
  presentedTwice:
    "This payment was already presented once. A payment pays for one answer only, so it was not sent again. Pay with a new transaction.",
  wouldNotGoThrough:
    "This payment would not go through, for example because the wallet holds too little USDC. It was not sent and nothing was charged.",
  unavailable:
    "Paying from a wallet is not available right now. Nothing was sent and nothing was charged. Try again later.",
  addressMinute:
    "More requests came from this address than this agent allows for now. Nothing was sent and nothing was charged. The retry-after header says how many seconds to wait.",
  walletOrAddressDay:
    "More payments came from this wallet or address than this agent allows for now. Nothing was sent and nothing was charged. The retry-after header says how many seconds to wait.",
  walletStillOpen:
    "A payment from this wallet is still going through. Wait for its answer, then try again. Nothing was sent and nothing was charged.",
  tooManyUnpaid:
    "Too many answers were made today for payments from this wallet or address that did not go through. Try again tomorrow. Nothing was charged.",
  cannotCount:
    "Requests cannot be counted right now, so none are taken. Nothing was sent and nothing was charged. Try again in a minute.",
  paused: "This agent is paused right now. Nothing was sent and nothing was charged.",
  modelFailed: "The agent could not answer this time. Your payment was not sent and nothing was charged.",
  withheld: "The answer could not be released. Your payment was not sent and nothing was charged.",
  tooSlow: `The answer was not ready within ${ANSWER_DEADLINE_SECONDS} seconds, the longest a payment from a wallet can wait, so it was stopped. Your payment was not sent and nothing was charged.`,
  callerLeft: "The request was closed before the answer was ready. Your payment was not sent and nothing was charged.",
  chainRefused:
    "The payment did not go through on Solana, so the answer was not released. Nothing was taken from your wallet.",
  expired:
    "The payment expired before it could go through, so the answer was not released. Nothing was taken from your wallet. Pay again with a new transaction.",
  unconfirmed:
    "Your payment was sent but could not be confirmed in time, so the answer was not released. The transaction is named in this answer.",
  unserved: "Your payment went through but the answer could not be released. The transaction is named in this answer.",
} as const;
