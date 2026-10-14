import assert from "node:assert/strict";
import test from "node:test";

import {
  X402_ANSWER_DEADLINE_MS,
  X402_DOOR_CONFIRM_MAX_MS,
  X402_DOOR_DEAD_TRUSTED_AFTER_MS,
  X402_DOOR_FINISH_AFTER_MS,
  X402_DOOR_MESSAGES,
  X402_DOOR_ON_MAINNET,
  X402_FEE_PAYER_MIN_LAMPORTS,
  X402_MAX_TIMEOUT_SECONDS,
  X402_SEND_BY_MS,
  X402_UNPAID_ANSWERS_PER_DAY,
  x402DoorOpen,
  x402ListingServed,
  type X402DoorAgent,
  type X402DoorListing,
  type X402DoorSettings,
} from "../services/x402DoorRules.js";
import { X402_ERROR_REASONS } from "../services/x402Wire.js";

// The rules of the x402 door: its numbers, when it is open, which listings
// it serves, and what a caller at it is told.

// ============================================
// The numbers
// ============================================

test("the numbers, each once", () => {
  assert.equal(X402_ANSWER_DEADLINE_MS, 30_000);
  assert.equal(X402_SEND_BY_MS, 45_000);
  assert.equal(X402_DOOR_CONFIRM_MAX_MS, 120_000);
  assert.equal(X402_DOOR_DEAD_TRUSTED_AFTER_MS, 20_000);
  assert.equal(X402_DOOR_FINISH_AFTER_MS, 300_000);
  assert.equal(X402_MAX_TIMEOUT_SECONDS, 180);
  assert.equal(X402_UNPAID_ANSWERS_PER_DAY, 3);
  assert.equal(X402_FEE_PAYER_MIN_LAMPORTS, 10_000_000n);
  assert.equal(X402_DOOR_ON_MAINNET, false);
});

test("the four relations between the times", () => {
  // The answer is made before the send is due.
  assert.ok(X402_ANSWER_DEADLINE_MS < X402_SEND_BY_MS);
  // What the client is told to wait covers the send and the confirm wait.
  assert.ok(X402_MAX_TIMEOUT_SECONDS * 1000 >= X402_SEND_BY_MS + X402_DOOR_CONFIRM_MAX_MS);
  // The worker never touches a row the request may still be waiting on.
  assert.ok(X402_DOOR_FINISH_AFTER_MS >= X402_SEND_BY_MS + X402_DOOR_CONFIRM_MAX_MS + 60_000);
  // A new blockhash reads invalid at finalized for about 13 seconds.
  assert.ok(X402_DOOR_DEAD_TRUSTED_AFTER_MS >= 15_000);
});

// ============================================
// When the door is open
// ============================================

const OPEN: X402DoorSettings = {
  x402Enabled: true,
  submitTransactions: true,
  settlementWorkerEnabled: true,
  publicApiUrl: "https://api.example.test",
  walletMasterKey: "m".repeat(32),
  solanaNetwork: "devnet",
};

test("x402DoorOpen: open only when every condition holds", () => {
  assert.equal(x402DoorOpen(OPEN), true);
  assert.equal(x402DoorOpen({ ...OPEN, publicApiUrl: "http://localhost:4000" }), true);
  const closed: Array<[string, Partial<X402DoorSettings>]> = [
    ["x402 off", { x402Enabled: false }],
    ["transactions not submitted", { submitTransactions: false }],
    ["the settlement worker off", { settlementWorkerEnabled: false }],
    ["PUBLIC_API_URL unset", { publicApiUrl: undefined }],
    ["PUBLIC_API_URL null", { publicApiUrl: null }],
    ["PUBLIC_API_URL empty", { publicApiUrl: "  " }],
    ["PUBLIC_API_URL not a URL", { publicApiUrl: "api.example.test" }],
    ["PUBLIC_API_URL of another scheme", { publicApiUrl: "ftp://api.example.test" }],
    ["no master key", { walletMasterKey: undefined }],
    ["a master key of 31 characters", { walletMasterKey: "m".repeat(31) }],
    ["mainnet-beta", { solanaNetwork: "mainnet-beta" }],
    ["another network", { solanaNetwork: "testnet" }],
  ];
  for (const [name, change] of closed) {
    assert.equal(x402DoorOpen({ ...OPEN, ...change }), false, name);
  }
  // A setting that is not a plain true is not on.
  assert.equal(x402DoorOpen({ ...OPEN, x402Enabled: "true" as unknown as boolean }), false);
});

