import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";

import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { prisma } from "../lib/prisma.js";
import { buildCapabilitiesDeps } from "../routes/capabilitiesBindings.js";
import { productionPaidUseDeps } from "../services/buildPaidUseDeps.js";
import {
  buildPaidUseX402Deps,
  cancelInFlightX402Uses,
  X402_LISTING_COLUMNS,
  x402DoorBindingOf,
  x402DoorOpenNow,
  x402DoorUsable,
  x402FeePayerAddress,
  x402FeePayerConflict,
  type X402BindingEnv,
  type X402BindingSources,
  type X402ListingDb,
} from "../services/buildPaidUseX402Deps.js";
import { publicChatLimiter } from "../services/buildPublicChatDeps.js";
import type { X402DoorConnection } from "../services/buildX402PaymentsDeps.js";
import { createFailClosedLimiter, createMemoryLimiterStore } from "../services/failClosedLimiter.js";
import { CONFIDENTIAL_CHAT_RULES } from "../services/jobPrompt.js";
import { PAID_USE_LIMITS, paidToolAllowlist, runPaidChat } from "../services/paidUse.js";
import { runX402Use, type X402UseDeps, type X402UseInput } from "../services/paidUseX402.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { beginX402Metering } from "../services/useMeteringProduction.js";
import { hashBucket, ipBucket } from "../services/widgetKeys.js";
import { listingRequirements, makeX402Memo, type PaymentRequirements } from "../services/x402Wire.js";
import { aBlockhash, exactPayment, keypairOf, readPaymentRequired } from "./x402DoorStandIns.js";
import {
  AGENT as BUYER_AGENT,
  CREATOR_ORG as BUYER_AGENT_ORG,
  LISTING as BUYER_LISTING,
  paidHarness,
  paidMoneyTables,
  SESSION,
} from "./paidUseHarness.js";
import { AGENT, CHAT_BODY, HANDLE, LISTING } from "./paidUseX402Harness.js";

// The production binding of the x402 door (services/buildPaidUseX402Deps.ts)
// over stand-ins for the database, the connection and the settings: what the
// door reads of a listing, the answer made with paid use's own chat and a
// metering that charges nothing, the chain read on its cluster, a fee payer
// derived from the master key that is never the treasury or the payout
// wallet, the one answer of whether the door is usable, the fail-closed
// limiter and the door's own shutdown slots. Nothing here opens a socket.

const TREASURY = keypairOf(7).publicKey.toBase58();
const MASTER_KEY = "a-master-key-for-the-door-of-forty-chars!";
const JWT_SECRET = "a-jwt-secret-of-at-least-thirty-two-chars";
const MINT = usdcMintForNetwork("devnet").toBase58();

/** Every setting the door needs, on. */
const OPEN: X402BindingEnv = {
  X402_ENABLED: true,
  X402_SUBMIT_TRANSACTIONS: true,
  X402_SETTLEMENT_WORKER_ENABLED: true,
  PUBLIC_API_URL: "https://api.wheelsai.test",
  WALLET_MASTER_KEY: MASTER_KEY,
  SOLANA_NETWORK: "devnet",
  TREASURY_WALLET_ADDRESS: TREASURY,
  JWT_SECRET,
};

interface Built {
  deps: X402UseDeps;
  logs: string[];
  reads: Array<{ where: unknown; select: unknown }>;
  chainCalls: string[];
}

