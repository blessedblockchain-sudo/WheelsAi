/**
 * Composition root for the job sweeper (services/runJobSweepTick.ts).
 *
 * Each load is one indexed range scan, oldest first:
 *
 *   expired       status IN (funded, running) AND deadline_at <= now
 *                                              jobs(status, deadline_at)
 *   reviewLapsed  status = submitted AND review_deadline_at <= now
 *                                              jobs(status, review_deadline_at)
 *   staleFunded   status = funded AND funded_at <= cutoff AND deadline_at > now
 *                                              jobs(status, deadline_at)
 *   lapsedLease   status = running AND lease_expires_at <= now AND deadline_at > now
 *                                              jobs(status, lease_expires_at)
 */

import { prisma as defaultPrisma } from "../lib/prisma.js";
import type { EscrowTx } from "./jobEscrow.js";
import type { JobSweepDeps, SweepKind, SweepRow } from "./runJobSweepTick.js";

interface SweepWhere {
  status: string | { in: string[] };
  id?: { notIn: string[] };
  deadlineAt?: { lte: Date } | { gt: Date };
  reviewDeadlineAt?: { lte: Date };
  fundedAt?: { lte: Date };
  leaseExpiresAt?: { lte: Date };
}

interface JobSweepPrisma {
  job: {
    findMany(args: {
      where: SweepWhere;
      orderBy: Record<string, "asc">;
      take: number;
      select: { id: true; publisherId: true };
    }): Promise<SweepRow[]>;
  };
  $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

export function sweepQuery(
  kind: SweepKind,
  now: Date,
  fundedBefore: Date,
): { where: SweepWhere; orderBy: Record<string, "asc"> } {
  switch (kind) {
    case "expired":
      return {
        where: { status: { in: ["funded", "running"] }, deadlineAt: { lte: now } },
        orderBy: { deadlineAt: "asc" },
      };
    case "reviewLapsed":
      return {
        where: { status: "submitted", reviewDeadlineAt: { lte: now } },
        orderBy: { reviewDeadlineAt: "asc" },
      };
    case "staleFunded":
      return {
        where: { status: "funded", fundedAt: { lte: fundedBefore }, deadlineAt: { gt: now } },
        orderBy: { deadlineAt: "asc" },
      };
    case "lapsedLease":
      return {
        where: { status: "running", leaseExpiresAt: { lte: now }, deadlineAt: { gt: now } },
        orderBy: { leaseExpiresAt: "asc" },
      };
  }
}

export function buildJobSweepTickDeps(input: {
  prisma?: JobSweepPrisma;
  enqueue: JobSweepDeps["enqueue"];
  ensurePublisherProfile: JobSweepDeps["ensurePublisherProfile"];
  afterSettle: JobSweepDeps["afterSettle"];
  notify: JobSweepDeps["notify"];
}): JobSweepDeps {
  const prisma = input.prisma ?? (defaultPrisma as unknown as JobSweepPrisma);
  return {
    load: ({ kind, now, fundedBefore, limit, excludeIds }) => {
      const { where, orderBy } = sweepQuery(kind, now, fundedBefore);
      return prisma.job.findMany({
        where: { ...where, ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }) },
        orderBy,
        take: limit,
        select: { id: true, publisherId: true },
      });
    },
    inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as EscrowTx)),
    enqueue: input.enqueue,
    ensurePublisherProfile: input.ensurePublisherProfile,
    afterSettle: input.afterSettle,
    notify: input.notify,
  };
}
