/**
 * Production wiring for the operator compute view (routes/platformCompute.ts)
 * and for the "GPU compute" component of the public status page.
 *
 * Everything here reads: the access configuration, the Nosana client's
 * read-only calls (credit balance, wallet balance, market list, deployment
 * list), our own tables and the fine-tuning configuration. Nothing is
 * created, stopped or changed.
 *
 * buildPlatformComputeDeps takes its collaborators as arguments so the wiring
 * is unit tested against a fake Nosana API and an in-memory store.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  getNosanaAccessConfig,
  rowAccessMode,
  type NosanaAccessConfig,
} from "../config/nosanaAccess.js";
import { prisma } from "../lib/prisma.js";
import {
  AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES,
  MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES,
} from "../services/buildDeploymentStatusTickDeps.js";
import { readTrainingOperatorBlockers } from "../services/buildTrainingDeps.js";
import { getNosanaClient, type NosanaClient } from "../services/nosana.js";
import { recentPlacementFailures } from "../services/nosanaPlacementFailures.js";
import {
  PLACEMENT_FAILURE_REASONS,
  type PlacementFailure,
} from "../services/runDeploymentStatusTick.js";
import { MARKETS } from "../services/nosanaMarkets.js";
import { createLogger } from "../utils/logger.js";
import {
  createPlatformComputeRoutes,
  gpuComputeStatus,
  MAX_LISTED,
  type GpuComputeStatus,
  type OpenNosanaRow,
  type PlacementFailureRow,
  type PlatformComputeDeps,
} from "./platformCompute.js";

const logger = createLogger("platform-compute");

/** The NosanaClient calls the view makes. Every one is a read. */
export type PlatformComputeClient = Pick<
  NosanaClient,
  | "getAccessMode"
  | "getNetwork"
  | "hasAccessMode"
  | "getCreditBalance"
  | "minimumDeployCreditsMicroUsd"
  | "getWalletAddress"
  | "getWalletBalance"
  | "getMarketCosts"
  | "listDeployments"
  | "resolveMarketAddress"
>;

type Row = Record<string, any>;

/** The slice of Prisma the view reads. */
export interface PlatformComputePrisma {
  deployment: { findMany(args: any): Promise<Row[]> };
  agentDeployment: { findMany(args: any): Promise<Row[]> };
  trainingJob: { findMany(args: any): Promise<Row[]> };
  openClawDeployment: { findMany(args: any): Promise<Row[]> };
  nosanaOrphanDeployment: { findMany(args: any): Promise<Row[]> };
}

const TRAINING_OPEN_STATUSES = ["pending", "queued", "running"];
const OPENCLAW_OPEN_STATUSES = ["PENDING", "BUILDING", "DEPLOYING", "RUNNING"];

export interface BuildPlatformComputeDepsInput {
  getClient: () => Promise<PlatformComputeClient>;
  prisma: PlatformComputePrisma;
  getAccessConfig: () => NosanaAccessConfig;
  adminKey: () => string | undefined;
  /** What keeps fine-tuning from starting, in operator language. */
  trainingBlockers?: () => Promise<Array<{ code: string; message: string }>>;
  /**
   * The placement failures this process's status worker observed, with
   * Nosana's own message (services/nosanaPlacementFailures.ts). Omit and the
   * view lists the failed rows without detail.
   */
  observedPlacementFailures?: () => PlacementFailure[];
  now?: () => Date;
}

/** How far back the view lists placement failures. */
export const PLACEMENT_FAILURE_WINDOW_MS = 72 * 3_600_000;

