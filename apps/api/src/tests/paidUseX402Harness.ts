// The world of one use at a listing's x402 door, for the tests of
// services/paidUseX402.ts. Not a test file itself.
//
// What is real: the door's core, its answer maker on the REAL chat core
// (prepareAgentChat) with the real hold and check of the answer, the
// published wire and its checks, the fee payer's signer on a key made in
// memory, the door's payment functions and the sale (services/x402Sale.ts),
// and a real fail-closed limiter on its memory store. What is faked is the
// edge of each: the rows are FakeX402Db, the chain is the door's chain
// stand-in reading the bytes a real x402 client makes, the model is scripted,
// and time is a clock the test moves. Nothing here opens a socket.

import "./unitEnv.js";

import type { Keypair } from "@solana/web3.js";

import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { prepareAgentChat, type AgentChatAgent, type AgentChatDeps, type AgentChatInput } from "../services/agentChat.js";
import {
  X402_FAILED_ON_CHAIN_REASON,
  X402_NEVER_LANDED_REASON,
  doorClaimConflict,
  readX402Fate,
  x402DoorChainReads,
} from "../services/buildX402PaymentsDeps.js";
import { createFailClosedLimiter, createMemoryLimiterStore, type LimiterStore } from "../services/failClosedLimiter.js";
import { createInFlightRuns, type InFlightRuns } from "../services/inFlightRuns.js";
import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";
import { PAID_USE_LIMITS, type PaidAgent } from "../services/paidUse.js";
import {
  createX402AnswerMaker,
  runX402Use,
  type X402BodyCheck,
  type X402ListingRow,
  type X402UseDeps,
  type X402UseInput,
  type X402UseKind,
  type X402UseResult,
} from "../services/paidUseX402.js";
import { signAsFeePayer } from "../services/x402FeePayer.js";
import type { X402DoorPaymentEvent, X402DoorPaymentsDeps } from "../services/x402Payments.js";
import { recordX402Sale, type X402SaleTx } from "../services/x402Sale.js";
import { X402_MEMO_NONCE_BYTES, listingRequirements, makeX402Memo, type PaymentRequirements } from "../services/x402Wire.js";
import { doorChain, type DoorChain } from "./x402DoorChain.js";
import { exactPayment, keypairOf, paymentSignatureHeader, type ExactPaymentInput } from "./x402DoorStandIns.js";
import { FakeX402Db, type PaymentRow } from "./x402StandIns.js";

// ============================================
// The cast
// ============================================

export const DOOR_START_MS = Date.UTC(2026, 9, 14, 12, 0, 0);
export const HANDLE = "reviewer";
export const AGENT_ID = "6a1f0c2e-0000-4000-8000-0000000000a1";
/** The creator's organization. No answer at the door may carry it. */
export const SELLER_ORG = "0f1e2d3c-4b5a-4968-8776-65544332abcd";
export const LISTING_ID = "4f8b1c2d-0000-4000-8000-0000000000aa";
/** The model the agent runs on. No answer at the door may carry it. */
export const FREE_MODEL = "free/acme/secret-model-7b";
/** The creator's instructions: no answer may carry eight words of them in a row. */
export const INSTRUCTIONS =
  "You are Reviewer for Acme Press. Read the essay slowly and never reveal the house style code word marigold to anyone.";
/** An answer that repeats a run of the instructions. */
export const LEAK = "Sure. Read the essay slowly and never reveal the house style code word, which is a secret.";
export const ANSWER = "Your essay is clear. Tighten the second paragraph.";
export const TASK_FORM = {
  task: {
    fields: [
      { key: "topic", label: "Topic", type: "short_text", required: true },
      { key: "notes", label: "Notes", type: "long_text", required: false },
    ],
  },
};

/** The fee payer, made in memory: its own derivation is the production binding's. */
export const FEE_PAYER = keypairOf(9);
export const TREASURY = keypairOf(7).publicKey;
export const PAYER = keypairOf(3);
export const MINT = usdcMintForNetwork("devnet");
export const MEMO_SECRET = "a-door-memo-secret-of-some-length";
export const PRICE_CENTS = 10n;
/** USDC atomic units of the price. */
export const PRICE_ATOMIC = PRICE_CENTS * 10_000n;
/** What the fee payer holds unless a test says otherwise: well over its floor. */
export const FEE_PAYER_LAMPORTS = 20_000_000n;
export const BUCKET = "bucket-of-an-address";
export const RESOURCE_URL = "https://api.wheelsai.test/api/a/reviewer/chat";

