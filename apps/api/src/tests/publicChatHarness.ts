// Fakes shared by the route tests of the web widget and Try it
// (widgetRoutes, tryItRoutes) and by the public task run's tests
// (publicTask): real services/publicChat.ts and a real fail-closed limiter
// on its memory store, with a stand-in for agent chat. Not a test file
// itself.

import type {
  AgentChatFailure,
  AgentChatInput,
  AgentChatRefusal,
  AgentChatSession,
  PrepareAgentChatResult,
} from "../services/agentChat.js";
import {
  createFailClosedLimiter,
  createMemoryLimiterStore,
  type FailClosedLimiter,
  type LimiterStore,
} from "../services/failClosedLimiter.js";
import type { ChatResult, ChatStream, StreamOutcome } from "../services/mastra-runtime.js";
import type {
  PublicChatDeps,
  PublicChatLimitConfig,
  PublicChatTranscript,
  PublicWidgetKey,
  TrialListing,
} from "../services/publicChat.js";
import { verifyTrialSession } from "../services/trialSession.js";
import { hashBucket, ipBucket } from "../services/widgetKeys.js";

export const SECRET = "0123456789abcdef0123456789abcdef";
export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const DAY = "2026-10-10";
export const PUBLIC_KEY = `wpk_${"a".repeat(32)}`;
export const ORIGIN = "https://shop.example.com";
export const APP_ORIGIN = "https://app.wheelsai.test";
export const FREE_MODEL = "free/groq/llama-3.3-70b";

export const KEY: PublicWidgetKey = {
  id: "key-1",
  orgId: "org-owner",
  agentId: "agent-1",
  allowedOrigins: [ORIGIN],
  dailyMessageCap: null,
  perIpPerMinute: null,
  storeTranscripts: false,
  enabled: true,
  revokedAt: null,
  lastUsedAt: null,
};

/** A task agent's form (Agent.kindConfig): three questions, one of them required. */
export const TASK_FORM = {
  task: {
    fields: [
      { key: "topic", label: "Topic", type: "short_text", required: true },
      { key: "audience", label: "Who is it for?", type: "choice", required: false, options: ["Customers", "Team"] },
      { key: "notes", label: "Notes", type: "long_text", required: false },
    ],
  },
};

/**
 * The key of a task agent's public page, as the owner's side creates it:
 * marked with its agent, no allowed sites, a cap of 100 a day.
 */
export const PAGE_KEY: PublicWidgetKey = {
  ...KEY,
  allowedOrigins: [],
  dailyMessageCap: 100,
  pageOfAgentId: KEY.agentId,
  agent: { isPublic: true, agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" },
};

export const LISTING: TrialListing = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "support-pro",
  agentId: "agent-pub",
  agentOrgId: "org-publisher",
  publisherId: "org-publisher",
  agentEntrypoint: "chat",
  trialFundedDailyCap: 0,
};

export const LIMITS: PublicChatLimitConfig = {
  widget: { perIpPerMinute: 5, perIpPerDay: 50, perKeyPerMinute: 20, defaultDailyCap: 100 },
  trial: { perIpPerHour: 30, messagesPerSession: 3, signedInPerDay: 40, globalPerMinute: 100, baseDailyMessages: 2 },
  maxOutputTokens: 1024,
  maxToolRounds: 3,
};

const RESULT: ChatResult = {
  content: "Hello there.",
  usage: { inputTokens: 10, outputTokens: 4 },
  reportedUsage: { inputTokens: 10, outputTokens: 4 },
  finishReason: "stop",
  toolCalls: [{ round: 1, name: "web_search", status: "unavailable", detail: "TAVILY_API_KEY is not configured" }],
  clientToolCalls: [],
  transcript: [],
};

const enc = new TextEncoder();

