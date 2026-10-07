/**
 * Composition root for the GPU billing tick (runGpuBillingTick).
 *
 * Wires:
 *   loadRunningDeployments -> model Deployment rows with status 'running' and a
 *                             Nosana deployment id (mock ids never consume a GPU
 *                             and are skipped)
 *   initialiseCursor       -> CAS billedThroughAt null -> now
 *   chargeWindow           -> one prisma.$transaction running chargeGpuWindow
 *                             (cursor CAS -> conditional decrement -> ledger);
 *                             an unpayable window rolls the transaction back and
 *                             is reported as `insufficient_credits`
 *   stopDeployment         -> NosanaClient.stopDeployment (stopAndReclaim),
 *                             then the confirmed stop time is recorded on the
 *                             row (gpuStoppedAt) in its own statement
 *   markStopped...         -> one transaction: CAS running -> stopped (reason
 *                             insufficient_credits), release the admission
 *                             reservation (exactly once, via its own CAS),
 *                             settle the final window - up to the recorded stop
 *                             time - from what is left, drop the nodes
 *   canReach               -> hasAccessMode for the row's access-mode stamp
 *   skipUnreachableWindow  -> CAS the cursor forward with no charge
 *   ensureRunway           -> top the Nosana vault up after a successful charge,
 *                             throttled per deployment across every API replica
 *                             (CAS on runwayCheckedAt)
 */

import type { PrismaClient } from "@prisma/client";

import {
  InsufficientGpuCreditsError,
  chargeGpuWindow,
  type GpuBillingTx,
} from "./gpuBilling.js";
import { getPricePerSecond } from "./computeMetering.js";
import { releaseDeploymentReservation } from "./deploymentCreditGate.js";
import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import { isMockNosanaId } from "./nosanaIds.js";
import type {
  GpuBillingRow,
  GpuBillingTickDeps,
  GpuStopResult,
} from "./runGpuBillingTick.js";

export const GPU_BILLING_STOP_REASON = "insufficient_credits";

interface RunningDeploymentRow {
  id: string;
  orgId: string;
  gpuTier: string;
  replicas: number;
  status: string;
  billedThroughAt: Date | null;
  nosanaJobIds: string[];
  nosanaAccessMode?: string | null;
  runGeneration: number;
  gpuStoppedAt?: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
}

/** Fleet-wide runway claim: not checked yet, or last checked an interval ago. */
type RunwayDue = [{ runwayCheckedAt: null }, { runwayCheckedAt: { lte: Date } }];

interface GpuBillingPrismaSurface {
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  deployment: {
    findMany: (args: {
      where: { status: "running"; nosanaJobIds: { isEmpty: false } };
      select: {
        id: true;
        orgId: true;
        gpuTier: true;
        replicas: true;
        status: true;
        billedThroughAt: true;
        nosanaJobIds: true;
        nosanaAccessMode: true;
        runGeneration: true;
        gpuStoppedAt: true;
        reservationCents: true;
        reservationReleasedAt: true;
      };
      orderBy: { createdAt: "asc" };
    }) => Promise<RunningDeploymentRow[]>;
    updateMany: (args: {
      where: {
        id: string;
        status?: string;
        runGeneration?: number;
        nosanaJobIds?: { has: string };
        billedThroughAt?: Date | null;
        gpuStoppedAt?: null;
        OR?: RunwayDue;
      };
      data: { billedThroughAt?: Date; gpuStoppedAt?: Date; runwayCheckedAt?: Date };
    }) => Promise<{ count: number }>;
  };
}

