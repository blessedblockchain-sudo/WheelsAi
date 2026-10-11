// Fakes for the tests of paid use (paidUse, paidUseRoutes): the REAL
// services/paidUse.ts on the real chat core (prepareAgentChat), the real
// metering of one use (beginUseMetering over chargeUse, settleUse and
// refundUse) and a real fail-closed limiter on its memory store. What is
// faked is the edge of each: the rows, the model and the money tables,
// which are kept in memory with transactions that roll back. Not a test
// file itself.

import type { AgentChatAgent, AgentChatDeps, AgentChatInput } from "../services/agentChat.js";
import { prepareAgentChat } from "../services/agentChat.js";
import { peekApiKeySpend, type ApiKeySpendReadDb } from "../services/apiKeySpend.js";
import {
  createFailClosedLimiter,
  createMemoryLimiterStore,
  type LimiterStore,
} from "../services/failClosedLimiter.js";
import type { ChatMessage, ChatStream, RunChatOptions, StreamOutcome } from "../services/mastra-runtime.js";
import {
  PAID_USE_LIMITS,
  type PaidAgent,
  type PaidCaller,
  type PaidSubscription,
  type PaidUseDeps,
  type PaidUseLimits,
} from "../services/paidUse.js";
import type { PublicChatTranscript } from "../services/publicChat.js";
import type { UseListingRow } from "../services/useListing.js";
import type { UseBillingLicence, UseMeteringTx } from "../services/useMetering.js";
import { beginUseMetering, type BeginUseMeteringArgs } from "../services/useMeteringProduction.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const DAY = "2026-10-10";
export const HANDLE = "support-bot";
export const CREATOR_ORG = "org-creator";
export const BUYER_ORG = "org-buyer";
export const FREE_MODEL = "free/groq/llama-3.3-70b";
export const OWN_KEY_MODEL = "openai/gpt-4o-mini";

/** The creator's instructions. No reply may carry them, or any eight words of them in a row. */
export const INSTRUCTIONS =
  "You are Support Bot for Acme. Always greet the customer by name and never mention the internal escalation code seven four two.";
/** An answer that repeats a run of the instructions. */
export const LEAK = "Sure! Always greet the customer by name and never mention the internal escalation code.";

export const KB_DOCUMENT_TITLE = "Internal Pricing Handbook 2026";

export const TASK_FORM = {
  task: {
    fields: [
      { key: "topic", label: "Topic", type: "short_text", required: true },
      { key: "notes", label: "Notes", type: "long_text", required: false },
    ],
  },
};

export const AGENT: PaidAgent = {
  id: "agent-1",
  orgId: CREATOR_ORG,
  name: "Support Bot",
  agentKind: "conversation",
  kindConfig: null,
  entrypoint: "chat",
  isPublic: true,
  // "Show results" on the agent's page: on, as listing an agent for use sets it.
  publicResults: true,
  systemPrompt: INSTRUCTIONS,
  tools: [
    { name: "calculator", description: "calc", config: { secretSetting: "TOOL_SETTING_VALUE" } },
    { name: "http_request", description: "http" },
    { name: "web_search", description: "search" },
  ],
  pageKey: { id: "key-page", storeTranscripts: false },
};

export const LISTING: UseListingRow = {
  id: "lst-1",
  slug: "support-bot",
  title: "Support Bot",
  agentId: AGENT.id,
  publisherId: CREATOR_ORG,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  monthlyPriceCents: null,
  useAllowedTools: [],
};

export const LICENCE: UseBillingLicence = {
  id: "ins-1",
  buyerId: BUYER_ORG,
  kind: "use",
  status: "active",
  acceptedPricingModel: "per_request",
  acceptedPricePerRequestCents: 5n,
};

export const MONTHLY_LISTING: UseListingRow = {
  ...LISTING,
  pricingModel: "monthly",
  pricePerRequestCents: null,
  monthlyPriceCents: 900n,
};
export const MONTHLY_LICENCE: UseBillingLicence = {
  ...LICENCE,
  acceptedPricingModel: "monthly",
  acceptedPricePerRequestCents: null,
};
export const PAID_MONTH: PaidSubscription = {
  status: "active",
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  endReason: null,
  priceCents: 900n,
};

