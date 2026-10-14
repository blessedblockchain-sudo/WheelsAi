/**
 * Paid runs of a workflow on sale, by the slug of its listing.
 *
 *   GET  /api/w/:slug           its page, before anyone pays (anyone)
 *   GET  /api/w/:slug/api       its API page (anyone)
 *   GET  /api/w/:slug/access    what the caller may do with it right now
 *   POST /api/w/:slug/run       one paid run: `{ input: { ... } }`
 *
 * The two reads open to anyone are guarded as the agent's public page and
 * its API page are (routes/publicAgent.ts): no sign-in, the global rate
 * limit, and one 404 for every slug that has no page, so nothing tells a
 * draft or an agent's listing from a slug nobody holds. What they say is
 * services/workflowPublicPage.ts.
 *
 * Who: a session, or an API key. To pay a key must have been granted
 * agents:use by name, the scope it pays for an agent with; reading access
 * needs no scope. A paid run is not one of the caller's own API calls
 * (middleware/auth.ts, countsAsApiCall).
 *
 * Everything else is services/paidWorkflow.ts: the order of one paid run,
 * what a buyer is told and what they are never told. This file turns its
 * results into HTTP and adds nothing to them. A run is always answered as
 * one JSON body, after the run ended: the usage headers say what the body's
 * `billing` says, and are set before it.
 */

import type { FastifyError, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

import { TASK_MESSAGES } from "../services/agentTask.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { PaidCaller } from "../services/paidUse.js";
import { getWorkflowAccess, runPaidWorkflow, type PaidWorkflowDeps } from "../services/paidWorkflow.js";
import { setUsageHeaders, usageHeadersOf } from "../services/usageHeaders.js";
import { MAX_WORKFLOW_INPUT_BYTES } from "../services/workflowChat.js";
import {
  readWorkflowPublicSource,
  workflowApiPageOf,
  workflowPublicReadOf,
  type WorkflowPublicPageDeps,
} from "../services/workflowPublicPage.js";
import { sendPaidRefusal, type PaidUseGuards } from "./paidUse.js";
import { paidWorkflowOpenAiModel } from "./paidWorkflowCompletions.js";

/**
 * The parser's own limit on a run's body. Twice the input a run takes: the
 * input's own size is the paid service's to refuse, in its words, and this
 * only stops a body no run could take.
 */
export const PAID_WORKFLOW_BODY_LIMIT_BYTES = 2 * MAX_WORKFLOW_INPUT_BYTES;

export interface PaidWorkflowRouteDeps {
  guards: PaidUseGuards;
  /** Built on first use, so registering the routes opens no connection. */
  paidWorkflow: () => PaidWorkflowDeps;
  /**
   * The reads of the two pages open to anyone, built on first use. When
   * omitted those two routes are not registered.
   */
  publicPage?: () => WorkflowPublicPageDeps;
}

function callerOf(request: FastifyRequest): PaidCaller {
  const auth = request.auth!;
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    type: auth.type,
    apiKeyId: auth.apiKeyId ?? null,
    scopes: auth.scopes ?? [],
  };
}

export function createPaidWorkflowRoutes(deps: PaidWorkflowRouteDeps): FastifyPluginAsync {
  let paidWorkflow: PaidWorkflowDeps | null = null;
  const core = () => (paidWorkflow ??= deps.paidWorkflow());
  let publicPage: WorkflowPublicPageDeps | null = null;
  const { auth, use } = deps.guards;

  return async (app) => {
    // A body over the limit is refused by the parser before the handler
    // runs: for a run that is "your answers are too long". Anything else
    // goes on to the handler this plugin inherited.
    app.setErrorHandler((error: FastifyError, _request, reply: FastifyReply) => {
      if (error.statusCode !== 413) throw error;
      reply.header("cache-control", "no-store");
      return reply.status(413).send({ error: "input_too_large", message: TASK_MESSAGES.inputTooLarge });
    });

    const publicReads = deps.publicPage;
    if (publicReads) {
      const reads = () => (publicPage ??= publicReads());

      // No sign-in: the page is for people who have not started yet.
      app.get<{ Params: { slug: string } }>(
        "/w/:slug",
        { schema: { tags: ["Paid use"], description: "The page of a workflow on sale" } },
        async (request, reply) => {
          const source = await readWorkflowPublicSource(request.params.slug, reads());
          if (!source) return reply.status(404).send({ error: "workflow_not_found" });
          return reply.status(200).send(workflowPublicReadOf(source));
        },
      );

      // The same read, the same 404.
      app.get<{ Params: { slug: string } }>(
        "/w/:slug/api",
        { schema: { tags: ["Paid use"], description: "The API page of a workflow on sale" } },
        async (request, reply) => {
          const read = reads();
          const source = await readWorkflowPublicSource(request.params.slug, read);
          if (!source) return reply.status(404).send({ error: "workflow_not_found" });
          return reply.status(200).send(
            workflowApiPageOf(source, {
              model: paidWorkflowOpenAiModel(source.listing.slug),
              publicApiUrl: read.publicApiUrl ?? null,
            }),
          );
        },
      );
    }

    app.get<{ Params: { slug: string } }>(
      "/w/:slug/access",
      { preHandler: [auth], schema: { tags: ["Paid use"], description: "What the caller may do with a paid workflow" } },
      async (request, reply) => {
        const result = await getWorkflowAccess({ caller: callerOf(request), slug: request.params.slug }, core());
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        reply.header("cache-control", "no-store");
        return reply.status(200).send(result.view);
      },
    );

    app.post<{ Params: { slug: string } }>(
      "/w/:slug/run",
      {
        preHandler: [auth, use],
        bodyLimit: PAID_WORKFLOW_BODY_LIMIT_BYTES,
        schema: { tags: ["Paid use"], description: "Run a workflow you pay to use, on one filled-in form" },
      },
      async (request, reply) => {
        // Wired before the first await: a caller who leaves cancels the run,
        // and whatever was charged goes back.
        const abort = abortOnClientClose(reply.raw);
        const result = await runPaidWorkflow(
          { caller: callerOf(request), slug: request.params.slug, body: request.body, signal: abort.signal },
          core(),
        );
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        // A body is never streamed (the paid service streams only messages
        // that ask for it). Were one ever handed back, its answer is whole
        // and checked: it is delivered as one body, settled as a whole
        // answer is, and its `finished` lets the run go.
        let output = result.kind === "result" ? result.output : null;
        if (result.kind === "stream") {
          let settled = false;
          try {
            await result.meter.settle();
            settled = true;
          } finally {
            await result.finished({ ok: settled });
          }
          output = { format: "text", text: result.text };
        }
        reply.header("cache-control", "no-store");
        setUsageHeaders(reply, usageHeadersOf(result.billing));
        return reply.status(200).send({ output, billing: result.billing });
      },
    );
  };
}