function streamOf(outcome: StreamOutcome, events: string[]): ChatStream {
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

export interface FakeChat {
  deps: PublicChatDeps;
  limiter: FailClosedLimiter;
  /** Every effect, in the order it happened. */
  log: string[];
  chatInputs: AgentChatInput[];
  transcripts: PublicChatTranscript[];
  keyUsed: Array<{ id: string; previous: Date | null; at: Date }>;
  holds: Array<{ listingId: string; publisherId: string; day: string; dailyCap: number }>;
}

export interface FakeChatOptions {
  /** The key behind PUBLIC_KEY; a function is read on every lookup. */
  key?: PublicWidgetKey | null | ((publicKey: string) => PublicWidgetKey | null);
  listing?: TrialListing | null;
  limits?: PublicChatLimitConfig;
  store?: LimiterStore;
  refusal?: AgentChatRefusal;
  /** The core refuses at model resolution, before `admit`. */
  refusalBeforeAdmit?: AgentChatRefusal;
  /** The admitted chat produces no answer. */
  failure?: AgentChatFailure;
  /** The owner's plan has no API calls left. */
  planExhausted?: boolean;
  anonymousAllowed?: boolean;
  trialModel?: string | null;
  /** Publisher-funded holds: "ok", "refused", or omitted = not configured. */
  funding?: "ok" | "refused";
  streamOutcome?: StreamOutcome;
  streamEvents?: string[];
}

export function fakeChat(options: FakeChatOptions = {}): FakeChat {
  const log: string[] = [];
  const chatInputs: AgentChatInput[] = [];
  const transcripts: PublicChatTranscript[] = [];
  const keyUsed: FakeChat["keyUsed"] = [];
  const holds: FakeChat["holds"] = [];
  const limiter = createFailClosedLimiter(options.store ?? createMemoryLimiterStore(() => NOW.getTime()));

  // Keeps prepareAgentChat's order: the caller's admission check, then the
  // session.
  const prepareChat = async (input: AgentChatInput): Promise<PrepareAgentChatResult> => {
    chatInputs.push(input);
    log.push("prepare");
    if (options.refusalBeforeAdmit) return { ok: false, refusal: options.refusalBeforeAdmit };
    await input.admit?.({ agentId: "agent", modelId: FREE_MODEL, freeModel: true });
    if (options.refusal) return { ok: false, refusal: options.refusal };
    const session = {
      agent: { id: "agent", slug: "agent", name: "Agent", version: "1" },
      runtime: "platform",
      modelId: FREE_MODEL,
      toolMode: "public",
      platformModel: true,
      rateLimit: null,
      retrieval: null,
      billing: null,
      meter: null,
      complete: async () => {
        log.push("complete");
        if (options.failure) return { ok: false as const, failure: options.failure };
        return { ok: true as const, result: RESULT };
      },
      stream: async () => {
        log.push("stream");
        if (options.failure) return { ok: false as const, failure: options.failure };
        return {
          ok: true as const,
          chat: streamOf(
            options.streamOutcome ?? { ok: true, usage: null, toolCalls: [], content: "Streamed answer." },
            options.streamEvents ?? ['data: {"choices":[{"delta":{"content":"Streamed answer."}}]}\n\n'],
          ),
        };
      },
    } as unknown as AgentChatSession;
    return { ok: true, session };
  };

  const deps: PublicChatDeps = {
    limiter,
    limits: options.limits ?? LIMITS,
    bucketOf: (ip) => hashBucket(ipBucket(ip), SECRET),
    appOrigins: [APP_ORIGIN],
    loadWidgetKey: async (publicKey) => {
      log.push("loadKey");
      if (typeof options.key === "function") return options.key(publicKey);
      const key = options.key === undefined ? KEY : options.key;
      return publicKey === PUBLIC_KEY ? key : null;
    },
    loadTrialListing: async (slug) => {
      log.push("loadListing");
      const listing = options.listing === undefined ? LISTING : options.listing;
      return listing && slug === listing.slug ? listing : null;
    },
    verifyTrialSession: (args) => verifyTrialSession(args, { secret: SECRET, now: () => NOW }),
    anonymousTrialAllowed: () => options.anonymousAllowed ?? true,
    trialModelId: () => (options.trialModel === undefined ? FREE_MODEL : options.trialModel),
    meterOwnerCall: async (orgId) => {
      log.push(`plan:${orgId}`);
      return !options.planExhausted;
    },
    ...(options.funding && {
      holdFundedMessage: async (args) => {
        holds.push(args);
        log.push("hold");
        if (options.funding === "refused") return { ok: false as const };
        return {
          ok: true as const,
          meter: {
            settle: async () => {
              log.push("funded:settle");
            },
            refund: async (reason: string) => {
              log.push(`funded:refund:${reason}`);
            },
          },
        };
      },
    }),
    prepareChat,
    writeTranscript: async (transcript) => {
      transcripts.push(transcript);
    },
    markKeyUsed: async (key) => {
      keyUsed.push(key);
    },
    recordPlatformTrialMessage: async ({ listingId, day }) => {
      log.push(`base:${listingId}:${day}`);
    },
    now: () => NOW,
  };
  return { deps, limiter, log, chatInputs, transcripts, keyUsed, holds };
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