export const SESSION: PaidCaller = { orgId: BUYER_ORG, userId: "user-1", type: "jwt", apiKeyId: null, scopes: [] };
export const KEY_CALLER: PaidCaller = {
  orgId: BUYER_ORG,
  userId: null,
  type: "api_key",
  apiKeyId: "key-1",
  scopes: ["agents:use"],
};

const enc = new TextEncoder();
/** A runtime event as the provider sends it: with ids and the model's name, which must not reach a buyer. */
export const delta = (content: string) =>
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

export interface PaidHarnessOptions {
  agent?: Partial<PaidAgent> | null;
  /** The model the agent configures. Default: a free model, on the platform's keys. */
  model?: string;
  listing?: UseListingRow | null;
  licence?: UseBillingLicence | null;
  sub?: PaidSubscription | null;
  /** The buyer's credits, in cents. */
  balance?: bigint;
  /** The paying key's caps and what it has spent today. */
  keyCaps?: { maxUse: bigint | null; daily: bigint | null; spent?: bigint };
  /** What the agent answers. */
  answer?: string;
  /** The stream's outcome, when it is not a plain answer. */
  outcome?: StreamOutcome;
  /** The model call throws before a stream exists. */
  modelThrows?: Error;
  /** The creator's free-model allowance is used up. */
  allowanceUsedUp?: boolean;
  /** Fires while the model is producing the answer: the caller left. */
  abortDuringRun?: AbortController;
  /** The metering hands the core no charge, whatever the use is (a fault this must survive). */
  meteringChargesNothing?: boolean;
  limits?: Partial<PaidUseLimits>;
  store?: LimiterStore;
  /** The caller's role in the buying organization as it is now; null = no longer a member. Default: owner. */
  role?: string | null;
  /** The membership cannot be read. */
  roleThrows?: Error;
  results?: Array<{ finishedAt: Date; text: string }>;
  /** The model is one the creator's organization runs itself (give `model` a wheelsai/ id), and it is not running. */
  hostedModelDown?: boolean;
  /** What "is the listing paused now" answers; an Error is thrown. Default: not paused. */
  paused?: boolean | Error;
}

export interface PaidHarness {
  deps: PaidUseDeps;
  /** Every effect, in the order it happened. */
  log: string[];
  chatInputs: AgentChatInput[];
  chatCalls: Array<{ messages: ChatMessage[]; options: RunChatOptions; config: { tools: Array<{ name: string }>; modelConfig: { maxTokens: number } } }>;
  transcripts: PublicChatTranscript[];
  usageSources: string[];
  money: {
    balance: bigint;
    ledger: Array<{ type: string; amountCents: bigint; description: string }>;
    revenue: Array<{ id: string; status: string; gross: bigint; creator: bigint; platformFee: bigint }>;
    publisherPending: bigint;
    /** The creator's ledger: one row for every change to what they are owed. */
    earnings: EarningsRow[];
    keySpent: bigint;
    useModelCostMicros: bigint;
  };
  /** How many requests the creator's free-model allowance has counted. */
  allowanceCounted(): number;
}

