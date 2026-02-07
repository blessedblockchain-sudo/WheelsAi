import { prisma } from "@wheelsai/db";
import type { Prisma } from "@wheelsai/db";
import crypto from "crypto";
import dns from "dns/promises";

// Types
export interface CreateDomainInput {
  domain: string;
  targetType: "agent" | "deployment";
  targetId: string;
  forceHttps?: boolean;
  headers?: Record<string, string>;
}

export interface UpdateDomainInput {
  forceHttps?: boolean;
  headers?: Record<string, string>;
  isPrimary?: boolean;
}

export type VerificationStatus = "pending" | "verified" | "failed" | "expired";
export type SslStatus = "pending" | "provisioning" | "active" | "failed" | "expired";

// Helper to parse domain
function parseDomain(domain: string): { subdomain: string | null; rootDomain: string } {
  const parts = domain.toLowerCase().split(".");
  if (parts.length <= 2) {
    return { subdomain: null, rootDomain: domain };
  }
  // Handle common TLDs like .co.uk, .com.au
  const commonSuffixes = ["co.uk", "com.au", "com.br", "co.nz", "co.jp"];
  const lastTwo = parts.slice(-2).join(".");
  if (commonSuffixes.includes(lastTwo)) {
    if (parts.length === 3) {
      return { subdomain: null, rootDomain: domain };
    }
    return {
      subdomain: parts.slice(0, -3).join("."),
      rootDomain: parts.slice(-3).join("."),
    };
  }
  return {
    subdomain: parts.slice(0, -2).join("."),
    rootDomain: parts.slice(-2).join("."),
  };
}

// Generate verification token
function generateVerificationToken(): string {
  return `wheels-verify-${crypto.randomBytes(16).toString("hex")}`;
}

// Create custom domain
export async function createCustomDomain(orgId: string, input: CreateDomainInput) {
  const { domain, targetType, targetId, forceHttps = true, headers } = input;

  // Validate domain format
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain)) {
    throw new Error("Invalid domain format");
  }

  // Check if domain already exists
  const existing = await prisma.customDomain.findUnique({
    where: { domain: domain.toLowerCase() },
  });

  if (existing) {
    throw new Error("Domain already registered");
  }

  // Verify target exists
  if (targetType === "agent") {
    const agent = await prisma.agent.findFirst({
      where: { id: targetId, orgId },
    });
    if (!agent) throw new Error("Agent not found");
  } else if (targetType === "deployment") {
    const deployment = await prisma.deployment.findFirst({
      where: { id: targetId, orgId },
    });
    if (!deployment) throw new Error("Deployment not found");
  }

  const { subdomain, rootDomain } = parseDomain(domain);
  const verificationToken = generateVerificationToken();

  const customDomain = await prisma.customDomain.create({
    data: {
      orgId,
      domain: domain.toLowerCase(),
      subdomain,
      rootDomain,
      targetType,
      targetId,
      verificationToken,
      forceHttps,
      headers: headers as Prisma.InputJsonValue,
    },
  });

  // Log event
  await logDomainEvent(customDomain.id, "created", "Domain created", {
    domain: customDomain.domain,
    targetType,
    targetId,
  });

  return {
    ...customDomain,
    dnsRecords: getDnsInstructions(customDomain),
  };
}

// Get DNS instructions for verification
function getDnsInstructions(domain: {
  domain: string;
  verificationToken: string;
  verificationMethod: string;
}) {
  return {
    txtRecord: {
      name: `_wheels-verification.${domain.domain}`,
      type: "TXT",
      value: domain.verificationToken,
    },
    cnameRecord: {
      name: domain.domain,
      type: "CNAME",
      value: "domains.wheels.ai",
    },
  };
}

