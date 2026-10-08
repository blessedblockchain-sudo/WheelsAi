/**
 * Composition root for resultDelivery.ts: the organization's alert channel,
 * read scoped to that organization, and the same senders a report uses.
 */

import { prisma as defaultPrisma } from "@wheelsai/db";

import type { UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { isEmailConfigured, sendEmail } from "../email/emailService.js";
import type { ReportChannel } from "./report.js";
import { buildReportDelivery } from "./reportDelivery.js";
import type { ResultDeliveryDeps } from "./resultDelivery.js";

/** The slice of Prisma a delivery reads. */
export interface ResultDeliveryPrisma {
  alertChannel: {
    findFirst(args: {
      where: { id: string; orgId: string };
      select: { id: true; name: true; type: true; isEnabled: true; config: true };
    }): Promise<ReportChannel | null>;
  };
}

export interface BuildResultDeliveryDepsInput {
  prisma?: ResultDeliveryPrisma;
  fetchFn?: typeof fetch;
  /** DNS seam for the SSRF guard; production uses real DNS. */
  guardDeps?: UrlGuardDeps;
  now?: () => Date;
}

export function buildResultDeliveryDeps(input: BuildResultDeliveryDepsInput = {}): ResultDeliveryDeps {
  const prisma = input.prisma ?? (defaultPrisma as unknown as ResultDeliveryPrisma);
  const delivery = buildReportDelivery({
    fetchFn: input.fetchFn,
    guardDeps: input.guardDeps,
    sendEmail,
  });
  return {
    loadAlertChannel: (channelId, orgId) =>
      prisma.alertChannel.findFirst({
        where: { id: channelId, orgId },
        select: { id: true, name: true, type: true, isEnabled: true, config: true },
      }),
    emailConfigured: isEmailConfigured,
    sendToChannel: delivery.sendToChannel,
    sendEmail: delivery.sendEmail,
    now: input.now,
  };
}
