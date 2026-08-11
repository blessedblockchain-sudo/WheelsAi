/**
 * Org ↔ GitHub App installation mapping (W2).
 *
 * Stored on the existing `Integration` model with `type: "github"`. That
 * model's encrypted `accessToken` columns stay UNUSED here on purpose:
 * installation tokens are minted on demand and never persisted, so there
 * is no secret to encrypt — which also sidesteps that model's own broken
 * token crypto entirely.
 *
 * `externalId` holds the installation id. It is not a secret (it appears
 * in a browser query string), but it IS the tenancy key: every webhook
 * resolves its org by looking the installation up here, never by trusting
 * the payload.
 */

import { prisma } from "../lib/prisma.js";

export async function saveInstallation(args: {
  orgId: string;
  installationId: string;
  accountLogin: string;
}): Promise<void> {
  await prisma.integration.upsert({
    where: {
      orgId_type_name: {
        orgId: args.orgId,
        type: "github",
        name: "GitHub App",
      },
    },
    create: {
      orgId: args.orgId,
      type: "github",
      name: "GitHub App",
      externalId: args.installationId,
      externalName: args.accountLogin,
      isConnected: true,
      isEnabled: true,
      config: {},
    },
    update: {
      externalId: args.installationId,
      externalName: args.accountLogin,
      isConnected: true,
      lastError: null,
    },
  });
}

/** installation id → owning org. The tenancy source for every webhook. */
export async function resolveOrgByInstallation(
  installationId: string,
): Promise<string | null> {
  const row = await prisma.integration.findFirst({
    where: { type: "github", externalId: installationId, isConnected: true },
    select: { orgId: true },
  });
  return row?.orgId ?? null;
}

/** The org's installation id, for import-time token minting. */
export async function resolveInstallationForOrg(
  orgId: string,
): Promise<string | null> {
  const row = await prisma.integration.findFirst({
    where: { orgId, type: "github", isConnected: true },
    select: { externalId: true },
  });
  return row?.externalId ?? null;
}

/**
 * Marks an installation disconnected after GitHub says it was deleted or
 * suspended. The row is kept rather than deleted so the disconnection is
 * visible in the UI instead of the integration silently vanishing.
 */
export async function markInstallationRemoved(
  installationId: string,
): Promise<void> {
  await prisma.integration.updateMany({
    where: { type: "github", externalId: installationId },
    data: {
      isConnected: false,
      externalId: null,
      lastError: "Installation removed or suspended on GitHub",
    },
  });
}