// Get custom domains for org
export async function getCustomDomains(
  orgId: string,
  options: {
    targetType?: string;
    targetId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { targetType, targetId, isActive, limit = 20, offset = 0 } = options;

  const where: Prisma.CustomDomainWhereInput = {
    orgId,
    ...(targetType && { targetType }),
    ...(targetId && { targetId }),
    ...(isActive !== undefined && { isActive }),
  };

  const [domains, total] = await Promise.all([
    prisma.customDomain.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.customDomain.count({ where }),
  ]);

  return { domains, total, limit, offset };
}

// Get single domain
export async function getCustomDomain(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  return {
    ...domain,
    dnsRecords: getDnsInstructions(domain),
  };
}

// Get domain by domain name
export async function getCustomDomainByName(domainName: string) {
  return prisma.customDomain.findUnique({
    where: { domain: domainName.toLowerCase() },
  });
}

// Update domain
export async function updateCustomDomain(
  domainId: string,
  orgId: string,
  updates: UpdateDomainInput
) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  // If setting as primary, unset other primary domains for same target
  if (updates.isPrimary) {
    await prisma.customDomain.updateMany({
      where: {
        orgId,
        targetType: domain.targetType,
        targetId: domain.targetId,
        id: { not: domainId },
      },
      data: { isPrimary: false },
    });
  }

  return prisma.customDomain.update({
    where: { id: domainId },
    data: {
      ...(updates.forceHttps !== undefined && { forceHttps: updates.forceHttps }),
      ...(updates.headers && { headers: updates.headers as Prisma.InputJsonValue }),
      ...(updates.isPrimary !== undefined && { isPrimary: updates.isPrimary }),
    },
  });
}

// Delete domain
export async function deleteCustomDomain(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  await prisma.$transaction([
    prisma.domainEvent.deleteMany({ where: { domainId } }),
    prisma.customDomain.delete({ where: { id: domainId } }),
  ]);

  return { success: true };
}

// Verify domain ownership via DNS
export async function verifyDomain(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  await logDomainEvent(domainId, "verification_started", "DNS verification started");

  try {
    // Check TXT record
    const txtRecordName = `_wheels-verification.${domain.domain}`;
    let verified = false;

    try {
      const records = await dns.resolveTxt(txtRecordName);
      const flatRecords = records.flat();
      verified = flatRecords.includes(domain.verificationToken);
    } catch (dnsError: any) {
      if (dnsError.code !== "ENOTFOUND" && dnsError.code !== "ENODATA") {
        throw dnsError;
      }
    }

    if (verified) {
      const updated = await prisma.customDomain.update({
        where: { id: domainId },
        data: {
          verificationStatus: "verified",
          verifiedAt: new Date(),
          lastCheckedAt: new Date(),
          verificationError: null,
        },
      });

      await logDomainEvent(
        domainId,
        "verification_success",
        "Domain verified successfully",
        null,
        "pending",
        "verified"
      );

      // Start SSL provisioning
      await startSslProvisioning(domainId, orgId);

      return {
        verified: true,
        domain: updated,
        message: "Domain verified successfully. SSL certificate provisioning started.",
      };
    } else {
      await prisma.customDomain.update({
        where: { id: domainId },
        data: {
          verificationStatus: "pending",
          lastCheckedAt: new Date(),
          verificationError: "TXT record not found or does not match",
        },
      });

      await logDomainEvent(
        domainId,
        "verification_failed",
        "TXT record not found or does not match"
      );

      return {
        verified: false,
        domain,
        message: "TXT record not found. Please add the DNS record and try again.",
        dnsRecords: getDnsInstructions(domain),
      };
    }
  } catch (error) {
    const errorMessage = (error as Error).message;
    await prisma.customDomain.update({
      where: { id: domainId },
      data: {
        verificationStatus: "failed",
        lastCheckedAt: new Date(),
        verificationError: errorMessage,
      },
    });

    await logDomainEvent(domainId, "verification_failed", errorMessage);

    return {
      verified: false,
      error: errorMessage,
      dnsRecords: getDnsInstructions(domain),
    };
  }
}

