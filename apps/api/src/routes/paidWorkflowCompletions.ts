/**
 * `model: "w/<slug>"` on /v1/chat/completions: a workflow the caller PAYS to
 * run, named by the slug of its listing, the name it has on its page.
 *
 * It is the page's paid run (services/paidWorkflow.ts, runPaidWorkflow) in
 * OpenAI's wire format, on the same deps (productionPaidWorkflowDeps), so a
 * buyer's limits and counters are shared between the page and the API. What
 * this file adds is the translation, both ways:
 *
 *   in    the messages, as the owner's own `workflow/<slug>` takes them;
 *         tools, tool_choice and a system or tool message are
 *         `unsupported_parameter` before anything is counted or charged.
 *         Sampling settings are accepted and not applied.
 *   out   a chat.completion (or its chunks) whose `model` echoes
 *         `w/<listing slug>`, plus `wheelsai: { workflow: { slug }, billing }`
 *         and nothing else: never a run id, the workflow's own slug or name,
 *         a step, or tokens.
 *
 * A workflow never produces its answer as it goes, so a stream is opened
 * only after the answer is whole and checked, and is settled by
 * streamToReply once the bytes arrived; nothing is sent before then, so the
 * usage headers of the head are true.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { replyOpenAiError, sendOpenAiError } from "../middleware/openaiAuth.js";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";
import {
  extensionChunk,
  newCompletionId,
  paidUseOpenAiError,
  SSE_DONE,
  sseFrame,
  toChatCompletion,
  toChunk,
  type CompletionMeta,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";
import type { PaidUseBilling } from "../services/paidUse.js";
import { runPaidWorkflow, type PaidWorkflowDeps } from "../services/paidWorkflow.js";
import { streamToReply } from "../services/sseReply.js";
import { clearUsageHeaders, refusalUsageHeadersOf, setUsageHeaders, usageHeadersOf } from "../services/usageHeaders.js";

/** What `model` starts with for a workflow the caller pays to run. A deployment's slug has no "/". */
export const PAID_WORKFLOW_MODEL_PREFIX = "w/";

const STREAM_HEARTBEAT_MS = 15_000;
/** The answer is whole: it is written out in pieces of this many characters. */
const STREAM_PIECE_CHARS = 2_000;

/** `w/<slug>`: what a paid workflow is called as an OpenAI `model`. */
export function paidWorkflowOpenAiModel(slug: string): string {
  return `${PAID_WORKFLOW_MODEL_PREFIX}${slug}`;
}

/** A workflow on sale the organization pays to run, as an OpenAI model object. */
export function paidWorkflowModelEntry(workflow: { slug: string; createdAt: Date }): Record<string, unknown> {
  return {
    id: paidWorkflowOpenAiModel(workflow.slug),
    object: "model",
    created: Math.floor(workflow.createdAt.getTime() / 1000),
    owned_by: "wheelsai",
    wheelsai: { kind: "paid_workflow" },
  };
}

export interface PaidWorkflowCompletionDeps {
  /** Built on first use. Default: the one set of paid-run deps of this process. */
  paidWorkflow?: () => PaidWorkflowDeps;
  now?: () => number;
  heartbeatMs?: number;
}

export type PaidWorkflowCompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: { slug: string; chat: ParsedChatRequest },
) => Promise<FastifyReply | void>;

/** What a buyer may not send, by the name of the parameter. null = nothing. */
export function paidWorkflowRequestRefusal(chat: ParsedChatRequest): { param: string; message: string } | null {
  if (chat.tools.length > 0) {
    return { param: "tools", message: "A workflow you pay to use does not accept caller-defined tools. Remove tools." };
  }
  if (chat.toolChoice !== null) {
    return { param: "tool_choice", message: "A workflow you pay to use does not accept tool_choice. Remove it." };
  }
  for (const [index, message] of chat.messages.entries()) {
    const steering =
      message.role === "system" ||
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0);
    if (steering) {
      return {
        param: `messages[${index}].role`,
        message:
          "A workflow you pay to use accepts only user and assistant text messages. Its owner sets its instructions; remove the system and tool messages.",
      };
    }
  }
  return null;
}

/**
 * The `wheelsai` object of a paid run's answer: the listing's slug and the
 * billing, field by field, as an agent's paid answer carries its billing
 * (routes/paidCompletions.ts).
 */
function extensionOf(slug: string, billing: PaidUseBilling): Record<string, unknown> {
  const { plan } = billing;
  return {
    workflow: { slug },
    billing: {
      chargedCents: billing.chargedCents,
      balanceCents: billing.balanceCents,
      access: billing.access,
      ...(plan && {
        plan: {
          id: plan.id,
          use: plan.use,
          trial: plan.trial,
          includedUses: plan.includedUses,
          carriedUses: plan.carriedUses,
          usedUses: plan.usedUses,
          remainingUses: plan.remainingUses,
          extraUsePriceCents: plan.extraUsePriceCents,
          ...(plan.resetsAt !== undefined && { resetsAt: plan.resetsAt }),
          warning: plan.warning,
        },
      }),
    },
  };
}

