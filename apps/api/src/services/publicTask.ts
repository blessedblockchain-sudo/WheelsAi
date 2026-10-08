/**
 * A task run by somebody nobody can identify: the form on an agent's public
 * page (/a/<handle>), filled in and sent with the page's publishable key.
 *
 *   POST /api/widget/:publicKey/run   { input, stream? }
 *
 * It is the public chat's sibling (services/publicChat.ts), not a second
 * implementation. The visitor, the key, the counters and the chat core are
 * the same; what differs is what is sent (a form's answers, not a
 * conversation) and what comes back (one result). So the steps of the widget
 * are the public chat's own helpers, and the order is the same order with
 * two checks of the answers added before anything is spent:
 *
 *   1. limit     the visitor's address, on the counters a chat message uses
 *                (widgetAddressRules), on a limiter that fails closed.
 *                Nothing below runs for a request that was not counted.
 *   2. body      `{ input, stream? }` and nothing else.
 *   3. key       enabled, not revoked, and for a page key only while the
 *                page is on (loadLiveWidgetKey). Otherwise 404.
 *   4. origin    the request's Origin is the platform's own page or a site
 *                the key's owner listed.
 *   5. kind      the agent is a task agent (409).
 *   6. answers   not too long (413) and matching the form (422), by
 *                checkTaskInput.
 *   7. model     the agent's own. (agentChat steps 1-3.)
 *   8. budget    the key's per-minute limit and daily cap, one API call of
 *                the owner's plan (widgetKeyAdmit), then the owner's
 *                free-model allowance, failing closed. (agentChat step 4.)
 *   9. run
 *
 * A wrong input therefore spends nobody's cap: steps 5 and 6 read no
 * counter, and the budgets of step 8 are opened by the core only after the
 * model is known.
 *
 * What the model reads is buildTaskBrief's (services/agentTask.ts): the same
 * brief as the owner's run and a paid job. The run is a `public` caller of
 * the chat core, so its tools are held to the `public` tool mode.
 *
 * What a visitor is told is the public chat's vocabulary: a status, a code
 * and a sentence. Never the agent's instructions, the brief's system part,
 * tool settings, secret names, the organization, the daily cap or how much
 * of it is used.
 *
 * What is stored: the counters and the usage record the core writes for any
 * widget message. Only when the key's owner turned "keep a copy" on, the
 * answers (as text, under their labels) and the result, as one conversation.
 *
 * Pure core: every effect is a dependency, and they are the public chat's
 * (services/buildPublicChatDeps.ts), so chat and run share one limiter.
 */

import { z } from "zod";

import { publicToolCalls, toPublicStream, type PublicToolCall } from "../lib/publicSse.js";
import type { AgentChatInput, AgentChatRefusal, PrepareAgentChatResult } from "./agentChat.js";
import {
  buildTaskBrief,
  checkTaskInput,
  TASK_MAX_OUTPUT_TOKENS,
  TASK_MAX_TOOL_ROUNDS,
  TASK_REFUSAL_STATUS,
  TASK_TIME_LIMIT_MS,
  type TaskInputCheck,
} from "./agentTask.js";
import type { SettleableMeter } from "./chatStreamSettlement.js";
import type { ChatStream, StreamOutcome } from "./mastra-runtime.js";
import {
  AdmissionRefused,
  agentUnavailable,
  consumePublicLimit,
  loadLiveWidgetKey,
  markWidgetKeyUsed,
  publicFailureOf,
  publicRefusalOf,
  WIDGET_KEY_NOT_FOUND,
  widgetAddressRules,
  widgetKeyAdmit,
  type PublicChatDeps,
  type PublicChatRefusal,
} from "./publicChat.js";
import { originAllowed } from "./widgetKeys.js";

// ============================================
// Request body
// ============================================

/**
 * Strict, like a public chat's body: an unknown key (`model`, `system`,
 * `messages`) is a 400, not something silently ignored. `input` is checked
 * against the agent's form in step 6, once the agent is known.
 */
export const publicTaskBodySchema = z
  .object({
    input: z.unknown(),
    stream: z.boolean().optional(),
  })
  .strict();

export type PublicTaskBody = z.infer<typeof publicTaskBodySchema>;

// ============================================
// Input, dependencies, results
// ============================================

export interface PublicTaskInput {
  publicKey: string;
  /** The request's Origin header, as sent. */
  origin: string | null | undefined;
  /** The visitor's address (request.ip, behind the configured proxy hops). */
  ip: string | null | undefined;
  /** The parsed JSON body, not yet validated. */
  body: unknown;
  /** Fires when the client goes away; the run stops and is refunded. */
  signal: AbortSignal;
}

/** The public chat's own deps: one limiter, one key lookup, one chat core. */
export type PublicTaskDeps = Pick<
  PublicChatDeps,
  | "limiter"
  | "limits"
  | "bucketOf"
  | "appOrigins"
  | "loadWidgetKey"
  | "meterOwnerCall"
  | "prepareChat"
  | "writeTranscript"
  | "markKeyUsed"
  | "now"
  | "logger"
