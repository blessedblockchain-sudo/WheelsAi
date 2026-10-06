import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth, requireJwtAuth, requireRole } from "../middleware/auth.js";
import { prisma } from "@wheelsai/db";
import {
  listContributors,
  addContributor,
  updateContributor,
  removeContributor,
  acceptInvitation,
  declineInvitation,
  listMyContributions,
  normalizeInviteEmail,
  ContributorInviteError,
} from "../services/collaboration.js";

// Contributor shares pay out real money, so adding, changing or removing
// one takes an owner or admin in a signed-in session (never an API key),
// the same bar as requesting a payout.
export const collaborationRoutes: FastifyPluginAsync = async (app) => {
  // The signed-in user's own contributions: invitations and earnings
  app.get(
    "/contributions",
    { preHandler: [requireAuth], schema: { tags: ["Collaboration"], description: "List my contributor invitations and shares" } },
    async (request, reply) => {
      const userId = request.auth!.userId;
      if (!userId) return reply.forbidden("User session required");
      return { contributions: await listMyContributions(userId) };
    }
  );

  // List contributors for an agent
  app.get(
    "/:agentId/contributors",
    { preHandler: [requireAuth], schema: { tags: ["Collaboration"], description: "List agent contributors" } },
    async (request, reply) => {
      const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const orgId = request.auth!.orgId;

      const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId } });
      if (!agent) return reply.notFound("Agent not found");

      const contributors = await listContributors(agentId);
      return { contributors };
    }
  );

  // Add a contributor
  app.post(
    "/:agentId/contributors",
    { preHandler: [requireAuth, requireJwtAuth, requireRole("owner", "admin")], schema: { tags: ["Collaboration"], description: "Invite a contributor to an agent" } },
    async (request, reply) => {
      const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          // Invite by account email (the dashboard) or by user id (API).
          email: z.string().email().optional(),
          userId: z.string().uuid().optional(),
          role: z.enum(["contributor", "reviewer"]).default("contributor"),
          revenueShare: z.number().min(0).max(1).default(0),
        })
        .refine((b) => b.email || b.userId, { message: "email or userId is required" })
        .parse(request.body);

      const orgId = request.auth!.orgId;
      const currentUserId = request.auth!.userId;
      // Inviting a contributor is attributed to the acting user; an API-key
      // principal has no user identity behind it (F4).
      if (!currentUserId) return reply.forbidden("User session required");

      const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId } });
      if (!agent) return reply.notFound("Agent not found");

      // The same answer whether or not the email has an account. The
      // address is never resolved to an account here: the invitation is
      // stored under it and bound when its owner accepts, so neither this
      // response, nor a repeated invite, nor the share check, nor the
      // contributor list can be used to look accounts up.
      const invited = {
        message: "If that address belongs to a WheelsAI account, they can accept the invitation from Revenue & Payouts.",
      };
      // The one address this compares against is the caller's own.
      if (body.userId === undefined) {
        const self = await prisma.user.findUnique({ where: { id: currentUserId }, select: { email: true } });
        if (self?.email && normalizeInviteEmail(self.email) === normalizeInviteEmail(body.email!)) {
          return reply.badRequest("You can't add yourself as a contributor");
        }
      } else if (body.userId === currentUserId) {
        return reply.badRequest("You can't add yourself as a contributor");
      }

      try {
        await addContributor(
          agentId,
          body.userId !== undefined ? { userId: body.userId } : { email: body.email! },
          body.role,
          body.revenueShare,
          currentUserId,
        );
        return reply.status(202).send(invited);
      } catch (err) {
        if (err instanceof ContributorInviteError) return reply.badRequest(err.message);
        throw err;
      }
    }
  );

  // Update a contributor
  app.patch(
    "/:agentId/contributors/:contributorId",
    { preHandler: [requireAuth, requireJwtAuth, requireRole("owner", "admin")], schema: { tags: ["Collaboration"], description: "Update contributor role or revenue share" } },
    async (request, reply) => {
      const { agentId, contributorId } = z
        .object({ agentId: z.string().uuid(), contributorId: z.string().uuid() })
        .parse(request.params);
      const body = z
        .object({
          role: z.enum(["owner", "contributor", "reviewer"]).optional(),
          revenueShare: z.number().min(0).max(1).optional(),
        })
        .parse(request.body);

      const orgId = request.auth!.orgId;
      const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId } });
      if (!agent) return reply.notFound("Agent not found");

      try {
        const contributor = await updateContributor(contributorId, agentId, body);
        return { contributor };
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : "Failed to update");
      }
    }
  );

  // Remove a contributor
  app.delete(
    "/:agentId/contributors/:contributorId",
    { preHandler: [requireAuth, requireJwtAuth, requireRole("owner", "admin")], schema: { tags: ["Collaboration"], description: "Remove a contributor from an agent" } },
    async (request, reply) => {
      const { agentId, contributorId } = z
        .object({ agentId: z.string().uuid(), contributorId: z.string().uuid() })
        .parse(request.params);

      const orgId = request.auth!.orgId;
      const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId } });
      if (!agent) return reply.notFound("Agent not found");

      await removeContributor(contributorId, agentId);
      return { message: "Contributor removed" };
    }
  );

  // Decline an invitation (the invitee only)
  app.post(
    "/:agentId/contributors/:contributorId/decline",
    { preHandler: [requireAuth], schema: { tags: ["Collaboration"], description: "Decline contributor invitation" } },
    async (request, reply) => {
      const { contributorId } = z
        .object({ agentId: z.string().uuid(), contributorId: z.string().uuid() })
        .parse(request.params);
      const userId = request.auth!.userId;
      if (!userId) return reply.forbidden("User session required");
      try {
        return await declineInvitation(contributorId, userId);
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : "Failed to decline");
      }
    }
  );

  // Accept an invitation
  app.post(
    "/:agentId/contributors/:contributorId/accept",
    { preHandler: [requireAuth], schema: { tags: ["Collaboration"], description: "Accept contributor invitation" } },
    async (request, reply) => {
      const { contributorId } = z
        .object({ agentId: z.string().uuid(), contributorId: z.string().uuid() })
        .parse(request.params);

      const userId = request.auth!.userId;
      // Accepting an invitation is a per-user action — an API key cannot be the
      // accepting user (F4).
      if (!userId) return reply.forbidden("User session required");

      try {
        const contributor = await acceptInvitation(contributorId, userId);
        return { contributor, message: "Invitation accepted" };
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : "Failed to accept");
      }
    }
  );
};