// Start SSL provisioning (mock implementation)
async function startSslProvisioning(domainId: string, orgId: string) {
  await prisma.customDomain.update({
    where: { id: domainId },
    data: {
      sslStatus: "provisioning",
      sslProvider: "lets_encrypt",
    },
  });

  await logDomainEvent(
    domainId,
    "ssl_provisioning",
    "SSL certificate provisioning started",
    null,
    "pending",
    "provisioning"
  );

  // In production, this would trigger Let's Encrypt certificate provisioning
  // For now, we simulate completion after verification
  setTimeout(async () => {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90); // 90 days for Let's Encrypt

      await prisma.customDomain.update({
        where: { id: domainId },
        data: {
          sslStatus: "active",
          sslExpiresAt: expiresAt,
          sslError: null,
          isActive: true,
        },
      });

      await logDomainEvent(
        domainId,
        "ssl_provisioned",
        "SSL certificate provisioned successfully",
        { expiresAt },
        "provisioning",
        "active"
      );
    } catch (error) {
      console.error("SSL provisioning error:", error);
    }
  }, 2000);
}

// Activate/deactivate domain
export async function toggleDomain(domainId: string, orgId: string, isActive: boolean) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  // Can only activate if verified and SSL is active
  if (isActive && domain.verificationStatus !== "verified") {
    throw new Error("Domain must be verified before activation");
  }

  if (isActive && domain.sslStatus !== "active") {
    throw new Error("SSL certificate must be active before activation");
  }

  const updated = await prisma.customDomain.update({
    where: { id: domainId },
    data: { isActive },
  });

  await logDomainEvent(
    domainId,
    isActive ? "activated" : "deactivated",
    isActive ? "Domain activated" : "Domain deactivated",
    null,
    domain.isActive.toString(),
    isActive.toString()
  );

  return updated;
}

// Get domain events
export async function getDomainEvents(
  domainId: string,
  orgId: string,
  options: { limit?: number; offset?: number } = {}
) {
  const { limit = 50, offset = 0 } = options;

  // Verify ownership
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  const [events, total] = await Promise.all([
    prisma.domainEvent.findMany({
      where: { domainId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.domainEvent.count({ where: { domainId } }),
  ]);

  return { events, total, limit, offset };
}

// Log domain event
async function logDomainEvent(
  domainId: string,
  eventType: string,
  message: string,
  details?: Record<string, unknown> | null,
  previousStatus?: string,
  newStatus?: string
) {
  return prisma.domainEvent.create({
    data: {
      domainId,
      eventType,
      message,
      details: details as Prisma.InputJsonValue,
      previousStatus,
      newStatus,
    },
  });
}

// Get domain stats
export async function getDomainStats(orgId: string) {
  const [total, verified, active, pending] = await Promise.all([
    prisma.customDomain.count({ where: { orgId } }),
    prisma.customDomain.count({ where: { orgId, verificationStatus: "verified" } }),
    prisma.customDomain.count({ where: { orgId, isActive: true } }),
    prisma.customDomain.count({ where: { orgId, verificationStatus: "pending" } }),
  ]);

  const sslExpiringSoon = await prisma.customDomain.count({
    where: {
      orgId,
      sslStatus: "active",
      sslExpiresAt: {
        lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    },
  });

  return {
    total,
    verified,
    active,
    pending,
    sslExpiringSoon,
  };
}

// Re-verify domain (for expired or failed verifications)
export async function reverifyDomain(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  // Generate new verification token
  const newToken = generateVerificationToken();

  await prisma.customDomain.update({
    where: { id: domainId },
    data: {
      verificationToken: newToken,
      verificationStatus: "pending",
      verificationError: null,
      isActive: false,
    },
  });

  await logDomainEvent(domainId, "reverification_started", "New verification token generated");

  return {
    domain: { ...domain, verificationToken: newToken },
    dnsRecords: getDnsInstructions({ ...domain, verificationToken: newToken }),
  };
}

// Check SSL certificate status
export async function checkSslStatus(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  return {
    sslStatus: domain.sslStatus,
    sslProvider: domain.sslProvider,
    sslExpiresAt: domain.sslExpiresAt,
    sslError: domain.sslError,
    needsRenewal: domain.sslExpiresAt
      ? domain.sslExpiresAt.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000
      : false,
  };
}

// Renew SSL certificate
export async function renewSsl(domainId: string, orgId: string) {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, orgId },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  if (domain.verificationStatus !== "verified") {
    throw new Error("Domain must be verified before SSL renewal");
  }

  await startSslProvisioning(domainId, orgId);

  return { message: "SSL renewal started" };
}