/** The binding over stand-ins, with the listing and agent of the door's harness. */
function built(over: Partial<X402BindingSources> & { settings?: X402BindingEnv; cluster?: boolean } = {}): Built {
  const logs: string[] = [];
  const reads: Array<{ where: unknown; select: unknown }> = [];
  const chainCalls: string[] = [];
  const db: X402ListingDb = {
    agentListing: {
      findUnique: async (args) => {
        reads.push(args);
        return args.where.agentId === AGENT.id ? { ...LISTING } : null;
      },
    },
  };
  const connection: X402DoorConnection = {
    getMultipleAccountsInfo: async () => {
      chainCalls.push("accounts");
      return [{ lamports: 50_000_000 }, { lamports: 1 }, { lamports: 1 }];
    },
    isBlockhashValid: async () => {
      chainCalls.push("blockhash");
      return { value: true };
    },
    simulateTransaction: async () => {
      chainCalls.push("simulate");
      return { value: { err: null } };
    },
  };
  const { settings, cluster, ...sources } = over;
  const deps = buildPaidUseX402Deps({
    env: () => settings ?? OPEN,
    paidUse: () => ({
      loadAgentByHandle: async (handle) => (handle === HANDLE ? { ...AGENT } : null),
      prepareChat: async () => {
        throw new Error("no answer is made in these tests unless one says so");
      },
      outboundToolNames: () => ["http_request"],
    }),
    db,
    limiter: createFailClosedLimiter(createMemoryLimiterStore(() => Date.UTC(2026, 9, 14, 12))),
    connection: () => connection,
    clusterOk: async () => cluster ?? true,
    pausedNow: async () => false,
    // The payment rows are not reached in these tests: any use of them throws.
    payments: () =>
      new Proxy({} as X402UseDeps["payments"], {
        get: () => () => {
          throw new Error("the payment rows are not reached in these tests");
        },
      }),
    recordSale: async () => {
      throw new Error("no sale is written in these tests");
    },
    now: () => new Date(Date.UTC(2026, 9, 14, 12)),
    logger: {
      warn: (_obj, msg) => void logs.push(msg),
      error: (_obj, msg) => void logs.push(msg),
    },
    ...sources,
  });
  return { deps, logs, reads, chainCalls };
}

function input(over: Partial<X402UseInput> = {}): X402UseInput {
  return {
    kind: "chat",
    handle: HANDLE,
    body: CHAT_BODY,
    headers: {},
    bucket: "a-bucket",
    arrivedAt: new Date(Date.UTC(2026, 9, 14, 12)),
    resourceUrl: "https://api.wheelsai.test/api/a/reviewer/chat",
    signal: new AbortController().signal,
    ...over,
  };
}

/** The requirements of the harness's listing, for this fee payer. */
function requirementsFor(feePayer: string): PaymentRequirements {
  const base = listingRequirements({
    network: "devnet",
    priceCents: LISTING.pricePerRequestCents ?? 0n,
    asset: MINT,
    payTo: TREASURY,
    feePayer,
    memo: "",
  });
  const { memo } = makeX402Memo({ listingId: LISTING.id, amount: base.amount, secret: JWT_SECRET });
  return { ...base, extra: { feePayer: base.extra.feePayer, memo } };
}

// ============================================
// The listing
// ============================================

test("paid use's own read of a listing selects the creator's switch, which the door reads through it", async () => {
  const saved = (prisma as unknown as { agentListing: unknown }).agentListing;
  const seen: Array<{ select: Record<string, unknown> }> = [];
  (prisma as unknown as { agentListing: unknown }).agentListing = {
    findUnique: async (args: { select: Record<string, unknown> }) => {
      seen.push(args);
      return null;
    },
  };
  try {
    assert.equal(await productionPaidUseDeps().loadListing(AGENT.id), null);
  } finally {
    (prisma as unknown as { agentListing: unknown }).agentListing = saved;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.select.x402Enabled, true);
});

test("the door reads the agent's one listing with the switch, the workflow marker and its one line, and nothing for another agent", async () => {
  const { deps, reads } = built();
  const row = await deps.loadListing(AGENT.id);
  assert.deepEqual(reads[0], { where: { agentId: AGENT.id }, select: X402_LISTING_COLUMNS });
  for (const column of ["x402Enabled", "orchestrationId", "shortDescription", "pricePerRequestCents", "publisherId"]) {
    assert.equal((X402_LISTING_COLUMNS as Record<string, unknown>)[column], true, column);
  }
  assert.equal(row?.x402Enabled, true);
  assert.equal(row?.agentId, AGENT.id);
  assert.equal(await deps.loadListing("another-agent"), null);

  // A row with no agent is not this agent's listing.
  const orphan = built({
    db: { agentListing: { findUnique: async () => ({ ...LISTING, agentId: null }) } },
  });
  assert.equal(await orphan.deps.loadListing(AGENT.id), null);
});

// ============================================
// The answer
// ============================================