/** What the finalisation transaction touches (superset of the charge surface). */
interface FinaliseTx extends GpuBillingTx {
  deployment: GpuBillingTx["deployment"] & {
    updateMany(args: {
      where: {
        id: string;
        status?: string;
        runGeneration?: number;
        nosanaJobIds?: { has: string };
        billedThroughAt?: Date | null;
      };
      data: {
        billedThroughAt?: Date;
        status?: string;
        stoppedAt?: Date;
        statusReason?: string;
        vaultReclaimedAt?: Date | null;
      };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: {
        reservationCents: true;
        reservationReleasedAt: true;
        billedThroughAt: true;
        replicas: true;
        gpuTier: true;
        gpuStoppedAt: true;
      };
    }): Promise<{
      reservationCents: bigint | null;
      reservationReleasedAt: Date | null;
      billedThroughAt: Date | null;
      replicas: number;
      gpuTier: string;
      gpuStoppedAt?: Date | null;
    } | null>;
  };
  creditBalance: GpuBillingTx["creditBalance"] & {
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
  };
  agentDeployment: {
    updateMany(args: {
      where: { id: string; reservationReleasedAt: null };
      data: { reservationReleasedAt: Date };
    }): Promise<{ count: number }>;
  };
  deploymentNode: {
    deleteMany(args: { where: { deploymentId: string } }): Promise<{ count: number }>;
  };
}

export interface BuildGpuBillingTickDepsInput {
  prisma: GpuBillingPrismaSurface | Pick<PrismaClient, "$transaction" | "deployment">;
  /**
   * NosanaClient.stopDeployment (stopAndReclaim; throws if the stop failed).
   * `accessMode` is the row's stamp: the stop goes through the credential
   * that created the deployment.
   */
  stopDeployment: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessMode,
  ) => Promise<GpuStopResult>;
  /**
   * NosanaClient.ensureDeploymentRunway. Omit to leave vault funding to the
   * initial deposit. With API-key access it never tops anything up: it
   * answers reason "credits" and the seconds the shared balance would cover.
   */
  ensureRunway?: (args: {
    nosanaDeploymentId: string;
    gpuTier: string;
    replicas: number;
    accessMode?: NosanaAccessMode;
  }) => Promise<{ toppedUp: boolean; runwaySeconds?: number | null; reason?: string }>;
  /**
   * Below this many seconds a credits-mode runway is "short"
   * (NOSANA_VAULT_MIN_RUNWAY_SECONDS). Default 1800.
   */
  minRunwaySeconds?: number;
  /**
   * A credits-mode runway check came back short: nothing was topped up (there
   * is nothing to top up), so an operator has to add credits. At most once per
   * deployment per runway interval, by the same throttle as the check.
   */
  onCreditsRunwayLow?: (info: {
    row: GpuBillingRow;
    runwaySeconds: number;
    minRunwaySeconds: number;
  }) => void;
  /**
   * Whether this process holds the credential for an access mode
   * (NosanaClient.hasAccessMode). A running row whose mode it does not hold is
   * not billed: it can be neither observed nor stopped from here. Omit to
   * treat every row as reachable.
   */
  hasAccessMode?: (mode: NosanaAccessMode) => boolean;
  /**
   * Called once per tick with the rows this process has no credential for
   * (their access mode's key or wallet is not configured here).
   */
  reportAccessModeUnavailable?: GpuBillingTickDeps["reportAccessModeUnavailable"];
  /** Minimum gap between runway checks of one deployment. Default 600s. */
  runwayCheckIntervalMs?: number;
  /** Injectable tier price (USD/second); defaults to the production table. */
  pricePerSecondUsd?: (tier: string) => number;
  /** deployment.stopped webhook for the credit-exhaustion stop. Best effort. */
  emitStopped?: (row: GpuBillingRow, reason: string) => Promise<void>;
  /**
   * Clock. Read AFTER the Nosana stop returns to time the final GPU window, and
   * for the runway throttle. Injectable for tests.
   */
  now?: () => Date;
}

/**
 * Last runway check per deployment, as this process knows it. MODULE scope on
 * purpose: the queue builds fresh deps on every job, so a per-build Map was
 * empty each minute and the throttle never throttled (a Nosana API + RPC round
 * trip per deployment per tick).
 *
 * It is only the fast path. Every API replica runs this worker with its own
 * Map, so the interval is enforced by a CAS on Deployment.runwayCheckedAt (see
 * ensureRunway); the Map just saves that write while this process already
 * knows the answer.
 */
