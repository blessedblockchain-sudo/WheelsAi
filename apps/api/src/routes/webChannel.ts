/**
 * /api/channels/web: an owner's web chat keys.
 *
 *   GET    /keys?agentId=&includeRevoked=   the organization's keys
 *   POST   /keys                            create one            owner, admin
 *   PATCH  /keys/:id                        origins, limits, look owner, admin
 *   POST   /keys/:id/rotate                 a new public value    owner, admin
 *   DELETE /keys/:id                        revoke (permanent)    owner, admin
 *
 * Everything is scoped to the caller's organization inside the service
 * (services/webChannel.ts). The public side - what a visitor's browser does
 * with a key - is routes/widget.ts.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import {
  createWebKey,
  createWebKeySchema,
  listWebKeys,
  revokeWebKey,
  rotateWebKey,
  updateWebKey,
  updateWebKeySchema,
  WebChannelError,
  type WebChannelDeps,
} from "../services/webChannel.js";

export interface WebChannelGuards {
  /** Who are you. */
  auth: preHandlerAsyncHookHandler;
  /** May you change the organization's channels: an owner or admin, or an API key. */
  manage: preHandlerAsyncHookHandler;
}

export interface WebChannelRouteDeps {
  channel: WebChannelDeps;
  guards: WebChannelGuards;
}

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  agentId: z.string().uuid().optional(),
  includeRevoked: z.enum(["true", "false"]).optional(),
});

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof WebChannelError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof z.ZodError) {
    return reply.status(400).send({
      error: "invalid_request",
      message: "The request is not valid",
      details: err.issues.map((issue) => ({ path: `/${issue.path.join("/")}`, message: issue.message })),
    });
  }
  throw err;
}

export function createWebChannelRoutes(deps: WebChannelRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const { channel, guards } = deps;
    const manage = [guards.auth, guards.manage];

    app.get("/keys", { preHandler: [guards.auth] }, async (request, reply) => {
      try {
        const query = listQuery.parse(request.query);
        return await listWebKeys(channel, request.auth!.orgId, {
          agentId: query.agentId,
          includeRevoked: query.includeRevoked === "true",
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post("/keys", { preHandler: manage }, async (request, reply) => {
      try {
        const body = createWebKeySchema.parse(request.body);
        const key = await createWebKey(channel, request.auth!.orgId, body);
        return reply.status(201).send({ key });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.patch("/keys/:id", { preHandler: manage }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const body = updateWebKeySchema.parse(request.body);
        return { key: await updateWebKey(channel, request.auth!.orgId, id, body) };
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post("/keys/:id/rotate", { preHandler: manage }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        return { key: await rotateWebKey(channel, request.auth!.orgId, id) };
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.delete("/keys/:id", { preHandler: manage }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        await revokeWebKey(channel, request.auth!.orgId, id);
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}