test("the answer is asked of paid use's own chat with a buyer's arguments, and only the metering is the door's", async () => {
  // A buyer's use of the paid harness's agent: what paid use hands the chat core.
  const h = paidHarness();
  const bought = await runPaidChat(
    {
      caller: SESSION,
      handle: "support-bot",
      body: { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false },
      signal: new AbortController().signal,
    },
    h.deps,
  );
  assert.equal(bought.kind, "answer");
  const buyer = h.chatInputs[0]!;

  // The door's binding over the same agent, listing and messages.
  const asked: Array<{ input: Record<string, unknown>; beginMetering: unknown }> = [];
  const { deps } = built({
    paidUse: () => ({
      loadAgentByHandle: async () => null,
      prepareChat: async (chat, beginMetering) => {
        asked.push({ input: chat as unknown as Record<string, unknown>, beginMetering });
        return { ok: false, refusal: { kind: "agent_not_found" } };
      },
      outboundToolNames: () => ["http_request"],
    }),
  });
  const signal = new AbortController().signal;
  const answer = await deps.makeAnswer({
    agent: BUYER_AGENT,
    listing: BUYER_LISTING,
    messages: buyer.messages,
    systemAddendum: CONFIDENTIAL_CHAT_RULES,
    promptChars: 10,
    deadlineMs: 25_000,
    signal,
    admit: async () => null,
  });
  assert.deepEqual(answer, { ok: false, ending: "unavailable" });
  assert.equal(asked.length, 1);
  const door = asked[0]!.input;

  for (const field of ["caller", "source", "orgId", "agent", "messages", "systemAddendum", "hideSourceTitles", "toolAllowlist", "maxToolRounds"]) {
    assert.deepEqual(door[field], (buyer as unknown as Record<string, unknown>)[field], field);
  }
  assert.equal(door.caller, "public");
  assert.equal(door.source, "paid");
  assert.equal(door.orgId, BUYER_AGENT_ORG);
  assert.equal(door.hideSourceTitles, true);
  assert.equal(door.maxToolRounds, PAID_USE_LIMITS.maxToolRounds);
  assert.deepEqual(door.toolAllowlist, paidToolAllowlist(BUYER_AGENT.tools, ["http_request"], BUYER_LISTING.useAllowedTools));
  assert.equal(door.systemAddendum, CONFIDENTIAL_CHAT_RULES);
  // The door's own bounds: its deadline and the caller's signal.
  assert.equal(door.deadlineMs, 25_000);
  assert.equal(door.signal, signal);

  // The metering is the door's: it charges nothing, once, for this agent only.
  const beginMetering = asked[0]!.beginMetering as (args: { agentId: string; orgId: string }) => Promise<unknown>;
  assert.equal(await beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG }), null);
  await assert.rejects(beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG }), /twice/);
});

// ============================================
// The metering
// ============================================

const INSTALL = {
  installId: "ins-1",
  listingId: "lst-1",
  listingTitle: "Support Bot",
  publisherId: BUYER_AGENT_ORG,
  buyerId: "org-buyer",
  pricePerRequestCents: 5n,
  kind: "use" as const,
};
const RATES = { inputCentsPerMTok: 15, outputCentsPerMTok: 60 };

/** The model cost a buyer's use takes at its settle, after `note`. */
async function buyerModelCost(note: (binding: { noteRun: (run: never) => void; notePlatformUsage: (u: never) => void }) => void): Promise<bigint> {
  const tables = paidMoneyTables();
  const binding = tables.beginUse({ agentId: BUYER_AGENT.id, install: INSTALL, apiKeyId: null, unit: "message" });
  const begun = await binding.beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG });
  assert.ok(begun && begun.ok);
  note(binding as never);
  await begun.handle.settle();
  return tables.money.useModelCostMicros;
}

test("the door's metering notes the same model cost as a buyer's use for the same usage, and charges nothing", async () => {
  const usage = { inputTokens: 100_000, outputTokens: 50_000 };
  const cases: Array<[string, (binding: { noteRun: (run: never) => void; notePlatformUsage: (u: never) => void }) => void]> = [
    ["on the platform's keys", (b) => b.noteRun({ platformModel: true, usage, content: "x", promptChars: 10 } as never)],
    ["on the creator's own key", (b) => b.noteRun({ platformModel: false, usage, content: "x", promptChars: 10 } as never)],
    ["a ready sum", (b) => b.notePlatformUsage(usage as never)],
    ["no sum", (b) => b.notePlatformUsage(null as never)],
    [
      "the last note wins",
      (b) => {
        b.noteRun({ platformModel: true, usage, content: "x", promptChars: 10 } as never);
        b.notePlatformUsage(null as never);
      },
    ],
  ];
  for (const [name, note] of cases) {
    const expected = await buyerModelCost(note);
    const door = beginX402Metering({ agentId: BUYER_AGENT.id }, { rates: RATES });
    assert.equal(await door.beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG }), null, name);
    note(door as never);
    assert.equal(door.modelCostMicros(), expected, name);
  }
  // 100,000 at 15 and 50,000 at 60 cents a million.
  const door = beginX402Metering({ agentId: BUYER_AGENT.id }, { rates: RATES });
  door.noteRun({ platformModel: true, usage, content: "x", promptChars: 10 });
  assert.equal(door.modelCostMicros(), 4_500_000n);
});

