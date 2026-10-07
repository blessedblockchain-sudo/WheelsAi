/**
 * Composition root for job notifications (services/jobNotifications.ts):
 * the organization's webhooks, and the email provider when one is
 * configured.
 */

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { isEmailConfigured, sendEmail } from "./email/emailService.js";
import { createJobNotifier, type JobEvent, type JobNotifierDeps } from "./jobNotifications.js";
import { triggerWebhook } from "./webhooks.js";

const logger = createLogger("job-notifications");

export function buildJobNotifier(
  overrides: Partial<JobNotifierDeps> = {},
): (event: JobEvent, jobId: string) => Promise<void> {
  return createJobNotifier({
    loadJob: async (jobId) => {
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          offeringId: true,
          buyerId: true,
          publisherId: true,
          status: true,
          priceCents: true,
          deadlineAt: true,
          reviewDeadlineAt: true,
          offering: { select: { title: true } },
        },
      });
      if (!job) return null;
      const { offering, ...rest } = job;
      return { ...rest, title: offering.title };
    },
    sendWebhook: (orgId, event, data, jobId) => triggerWebhook(orgId, event, data, "job", jobId),
    emailConfigured: isEmailConfigured,
    ownerEmail: async (orgId) => {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { owner: { select: { email: true } } },
      });
      return org?.owner.email ?? null;
    },
    sendEmail,
    webUrl: env.PUBLIC_WEB_URL ?? null,
    onError: (what, err) => logger.error({ err, what }, "Job notification failed"),
    ...overrides,
  });
}