>;

export type PublicTaskResult =
  | { kind: "refused"; refusal: PublicChatRefusal }
  | {
      kind: "result";
      output: { format: "text"; text: string };
      toolCalls: PublicToolCall[];
    }
  | {
      kind: "stream";
      /** Already in the public encoding (lib/publicSse.ts). */
      chat: ChatStream;
      /**
       * Every charge behind this result. The caller MUST forward the stream
       * with streamToReply / forwardAndSettle and this meter.
       */
      meter: SettleableMeter | null;
      /**
       * Call with the outcome forwardAndSettle returned: writes the
       * opted-in copy of a result that arrived. Never throws.
       */
      finished(outcome: StreamOutcome): Promise<void>;
    };

// ============================================
// Words
// ============================================

/** What a visitor of a task page is told. No em dashes, no codes, no numbers of the owner's. */
export const PUBLIC_TASK_MESSAGES = {
  invalidBody: "Send your answers as { input: { ... } }. Nothing else is accepted here.",
  originNotAllowed: "This site is not allowed to use this agent.",
  unavailable: "This agent is not available right now.",
  usageLimit: "This agent has reached its usage limit for now. Please try again later.",
  dailyLimit: "This agent has reached its limit for today. Try again tomorrow.",
  busy: "This agent is getting a lot of requests right now. Try again in a moment.",
  temporarilyUnavailable: "This agent is temporarily unavailable. Please try again shortly.",
  restarting: "This agent is restarting. Please try again in a moment.",
  visitorLimit: (retryAfterSeconds: number) => `You have reached the limit for now. Try again in ${waitOf(retryAfterSeconds)}.`,
} as const;