/**
 * The whole answer as OpenAI chunks: the `wheelsai` chunk, the text in
 * pieces, a finish chunk, [DONE]. Its outcome is a real answer once the last
 * frame was read, and a failure when the reader stopped before it.
 */
function answerStream(meta: CompletionMeta, extension: Record<string, unknown>, text: string): ChatStream {
  const encoder = new TextEncoder();
  const frames = [sseFrame(extensionChunk(meta, extension))];
  for (let at = 0; at < text.length; at += STREAM_PIECE_CHARS) {
    const content = text.slice(at, at + STREAM_PIECE_CHARS);
    frames.push(sseFrame(toChunk(meta, at === 0 ? { role: "assistant", content } : { content })));
  }
  frames.push(sseFrame(toChunk(meta, {}, "stop")), SSE_DONE);

  let resolve!: (outcome: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>((done) => {
    resolve = done;
  });
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < frames.length) {
        controller.enqueue(encoder.encode(frames[next++]!));
        return;
      }
      controller.close();
      resolve({ ok: true, usage: null, toolCalls: [] });
    },
    cancel() {
      resolve({ ok: false, error: CLIENT_GONE, toolCalls: [], code: "client_gone" });
    },
  });
  return { stream, outcome };
}

export function createPaidWorkflowCompletionHandler(deps: PaidWorkflowCompletionDeps = {}): PaidWorkflowCompletionHandler {
  const now = deps.now ?? Date.now;
  let paidWorkflow: PaidWorkflowDeps | null = null;
  const core = async (): Promise<PaidWorkflowDeps> => {
    if (paidWorkflow) return paidWorkflow;
    if (deps.paidWorkflow) return (paidWorkflow = deps.paidWorkflow());
    // Imported on first use: registering /v1 opens nothing of a paid run.
    const { productionPaidWorkflowDeps } = await import("../services/buildPaidWorkflowDeps.js");
    return (paidWorkflow = productionPaidWorkflowDeps());
  };

  return async (request, reply, { slug, chat }) => {
    // Wired before the first await: a caller who leaves cancels the run, and
    // whatever was charged goes back.
    const abort = abortOnClientClose(reply.raw);

    // Before anything is counted, looked up or charged.
    const unsupported = paidWorkflowRequestRefusal(chat);
    if (unsupported) return replyOpenAiError(reply, "unsupported_parameter", unsupported);

    const auth = request.auth!;
    const result = await runPaidWorkflow(
      {
        caller: {
          orgId: auth.orgId,
          userId: auth.userId,
          type: auth.type,
          apiKeyId: auth.apiKeyId ?? null,
          scopes: auth.scopes ?? [],
        },
        slug,
        messages: chat.messages,
        stream: chat.stream,
        signal: abort.signal,
      },
      await core(),
    );

    reply.header("cache-control", "no-store");
    if (result.kind === "refused") {
      // Only a plan that is used up has any: the plan's count, with nothing remaining.
      setUsageHeaders(reply, refusalUsageHeadersOf(result.refusal));
      return sendOpenAiError(reply, paidUseOpenAiError(result.refusal));
    }
    setUsageHeaders(reply, usageHeadersOf(result.billing));

    // The listing's slug, as the run found it: it was checked there.
    const shownSlug = slug.toLowerCase();
    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: Math.floor(now() / 1000),
      model: paidWorkflowOpenAiModel(shownSlug),
    };
    const extension = extensionOf(shownSlug, result.billing);

    if (result.kind === "stream") {
      // `finished` is called once, whatever happens below: it lets a
      // shutdown go on, and an open charge is never left to the sweeper.
      let delivered = false;
      let sent: Awaited<ReturnType<typeof streamToReply>>;
      try {
        sent = await streamToReply(reply, answerStream(meta, extension, result.text), {
          meter: result.meter,
          abort,
          heartbeatMs: deps.heartbeatMs ?? STREAM_HEARTBEAT_MS,
        });
        delivered = sent.started && sent.outcome.ok;
      } catch (err) {
        // The stream could not be written: no answer was delivered. A
        // refund after a settle is nothing (the meter is settled once).
        await result.meter.refund(CLIENT_GONE);
        throw err;
      } finally {
        await result.finished({ ok: delivered });
      }
      if (!sent.started) {
        // Gone before the first byte; streamToReply refunded.
        // No answer went out, so nothing says what one cost.
        clearUsageHeaders(reply);
        return replyOpenAiError(reply, "client_closed_request");
      }
      return;
    }

    return reply.status(200).send(
      toChatCompletion({ ...meta, content: result.output.text, finishReason: "stop", extension }),
    );
  };
}