// ============================================
// Which listings it serves
// ============================================

const LISTING: X402DoorListing = {
  agentId: "11111111-2222-4333-8444-555555555555",
  orchestrationId: null,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  x402Enabled: true,
};
const AGENT: X402DoorAgent = { isPublic: true, agentKind: "conversation", entrypoint: "chat" };

test("x402ListingServed: an agent's listing sold per use, switched on, of a public agent that answers when called", () => {
  assert.equal(x402ListingServed(LISTING, AGENT), true);
  assert.equal(x402ListingServed({ ...LISTING, pricePerRequestCents: 250n }, { ...AGENT, agentKind: "task" }), true);
});

test("x402ListingServed: each condition alone closes it", () => {
  const listings: Array<[string, Partial<X402DoorListing>]> = [
    ["a workflow's listing", { agentId: null, orchestrationId: "66666666-7777-4888-8999-aaaaaaaaaaaa" }],
    ["a row that names a workflow beside an agent", { orchestrationId: "66666666-7777-4888-8999-aaaaaaaaaaaa" }],
    ["a row with neither", { agentId: null }],
    ["a draft", { status: "draft" }],
    ["withdrawn", { status: "archived" }],
    ["sells copies", { sells: "copies" }],
    ["sold by the month", { pricingModel: "monthly" }],
    ["free", { pricingModel: "free", pricePerRequestCents: null }],
    ["tokenized", { pricingModel: "tokenized" }],
    ["no price", { pricePerRequestCents: null }],
    ["a price under the floor", { pricePerRequestCents: 4n }],
    ["the switch off", { x402Enabled: false }],
  ];
  for (const [name, change] of listings) {
    assert.equal(x402ListingServed({ ...LISTING, ...change }, AGENT), false, name);
  }
  const agents: Array<[string, Partial<X402DoorAgent>]> = [
    ["a private agent", { isPublic: false }],
    ["a scheduled agent", { agentKind: "scheduled" }],
    ["a kind it does not know", { agentKind: "other" }],
    ["an agent that answers through its graph", { entrypoint: "graph" }],
  ];
  for (const [name, change] of agents) {
    assert.equal(x402ListingServed(LISTING, { ...AGENT, ...change }), false, name);
  }
});

// ============================================
// Words
// ============================================

function sentences(): Array<[string, string]> {
  return Object.entries(X402_DOOR_MESSAGES).map(([name, value]) => [
    name,
    typeof value === "function" ? value(5n, "message") : value,
  ]);
}

test("the sentence of a 402 names the price as paid use writes it, and the unit", () => {
  assert.equal(
    X402_DOOR_MESSAGES.paymentRequired(5n, "message"),
    "Pay $0.05 in USDC from a Solana wallet for one message, as the PAYMENT-REQUIRED header of this answer says, or send an API key.",
  );
  assert.equal(
    X402_DOOR_MESSAGES.paymentRequired(250n, "run"),
    "Pay $2.50 in USDC from a Solana wallet for one run, as the PAYMENT-REQUIRED header of this answer says, or send an API key.",
  );
  assert.ok(X402_DOOR_MESSAGES.tooSlow.includes(`within ${X402_ANSWER_DEADLINE_MS / 1000} seconds`));
});

test("every sentence is plain: ASCII, no em dash, no code name, never a refund or a credit balance", () => {
  const reasons = Object.values(X402_ERROR_REASONS);
  for (const [name, text] of sentences()) {
    assert.ok([...text].every((ch) => ch.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.equal(/\u2014|\u2013| -- /.test(text), false, `${name} has no em dash`);
    assert.equal(/[a-z0-9]+_[a-z0-9_]+/i.test(text), false, `${name} holds a code name`);
    assert.equal(/x402|wheelsai/i.test(text), false, `${name} holds a code name`);
    for (const reason of reasons) assert.equal(text.includes(reason), false, `${name} holds ${reason}`);
    assert.equal(/refund/i.test(text), false, `${name} says refund`);
    assert.equal(/credit balance|credits/i.test(text), false, `${name} says credit balance`);
    assert.equal(/unlimited/i.test(text), false, `${name} says unlimited`);
  }
});

test("once the chain took a payment, no sentence says nothing was charged", () => {
  for (const name of ["unconfirmed", "unserved"] as const) {
    assert.equal(/nothing was charged/i.test(X402_DOOR_MESSAGES[name]), false, name);
    assert.ok(X402_DOOR_MESSAGES[name].includes("The transaction is named in this answer."), name);
  }
});