/** "1 minute", "4 minutes", "1 hour", "12 hours": how long to wait, rounded up. */
function waitOf(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** A per-minute counter never asks for a longer wait than this. */
const MINUTE = 60;

/**
 * A refusal of the shared steps, in a task page's words. The public chat's
 * sentences speak of "chat" and "messages"; the status, the code, the scope
 * and the wait are kept as they are, so a client that reads codes sees one
 * vocabulary on both routes.
 */
function inTaskWords(refusal: PublicChatRefusal): PublicChatRefusal {
  switch (refusal.code) {
    case "rate_limited": {
      const wait = refusal.retryAfterSeconds ?? MINUTE;
      if (refusal.scope === "ip") return { ...refusal, message: PUBLIC_TASK_MESSAGES.visitorLimit(wait) };
      // The owner's free-model allowance.
      if (refusal.scope === "agent") return { ...refusal, message: PUBLIC_TASK_MESSAGES.usageLimit };
      // The page's own budget: its daily cap, or its per-minute limit. The
      // cap itself and how much of it is used are the owner's to know.
      return { ...refusal, message: wait > MINUTE ? PUBLIC_TASK_MESSAGES.dailyLimit : PUBLIC_TASK_MESSAGES.busy };
    }
    case "rate_limiter_unavailable":
      return { ...refusal, message: PUBLIC_TASK_MESSAGES.temporarilyUnavailable };
    case "agent_unavailable":
      if (refusal.reason === "restarting") return { ...refusal, message: PUBLIC_TASK_MESSAGES.restarting };
      return refusal;
    default:
      return refusal;
  }
}

const refused = (refusal: PublicChatRefusal): PublicTaskResult => ({ kind: "refused", refusal: inTaskWords(refusal) });

const INVALID_BODY: PublicChatRefusal = {
  status: 400,
  code: "invalid_request",
  message: PUBLIC_TASK_MESSAGES.invalidBody,
};

const ORIGIN_NOT_ALLOWED: PublicChatRefusal = {
  status: 403,
  code: "origin_not_allowed",
  message: PUBLIC_TASK_MESSAGES.originNotAllowed,
};

/**
 * The core's refusal as a visitor of a task page hears it. The messages the
 * core was given are this file's own, so a refusal of their shape is not
 * something the visitor sent wrong.
 */
function coreRefusal(refusal: AgentChatRefusal, nowSeconds: number): PublicChatRefusal {
  const told = publicRefusalOf(refusal, "widget_key_not_found", nowSeconds);
  return told.code === "invalid_request" ? agentUnavailable("agent_misconfigured") : told;
}

/** checkTaskInput's refusal as a visitor hears it: its sentence, and for 422 each answer to fix. */
function taskRefusal(check: Exclude<TaskInputCheck, { ok: true }>): PublicChatRefusal {
  return {
    status: TASK_REFUSAL_STATUS[check.code],
    code: check.code,
    message: check.message,
    ...(check.code === "input_invalid" && { details: check.details }),
  };
}

// ============================================
// The service
// ============================================

export async function runPublicTask(input: PublicTaskInput, deps: PublicTaskDeps): Promise<PublicTaskResult> {
  const now = (deps.now ?? (() => new Date()))();

  // 1. The address, before anything is looked up. The same counters as a
  // chat message: a visitor has one allowance, however they use the page.
  const bucket = deps.bucketOf(input.ip);
  const addressLimit = await consumePublicLimit(
    deps.limiter,
    widgetAddressRules(deps.limits, bucket, now),
    "task",
    deps.logger,
  );
  if (addressLimit) return refused(addressLimit);

  // 2. The body is read here, not trusted: no lookup depends on it yet.
  const parsed = publicTaskBodySchema.safeParse(input.body);
  if (!parsed.success) return refused(INVALID_BODY);
  const body = parsed.data;

  // 3. The key.
  const key = await loadLiveWidgetKey(deps, input.publicKey);
  // A key whose agent could not be read has nothing to run.
  if (!key || !key.agent) return refused(WIDGET_KEY_NOT_FOUND);
  const agent = key.agent;

  // 4. The origin, before the key's own budgets: a site that is not allowed
  // to use the key must not be able to use up its daily cap. A page key
  // lists no sites, so only the platform's own page passes.
  if (!originAllowed(input.origin, key.allowedOrigins, deps.appOrigins)) return refused(ORIGIN_NOT_ALLOWED);

  // 5-6. The kind, then the answers against the form. Nothing has been
  // spent of the key's budget or the owner's plan yet, and nothing is here.
  let check: TaskInputCheck;
  try {
    check = checkTaskInput(agent, body.input);
  } catch (err) {
    // The agent's own form does not compile: its owner's to fix.
    deps.logger?.error({ err, widgetKeyId: key.id }, "public task refused: the agent's form cannot be read");
    return refused(agentUnavailable("agent_misconfigured"));
  }
  if (!check.ok) return refused(taskRefusal(check));

  const brief = buildTaskBrief(agent, check.input);

  const chatInput: AgentChatInput = {
    caller: "public",
    // An anonymous visitor: the `public` tool mode, and the usage record of
    // a widget message.
    source: "widget",
    orgId: key.orgId,
    agent: { id: key.agentId },
    messages: [{ role: "user", content: brief.brief }],
    systemAddendum: brief.systemAddendum,
    signal: input.signal,
    maxOutputTokens: TASK_MAX_OUTPUT_TOKENS,
    maxToolRounds: TASK_MAX_TOOL_ROUNDS,
    deadlineMs: TASK_TIME_LIMIT_MS,
    // 8. The key's budgets, then the owner's plan.
    admit: widgetKeyAdmit(deps, key, bucket, now),
  };

  const nowSeconds = Math.floor(now.getTime() / 1000);

  // 7-8. Model and budget, in the core's order.
  let prepared: PrepareAgentChatResult;
  try {
    prepared = await deps.prepareChat(chatInput);
  } catch (err) {
    if (err instanceof AdmissionRefused) return refused(err.refusal);
    throw err;
  }
  if (!prepared.ok) return refused(coreRefusal(prepared.refusal, nowSeconds));
  const { session } = prepared;

  markWidgetKeyUsed(deps, key, now);

  /** What follows a result that reached the visitor. Never throws. */
  const delivered = async (text: string): Promise<void> => {
    // Kept only when the key's owner opted in, and only of a result: the
    // answers as a person reads them, and what the agent produced.
    if (!key.storeTranscripts || !deps.writeTranscript || text.length === 0) return;
    await deps
      .writeTranscript({
        orgId: key.orgId,
        agentId: key.agentId,
        widgetKeyId: key.id,
        // One run is one conversation of its own.
        sessionId: null,
        origin: input.origin ?? null,
        userMessage: brief.text,
        assistantMessage: text,
      })
      .catch((err) => deps.logger?.warn({ err, widgetKeyId: key.id }, "failed to store a copy of a public task run"));
  };

  // 9. The run. Streaming is the default, as for a chat.
  if (body.stream === false) {
    const completed = await session.complete();
    if (!completed.ok) {
      return refused(
        completed.refusal
          ? coreRefusal(completed.refusal, nowSeconds)
          : publicFailureOf(completed.failure),
      );
    }
    await delivered(completed.result.content);
    return {
      kind: "result",
      output: { format: "text", text: completed.result.content },
      toolCalls: publicToolCalls(completed.result.toolCalls),
    };
  }

  const started = await session.stream();
  if (!started.ok) {
    return refused(
      started.refusal
        ? coreRefusal(started.refusal, nowSeconds)
        : publicFailureOf(started.failure),
    );
  }
  return {
    kind: "stream",
    chat: toPublicStream(started.chat),
    meter: session.meter,
    finished: async (outcome) => {
      if (outcome.ok) await delivered(outcome.content ?? "");
    },
  };
}
