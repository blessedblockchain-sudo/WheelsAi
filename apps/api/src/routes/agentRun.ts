/**
 * POST /api/agents/:agentId/run: a task agent's form, filled in, gives one
 * result. The owner's door, from the dashboard (a session) or from code (an
 * API key granted agents:invoke).
 *
 * In order, and the order is the point:
 *
 *   1. the agent, in the caller's organization or not at all (404)
 *   2. the input against the agent's form (services/agentTask.ts): 409 when
 *      the agent is not a task agent, 413 when the answers are too long, 422
 *      with every answer that needs another look
 *   3. only then the run
 *
 * A wrong input never reaches the chat core, so it is never counted against
 * the free-model allowance and never charged.
 *
 * The run is a chat on the shared agent-chat service
 * (services/agentChat.ts), exactly as the playground and the /v1 agent API
 * make one: the free-model allowance, a buyer's copy's licence and its
 * per-request charge, the refund of a run that did not answer and the tool
 * mode are that service's, so a run is limited and billed as a chat is. What
 * this route adds is the prompt (the brief a hired job is given, with the
 * rules of a job as a system turn after the agent's own) and a run's limits:
 * the length of the result, the tool rounds and the time.
 *
 * It streams by default, as the playground's chat does; `stream: false`
 * answers JSON. Nothing is saved as history: the answer is the result.
 */