test("the door's metering refuses another agent and a second call, as a buyer's does", async () => {
  const door = beginX402Metering({ agentId: BUYER_AGENT.id }, { rates: RATES });
  await assert.rejects(door.beginMetering({ agentId: "another-agent", orgId: BUYER_AGENT_ORG }), /another agent/);

  const tables = paidMoneyTables();
  const buyer = tables.beginUse({ agentId: BUYER_AGENT.id, install: INSTALL, apiKeyId: null, unit: "message" });
  await assert.rejects(buyer.beginMetering({ agentId: "another-agent", orgId: BUYER_AGENT_ORG }), /another agent/);

  const once = beginX402Metering({ agentId: BUYER_AGENT.id }, { rates: RATES });
  assert.equal(await once.beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG }), null);
  await assert.rejects(once.beginMetering({ agentId: BUYER_AGENT.id, orgId: BUYER_AGENT_ORG }), /twice/);
  assert.equal(once.modelCostMicros(), 0n, "nothing noted, nothing taken");
});

// ============================================
// The chain
// ============================================

test("the simulation is handed the deserialized transaction, without signature checks and on its own blockhash", async () => {
  const seen: Array<{ transaction: unknown; config: unknown }> = [];
  const connection: X402DoorConnection = {
    getMultipleAccountsInfo: async () => [],
    isBlockhashValid: async () => ({ value: true }),
    simulateTransaction: async (transaction, config) => {
      seen.push({ transaction, config });
      return { value: { err: { InstructionError: [2, { Custom: 1 }] } } };
    },
  };
  const { deps } = built({ connection: () => connection });
  const feePayer = x402FeePayerAddress(OPEN)!;
  const requirements = requirementsFor(feePayer);
  const b64 = exactPayment({
    payer: keypairOf(3),
    feePayer: new PublicKey(feePayer),
    payTo: new PublicKey(TREASURY),
    mint: new PublicKey(MINT),
    amount: BigInt(requirements.amount),
    memo: requirements.extra.memo,
    blockhash: aBlockhash(),
  });
  const answer = await deps.chain.simulate(b64);
  assert.equal(answer.ok, false, "a failure is read from value.err, never thrown");
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.transaction instanceof VersionedTransaction);
  assert.deepEqual(seen[0]!.config, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
});

test("the chain is read only on the cluster the settings name: a node on another one is never asked", async () => {
  const { deps, chainCalls } = built({ cluster: false });
  await assert.rejects(deps.chain.accounts({ feePayer: TREASURY, source: TREASURY, destination: TREASURY }));
  await assert.rejects(deps.chain.blockhashValid(aBlockhash()));
  await assert.rejects(deps.chain.simulate("AA=="));
  assert.deepEqual(chainCalls, []);

  const on = built();
  const accounts = await on.deps.chain.accounts({ feePayer: TREASURY, source: TREASURY, destination: TREASURY });
  assert.deepEqual(accounts, { feePayerLamports: 50_000_000n, sourceExists: true, destinationExists: true });
  assert.deepEqual(on.chainCalls, ["accounts"]);
});

test("a node that does not answer the cluster check in time is not asked: the read fails as a slow read does", async () => {
  const { deps, chainCalls } = built({ clusterOk: () => new Promise<boolean>(() => {}), clusterTimeoutMs: 20 });
  await assert.rejects(deps.chain.accounts({ feePayer: TREASURY, source: TREASURY, destination: TREASURY }));
  await assert.rejects(deps.chain.blockhashValid(aBlockhash()));
  assert.deepEqual(chainCalls, []);
});

// ============================================
// The settings of the requirements and the fee payer
// ============================================

