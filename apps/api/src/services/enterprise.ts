import { prisma } from "@wheelsai/db";
import { nanoid } from "nanoid";

// ============================================
// Audit Logging
// ============================================

export interface AuditLogEntry {
  orgId: string;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  status?: "success" | "failure";
  errorMessage?: string;
}

/**
 * Create an audit log entry
 */
export async function createAuditLog(entry: AuditLogEntry) {
  return prisma.auditLog.create({
    data: {
      orgId: entry.orgId,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      details: entry.details,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      status: entry.status || "success",
      errorMessage: entry.errorMessage,
    },
  });
}

/**
 * Get audit logs for an organization
 */
export async function getAuditLogs(
  orgId: string,
  options: {
    action?: string;
    resource?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  } = {}
) {
  const { action, resource, userId, startDate, endDate, page = 1, limit = 50 } = options;

  const where: any = { orgId };

  if (action) where.action = action;
  if (resource) where.resource = resource;
  if (userId) where.userId = userId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get audit log summary (action counts)
 */
export async function getAuditLogSummary(orgId: string, days: number = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const logs = await prisma.auditLog.groupBy({
    by: ["action"],
    where: {
      orgId,
      createdAt: { gte: startDate },
    },
    _count: { action: true },
  });

  return logs.map((l) => ({
    action: l.action,
    count: l._count.action,
  }));
}

// ============================================
// Team Management
// ============================================

/**
 * Create a team invite
 */
/** Roles an invite may grant. Ownership is never handed out by invite. */
export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export async function createTeamInvite(
  orgId: string,
  invitedBy: string,
  rawEmail: string,
  role: string = "member"
) {
  if (!(INVITABLE_ROLES as readonly string[]).includes(role)) {
    throw new Error("Invites can grant the admin or member role only");
  }
  const email = rawEmail.trim().toLowerCase();
  // Check if user is already a member
  const existingUser = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        where: { orgId },
      },
    },
  });

  if (existingUser?.memberships.length) {
    throw new Error("User is already a member of this organization");
  }

  // Check for pending invite
  const existingInvite = await prisma.teamInvite.findFirst({
    where: {
      orgId,
      email,
      status: "pending",
    },
  });

  if (existingInvite) {
    throw new Error("An invite is already pending for this email");
  }

  // Create invite with 7-day expiration
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  return prisma.teamInvite.create({
    data: {
      orgId,
      email,
      role,
      invitedBy,
      token: nanoid(32),
      expiresAt,
    },
  });
}

/**
 * Accept a team invite
 */
export async function acceptTeamInvite(token: string, userId: string) {
  const invite = await prisma.teamInvite.findUnique({
    where: { token },
  });

  if (!invite) {
    throw new Error("Invite not found");
  }

  if (invite.status !== "pending") {
    throw new Error("Invite is no longer valid");
  }

  if (new Date() > invite.expiresAt) {
    await prisma.teamInvite.updateMany({
      where: { id: invite.id, status: "pending" },
      data: { status: "expired" },
    });
    throw new Error("Invite has expired");
  }

  // The invite belongs to the address it was sent to. Before this, anyone
  // holding the link (forwarded, leaked) joined with the invited role.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error(
      `This invite was sent to ${invite.email}. Sign in with that email address to accept it.`
    );
  }

  await prisma.$transaction(async (tx) => {
    // Single use: only the request that flips pending -> accepted proceeds.
    const claimed = await tx.teamInvite.updateMany({
      where: { id: invite.id, status: "pending" },
      data: { status: "accepted", acceptedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new Error("Invite is no longer valid");
    }
    const existing = await tx.orgMember.findFirst({
      where: { orgId: invite.orgId, userId },
    });
    if (!existing) {
      await tx.orgMember.create({
        data: { orgId: invite.orgId, userId, role: invite.role },
      });
    }
    // Holding a link sent to this inbox proves control of the address.
    if (!user.emailVerified) {
      await tx.user.update({ where: { id: userId }, data: { emailVerified: true } });
    }
  });

  return { orgId: invite.orgId, role: invite.role };
}

/**
 * Revoke a team invite
 */
export async function revokeTeamInvite(inviteId: string, orgId: string) {
  const invite = await prisma.teamInvite.findFirst({
    where: { id: inviteId, orgId, status: "pending" },
  });

  if (!invite) {
    throw new Error("Invite not found or already processed");
  }

  return prisma.teamInvite.update({
    where: { id: inviteId },
    data: { status: "revoked" },
  });
}

/**
 * Get pending invites for an organization
 */
export async function getPendingInvites(orgId: string) {
  return prisma.teamInvite.findMany({
    where: { orgId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get team members
 */
export async function getTeamMembers(orgId: string) {
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          walletAddress: true,
          createdAt: true,
        },
      },
    },
  });

  return members.map((m) => ({
    userId: m.userId,
    role: m.role,
    email: m.user.email,
    displayName: m.user.displayName,
    walletAddress: m.user.walletAddress,
    joinedAt: m.user.createdAt,
  }));
}

