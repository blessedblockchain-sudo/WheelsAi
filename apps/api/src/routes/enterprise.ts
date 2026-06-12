import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import {
  createAuditLog,
  getAuditLogs,
  getAuditLogSummary,
  createTeamInvite,
  acceptTeamInvite,
  revokeTeamInvite,
  getPendingInvites,
  getTeamMembers,
  updateMemberRole,
  removeTeamMember,
  getSsoConfig,
  configureSamlSso,
  configureOidcSso,
  disableSso,
  deleteSsoConfig,
} from "../services/enterprise.js";

export async function enterpriseRoutes(app: FastifyInstance) {
  // All enterprise routes require authentication
  app.addHook("preHandler", authenticate);

  // ============================================
  // Audit Logs
  // ============================================

  // Get audit logs
  app.get("/audit-logs", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const {
      action,
      resource,
      userId,
      startDate,
      endDate,
      page,
      limit,
    } = request.query as {
      action?: string;
      resource?: string;
      userId?: string;
      startDate?: string;
      endDate?: string;
      page?: string;
      limit?: string;
    };

    const result = await getAuditLogs(orgId, {
      action,
      resource,
      userId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 50,
    });

    return reply.send({
      success: true,
      data: result.logs,
      pagination: result.pagination,
    });
  });

  // Get audit log summary
  app.get("/audit-logs/summary", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const summary = await getAuditLogSummary(orgId, days ? parseInt(days) : 30);

    return reply.send({
      success: true,
      data: summary,
    });
  });

  // ============================================
  // Team Management
  // ============================================

  // Get team members
  app.get("/team", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const members = await getTeamMembers(orgId);

    return reply.send({
      success: true,
      data: members,
    });
  });

  // Get pending invites
  app.get("/team/invites", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const invites = await getPendingInvites(orgId);

    return reply.send({
      success: true,
      data: invites,
    });
  });

  // Create team invite
  app.post("/team/invites", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { email, role } = request.body as { email: string; role?: string };

    if (!email) {
      return reply.status(400).send({
        success: false,
        error: "Email is required",
      });
    }

    try {
      const invite = await createTeamInvite(orgId, userId, email, role);

      // Log the action
      await createAuditLog({
        orgId,
        userId,
        action: "invite",
        resource: "team",
        resourceId: invite.id,
        details: { email, role: role || "member" },
      });

      return reply.send({
        success: true,
        data: invite,
        message: "Invite sent successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Revoke team invite
  app.delete("/team/invites/:inviteId", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { inviteId } = request.params as { inviteId: string };

    try {
      await revokeTeamInvite(inviteId, orgId);

      await createAuditLog({
        orgId,
        userId,
        action: "revoke_invite",
        resource: "team",
        resourceId: inviteId,
      });

      return reply.send({
        success: true,
        message: "Invite revoked",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Update member role
  app.patch("/team/:memberId/role", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { memberId } = request.params as { memberId: string };
    const { role } = request.body as { role: string };

    if (!role || !["admin", "member"].includes(role)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid role. Must be 'admin' or 'member'",
      });
    }

    try {
      await updateMemberRole(orgId, memberId, role, userId);

      await createAuditLog({
        orgId,
        userId,
        action: "update_role",
        resource: "team",
        resourceId: memberId,
        details: { newRole: role },
      });

      return reply.send({
        success: true,
        message: "Role updated",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Remove team member
  app.delete("/team/:memberId", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { memberId } = request.params as { memberId: string };

    try {
      await removeTeamMember(orgId, memberId, userId);

      await createAuditLog({
        orgId,
        userId,
        action: "remove_member",
        resource: "team",
        resourceId: memberId,
      });

      return reply.send({
        success: true,
        message: "Member removed",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // SSO Configuration
  // ============================================

  // Get SSO config
  app.get("/sso", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const config = await getSsoConfig(orgId);

    return reply.send({
      success: true,
      data: config,
    });
  });

  // Configure SAML SSO
  app.post("/sso/saml", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { entityId, ssoUrl, certificate, allowedDomains, autoProvision, defaultRole } =
      request.body as {
        entityId: string;
        ssoUrl: string;
        certificate: string;
        allowedDomains?: string[];
        autoProvision?: boolean;
        defaultRole?: string;
      };

    if (!entityId || !ssoUrl || !certificate) {
      return reply.status(400).send({
        success: false,
        error: "entityId, ssoUrl, and certificate are required",
      });
    }

    try {
      const config = await configureSamlSso(orgId, {
        entityId,
        ssoUrl,
        certificate,
        allowedDomains,
        autoProvision,
        defaultRole,
      });

      await createAuditLog({
        orgId,
        userId,
        action: "configure_sso",
        resource: "sso",
        details: { provider: "saml" },
      });

      return reply.send({
        success: true,
        data: {
          provider: config.provider,
          enabled: config.enabled,
        },
        message: "SAML SSO configured successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Configure OIDC SSO
  app.post("/sso/oidc", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { clientId, clientSecret, issuer, scopes, allowedDomains, autoProvision, defaultRole } =
      request.body as {
        clientId: string;
        clientSecret: string;
        issuer: string;
        scopes?: string[];
        allowedDomains?: string[];
        autoProvision?: boolean;
        defaultRole?: string;
      };

    if (!clientId || !clientSecret || !issuer) {
      return reply.status(400).send({
        success: false,
        error: "clientId, clientSecret, and issuer are required",
      });
    }

    try {
      const config = await configureOidcSso(orgId, {
        clientId,
        clientSecret,
        issuer,
        scopes,
        allowedDomains,
        autoProvision,
        defaultRole,
      });

      await createAuditLog({
        orgId,
        userId,
        action: "configure_sso",
        resource: "sso",
        details: { provider: "oidc" },
      });

      return reply.send({
        success: true,
        data: {
          provider: config.provider,
          enabled: config.enabled,
        },
        message: "OIDC SSO configured successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Disable SSO
  app.post("/sso/disable", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };

    try {
      await disableSso(orgId);

      await createAuditLog({
        orgId,
        userId,
        action: "disable_sso",
        resource: "sso",
      });

      return reply.send({
        success: true,
        message: "SSO disabled",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Delete SSO config
  app.delete("/sso", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };

    try {
      await deleteSsoConfig(orgId);

      await createAuditLog({
        orgId,
        userId,
        action: "delete_sso",
        resource: "sso",
      });

      return reply.send({
        success: true,
        message: "SSO configuration deleted",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Accept invite (public route handled separately)
  app.post("/team/invites/:token/accept", async (request, reply) => {
    const { userId } = request.user as { userId: string };
    const { token } = request.params as { token: string };

    try {
      const result = await acceptTeamInvite(token, userId);

      return reply.send({
        success: true,
        data: result,
        message: "Successfully joined the organization",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });
}