export function paidHarness(options: PaidHarnessOptions = {}): PaidHarness {
  const log: string[] = [];
  const chatInputs: AgentChatInput[] = [];
  const chatCalls: PaidHarness["chatCalls"] = [];
  const transcripts: PublicChatTranscript[] = [];
  const usageSources: string[] = [];
  let allowance = 0;

  const agent: PaidAgent | null = options.agent === null ? null : { ...AGENT, ...options.agent };
  const listing = options.listing === undefined ? LISTING : options.listing;
  const licence = options.licence === undefined ? LICENCE : options.licence;
  const sub = options.sub ?? null;
  const model = options.model ?? FREE_MODEL;

  // ---- money, in memory, with transactions that roll back ----
  let money: PaidHarness["money"] = {
    balance: options.balance ?? 500n,
    ledger: [],
    revenue: [],
    publisherPending: 0n,
    earnings: [],
    keySpent: options.keyCaps?.spent ?? 0n,
    useModelCostMicros: 0n,
  };
  let seq = 0;
  const keyRow = () =>
    options.keyCaps
      ? { orgId: BUYER_ORG, maxUsePriceCents: options.keyCaps.maxUse, dailySpendCapCents: options.keyCaps.daily }
      : null;
  const tx = {
    creditBalance: {
      updateMany: async (args: { where: { balanceCents: { gte: bigint } }; data: { balanceCents: { decrement: bigint } } }) => {
        log.push("charge");
        if (money.balance < args.where.balanceCents.gte) return { count: 0 };
        money.balance -= args.data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: money.balance }),
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        money.balance += args.data.balanceCents.increment;
        return { balanceCents: money.balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: { type: string; amountCents: bigint; description: string } }) => {
        money.ledger.push({ type: args.data.type, amountCents: args.data.amountCents, description: args.data.description });
        return {};
      },
    },
    marketplaceRevenue: {
      create: async (args: { data: { status: string; grossAmountCents: bigint; creatorAmountCents: bigint; platformFeeCents: bigint } }) => {
        const id = `rev-${++seq}`;
        money.revenue.push({
          id,
          status: args.data.status,
          gross: args.data.grossAmountCents,
          creator: args.data.creatorAmountCents,
          platformFee: args.data.platformFeeCents,
        });
        return { id };
      },
      updateMany: async (args: { where: { id: string; status: string }; data: { status: string } }) => {
        const row = money.revenue.find((r) => r.id === args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        row.status = args.data.status;
        log.push(args.data.status === "settled" ? "settle" : "refund");
        return { count: 1 };
      },
      update: async (args: { where: { id: string }; data: { platformFeeCents: { increment: bigint }; creatorAmountCents: { decrement: bigint } } }) => {
        const row = money.revenue.find((r) => r.id === args.where.id)!;
        row.platformFee += args.data.platformFeeCents.increment;
        row.creator -= args.data.creatorAmountCents.decrement;
        return {};
      },
    },
    // The creator is credited through the ledger (moveEarnings).
    ...earningsStandIn({
      pending: () => money.publisherPending,
      add: (_orgId, pending) => {
        money.publisherPending += pending;
      },
      write: (row) => money.earnings.push(row),
    }),
    agentInstall: { update: async () => ({}) },
    agentListing: {
      update: async (args: { data: { useModelCostMicros?: { increment: bigint } } }) => {
        if (args.data.useModelCostMicros) money.useModelCostMicros += args.data.useModelCostMicros.increment;
        return { useModelCostMicros: money.useModelCostMicros };
      },
    },
    apiKey: { findUnique: async () => keyRow() },
    apiKeySpendWindow: {
      createMany: async () => ({}),
      updateMany: async (args: { where: { spentCents: { lte: bigint } }; data: { spentCents: { increment: bigint } } }) => {
        if (money.keySpent > args.where.spentCents.lte) return { count: 0 };
        money.keySpent += args.data.spentCents.increment;
        return { count: 1 };
      },
      findUnique: async () => ({ spentCents: money.keySpent }),
    },
  };
  const transaction = async <T>(fn: (t: UseMeteringTx) => Promise<T>): Promise<T> => {
    const before = structuredClone(money);
    try {
      return await fn(tx as unknown as UseMeteringTx);
    } catch (err) {
      money = before;
      throw err;
    }
  };

  // ---- the chat core's edges ----
  const coreAgent: AgentChatAgent | null = agent && {
    id: agent.id,
    orgId: agent.orgId,
    slug: "support-bot",
    name: agent.name ?? "Agent",
    version: "1.0.0",
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    modelConfig: { externalModel: model, temperature: 0.3, maxTokens: 700 },
    env: {},
    knowledgeBaseId: "kb-1",
    entrypoint: agent.entrypoint,
  };
  const chatDeps: AgentChatDeps = {
    loadAgent: async (where) => {
      log.push("core:loadAgent");
      return coreAgent && coreAgent.orgId === where.orgId && "id" in where && where.id === coreAgent.id ? coreAgent : null;
    },
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => [FREE_MODEL],
    isFreeModel: (id) => id.startsWith("free/"),
    resolveModel: (modelId) => {
      log.push("core:model");
      return { apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId };
    },
    checkFreeTierLimit: async (orgId, { failClosed }) => {
      log.push(`core:allowance:${orgId}:${failClosed ? "closed" : "open"}`);
      if (options.allowanceUsedUp) {
        return { allowed: false, remaining: { rpm: 5, rpd: 0 }, resetAt: { rpm: 0, rpd: Math.floor(NOW.getTime() / 1000) + 3600 } };
      }
      allowance += 1;
      return { allowed: true, remaining: { rpm: 19, rpd: 199 }, resetAt: { rpm: 0, rpd: 0 } };
    },
    // Grounding with a document whose title is the creator's to know.
    retrieveContext: async () =>
      ({
        contextBlock: "CONTEXT: refunds take five days",
        mode: "keyword",
        fallbackReason: null,
        sources: [{ documentId: "doc-1", title: KB_DOCUMENT_TITLE, score: 1 }],
      }) as never,
    beginMetering: async () => {
      throw new Error("the copy path's metering must never be reached by a paid use");
    },
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => ["calculator", "http_request", "web_search"],
    runChat: async () => {
      throw new Error("a paid use never takes the unstreamed path: its answer is held");
    },
    runChatStream: async (_resolved, config, messages, runOptions) => {
      log.push("model");
      chatCalls.push({ messages, options: runOptions, config: config as never });
      if (options.modelThrows) throw options.modelThrows;
      options.abortDuringRun?.abort();
      const answer = options.answer ?? "Hello, Ada. How can I help?";
      return streamOf(
        [delta(answer.slice(0, 8)), delta(answer.slice(8))],
        options.outcome ?? {
          ok: true,
          usage: { inputTokens: 1_000, outputTokens: 500 },
          toolCalls: [{ round: 1, name: "web_search", status: "unavailable", detail: "TAVILY_API_KEY is not configured" }],
          content: answer,
        },
      );
    },
    recordUsage: async (record) => {
      usageSources.push(record.source);
    },
    deadlineMs: 60_000,
    ...(options.hostedModelDown && {
      resolveHostedModel: async () => {
        log.push("core:hostedModel");
        // The core's own words name the model and say what its owner can do.
        return { ok: false as const, message: 'This agent is set to "llama", and there is no running deployment of it now. Deploy the model.' };
      },
    }),
  };

  // ---- the limiter, logged ----
  const real = createFailClosedLimiter(options.store ?? createMemoryLimiterStore(() => NOW.getTime()));
  const limiter: PaidUseDeps["limiter"] = {
    consume: async (rules) => {
      log.push(`limit:${rules.map((rule) => rule.key.split(":").slice(0, 3).join(":")).join(",")}`);
      return real.consume(rules);
    },
    peek: async (key) => {
      log.push(`peek:${key.split(":").slice(0, 3).join(":")}`);
      return real.peek(key);
    },
  };

  const deps: PaidUseDeps = {
    limiter,
    limits: { ...PAID_USE_LIMITS, ...options.limits },
    loadAgentByHandle: async (handle) => {
      log.push("loadAgent");
      return handle === HANDLE ? agent : null;
    },
    loadListing: async () => {
      log.push("loadListing");
      return listing;
    },
    loadLicence: async () => {
      log.push("loadLicence");
      return { licence, sub };
    },
    readBalance: async () => {
      log.push("readBalance");
      return money.balance;
    },
    peekKeySpend: async (args) => {
      log.push("peekKey");
      return peekApiKeySpend(tx as unknown as ApiKeySpendReadDb, { ...args, cap: "use", now: NOW });
    },
    outboundToolNames: () => ["http_request"],
    beginUse: (args: BeginUseMeteringArgs) => {
      const binding = beginUseMetering(args, {
        metering: { transaction, now: () => NOW },
        rates: { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
      });
      if (!options.meteringChargesNothing) return binding;
      return { ...binding, beginMetering: async () => null, charge: () => null, refusal: () => null };
    },
    prepareChat: (input, beginMetering) => {
      chatInputs.push(input);
      return prepareAgentChat(input, { ...chatDeps, beginMetering });
    },
    writeTranscript: async (transcript) => {
      log.push("transcript");
      transcripts.push(transcript);
    },
    latestResults: async (args) => {
      log.push(`results:${args.orgId}:${args.limit}`);
      return (options.results ?? []).slice(0, args.limit);
    },
    memberRole: async () => {
      log.push("memberRole");
      if (options.roleThrows) throw options.roleThrows;
      return options.role === undefined ? "owner" : options.role;
    },
    listingPaused: async () => {
      if (options.paused instanceof Error) throw options.paused;
      return options.paused ?? false;
    },
    now: () => NOW,
  };

  return {
    deps,
    log,
    chatInputs,
    chatCalls,
    transcripts,
    usageSources,
    get money() {
      return money;
    },
    allowanceCounted: () => allowance,
  };
}

/** A limiter store that cannot count. */
export const brokenStore: LimiterStore = {
  consume: async () => {
    throw new Error("redis is down");
  },
  peek: async () => {
    throw new Error("redis is down");
  },
};