import type { FastifyError, FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validationFailure.js";
import {
  prepareAgentChat,
  SHUTTING_DOWN,
  type AgentChatDeps,
  type AgentChatFailure,
  type AgentChatNotAnswered,
  type AgentChatRefusal,
  type AgentChatSource,
} from "../services/agentChat.js";
import {
  buildTaskBrief,
  checkTaskInput,
  TASK_MAX_BODY_BYTES,
  TASK_MAX_OUTPUT_TOKENS,
  TASK_MAX_TOOL_ROUNDS,
  TASK_MESSAGES,
  TASK_REFUSAL_STATUS,
  TASK_TIME_LIMIT_MS,
  type TaskAgent,
} from "../services/agentTask.js";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { licenceRevokedMessage } from "../services/marketplaceMetering.js";
import { streamToReply } from "../services/sseReply.js";

/** What a run that did not produce a result is answered with (502 run_failed). */
export const RUN_MESSAGES = {
  failed: "This run could not be completed.",
  timedOut: "This run took longer than its time limit and was stopped.",
} as const;

/** A quiet stream is kept open through idle proxies, as a public answer is. */
const RUN_HEARTBEAT_MS = 15_000;

const runBodySchema = z
  .object({
    /** The form's answers, by question key. Checked by checkTaskInput, not here. */
    input: z.unknown().optional(),
    stream: z.boolean().optional().default(true),
  })
  .strict();

/** The agent columns a run reads before the chat core loads the rest. */
export interface RunAgentRow extends TaskAgent {
  id: string;
}

export interface AgentRunGuards {
  /** Who are you. Counts the call against the plan for an API key. */
  auth: preHandlerAsyncHookHandler;
  /** An API key must hold agents:invoke; a session is not scoped. */
  invoke: preHandlerAsyncHookHandler;
}

export interface AgentRunRouteDeps {
  guards: AgentRunGuards;
  /** MUST scope by orgId: another organization's agent is "not found". */
  loadAgent(where: { orgId: string; agentId: string }): Promise<RunAgentRow | null>;
  /** Built on first use, so registering the route opens no connection. */
  chatDeps: () => AgentChatDeps;
  /** How long one run may take. Defaults to TASK_TIME_LIMIT_MS. */
  timeLimitMs?: number;
  now?: () => number;
  logger?: { warn(obj: unknown, msg: string): void };
}

export function createAgentRunRoutes(deps: AgentRunRouteDeps): FastifyPluginAsync {
  let chatDeps: AgentChatDeps | null = null;
  const getChatDeps = () => (chatDeps ??= deps.chatDeps());
  const timeLimitMs = deps.timeLimitMs ?? TASK_TIME_LIMIT_MS;
  const now = deps.now ?? Date.now;

  return async (app) => {
    // A body over the limit is refused by the parser before the handler
    // runs, and for a run that is "your answers are too long". Anything else
    // goes on to the handler this plugin inherited.
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.statusCode !== 413) throw error;
      return reply
        .status(TASK_REFUSAL_STATUS.input_too_large)
        .send({ error: "input_too_large", message: TASK_MESSAGES.inputTooLarge });
    });

    app.post(
      "/agents/:agentId/run",
      {
        preHandler: [deps.guards.auth, deps.guards.invoke],
        bodyLimit: TASK_MAX_BODY_BYTES,
        schema: { tags: ["Agents"], description: "Run a task agent on one filled-in form" },
      },
      async (request, reply) => {
        // Client disconnect cancels the provider call and any running tool,
        // and so does the run's time limit: one signal stops the run, and the
        // chat core refunds whatever it charged. Wired before the first
        // await, as in the playground.
        const abort = abortOnClientClose(reply.raw);
        let timedOut = false;
        const timer = setTimeout(() => {
          if (abort.signal.aborted) return;
          timedOut = true;
          abort.abort();
        }, timeLimitMs);

        try {
          const params = z.object({ agentId: z.string().uuid() }).safeParse(request.params);
          if (!params.success) return reply.status(400).send(validationFailure(params.error));
          const body = runBodySchema.safeParse(request.body);
          if (!body.success) return reply.status(400).send(validationFailure(body.error));
          const { agentId } = params.data;
          const { orgId } = request.auth!;
          const startedAt = now();

          // 1. The agent, in the caller's organization or not at all.
          const agent = await deps.loadAgent({ orgId, agentId });
          if (!agent) return reply.notFound("Agent not found");

          // 2. The input. Nothing has been counted or charged, and on a
          // refusal nothing will be.
          const check = checkTaskInput(agent, body.data.input);
          if (!check.ok) {
            return reply.status(TASK_REFUSAL_STATUS[check.code]).send({
              error: check.code,
              message: check.message,
              ...(check.code === "input_invalid" && { details: check.details }),
            });
          }

          // 3. The run.
          const { brief, systemAddendum } = buildTaskBrief(agent, check.input);
          const source: AgentChatSource = request.auth!.type === "api_key" ? "api" : "playground";

          const clientGone = () =>
            reply.status(499).send({ error: "ClientClosedRequest", message: CLIENT_GONE });
          const runFailed = (message: string, detail?: Record<string, unknown>) =>
            reply.status(502).send({ error: "run_failed", message, ...detail });
          /** The signal fired: the time limit, or the caller left. */
          const stopped = () => (timedOut ? runFailed(RUN_MESSAGES.timedOut) : clientGone());

          // The statuses and wording the chat routes give these
          // (routes/playground.ts): a run is refused as a chat is.
          const refused = (refusal: AgentChatRefusal) => {
            switch (refusal.kind) {
              case "agent_not_found":
                return reply.notFound("Agent not found");
              case "invalid_request":
              case "model_invalid":
                return reply.badRequest(refusal.message);
              case "not_configured":
                return reply.status(501).send({ error: refusal.code, message: refusal.message });
              case "rate_limited":
                return reply.status(429).send({
                  error: "RateLimitExceeded",
                  message: "Free tier rate limit exceeded. Try again later or use a paid model.",
                  remaining: refusal.limit.remaining,
                  resetAt: refusal.limit.resetAt,
                });
              case "licence_revoked":
                return reply.status(403).send({
                  error: "LicenceRevoked",
                  reason: refusal.revocation,
                  message: licenceRevokedMessage(refusal.listingTitle, refusal.revocation, refusal.token),
                  ...(refusal.token && { tokenSymbol: refusal.token.symbol, mintAddress: refusal.token.mintAddress }),
                });
              case "payment_required":
                return reply.status(402).send({
                  error: "PaymentRequired",
                  message: `"${refusal.listingTitle}" is billed per request by its publisher. This request costs ${(
                    Number(refusal.requiredCents) / 100
                  ).toFixed(4)} USD and your balance is ${(
                    Number(refusal.balanceCents) / 100
                  ).toFixed(2)} USD.`,
                  requiredCents: Number(refusal.requiredCents),
                  balanceCents: Number(refusal.balanceCents),
                });
              case "hosted_model_unavailable":
                return reply.status(503).send({ error: "hosted_model_not_running", message: refusal.message });
              case "shutting_down":
                return reply
                  .status(503)
                  .header("retry-after", "5")
                  .send({ error: "ServiceUnavailable", message: SHUTTING_DOWN });
              case "client_gone":
                return stopped();
            }
          };

          // The charge, if there was one, is already refunded by the service.
          // What the model or its provider said is not shown: a run that
          // failed there is told so in plain words.
          const failed = (failure: AgentChatFailure) => {
            if (failure.code === "client_gone") return stopped();
            if (failure.code === "service_unavailable") {
              return reply
                .status(503)
                .header("retry-after", "5")
                .send({ error: "ServiceUnavailable", message: failure.message });
            }
            return runFailed(
              failure.code === "upstream_timeout" ? RUN_MESSAGES.timedOut : RUN_MESSAGES.failed,
              failure.detail,
            );
          };

          const notAnswered = (result: AgentChatNotAnswered) =>
            result.refusal ? refused(result.refusal) : failed(result.failure);

          const prepared = await prepareAgentChat(
            {
              orgId,
              agent: { id: agent.id },
              caller: "owner",
              source,
              // As a hired job hands its brief to the core
              // (services/buildJobRunnerDeps.ts): the brief is the user turn,
              // and the rules of a job follow the agent's own prompt.
              messages: [{ role: "user", content: brief }],
              systemAddendum,
              maxOutputTokens: TASK_MAX_OUTPUT_TOKENS,
              maxToolRounds: TASK_MAX_TOOL_ROUNDS,
              signal: abort.signal,
              // The run's time limit is the signal above, tools included.
              deadlineMs: null,
            },
            getChatDeps(),
          );

          // The limiter's verdict rides on every answer for a free model,
          // refused or not.
          const limit = prepared.ok
            ? prepared.session.rateLimit
            : prepared.refusal.kind === "rate_limited"
              ? prepared.refusal.limit
              : null;
          if (limit) {
            reply.header("X-RateLimit-Remaining-RPM", limit.remaining.rpm);
            reply.header("X-RateLimit-Remaining-RPD", limit.remaining.rpd);
            reply.header("X-RateLimit-Reset-RPM", limit.resetAt.rpm);
            reply.header("X-RateLimit-Reset-RPD", limit.resetAt.rpd);
          }
          if (!prepared.ok) return refused(prepared.refusal);

          const { session } = prepared;

          if (body.data.stream) {
            const started = await session.stream();
            if (!started.ok) return notAnswered(started);

            // Billing settles only on a result that was produced AND
            // delivered; the time limit stops a stream as a hang-up does.
            const sent = await streamToReply(reply, started.chat, {
              meter: session.meter,
              abort,
              heartbeatMs: RUN_HEARTBEAT_MS,
            });
            if (!sent.started) return stopped();
            if (!sent.outcome.ok) {
              deps.logger?.warn({ agentId, modelId: session.modelId, error: sent.outcome.error }, "Streamed run produced no result");
            }
            return;
          }

          const completed = await session.complete();
          if (!completed.ok) return notAnswered(completed);
          const { result } = completed;

          return {
            output: { format: "text" as const, text: result.content },
            // Every tool the model called and how each call ended.
            toolCalls: result.toolCalls ?? [],
            durationMs: Math.max(0, now() - startedAt),
            // What this run cost a buyer's copy and who it went to; null when
            // nothing was charged.
            billing: session.billing,
          };
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
}