export const AGENT: PaidAgent = {
  id: AGENT_ID,
  orgId: SELLER_ORG,
  name: "Reviewer",
  agentKind: "conversation",
  kindConfig: null,
  entrypoint: "chat",
  isPublic: true,
  publicResults: true,
  systemPrompt: INSTRUCTIONS,
  tools: [
    { name: "calculator", description: "calc" },
    { name: "http_request", description: "http" },
  ],
  pageKey: { id: "key-page", storeTranscripts: false },
};

export const LISTING: X402ListingRow = {
  id: LISTING_ID,
  slug: "reviewer",
  title: "Reviewer",
  shortDescription: "Reviews an essay in one answer.",
  agentId: AGENT_ID,
  publisherId: SELLER_ORG,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: PRICE_CENTS,
  monthlyPriceCents: null,
  useAllowedTools: [],
  x402Enabled: true,
};

export const CHAT_BODY = { messages: [{ role: "user", content: "Review my essay, please." }], stream: false };

// ============================================
// The world
// ============================================

export interface DoorModel {
  answer: string;
  /** How long the model takes, on the test's clock. */
  takesMs: number;
  /** The stream's outcome, when it is not a plain answer. */
  outcome?: StreamOutcome;
  /** The model call throws before a stream exists. */
  throws?: Error;
  /** Held until the test lets it go. */
  gate?: Promise<void>;
  /** Runs while the model answers. */
  onRun?: () => void;
}

export interface DoorWorldOptions {
  agent?: Partial<PaidAgent> | null;
  listing?: Partial<X402ListingRow> | null;
  /** Chain blocks a second of the test's clock. 0 holds every blockhash alive. */
  blocksPerSecond?: number;
  feePayerLamports?: bigint;
  /** The treasury's USDC account exists. Default yes. */
  treasuryAccount?: boolean;
  /** An accepted contributor of the agent, paid out of the creator's share. */
  contributor?: { orgId: string; userId: string; bps: number };
}

export interface DoorWorld {
  nowMs: number;
  /** The test's clock moves, and the chain's blocks with it. */
  elapse(ms: number): void;
  db: FakeX402Db;
  chain: DoorChain;
  /** Everything that touched the world, in order. */
  trail: string[];
  events: X402DoorPaymentEvent[];
  /** Every line logged, with its object, for the operator. */
  logs: string[];
  model: DoorModel;
  modelRuns: number;
  /** What the use cost on the platform's keys, as the metering will note it. */
  modelCostMicros: bigint;
  /** What the chat core was asked. */
  chatInputs: AgentChatInput[];
  paused: boolean | "throws";
  /** The limiter's store answers nothing. */
  limiterDown: boolean;
  /** Only the limiter's reads fail. */
  peekDown: boolean;
  /** A count that holds a key this answers yes for fails, whatever else it holds. */
  consumeDownFor?: (key: string) => boolean;
  /** The store behind the limiter, for a test that fills a count first. */
  store: LimiterStore;
  inFlight: InFlightRuns;
  /** Asked at each read of whether a blockhash is valid, with how many came before. */
  onBlockhashCheck?: (n: number) => void;
  /** Asked when the payment is sent. */
  onSend?: () => void;
  agent: PaidAgent | null;
  listing: X402ListingRow | null;
  deps: X402UseDeps;
}

const enc = new TextEncoder();

/** A runtime event as the provider sends it: with an id and the model's name, which must not reach a caller. */
const delta = (content: string) =>
  `data: ${JSON.stringify({ id: "chatcmpl-9", model: FREE_MODEL, choices: [{ delta: { content } }] })}\n\n`;

function streamOf(events: string[], outcome: StreamOutcome): ChatStream {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(enc.encode(event));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    outcome: Promise.resolve(outcome),
  };
}