export function buildPlatformComputeDeps(input: BuildPlatformComputeDepsInput): PlatformComputeDeps {
  const { prisma: db } = input;

  let client: PlatformComputeClient | null = null;
  const getClient = async (): Promise<PlatformComputeClient> => (client ??= await input.getClient());
  /** The client, or null when it cannot be brought up (the view then states the configuration). */
  const tryClient = async (): Promise<PlatformComputeClient | null> => getClient().catch(() => null);

  return {
    adminKey: input.adminKey,
    now: input.now,
    ...(input.trainingBlockers ? { trainingBlockers: input.trainingBlockers } : {}),
    async loadPlacementFailures() {
      const now = (input.now ?? (() => new Date()))();
      const since = new Date(now.getTime() - PLACEMENT_FAILURE_WINDOW_MS);
      // The durable part: model rows carry the reason code. One more than
      // the ceiling, so the view can say "truncated".
      const rows = await db.deployment.findMany({
        where: {
          status: "failed",
          statusReason: { in: [...PLACEMENT_FAILURE_REASONS] },
          stoppedAt: { gte: since },
        },
        select: { id: true, nosanaJobIds: true, statusReason: true, stoppedAt: true },
        orderBy: { stoppedAt: "desc" },
        take: MAX_LISTED + 1,
      });
      // Nosana's message is only in the memory of the process that saw it.
      const observed = (input.observedPlacementFailures?.() ?? []).filter(
        (failure) => failure.observedAt.getTime() >= since.getTime(),
      );
      const detailOf = new Map<string, string>();
      for (const failure of observed) {
        if (failure.detail && !detailOf.has(`${failure.kind}:${failure.id}:${failure.nosanaDeploymentId}`)) {
          detailOf.set(`${failure.kind}:${failure.id}:${failure.nosanaDeploymentId}`, failure.detail);
        }
      }
      const listed: PlacementFailureRow[] = rows.map((row) => {
        const nosanaDeploymentId = (row.nosanaJobIds as string[] | undefined)?.[0] ?? null;
        return {
          source: "model",
          rowId: row.id as string,
          nosanaDeploymentId,
          reason: row.statusReason as string,
          failedAt: (row.stoppedAt as Date | null) ?? null,
          detail: detailOf.get(`model:${row.id}:${nosanaDeploymentId}`) ?? null,
        };
      });
      // An agent deployment keeps no reason code: only what this process saw.
      for (const failure of observed) {
        if (failure.kind !== "agent") continue;
        listed.push({
          source: "agent",
          rowId: failure.id,
          nosanaDeploymentId: failure.nosanaDeploymentId,
          reason: failure.reason,
          failedAt: failure.observedAt,
          detail: failure.detail ?? null,
        });
      }
      return listed.sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
    },
    async access() {
      const cfg = input.getAccessConfig();
      // What is LOADED decides, not what is configured: the client reports the
      // credentials it actually holds.
      const c = await tryClient();
      return {
        mode: c ? c.getAccessMode() : cfg.primary,
        network: c ? c.getNetwork() : cfg.network,
        hasWallet: c ? c.hasAccessMode("wallet") : cfg.hasWallet,
        hasApiKey: c ? c.hasAccessMode("api_key") : cfg.hasApiKey,
        apiKeySuffix: cfg.apiKeySuffix ?? null,
        minCreditsMicroUsd: cfg.minCreditsMicroUsd,
        warnCreditsMicroUsd: cfg.warnCreditsMicroUsd,
        timeoutUnit: cfg.timeoutUnit,
        timeoutUnitExplicit: cfg.timeoutUnitExplicit,
        warnings: cfg.warnings,
      };
    },
    readCredits: async () => (await getClient()).getCreditBalance(),
    minimumDeployCredits: async () => (await getClient()).minimumDeployCreditsMicroUsd(),
    async readWallet() {
      const c = await getClient();
      const publicKey = c.getWalletAddress();
      if (!publicKey) throw new Error("no wallet is loaded");
      return { publicKey, ...(await c.getWalletBalance()) };
    },
    async tiers() {
      const c = await tryClient();
      return Object.entries(MARKETS).map(([tier, market]) => {
        let marketAddress: string | null = null;
        try {
          // Resolved by the client, so the network is the one deploys use.
          marketAddress = c ? c.resolveMarketAddress(tier) : null;
        } catch {
          marketAddress = null;
        }
        return {
          tier,
          name: market.name,
          marketAddress,
          retailPricePerSecond: market.pricePerSecond,
          deployable: marketAddress !== null,
        };
      });
    },
    readMarketCosts: async () => (await getClient()).getMarketCosts(),
    async listNosanaDeployments(mode) {
      return (await (await getClient()).listDeployments(mode)).map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        replicas: d.replicas,
        createdAt: d.createdAt,
        accessMode: d.accessMode,
      }));
    },
    async findTrackedIds(nosanaIds) {
      if (nosanaIds.length === 0) return new Set();
      const [models, agents, training, openclaw, orphans] = await Promise.all([
        db.deployment.findMany({
          where: { nosanaJobIds: { hasSome: nosanaIds } },
          select: { nosanaJobIds: true },
        }),
        db.agentDeployment.findMany({
          where: { nosanaJobIds: { hasSome: nosanaIds } },
          select: { nosanaJobIds: true },
        }),
        db.trainingJob.findMany({
          where: { nosanaJobId: { in: nosanaIds } },
          select: { nosanaJobId: true },
        }),
        db.openClawDeployment.findMany({
          where: { nosanaJobId: { in: nosanaIds } },
          select: { nosanaJobId: true },
        }),
        db.nosanaOrphanDeployment.findMany({
          where: { nosanaDeploymentId: { in: nosanaIds } },
          select: { nosanaDeploymentId: true },
        }),
      ]);
      const tracked = new Set<string>();
      for (const r of [...models, ...agents]) for (const id of r.nosanaJobIds ?? []) tracked.add(id);
      for (const r of [...training, ...openclaw]) if (r.nosanaJobId) tracked.add(r.nosanaJobId);
      for (const r of orphans) tracked.add(r.nosanaDeploymentId);
      return tracked;
    },
    async loadOpenRows() {
      // One more than the ceiling per source, so the view can say "truncated".
      const take = MAX_LISTED + 1;
      const [models, agents, training, openclaw, orphans] = await Promise.all([
        db.deployment.findMany({
          where: {
            nosanaJobIds: { isEmpty: false },
            OR: [
              { status: { in: MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES } },
              { vaultReclaimedAt: null },
            ],
          },
          select: { id: true, status: true, nosanaJobIds: true, nosanaAccessMode: true },
          orderBy: { updatedAt: "desc" },
          take,
        }),
        db.agentDeployment.findMany({
          where: {
            nosanaJobIds: { isEmpty: false },
            status: { in: AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES },
          },
          select: { id: true, status: true, nosanaJobIds: true, nosanaAccessMode: true },
          take,
        }),
        db.trainingJob.findMany({
          where: { nosanaJobId: { not: null }, status: { in: TRAINING_OPEN_STATUSES } },
          select: { id: true, status: true, nosanaJobId: true, nosanaAccessMode: true },
          take,
        }),
        db.openClawDeployment.findMany({
          where: { nosanaJobId: { not: null }, status: { in: OPENCLAW_OPEN_STATUSES } },
          select: { id: true, status: true, nosanaJobId: true, nosanaAccessMode: true },
          take,
        }),
        db.nosanaOrphanDeployment.findMany({
          where: { reclaimedAt: null },
          select: { id: true, nosanaDeploymentId: true, accessMode: true },
          orderBy: { createdAt: "desc" },
          take,
        }),
      ]);
      const rows: OpenNosanaRow[] = [];
      const add = (
        source: OpenNosanaRow["source"],
        rowId: string,
        nosanaId: unknown,
        stamp: unknown,
        status: unknown,
      ) => {
        if (typeof nosanaId !== "string" || nosanaId === "") return;
        rows.push({
          source,
          rowId,
          nosanaDeploymentId: nosanaId,
          accessMode: rowAccessMode(typeof stamp === "string" ? stamp : null),
          status: String(status),
        });
      };
      for (const r of models) add("model", r.id, r.nosanaJobIds?.[0], r.nosanaAccessMode, r.status);
      for (const r of agents) add("agent", r.id, r.nosanaJobIds?.[0], r.nosanaAccessMode, r.status);
      for (const r of training) add("training", r.id, r.nosanaJobId, r.nosanaAccessMode, r.status);
      for (const r of openclaw) add("openclaw", r.id, r.nosanaJobId, r.nosanaAccessMode, r.status);
      for (const r of orphans) add("orphan", r.id, r.nosanaDeploymentId, r.accessMode, "unreleased");
      return rows;
    },
    async loadRunning() {
      const [models, agents] = await Promise.all([
        db.deployment.findMany({
          where: { status: "running", nosanaJobIds: { isEmpty: false } },
          select: { gpuTier: true, replicas: true },
        }),
        db.agentDeployment.findMany({
          where: { status: "running", nosanaJobIds: { isEmpty: false } },
          select: { gpuTier: true, replicas: true },
        }),
      ]);
      return [...models, ...agents].map((r) => ({ gpuTier: r.gpuTier, replicas: r.replicas }));
    },
    reportBelowCost(tiers) {
      logger.error({ tiers }, "GPU tiers are priced below their Nosana cost");
    },
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/platform. */
export function createPlatformComputeRoutesProduction(): FastifyPluginAsync {
  return createPlatformComputeRoutes(
    buildPlatformComputeDeps({
      getClient: getNosanaClient,
      prisma: prisma as unknown as PlatformComputePrisma,
      getAccessConfig: getNosanaAccessConfig,
      // Read per request, so rotating the key needs no reboot.
      adminKey: () => process.env.PLATFORM_ADMIN_KEY,
      trainingBlockers: readTrainingOperatorBlockers,
      observedPlacementFailures: recentPlacementFailures,
    }),
  );
}

/**
 * The public status page's GPU compute probe (routes/status.ts). Null when
 * Nosana access is not configured: the component is then left out.
 */
export function buildGpuComputeProbe(
  getClient: () => Promise<
    Pick<NosanaClient, "getAccessMode" | "getCreditBalance" | "minimumDeployCreditsMicroUsd">
  > = getNosanaClient,
  getAccessConfig: () => Pick<NosanaAccessConfig, "primary" | "minCreditsMicroUsd"> = getNosanaAccessConfig,
): () => Promise<GpuComputeStatus | null> {
  return async () => {
    const cfg = getAccessConfig();
    if (cfg.primary === "none") return null;
    let client: Awaited<ReturnType<typeof getClient>>;
    try {
      client = await getClient();
    } catch {
      // Configured, but the client could not be brought up: deploys would fail too.
      return "paused";
    }
    return gpuComputeStatus({
      mode: () => client.getAccessMode(),
      readCredits: () => client.getCreditBalance(),
      minimumDeployCredits: () => client.minimumDeployCreditsMicroUsd(),
      floorMicroUsd: () => cfg.minCreditsMicroUsd,
    });
  };
}
