/**
 * Production wiring for /api/destinations (routes/destinations.ts).
 *
 *   places         the organization's alert channels. A new one is stored
 *                  by services/monitoring.ts createAlertChannel, the same
 *                  function the Monitoring form's route calls. The config
 *                  (the link, the addresses) is read only to recognise the
 *                  member's own email places and never returned.
 *   linkAllowed    the address guard every outbound request passes
 *   loadMember     the signed-in user, as a member of the organization
 *   delivery       the loader and senders a result is delivered with
 *                  (services/scheduledTasks/buildResultDeliveryDeps.ts)
 *
 * buildDestinationsDeps takes its collaborators as arguments so the wiring
 * is unit tested without a database.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { prisma as defaultPrisma } from "../lib/prisma.js";
import { assertUrlAllowed, type UrlGuardDeps } from "../lib/ssrfGuard.js";
import { requireAuth } from "../middleware/auth.js";
import { isEmailConfigured } from "../services/email/emailService.js";
import { buildResultDeliveryDeps } from "../services/scheduledTasks/buildResultDeliveryDeps.js";
import type { ResultDeliveryDeps } from "../services/scheduledTasks/resultDelivery.js";
import { createDestinationsRoutes, type DestinationsRouteDeps, type PlaceConfig, type PlaceRow } from "./destinations.js";

const PLACE_COLUMNS = { id: true, name: true, type: true, isEnabled: true } as const;

/** The slice of Prisma the places are read through. */
export interface DestinationsPrisma {
  alertChannel: {
    findMany(args: {
      where: { orgId: string; type?: string; isEnabled?: boolean };
      orderBy?: { createdAt: "asc" };
      select: typeof PLACE_COLUMNS & { config?: true };
    }): Promise<Array<PlaceRow & { config?: unknown }>>;
  };
  user: {
    findFirst(args: {
      where: { id: string; memberships: { some: { orgId: string } } };
      select: { email: true; emailVerified: true; displayName: true };
    }): Promise<{ email: string | null; emailVerified: boolean; displayName: string | null } | null>;
  };
}

export interface BuildDestinationsDepsInput {
  prisma?: DestinationsPrisma;
  /** Defaults to services/monitoring.ts createAlertChannel, loaded on first use. */
  createAlertChannel?: (
    orgId: string,
    name: string,
    type: "slack" | "discord" | "email",
    config: PlaceConfig,
  ) => Promise<PlaceRow>;
  /** DNS seam for the address guard; production uses real DNS. */
  guardDeps?: UrlGuardDeps;
  emailConfigured?: () => boolean;
  delivery?: () => Pick<ResultDeliveryDeps, "loadAlertChannel" | "sendToChannel" | "sendEmail">;
  auth: preHandlerAsyncHookHandler;
}

/** Whether a stored email config goes to exactly this address and no other. */
export function isOwnEmailConfig(config: unknown, address: string): boolean {
  const emails = typeof config === "object" && config !== null ? (config as { emails?: unknown }).emails : undefined;
  return (
    Array.isArray(emails) &&
    emails.length === 1 &&
    typeof emails[0] === "string" &&
    emails[0].toLowerCase() === address.toLowerCase()
  );
}

export function buildDestinationsDeps(input: BuildDestinationsDepsInput): DestinationsRouteDeps {
  const prisma = input.prisma ?? (defaultPrisma as unknown as DestinationsPrisma);
  const createAlertChannel =
    input.createAlertChannel ??
    (async (orgId, name, type, config) =>
      (await import("../services/monitoring.js")).createAlertChannel(orgId, name, type, config));
  let delivery: ResultDeliveryDeps | null = null;

  return {
    guards: { auth: input.auth },
    places: {
      list: (orgId) =>
        prisma.alertChannel.findMany({ where: { orgId }, orderBy: { createdAt: "asc" }, select: PLACE_COLUMNS }),
      create: async (orgId, place) => {
        const row = await createAlertChannel(orgId, place.name, place.type, place.config);
        // Field by field: the stored row carries its config.
        return { id: row.id, name: row.name, type: row.type, isEnabled: row.isEnabled };
      },
      findEmailPlace: async (orgId, address) => {
        const rows = await prisma.alertChannel.findMany({
          where: { orgId, type: "email", isEnabled: true },
          orderBy: { createdAt: "asc" },
          select: { ...PLACE_COLUMNS, config: true },
        });
        const own = rows.find((row) => isOwnEmailConfig(row.config, address));
        return own ? { id: own.id, name: own.name, type: own.type, isEnabled: own.isEnabled } : null;
      },
      ownEmailPlaceIds: async (orgId, address) => {
        const rows = await prisma.alertChannel.findMany({
          where: { orgId, type: "email" },
          orderBy: { createdAt: "asc" },
          select: { ...PLACE_COLUMNS, config: true },
        });
        return rows.filter((row) => isOwnEmailConfig(row.config, address)).map((row) => row.id);
      },
    },
    loadMember: (userId, orgId) =>
      prisma.user.findFirst({
        where: { id: userId, memberships: { some: { orgId } } },
        select: { email: true, emailVerified: true, displayName: true },
      }),
    linkAllowed: async (link) => (await assertUrlAllowed(link, input.guardDeps)).ok,
    emailConfigured: input.emailConfigured ?? isEmailConfigured,
    delivery: input.delivery ?? (() => (delivery ??= buildResultDeliveryDeps())),
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/destinations. */
export function createDestinationsRoutesProduction(): FastifyPluginAsync {
  return createDestinationsRoutes(buildDestinationsDeps({ auth: requireAuth as preHandlerAsyncHookHandler }));
}