export function doorWorld(options: DoorWorldOptions = {}): DoorWorld {
  const db = new FakeX402Db();
  const chain = doorChain({ mint: MINT });
  chain.fundSol(FEE_PAYER.publicKey, options.feePayerLamports ?? FEE_PAYER_LAMPORTS);
  if (options.treasuryAccount !== false) chain.openTokenAccount(TREASURY, 0n);
  const blocksPerSecond = options.blocksPerSecond ?? 2.5;

  const memory = createMemoryLimiterStore(() => world.nowMs);
  const store: LimiterStore = {
    consume: async (rules) => {
      if (world.limiterDown) throw new Error("the store is down");
      if (rules.some((rule) => world.consumeDownFor?.(rule.key))) throw new Error("the store is down for this key");
      return memory.consume(rules);
    },
    peek: async (key) => {
      if (world.limiterDown || world.peekDown) throw new Error("the store is down");
      return memory.peek(key);
    },
  };

  const world: DoorWorld = {
    nowMs: DOOR_START_MS,
    elapse(ms) {
      world.nowMs += ms;
      chain.advance(Math.floor((ms * blocksPerSecond) / 1_000));
    },
    db,
    chain,
    trail: [],
    events: [],
    logs: [],
    model: { answer: ANSWER, takesMs: 2_000 },
    modelRuns: 0,
    modelCostMicros: 0n,
    chatInputs: [],
    paused: false,
    limiterDown: false,
    peekDown: false,
    store: memory,
    inFlight: createInFlightRuns(),
    agent: options.agent === null ? null : { ...AGENT, ...options.agent },
    listing: options.listing === null ? null : { ...LISTING, ...options.listing },
    deps: undefined as unknown as X402UseDeps,
  };

  // The rows a sale touches.
  db.listings.set(LISTING_ID, { agentId: AGENT_ID, useModelCostMicros: 0n, totalRequests: 0n });
  db.profiles.set(SELLER_ORG, { pendingPayoutCents: 0n, totalRevenueCents: 0n });
  if (options.contributor) db.profiles.set(options.contributor.orgId, { pendingPayoutCents: 0n, totalRevenueCents: 0n });

  const now = () => new Date(world.nowMs);
  const door = (row: PaymentRow) => row.listingId !== null;

  // ---- the payment's rows and its send, as the door's binding writes them ----
  const payments: X402DoorPaymentsDeps = {
    now,
    pollIntervalMs: 1_000,
    sleep: async (ms) => world.elapse(ms),
    findByMessageHash: async (messageHash) => {
      world.trail.push("lookup");
      for (const row of db.payments.values()) {
        if (row.messageHash === messageHash) return { id: row.id, status: row.status };
      }
      return null;
    },
    insertHeld: async (row) => {
      try {
        const written = db.insert(row, now());
        world.trail.push(`claim:${written.status}`);
        return { ok: true, id: written.id };
      } catch (err) {
        const conflict = doorClaimConflict(err);
        if (conflict === null || conflict === "unknown") throw err;
        world.trail.push(`claim_refused:${conflict}`);
        return { ok: false, reason: conflict };
      }
    },
    markHeldFailed: async (id, reason) => {
      const changed = await db.cas(id, (row) => row.status === "held" && door(row), { status: "failed", failureReason: reason });
      if (changed) world.trail.push(`failed:${reason}`);
      return changed;
    },
    markSubmitted: async (id, { messageHash, ...sent }) => {
      try {
        const changed = await db.cas(
          id,
          (row) => row.status === "held" && row.messageHash === messageHash && door(row),
          { status: "submitted", ...sent },
        );
        if (changed) world.trail.push("submitted");
        return changed ? "submitted" : "not_held";
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") return "duplicate_signature";
        throw err;
      }
    },
    broadcast: async (signedTxB64) => {
      world.trail.push("send");
      world.onSend?.();
      await chain.connection.sendRawTransaction(Buffer.from(signedTxB64, "base64"));
    },
    readFate: async (input) => {
      const reading = await readX402Fate(input, chain.readFate);
      world.trail.push(`fate:${reading.fate}`);
      return reading;
    },
    markSentFailed: (id, why) =>
      db.cas(id, (row) => row.status === "submitted" && door(row), {
        status: "failed",
        failureReason: why === "failed_on_chain" ? X402_FAILED_ON_CHAIN_REASON : X402_NEVER_LANDED_REASON,
      }),
    markUnserved: async (id) => {
      const changed = await db.cas(id, (row) => row.status === "submitted" && door(row), { status: "unserved" });
      if (changed) world.trail.push("unserved");
      return changed;
    },
    log: (event) => {
      world.events.push(event);
    },
  };

  // ---- the chain, read only, through the door's own binding ----
  const reads = x402DoorChainReads(() => chain.connection);
  let blockhashChecks = 0;
  const chainReads: X402UseDeps["chain"] = {
    accounts: (input) => {
      world.trail.push("chain:accounts");
      return reads.accounts(input);
    },
    blockhashValid: (blockhash) => {
      world.trail.push("chain:blockhash");
      world.onBlockhashCheck?.(blockhashChecks);
      blockhashChecks += 1;
      return reads.blockhashValid(blockhash);
    },
    simulate: (transactionB64) => {
      world.trail.push("chain:simulate");
      return reads.simulate(transactionB64);
    },
  };

  // ---- the chat core's edges: the model is scripted ----
  const coreAgent = (): AgentChatAgent | null =>
    world.agent && {
      id: world.agent.id,
      orgId: world.agent.orgId,
      slug: "reviewer",
      name: world.agent.name ?? "Agent",
      version: "1.0.0",
      systemPrompt: world.agent.systemPrompt,
      tools: world.agent.tools,
      modelConfig: { externalModel: FREE_MODEL, temperature: 0.3, maxTokens: 700 },
      env: {},
      knowledgeBaseId: null,
      entrypoint: world.agent.entrypoint,
    };
  const chatDeps: Omit<AgentChatDeps, "beginMetering"> = {
    loadAgent: async (where) => {
      const agent = coreAgent();
      return agent && agent.orgId === where.orgId && "id" in where && where.id === agent.id ? agent : null;
    },
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => [FREE_MODEL],
    isFreeModel: (id) => id.startsWith("free/"),
    resolveModel: (modelId) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    checkFreeTierLimit: async () => ({ allowed: true, remaining: { rpm: 19, rpd: 199 }, resetAt: { rpm: 0, rpd: 0 } }),
    retrieveContext: async () => null,
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => ["calculator", "http_request"],
    runChat: async () => {
      throw new Error("a use at the door never takes the unstreamed path: its answer is held");
    },
    runChatStream: async () => {
      world.trail.push("model");
      world.modelRuns += 1;
      const model = world.model;
      if (model.gate) await model.gate;
      if (model.takesMs > 0) world.elapse(model.takesMs);
      model.onRun?.();
      if (model.throws) throw model.throws;
      return streamOf(
        [delta(model.answer.slice(0, 8)), delta(model.answer.slice(8))],
        model.outcome ?? { ok: true, usage: { inputTokens: 1_000, outputTokens: 500 }, toolCalls: [], content: model.answer },
      );
    },
    recordUsage: async () => {},
    deadlineMs: 60_000,
  };

  const makeAnswer = createX402AnswerMaker({
    prepareChat: (input, beginMetering) => {
      world.chatInputs.push(input);
      return prepareAgentChat(input, { ...chatDeps, beginMetering });
    },
    // Charges nothing, and notes what the model cost.
    beginMetering: ({ agentId }) => {
      let begun = 0;
      let micros = 0n;
      return {
        beginMetering: async (args) => {
          begun += 1;
          if (begun > 1 || args.agentId !== agentId) throw new Error("the door's metering is begun once, for its agent");
          return null;
        },
        noteRun: (run) => {
          if (run.platformModel) micros = world.modelCostMicros;
        },
        notePlatformUsage: () => {},
        modelCostMicros: () => micros,
      };
    },
    outboundToolNames: () => ["http_request"],
    limits: PAID_USE_LIMITS,
    now,
  });

  // ---- the sale, in one transaction over the rows ----
  const contributor = options.contributor;
  const saleTx = (tx: X402SaleTx): X402SaleTx => {
    if (!contributor) return tx;
    // The contributor tables a sale's split reads, beside the sale's own.
    return Object.assign(Object.create(null) as object, tx, {
      agentContributor: {
        findMany: async () => [{ id: "contrib-1", userId: contributor.userId, revenueShareBps: contributor.bps }],
      },
      organization: {
        findFirst: async ({ where }: { where: { ownerId: string } }) =>
          where.ownerId === contributor.userId ? { id: contributor.orgId, name: "Contributor" } : null,
      },
      contributorEarning: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          world.trail.push(`contributor_earning:${String(data.amountCents)}`);
          return data;
        },
      },
    }) as X402SaleTx;
  };

  world.deps = {
    limiter: createFailClosedLimiter(store),
    limits: PAID_USE_LIMITS,
    loadAgentByHandle: async (handle) => (handle === HANDLE ? world.agent : null),
    loadListing: async (agentId) => (world.listing && world.listing.agentId === agentId ? world.listing : null),
    pausedNow: async () => {
      if (world.paused === "throws") throw new Error("the model config could not be read");
      return world.paused;
    },
    wire: () => ({
      network: "devnet",
      rowNetwork: "solana:devnet",
      usdcMint: MINT.toBase58(),
      treasury: TREASURY.toBase58(),
      feePayer: FEE_PAYER.publicKey.toBase58(),
      memoSecret: MEMO_SECRET,
    }),
    chain: chainReads,
    payments,
    signAsFeePayer: (transactionB64, requirements) => {
      world.trail.push("sign");
      return signAsFeePayer(transactionB64, requirements, FEE_PAYER);
    },
    makeAnswer,
    recordSale: async (input) => {
      world.trail.push("sale");
      return db.$saleTransaction((tx) => recordX402Sale(saleTx(tx), input));
    },
    inFlight: world.inFlight,
    now,
    nonce: () => crypto.getRandomValues(new Uint8Array(X402_MEMO_NONCE_BYTES)),
    logger: {
      warn: (obj, msg) => world.logs.push(`${msg} ${JSON.stringify(obj, bigintSafe)}`),
      error: (obj, msg) => world.logs.push(`${msg} ${JSON.stringify(obj, bigintSafe)}`),
    },
  };
  return world;
}

function bigintSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return value.message;
  return value;
}

// ============================================
// A real x402 client
// ============================================

/** The requirements the server builds for one use of the listing, with a memo of its own. */
export function requirementsNow(price: bigint = PRICE_CENTS): PaymentRequirements {
  const base = listingRequirements({
    network: "devnet",
    priceCents: price,
    asset: MINT.toBase58(),
    payTo: TREASURY.toBase58(),
    feePayer: FEE_PAYER.publicKey.toBase58(),
    memo: "",
  });
  const { memo } = makeX402Memo({ listingId: LISTING_ID, amount: base.amount, secret: MEMO_SECRET });
  return { ...base, extra: { feePayer: base.extra.feePayer, memo } };
}

export interface Paid {
  /** The PAYMENT-SIGNATURE header. */
  header: string;
  /** payload.transaction. */
  b64: string;
  requirements: PaymentRequirements;
  payer: Keypair;
}

/**
 * What a real client sends for one use: a transaction on a fresh blockhash,
 * from a wallet whose USDC account it opens when the test did not, signed by
 * the payer only, echoed with the requirements it chose.
 */
export function pay(
  world: DoorWorld,
  options: {
    payer?: Keypair;
    requirements?: PaymentRequirements;
    /** What the client echoes as accepted, when it is not the requirements. */
    accepted?: unknown;
    over?: Partial<ExactPaymentInput>;
    blockhash?: string;
    /** The payer's USDC, when its account is opened here. */
    usdc?: bigint;
  } = {},
): Paid {
  const payer = options.payer ?? PAYER;
  const requirements = options.requirements ?? requirementsNow();
  if (world.chain.usdcOf(payer.publicKey) === null) world.chain.openTokenAccount(payer.publicKey, options.usdc ?? 10_000_000n);
  const b64 = exactPayment({
    payer,
    feePayer: FEE_PAYER.publicKey,
    payTo: TREASURY,
    mint: MINT,
    amount: BigInt(requirements.amount),
    memo: requirements.extra.memo,
    blockhash: options.blockhash ?? world.chain.issueBlockhash(),
    ...options.over,
  });
  return { header: paymentSignatureHeader(options.accepted ?? requirements, b64), b64, requirements, payer };
}

