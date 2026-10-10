/**
 * /api/agents/:agentId/public-link: the owner's switch for the agent's
 * public page, /a/<handle>.
 *
 *   GET  /:agentId/public-link   the link as it is
 *   PUT  /:agentId/public-link   on, paused or off; the daily cap, the
 *                                address, whether results show   owner, admin
 *
 * Both answer { state, handle, url, dailyCap, usedToday, showResults,
 * toolsOffForVisitors }, plus `sale: { paid, listingSlug }` while a published
 * listing sells use of the agent. PUT then answers 409 `sold_as_paid` for
 * "on" while a price is set, and 409 `on_sale_for_use` for "off" (and for
 * "paused" on a free listing). Everything is scoped to the caller's organization
 * inside the service (services/agentPublicLink.ts): another organization's
 * agent is 404. What a visitor does with the page is routes/publicAgent.ts
 * and routes/widget.ts.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validationFailure.js";
import {
  getPublicLink,
  publicLinkBodySchema,
  PublicLinkError,
  setPublicLink,
  type AgentPublicLinkDeps,
} from "../services/agentPublicLink.js";

export interface AgentPublicLinkGuards {
  /** Who are you. */
  auth: preHandlerAsyncHookHandler;
  /** May you open the agent to the public: an owner or admin, or an API key. */
  manage: preHandlerAsyncHookHandler;
}

export interface AgentPublicLinkRouteDeps {
  link: AgentPublicLinkDeps;
  guards: AgentPublicLinkGuards;
}

const agentParams = z.object({ agentId: z.string().uuid() });

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PublicLinkError) {
    return reply.status(err.status).send(err.body ?? { error: err.code, message: err.message });
  }
  if (err instanceof z.ZodError) return reply.status(400).send(validationFailure(err));
  throw err;
}

export function createAgentPublicLinkRoutes(deps: AgentPublicLinkRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const { link, guards } = deps;
    const schema = { tags: ["Agents"] };

    app.get(
      "/:agentId/public-link",
      { preHandler: [guards.auth], schema: { ...schema, description: "An agent's public link" } },
      async (request, reply) => {
        try {
          const { agentId } = agentParams.parse(request.params);
          return await getPublicLink(link, request.auth!.orgId, agentId);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.put(
      "/:agentId/public-link",
      { preHandler: [guards.auth, guards.manage], schema: { ...schema, description: "Turn an agent's public link on, pause it or turn it off" } },
      async (request, reply) => {
        try {
          const { agentId } = agentParams.parse(request.params);
          const body = publicLinkBodySchema.parse(request.body);
          return await setPublicLink(link, request.auth!.orgId, agentId, body);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );
  };
}