test("the requirements are built from the settings, with a fee payer derived from the master key", async () => {
  const { deps } = built();
  const wire = deps.wire();
  const feePayer = x402FeePayerAddress(OPEN);
  assert.ok(feePayer);
  assert.deepEqual(wire, {
    network: "devnet",
    rowNetwork: "solana:devnet",
    usdcMint: MINT,
    treasury: TREASURY,
    feePayer,
    memoSecret: JWT_SECRET,
  });

  // A 402 of the door names it as the fee payer.
  const result = await runX402Use(input(), deps);
  assert.equal(result.kind, "refusal");
  if (result.kind !== "refusal") return;
  assert.equal(result.refusal.status, 402);
  const challenge = readPaymentRequired(result.headers["PAYMENT-REQUIRED"]!);
  assert.equal(challenge.accepts[0].extra.feePayer, feePayer);
  assert.equal(challenge.accepts[0].payTo, TREASURY);
  assert.equal(challenge.accepts[0].asset, MINT);
});

test("the fee payer is the same wallet for the same key, another for another key, and never the payout wallet", () => {
  const first = x402FeePayerAddress(OPEN);
  assert.equal(x402FeePayerAddress(OPEN), first);
  assert.notEqual(x402FeePayerAddress({ ...OPEN, WALLET_MASTER_KEY: "another-master-key-of-at-least-32-chars" }), first);
  assert.notEqual(first, derivePayoutKeypair(MASTER_KEY).publicKey.toBase58());
  assert.notEqual(first, TREASURY);
  // A closed door has no fee payer to fund.
  assert.equal(x402FeePayerAddress({ ...OPEN, X402_ENABLED: false }), null);
  assert.equal(x402FeePayerAddress({ ...OPEN, WALLET_MASTER_KEY: "too-short" }), null);
});

test("a fee payer that is the treasury or the payout wallet is a conflict", () => {
  assert.equal(x402FeePayerConflict({ feePayer: "A", treasury: "A", payout: "B" }), "treasury");
  assert.equal(x402FeePayerConflict({ feePayer: "B", treasury: "A", payout: "B" }), "payout");
  assert.equal(x402FeePayerConflict({ feePayer: "C", treasury: "A", payout: "B" }), null);
  assert.equal(x402FeePayerConflict({ feePayer: "C", treasury: undefined, payout: "B" }), null);
});

test("a fee payer equal to the treasury closes the door: 503 for a use it would serve, logged once, and the capabilities say so", async () => {
  const feePayer = x402FeePayerAddress(OPEN)!;
  const colliding: X402BindingEnv = { ...OPEN, TREASURY_WALLET_ADDRESS: feePayer };
  assert.equal(x402DoorUsable(OPEN), true);
  assert.equal(x402DoorUsable(colliding), false);
  assert.equal(x402FeePayerAddress(colliding), null);
  // Its settings alone are on: the routes still send a call with no credential to the door, which answers 503.
  assert.equal(x402DoorOpenNow(colliding), true);

  const { deps, logs } = built({ settings: colliding });
  assert.throws(() => deps.wire());
  for (let i = 0; i < 2; i++) {
    const result = await runX402Use(input(), deps);
    assert.equal(result.kind, "refusal");
    if (result.kind !== "refusal") return;
    assert.equal(result.refusal.status, 503);
    assert.equal(result.refusal.code, "x402_unavailable");
    assert.deepEqual(result.headers, {}, "no challenge names a fee payer that is the treasury");
    assert.ok(!JSON.stringify(result).includes(feePayer));
  }
  assert.equal(logs.filter((line) => /fee payer is the treasury wallet/.test(line)).length, 1, "logged once");
  // Nothing signs with it either.
  assert.deepEqual(
    (() => {
      try {
        return deps.signAsFeePayer("AA==", requirementsFor(feePayer));
      } catch (err) {
        return (err as Error).name;
      }
    })(),
    "X402DoorClosedError",
  );

  // The capabilities read the same answer.
  const capabilities = (settings: X402BindingEnv) =>
    buildCapabilitiesDeps({
      env: () => ({ PAYOUTS_ENABLED: false, PAYOUT_EXECUTOR_INTERVAL_MS: 0, AGENT_GPU_ENABLED: false, JOB_RUNNER_CONCURRENCY: 0, ...settings }),
      availableFreeModels: () => [],
      emailConfigured: () => false,
      auth: async () => undefined,
    });
  assert.equal(capabilities(OPEN).x402(), true);
  assert.equal(capabilities(colliding).x402(), false);
});