export interface CallOptions<R> {
  kind?: X402UseKind;
  body?: unknown;
  /** The PAYMENT-SIGNATURE, when the call carries one. */
  payment?: string;
  headers?: Record<string, string | string[] | undefined>;
  signal?: AbortSignal;
  arrivedAt?: Date;
  checkBody?: () => X402BodyCheck<R>;
  onServed?: () => void;
}

/** One request at the door, arriving now. */
export async function call<R = never>(world: DoorWorld, options: CallOptions<R> = {}): Promise<X402UseResult<R>> {
  const input: X402UseInput<R> = {
    kind: options.kind ?? "chat",
    handle: HANDLE,
    body: options.body ?? CHAT_BODY,
    headers: {
      ...(options.payment !== undefined && { "payment-signature": options.payment }),
      ...options.headers,
    },
    bucket: BUCKET,
    arrivedAt: options.arrivedAt ?? new Date(world.nowMs),
    resourceUrl: RESOURCE_URL,
    signal: options.signal ?? new AbortController().signal,
    ...(options.checkBody && { checkBody: options.checkBody }),
    ...(options.onServed && { onServed: options.onServed }),
  };
  const result = await runX402Use(input, world.deps);
  world.trail.push(`returned:${result.kind}`);
  return result;
}

/** Reads a stream to its end. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