const lastRunwayCheck = new Map<string, number>();
const RUNWAY_MAP_PRUNE_ABOVE = 1_000;

/** Test seam: forget every recorded runway check. */
export function resetRunwayThrottleForTests(): void {
  lastRunwayCheck.clear();
}

/** Test seam: how many deployments the throttle currently remembers. */
export function runwayThrottleSizeForTests(): number {
  return lastRunwayCheck.size;
}

function pruneRunwayChecks(nowMs: number, intervalMs: number): void {
  if (lastRunwayCheck.size <= RUNWAY_MAP_PRUNE_ABOVE) return;
  // Entries older than a few intervals no longer throttle anything.
  for (const [id, at] of lastRunwayCheck) {
    if (nowMs - at > intervalMs * 4) lastRunwayCheck.delete(id);
  }
}

export function buildGpuBillingTickDeps(
  input: BuildGpuBillingTickDepsInput,
): GpuBillingTickDeps {
  const prisma = input.prisma as unknown as GpuBillingPrismaSurface;
  const pricePerSecondUsd = input.pricePerSecondUsd ?? getPricePerSecond;
  const clock = input.now ?? (() => new Date());
  const runwayIntervalMs = input.runwayCheckIntervalMs ?? 600_000;
  const minRunwaySeconds = input.minRunwaySeconds ?? 1_800;

  const deps: GpuBillingTickDeps = {
    loadRunningDeployments: async () => {
      const rows = await prisma.deployment.findMany({
        where: { status: "running", nosanaJobIds: { isEmpty: false } },
        select: {
          id: true,
          orgId: true,
          gpuTier: true,
          replicas: true,
          status: true,
          billedThroughAt: true,
          nosanaJobIds: true,
          nosanaAccessMode: true,
          runGeneration: true,
          gpuStoppedAt: true,
          reservationCents: true,
          reservationReleasedAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.flatMap((r): GpuBillingRow[] => {
        const nosanaDeploymentId = r.nosanaJobIds[0];
        if (!nosanaDeploymentId || isMockNosanaId(nosanaDeploymentId)) return [];
        return [
          {
            id: r.id,
            orgId: r.orgId,
            gpuTier: r.gpuTier,
            replicas: r.replicas,
            status: r.status,
            billedThroughAt: r.billedThroughAt,
            nosanaDeploymentId,
            nosanaAccessMode: rowAccessMode(r.nosanaAccessMode),
            runGeneration: r.runGeneration,
            gpuStoppedAt: r.gpuStoppedAt ?? null,
            reservationCents: r.reservationCents,
            reservationReleasedAt: r.reservationReleasedAt,
          },
        ];
      });
    },

    initialiseCursor: (row, now) =>
      prisma.deployment.updateMany({
        where: {
          id: row.id,
          status: "running",
          runGeneration: row.runGeneration,
          billedThroughAt: null,
        },
        data: { billedThroughAt: now },
      }),

    chargeWindow: async (row, now) => {
      if (row.billedThroughAt === null) return { kind: "cursor_lost" };
      const cursor = row.billedThroughAt;
      // A row whose GPUs are confirmed stopped but which could not be finalised
      // is still `running` here. The org may have added credits since: it is
      // charged up to the stop, never for the time after it.
      const windowEnd = row.gpuStoppedAt && row.gpuStoppedAt < now ? row.gpuStoppedAt : now;
      try {
        const outcome = await prisma.$transaction((tx) =>
          chargeGpuWindow(tx as GpuBillingTx, {
            deploymentId: row.id,
            orgId: row.orgId,
            gpuTier: row.gpuTier,
            replicas: row.replicas,
            billedThroughAt: cursor,
            now: windowEnd,
            mode: "tick",
            pricePerSecondUsd,
          }),
        );
        if (outcome.kind === "charged") {
          return {
            kind: "charged",
            cents: outcome.cents,
            coveredSeconds: outcome.coveredSeconds,
          };
        }
        return outcome;
      } catch (err) {
        if (err instanceof InsufficientGpuCreditsError) {
          return { kind: "insufficient_credits", requiredCents: err.requiredCents };
        }
        throw err;
      }
    },

    stopDeployment: async (row) => {
      const stop = await input.stopDeployment(row.nosanaDeploymentId, row.nosanaAccessMode);
      const alreadyStopped = stop.alreadyStopped === true;
      if (!alreadyStopped) {
        // The GPUs ran until this call returned. Record that now, in its own
        // statement: the finalisation transaction can fail (pool timeout, a
        // worker restart), the row then stays `running`, and the retry a tick
        // later would otherwise end the final window at ITS clock - a minute of
        // GPU time that never ran. Set once per run; best effort (without it
        // the finalisation falls back to its own clock, as before).
        await prisma.deployment
          .updateMany({
            where: {
              id: row.id,
              status: "running",
              runGeneration: row.runGeneration,
              nosanaJobIds: { has: row.nosanaDeploymentId },
              gpuStoppedAt: null,
            },
            data: { gpuStoppedAt: clock() },
          })
          .catch(() => undefined);
      }
      return { reclaimed: stop.reclaimed, alreadyStopped };
    },

    markStoppedForInsufficientCredits: async (row, stop) => {
      const outcome = await prisma.$transaction(async (rawTx) => {
        const tx = rawTx as FinaliseTx;

        // When the GPUs stopped: the recorded time (this tick's stop, or an
        // earlier tick's whose finalisation failed). Only without one is it
        // this call's clock - taken after Nosana confirmed the stop, not at the
        // tick's start, so a slow stop call does not leave its tail unbilled.
        const recorded = (
          await tx.deployment.findUnique({
            where: { id: row.id },
            select: {
              reservationCents: true,
              reservationReleasedAt: true,
              billedThroughAt: true,
              replicas: true,
              gpuTier: true,
              gpuStoppedAt: true,
            },
          })
        )?.gpuStoppedAt;
        const stoppedAt = recorded ?? clock();
        // Nosana had already stopped it and nobody recorded when: the window
        // ends at the cursor rather than at a clock the GPUs never ran to.
        const windowEnd = recorded ?? (stop.alreadyStopped ? null : stoppedAt);

        // Claim the stop. Losing means the status tick / a user already moved
        // the row - they own the release and the final settlement.
        //
        // The claim names the run and the Nosana id that were actually stopped.
        // {id, status: running} alone also matches a run the user restarted
        // while the stop call was in flight: that run would be marked stopped
        // with this one's vault result, lose its hold and its nodes, and keep
        // running on Nosana hidden from billing and from the vault sweep.
        const claimed = await tx.deployment.updateMany({
          where: {
            id: row.id,
            status: "running",
            runGeneration: row.runGeneration,
            nosanaJobIds: { has: row.nosanaDeploymentId },
          },
          data: {
            status: "stopped",
            stoppedAt,
            statusReason: GPU_BILLING_STOP_REASON,
            // Explicit either way: never inherit a stale stamp from an earlier run.
            vaultReclaimedAt: stop.reclaimed ? stoppedAt : null,
          },
        });
        if (claimed.count === 0) return { stopped: false };

        // Everything below reads the row FRESH under the lock the claim just
        // took: a replica change or a concurrent billing tick may have moved
        // the cursor, the replica count or the hold since this tick loaded it.
        const fresh = await tx.deployment.findUnique({
          where: { id: row.id },
          select: {
            reservationCents: true,
            reservationReleasedAt: true,
            billedThroughAt: true,
            replicas: true,
            gpuTier: true,
            gpuStoppedAt: true,
          },
        });

        // Give the admission hold back FIRST so it can cover the final window.
        if (
          fresh?.reservationCents &&
          fresh.reservationCents > 0n &&
          !fresh.reservationReleasedAt
        ) {
          await releaseDeploymentReservation({
            tx: tx as never,
            kind: "model",
            deploymentId: row.id,
            orgId: row.orgId,
            reservationCents: fresh.reservationCents,
            reason: GPU_BILLING_STOP_REASON,
            now: () => stoppedAt,
            onlyIfStatusIn: ["stopped", "failed"],
            onlyIfRunGeneration: row.runGeneration,
          });
        }

        // Settle whatever GPU time is still unbilled, from what the org has.
        if (fresh?.billedThroughAt && windowEnd) {
          const settled = await chargeGpuWindow(tx, {
            deploymentId: row.id,
            orgId: row.orgId,
            gpuTier: fresh.gpuTier,
            replicas: fresh.replicas,
            billedThroughAt: fresh.billedThroughAt,
            now: windowEnd,
            mode: "final",
            pricePerSecondUsd,
          });
          // Cannot happen under the claim's row lock. A stop must not commit
          // with its final window unbilled: roll back, the next tick retries.
          if (settled.kind === "cursor_lost") {
            throw new Error(`GPU billing cursor of deployment ${row.id} moved under its stop claim`);
          }
        }

        await tx.deploymentNode.deleteMany({ where: { deploymentId: row.id } });
        return { stopped: true };
      });

      if (outcome.stopped && input.emitStopped) {
        await input.emitStopped(row, GPU_BILLING_STOP_REASON).catch(() => {});
      }
      return outcome;
    },
  };

  if (input.reportAccessModeUnavailable) {
    deps.reportAccessModeUnavailable = input.reportAccessModeUnavailable;
  }

  const hasAccessMode = input.hasAccessMode;
  if (hasAccessMode) {
    deps.canReach = (row) => hasAccessMode(row.nosanaAccessMode ?? "wallet");
    // Keyed on the cursor as loaded, like every other cursor move: a stopper
    // or another replica's tick that got there first owns the window.
    deps.skipUnreachableWindow = (row, now) =>
      prisma.deployment.updateMany({
        where: {
          id: row.id,
          status: "running",
          runGeneration: row.runGeneration,
          billedThroughAt: row.billedThroughAt,
        },
        data: { billedThroughAt: now },
      });
  }

  const ensureRunway = input.ensureRunway;
  if (ensureRunway) {
    deps.ensureRunway = async (row) => {
      const last = lastRunwayCheck.get(row.id);
      const nowMs = clock().getTime();
      if (last !== undefined && nowMs - last < runwayIntervalMs) {
        return { toppedUp: false };
      }
      // Stamp BEFORE the call: a failing Nosana API must not be hammered once
      // per billing tick for every deployment.
      lastRunwayCheck.set(row.id, nowMs);
      pruneRunwayChecks(nowMs, runwayIntervalMs);
      // Claim the check for the whole fleet. Another replica's worker that took
      // this deployment's check within the interval makes the CAS miss.
      const claimed = await prisma.deployment.updateMany({
        where: {
          id: row.id,
          OR: [
            { runwayCheckedAt: null },
            { runwayCheckedAt: { lte: new Date(nowMs - runwayIntervalMs) } },
          ],
        },
        data: { runwayCheckedAt: new Date(nowMs) },
      });
      if (claimed.count === 0) return { toppedUp: false };
      const runway = await ensureRunway({
        nosanaDeploymentId: row.nosanaDeploymentId,
        gpuTier: row.gpuTier,
        replicas: row.replicas,
        ...(row.nosanaAccessMode ? { accessMode: row.nosanaAccessMode } : {}),
      });
      // Credits: there is no vault to refill, only a shared balance to watch.
      // A short runway is reported, never acted on from here.
      const low =
        runway.reason === "credits" &&
        typeof runway.runwaySeconds === "number" &&
        runway.runwaySeconds < minRunwaySeconds;
      if (low) {
        try {
          input.onCreditsRunwayLow?.({
            row,
            runwaySeconds: runway.runwaySeconds as number,
            minRunwaySeconds,
          });
        } catch {
          // Reporting never fails the billing of the row.
        }
      }
      return { toppedUp: runway.toppedUp, ...(low ? { runwayLow: true } : {}) };
    };
  }

  return deps;
}