test("a door whose settings are off has no requirements to build and nothing to sign with", () => {
  for (const settings of [
    { ...OPEN, X402_ENABLED: false },
    { ...OPEN, SOLANA_NETWORK: "mainnet-beta" as const },
    { ...OPEN, X402_SETTLEMENT_WORKER_ENABLED: false },
    { ...OPEN, PUBLIC_API_URL: undefined },
  ]) {
    const { deps } = built({ settings });
    assert.throws(() => deps.wire());
    assert.equal(x402DoorUsable(settings), false);
  }
});

test("the binding's signer signs a checked payment with the derived fee payer, and nothing for another fee payer", () => {
  const { deps } = built();
  const feePayer = x402FeePayerAddress(OPEN)!;
  const requirements = requirementsFor(feePayer);
  const b64 = exactPayment({
    payer: keypairOf(3),
    feePayer: new PublicKey(feePayer),
    payTo: new PublicKey(TREASURY),
    mint: new PublicKey(MINT),
    amount: BigInt(requirements.amount),
    memo: requirements.extra.memo,
    blockhash: aBlockhash(),
  });
  const signed = deps.signAsFeePayer(b64, requirements);
  assert.ok("signedTxB64" in signed);
  if (!("signedTxB64" in signed)) return;
  const tx = VersionedTransaction.deserialize(Buffer.from(signed.signedTxB64, "base64"));
  const message = tx.message.serialize();
  assert.ok(nacl.sign.detached.verify(message, tx.signatures[0]!, new PublicKey(feePayer).toBytes()));
  assert.equal(signed.payer, keypairOf(3).publicKey.toBase58());

  // Built for another fee payer: refused, no bytes.
  const other = keypairOf(11).publicKey.toBase58();
  const theirs = requirementsFor(other);
  const refused = deps.signAsFeePayer(
    exactPayment({
      payer: keypairOf(3),
      feePayer: new PublicKey(other),
      payTo: new PublicKey(TREASURY),
      mint: new PublicKey(MINT),
      amount: BigInt(theirs.amount),
      memo: theirs.extra.memo,
      blockhash: aBlockhash(),
    }),
    theirs,
  );
  assert.ok("invalidReason" in refused);
  assert.ok(!("signedTxB64" in refused));
});

// ============================================
// The limiter, the address and the slots
// ============================================

test("the limiter is the process's fail-closed one: a store that cannot be reached refuses", async () => {
  const production = buildPaidUseX402Deps({ env: () => OPEN });
  assert.equal(production.limiter, publicChatLimiter);
  assert.equal(production.limits, PAID_USE_LIMITS);

  const unreachable = createFailClosedLimiter({
    consume: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    peek: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const { deps } = built({ limiter: unreachable });
  const result = await runX402Use(input(), deps);
  assert.equal(result.kind, "refusal");
  if (result.kind !== "refusal") return;
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "rate_limiter_unavailable");
  assert.ok(!JSON.stringify(result).includes("ECONNREFUSED"));
});

test("a use is named by the public address and a caller by the public page's bucket, never a raw address", () => {
  const door = x402DoorBindingOf({ env: () => ({ ...OPEN, PUBLIC_API_URL: "https://api.wheelsai.test/" }), use: () => built().deps });
  assert.equal(door.resourceUrl("/api/a/reviewer/chat"), "https://api.wheelsai.test/api/a/reviewer/chat");
  assert.equal(door.bucketOf("203.0.113.9"), hashBucket(ipBucket("203.0.113.9"), JWT_SECRET));
  assert.ok(!door.bucketOf("203.0.113.9").includes("203.0.113"));

  const nowhere = x402DoorBindingOf({ env: () => ({ ...OPEN, PUBLIC_API_URL: undefined }), use: () => built().deps });
  assert.throws(() => nowhere.resourceUrl("/api/a/reviewer/chat"));
});

test("shutdown stops the door's own uses: a slot is aborted and no new one is given", async () => {
  // Last in this file: it closes the door's slots for the life of the process.
  const { deps } = built();
  const slot = deps.inFlight.begin();
  assert.ok(slot);
  const drained = cancelInFlightX402Uses(1_000);
  assert.equal(slot.signal.aborted, true);
  slot.done();
  assert.deepEqual(await drained, { cancelled: 1, unfinished: 0 });
  assert.equal(deps.inFlight.begin(), null);
});