/**
 * Update member role
 */
export async function updateMemberRole(
  orgId: string,
  userId: string,
  newRole: string,
  updatedBy: string
) {
  // Can't change own role
  if (userId === updatedBy) {
    throw new Error("Cannot change your own role");
  }

  // Check if updater has permission (must be owner or admin)
  const updater = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId: updatedBy },
    },
  });

  if (!updater || !["owner", "admin"].includes(updater.role)) {
    throw new Error("Insufficient permissions");
  }

  // Can't change owner role unless you're the owner
  const target = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId },
    },
  });

  if (target?.role === "owner" && updater.role !== "owner") {
    throw new Error("Only the owner can change the owner role");
  }

  return prisma.orgMember.update({
    where: {
      orgId_userId: { orgId, userId },
    },
    data: { role: newRole },
  });
}

/**
 * Remove team member
 */
export async function removeTeamMember(
  orgId: string,
  userId: string,
  removedBy: string
) {
  // Can't remove yourself
  if (userId === removedBy) {
    throw new Error("Cannot remove yourself from the organization");
  }

  // Check permissions
  const remover = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId: removedBy },
    },
  });

  if (!remover || !["owner", "admin"].includes(remover.role)) {
    throw new Error("Insufficient permissions");
  }

  // Can't remove owner
  const target = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId },
    },
  });

  if (target?.role === "owner") {
    throw new Error("Cannot remove the organization owner");
  }

  return prisma.orgMember.delete({
    where: {
      orgId_userId: { orgId, userId },
    },
  });
}

// ============================================
// SSO Configuration
// ============================================

/**
 * Get SSO configuration
 */
export async function getSsoConfig(orgId: string) {
  return prisma.ssoConfig.findUnique({
    where: { orgId },
    select: {
      provider: true,
      enabled: true,
      samlEntityId: true,
      samlSsoUrl: true,
      oidcClientId: true,
      oidcIssuer: true,
      oidcScopes: true,
      allowedDomains: true,
      autoProvision: true,
      defaultRole: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Configure SAML SSO
 */
export async function configureSamlSso(
  orgId: string,
  config: {
    entityId: string;
    ssoUrl: string;
    certificate: string;
    allowedDomains?: string[];
    autoProvision?: boolean;
    defaultRole?: string;
  }
) {
  return prisma.ssoConfig.upsert({
    where: { orgId },
    create: {
      orgId,
      provider: "saml",
      enabled: true,
      samlEntityId: config.entityId,
      samlSsoUrl: config.ssoUrl,
      samlCertificate: config.certificate,
      allowedDomains: config.allowedDomains || [],
      autoProvision: config.autoProvision ?? true,
      defaultRole: config.defaultRole || "member",
    },
    update: {
      provider: "saml",
      enabled: true,
      samlEntityId: config.entityId,
      samlSsoUrl: config.ssoUrl,
      samlCertificate: config.certificate,
      allowedDomains: config.allowedDomains,
      autoProvision: config.autoProvision,
      defaultRole: config.defaultRole,
    },
  });
}

/**
 * Configure OIDC SSO
 */
export async function configureOidcSso(
  orgId: string,
  config: {
    clientId: string;
    clientSecret: string;
    issuer: string;
    scopes?: string[];
    allowedDomains?: string[];
    autoProvision?: boolean;
    defaultRole?: string;
  }
) {
  // In production, encrypt the client secret
  const encryptedSecret = Buffer.from(config.clientSecret);

  return prisma.ssoConfig.upsert({
    where: { orgId },
    create: {
      orgId,
      provider: "oidc",
      enabled: true,
      oidcClientId: config.clientId,
      oidcClientSecret: encryptedSecret,
      oidcIssuer: config.issuer,
      oidcScopes: config.scopes || ["openid", "profile", "email"],
      allowedDomains: config.allowedDomains || [],
      autoProvision: config.autoProvision ?? true,
      defaultRole: config.defaultRole || "member",
    },
    update: {
      provider: "oidc",
      enabled: true,
      oidcClientId: config.clientId,
      oidcClientSecret: encryptedSecret,
      oidcIssuer: config.issuer,
      oidcScopes: config.scopes,
      allowedDomains: config.allowedDomains,
      autoProvision: config.autoProvision,
      defaultRole: config.defaultRole,
    },
  });
}

/**
 * Disable SSO
 */
export async function disableSso(orgId: string) {
  const config = await prisma.ssoConfig.findUnique({
    where: { orgId },
  });

  if (!config) {
    throw new Error("SSO is not configured");
  }

  return prisma.ssoConfig.update({
    where: { orgId },
    data: { enabled: false },
  });
}

/**
 * Delete SSO configuration
 */
export async function deleteSsoConfig(orgId: string) {
  return prisma.ssoConfig.delete({
    where: { orgId },
  });
}
