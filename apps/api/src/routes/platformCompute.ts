/**
 * Operator view of the platform's GPU compute account.
 *
 *   GET /api/platform/compute   (mounted with prefix "/api/platform")
 *
 * Gated by PLATFORM_ADMIN_KEY through the x-admin-key header, the way the
 * marketplace curation route is: read at request time so rotating the key
 * needs no reboot, compared in constant time, and an honest 503 when unset.
 *
 * READ-ONLY. It reports what the platform pays Nosana with (wallet or API
 * key), the prepaid credit balance against the floor new deployments need,
 * what each GPU tier costs against what it sells for, what is running, and
 * two lists that need a person:
 *
 *   unreachable   rows that hold a Nosana id created with a credential this
 *                 process does not have. They cannot be stopped, scaled or
 *                 confirmed released from here.
 *   untracked     deployments Nosana reports as starting or running under a
 *                 "wheelsai-" name, older than the grace period, that no row
 *                 and no orphan record knows. Reported only: nothing here
 *                 stops them.
 *   drafts        the same, for deployments Nosana holds as a draft: what a
 *                 create call leaves behind when it threw after Nosana had
 *                 already created the deployment. The name says which row it
 *                 was for.
 *
 * An upstream read that fails does not fail the route: that section says
 * "unreadable" and the rest is still answered.
 *
 * Pure core (computePlatformCompute) with injected IO; production wiring is in
 * platformComputeBindings.ts.
 */

import crypto from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import type {
  NosanaAccessMode,
  NosanaPrimaryMode,
  NosanaTimeoutUnit,
} from "../config/nosanaAccess.js";
import type { CreditBalance } from "../services/nosanaCredits.js";
import type { MarketCost } from "../services/nosanaMarketCosts.js";
import { isMockNosanaId } from "../services/nosanaIds.js";

// ============================================
// Types
// ============================================

/** Every deployment this platform creates on Nosana is named with this prefix. */
export const WHEELSAI_NAME_PREFIX = "wheelsai-";

/** A deployment younger than this may still be between create and its row write. */
export const UNTRACKED_GRACE_MS = 15 * 60_000;

/** Ceiling on each list in the body; `truncated` says when it was hit. */
export const MAX_LISTED = 100;

export type CreditsState = "ok" | "low" | "blocked" | "unreadable" | "not_applicable";
export type SectionState = "ok" | "unreadable" | "not_applicable";

export interface PlatformComputeAccess {
  /** The credential that creates new deployments. */
  mode: NosanaPrimaryMode;
  network: "mainnet" | "devnet";
  hasWallet: boolean;
  hasApiKey: boolean;
  /** Last four characters of the API key. Never the key. */
  apiKeySuffix: string | null;
  minCreditsMicroUsd: bigint;
  warnCreditsMicroUsd: bigint;
  timeoutUnit: NosanaTimeoutUnit;
  timeoutUnitExplicit: boolean;
  /** Boot warnings of the access configuration. Never contain the key. */
  warnings: string[];
}

export interface ComputeTier {
  tier: string;
  name: string;
  /** Null when the tier has no market on this network. */
  marketAddress: string | null;
  /** USD per second per replica, as billed to an organization. */
  retailPricePerSecond: number;
  deployable: boolean;
}

/** One row of Nosana's own deployment list. */
export interface ListedNosanaDeployment {
  id: string;
  name: string;
  status: string;
  replicas: number | null;
  createdAt: Date | null;
  accessMode: NosanaAccessMode;
}

/** A row of ours that still needs Nosana: not ended, or its funding not confirmed released. */
export interface OpenNosanaRow {
  source: "model" | "agent" | "training" | "openclaw" | "orphan";
  rowId: string;
  nosanaDeploymentId: string;
  accessMode: NosanaAccessMode;
  status: string;
}

export interface RunningComputeRow {
  gpuTier: string;
  replicas: number;
}

export interface PlatformComputeDeps {
  /** PLATFORM_ADMIN_KEY, read per request. */
  adminKey: () => string | undefined;
  access: () => Promise<PlatformComputeAccess>;
  /** Prepaid credit balance. Asked only when an API key is loaded. */
  readCredits: () => Promise<CreditBalance>;
  /** What the cheapest new deployment needs available (floor included), or null. */
  minimumDeployCredits: () => Promise<bigint | null>;
  /** Wallet address and balances. Asked only when a wallet is loaded. */
  readWallet: () => Promise<{ publicKey: string; sol: number; nos: number }>;
  tiers: () => Promise<ComputeTier[]>;
  /** Nosana's cost per tier; a tier the market list does not price is null. Throws when unreadable. */
  readMarketCosts: () => Promise<Record<string, MarketCost | null>>;
  /** Nosana's deployment list for one credential. Asked only for loaded credentials. */
  listNosanaDeployments: (mode: NosanaAccessMode) => Promise<ListedNosanaDeployment[]>;
  /** Which of these Nosana ids any row or orphan record holds (ended ones included). */
  findTrackedIds: (nosanaIds: string[]) => Promise<Set<string>>;
  loadOpenRows: () => Promise<OpenNosanaRow[]>;
  loadRunning: () => Promise<RunningComputeRow[]>;
  /** Called with the tiers found priced below cost (the wallet path refuses nothing in a request). */
  reportBelowCost?: (tiers: string[]) => void;
  now?: () => Date;
  /** Ceiling for each upstream read. */
  timeoutMs?: number;
}

export interface PlatformComputeResponse {
  generatedAt: string;
  mode: NosanaPrimaryMode;
  network: "mainnet" | "devnet";
  configured: boolean;
  credentials: { wallet: boolean; apiKey: boolean; apiKeySuffix: string | null };
  timeout: { unit: NosanaTimeoutUnit; explicit: boolean };
  warnings: string[];
  credits: {
    state: CreditsState;
    /** Why the balance is unreadable (an error code), else null. */
    reason: string | null;
    assignedUsd: number | null;
    reservedUsd: number | null;
    settledUsd: number | null;
    availableUsd: number | null;
    /** NOSANA_MIN_CREDITS_USD: what must remain after a deployment's estimate. */
    minRequiredUsd: number;
    /** The floor plus the cheapest deployment's estimate; below it everything is refused. */
    minimumDeployUsd: number | null;
    warnUsd: number;
    checkedAt: string | null;
  };
  wallet: {
    state: "ok" | "unreadable";
    publicKey: string | null;
    sol: number | null;
    nos: number | null;
  } | null;
  marketCosts: { state: "ok" | "unreadable" };
  tiers: Array<{
    tier: string;
    name: string;
    marketAddress: string | null;
    deployable: boolean;
    retailUsdPerHour: number;
    /** Nosana's price with its network fee. Null = cost unknown. */
    costUsdPerHour: number | null;
    marginPct: number | null;
    belowCost: boolean | null;
  }>;
  nosana: {
    state: SectionState;
    accounts: Array<{
      mode: NosanaAccessMode;
      state: "ok" | "unreadable";
      listed: number | null;
      running: number | null;
      error: string | null;
    }>;
    listed: number;
    running: number;
    graceMinutes: number;
    untracked: Array<{
      id: string;
      name: string;
      status: string;
      replicas: number | null;
      createdAt: string | null;
      accessMode: NosanaAccessMode;
      /** The row the name was derived from, when it parses. */
      row: { scope: string; rowId: string; run: number | null } | null;
    }>;
    untrackedTruncated: boolean;
    /** Untracked drafts under our prefix, past the grace period: never started, left by a failed create. */
    untrackedDrafts: PlatformComputeResponse["nosana"]["untracked"];
  };
  running: {
    deployments: number;
    replicas: number;
    retailUsdPerHour: number;
    /** Null when a running tier's cost is unknown. */
    estimatedCostUsdPerHour: number | null;
  };
  unreachable: {
    /** Rows whose access mode has no credential in this process. */
    rows: OpenNosanaRow[];
    truncated: boolean;
  };
  rows: { state: "ok" | "unreadable" };
}

// ============================================
// Pure helpers (exported for tests)
// ============================================

const DEFAULT_TIMEOUT_MS = 20_000;
const MICRO = 1_000_000;

function microToUsd(micro: bigint): number {
  return Number(micro) / MICRO;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Constant-time comparison of the presented admin key with the configured one. */
export function adminKeyMatches(presented: unknown, expected: string): boolean {
  const presentedHash = crypto
    .createHash("sha256")
    .update(typeof presented === "string" ? presented : "")
    .digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Where a balance stands. "blocked": the credit gate refuses every new
 * deployment (below the floor plus the cheapest estimate; below the floor
 * alone when no estimate is known). "low": deployments pass but the operator
 * warning threshold is crossed.
 */
export function classifyCredits(a: {
  availableMicroUsd: bigint;
  minimumDeployMicroUsd: bigint | null;
  floorMicroUsd: bigint;
  warnMicroUsd: bigint;
}): "ok" | "low" | "blocked" {
  if (a.availableMicroUsd < (a.minimumDeployMicroUsd ?? a.floorMicroUsd)) return "blocked";
  if (a.availableMicroUsd < a.warnMicroUsd) return "low";
  return "ok";
}

/**
 * The row a deployment name was derived from: "wheelsai-model-<uuid>-r<run>"
 * (services/modelDeploymentLifecycle.ts) or "wheelsai-<scope>-<uuid>"
 * (wheelsaiDeploymentName). Null for any other name.
 */
export function parseWheelsaiName(
  name: string,
): { scope: string; rowId: string; run: number | null } | null {
  const match =
    /^wheelsai-([a-z0-9]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-r(\d{1,9}))?$/.exec(
      name,
    );
  if (!match) return null;
  return { scope: match[1]!, rowId: match[2]!, run: match[3] !== undefined ? Number(match[3]) : null };
}

/**
 * Deployments Nosana is running (or starting) under our name prefix that
 * nothing of ours tracks. One still inside the grace period may be between
 * its create call and the write of its id, so it is not reported yet; one
 * whose age Nosana does not state is reported (this list stops nothing).
 */
export function findUntracked(
  listed: ListedNosanaDeployment[],
  tracked: ReadonlySet<string>,
  now: Date,
  graceMs: number = UNTRACKED_GRACE_MS,
  statuses: readonly string[] = LIVE_STATUSES,
): ListedNosanaDeployment[] {
  return listed.filter((d) => {
    if (!d.name.startsWith(WHEELSAI_NAME_PREFIX)) return false;
    if (!statuses.includes(d.status)) return false;
    if (tracked.has(d.id)) return false;
    return d.createdAt === null || now.getTime() - d.createdAt.getTime() > graceMs;
  });
}

const LIVE_STATUSES = ["starting", "running"] as const;
const OPEN_STATUSES = [...LIVE_STATUSES, "draft"] as const;

/** Fee-inclusive tier economics. A tier with no known cost has null cost, margin and verdict. */
export function tierEconomics(
  tier: ComputeTier,
  cost: MarketCost | null | undefined,
): PlatformComputeResponse["tiers"][number] {
  const retailUsdPerHour = round(tier.retailPricePerSecond * 3600, 4);
  const base = {
    tier: tier.tier,
    name: tier.name,
    marketAddress: tier.marketAddress,
    deployable: tier.deployable,
    retailUsdPerHour,
  };
  if (!cost) return { ...base, costUsdPerHour: null, marginPct: null, belowCost: null };
  const retailMicroPerSecond = BigInt(Math.round(tier.retailPricePerSecond * MICRO));
  const costUsdPerHour = round((Number(cost.costMicroUsdPerSecond) * 3600) / MICRO, 4);
  return {
    ...base,
    costUsdPerHour,
    marginPct:
      retailUsdPerHour > 0
        ? round(((retailUsdPerHour - costUsdPerHour) / retailUsdPerHour) * 100, 1)
        : null,
    belowCost: retailMicroPerSecond < cost.costMicroUsdPerSecond,
  };
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(run: () => Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  try {
    return { ok: true, value: await withTimeout(run, timeoutMs) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** An error's code when it has one, else a fixed word. Never the message: it may quote upstream text. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : "read_failed";
}

// ============================================
// Computation
// ============================================

export async function computePlatformCompute(
  deps: PlatformComputeDeps,
): Promise<PlatformComputeResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const access = await deps.access();
  const modes: NosanaAccessMode[] = [
    ...(access.hasApiKey ? (["api_key"] as const) : []),
    ...(access.hasWallet ? (["wallet"] as const) : []),
  ];
  const holds = (mode: NosanaAccessMode) => modes.includes(mode);

  // Every read at once; each is settled on its own so one failure costs one section.
  const [credits, minimumDeploy, wallet, costs, lists, openRows, running, tierList] = await Promise.all([
    access.hasApiKey ? settle(deps.readCredits, timeoutMs) : null,
    access.hasApiKey ? settle(deps.minimumDeployCredits, timeoutMs) : null,
    access.hasWallet ? settle(deps.readWallet, timeoutMs) : null,
    settle(deps.readMarketCosts, timeoutMs),
    Promise.all(
      modes.map(async (mode) => ({
        mode,
        result: await settle(() => deps.listNosanaDeployments(mode), timeoutMs),
      })),
    ),
    settle(deps.loadOpenRows, timeoutMs),
    settle(deps.loadRunning, timeoutMs),
    deps.tiers(),
  ]);

  // ---- Credits ---------------------------------------------------------
  const minimumDeployMicroUsd = minimumDeploy?.ok ? minimumDeploy.value : null;
  const creditsBody: PlatformComputeResponse["credits"] = {
    state: "not_applicable",
    reason: null,
    assignedUsd: null,
    reservedUsd: null,
    settledUsd: null,
    availableUsd: null,
    minRequiredUsd: microToUsd(access.minCreditsMicroUsd),
    minimumDeployUsd: minimumDeployMicroUsd !== null ? microToUsd(minimumDeployMicroUsd) : null,
    warnUsd: microToUsd(access.warnCreditsMicroUsd),
    checkedAt: null,
  };
  if (credits) {
    if (credits.ok) {
      const b = credits.value;
      creditsBody.state = classifyCredits({
        availableMicroUsd: b.availableMicroUsd,
        minimumDeployMicroUsd,
        floorMicroUsd: access.minCreditsMicroUsd,
        warnMicroUsd: access.warnCreditsMicroUsd,
      });
      creditsBody.assignedUsd = microToUsd(b.assignedMicroUsd);
      creditsBody.reservedUsd = microToUsd(b.reservedMicroUsd);
      creditsBody.settledUsd = microToUsd(b.settledMicroUsd);
      creditsBody.availableUsd = microToUsd(b.availableMicroUsd);
      creditsBody.checkedAt = b.fetchedAt.toISOString();
    } else {
      creditsBody.state = "unreadable";
      creditsBody.reason = errorCode(credits.error);
    }
  }

  // ---- Wallet ----------------------------------------------------------
  const walletBody: PlatformComputeResponse["wallet"] = wallet
    ? wallet.ok
      ? { state: "ok", publicKey: wallet.value.publicKey, sol: wallet.value.sol, nos: wallet.value.nos }
      : { state: "unreadable", publicKey: null, sol: null, nos: null }
    : null;

  // ---- Tiers -----------------------------------------------------------
  const tiers = tierList.map((tier) => tierEconomics(tier, costs.ok ? costs.value[tier.tier] : null));
  const belowCost = tiers.filter((t) => t.belowCost === true).map((t) => t.tier);
  if (belowCost.length > 0) deps.reportBelowCost?.(belowCost);

  // ---- Nosana's own list -----------------------------------------------
  const accounts: PlatformComputeResponse["nosana"]["accounts"] = lists.map(({ mode, result }) =>
    result.ok
      ? {
          mode,
          state: "ok" as const,
          listed: result.value.length,
          running: result.value.filter((d) => d.status === "running" || d.status === "starting").length,
          error: null,
        }
      : { mode, state: "unreadable" as const, listed: null, running: null, error: errorCode(result.error) },
  );
  const listed = lists.flatMap(({ result }) => (result.ok ? result.value : []));
  let untracked: ListedNosanaDeployment[] = [];
  let untrackedReadable = true;
  // Names first, so the lookup is asked only about deployments that could be ours.
  const candidates = findUntracked(listed, new Set(), now, UNTRACKED_GRACE_MS, OPEN_STATUSES);
  if (candidates.length > 0) {
    const tracked = await settle(
      () => deps.findTrackedIds(candidates.map((d) => d.id)),
      timeoutMs,
    );
    if (tracked.ok) {
      untracked = findUntracked(candidates, tracked.value, now, UNTRACKED_GRACE_MS, OPEN_STATUSES);
    }
    // Without our side of the comparison nothing can be called untracked.
    else untrackedReadable = false;
  }
  const live = untracked.filter((d) => d.status !== "draft");
  const untrackedView = (d: ListedNosanaDeployment) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    replicas: d.replicas,
    createdAt: d.createdAt?.toISOString() ?? null,
    accessMode: d.accessMode,
    row: parseWheelsaiName(d.name),
  });
  const nosanaState: SectionState =
    modes.length === 0
      ? "not_applicable"
      : accounts.some((a) => a.state === "unreadable") || !untrackedReadable
        ? "unreadable"
        : "ok";

  // ---- What is running, by our rows --------------------------------------
  const runningRows = running.ok ? running.value : [];
  const retailByTier = new Map(tiers.map((t) => [t.tier, t]));
  let retailUsdPerHour = 0;
  let costUsdPerHour: number | null = 0;
  for (const row of runningRows) {
    const tier = retailByTier.get(row.gpuTier);
    retailUsdPerHour += (tier?.retailUsdPerHour ?? 0) * row.replicas;
    if (tier?.costUsdPerHour === null || tier?.costUsdPerHour === undefined) costUsdPerHour = null;
    else if (costUsdPerHour !== null) costUsdPerHour += tier.costUsdPerHour * row.replicas;
  }

  // ---- Rows this process cannot reach ------------------------------------
  const unreachable = (openRows.ok ? openRows.value : []).filter(
    (row) => !isMockNosanaId(row.nosanaDeploymentId) && !holds(row.accessMode),
  );

  return {
    generatedAt: now.toISOString(),
    mode: access.mode,
    network: access.network,
    configured: access.mode !== "none",
    credentials: {
      wallet: access.hasWallet,
      apiKey: access.hasApiKey,
      apiKeySuffix: access.apiKeySuffix,
    },
    timeout: { unit: access.timeoutUnit, explicit: access.timeoutUnitExplicit },
    warnings: access.warnings,
    credits: creditsBody,
    wallet: walletBody,
    marketCosts: { state: costs.ok ? "ok" : "unreadable" },
    tiers,
    nosana: {
      state: nosanaState,
      accounts,
      listed: listed.length,
      running: listed.filter((d) => d.status === "running" || d.status === "starting").length,
      graceMinutes: Math.round(UNTRACKED_GRACE_MS / 60_000),
      untracked: live.slice(0, MAX_LISTED).map(untrackedView),
      untrackedTruncated: live.length > MAX_LISTED,
      untrackedDrafts: untracked
        .filter((d) => d.status === "draft")
        .slice(0, MAX_LISTED)
        .map(untrackedView),
    },
    running: {
      deployments: runningRows.length,
      replicas: runningRows.reduce((sum, row) => sum + row.replicas, 0),
      retailUsdPerHour: round(retailUsdPerHour, 4),
      estimatedCostUsdPerHour: costUsdPerHour === null ? null : round(costUsdPerHour, 4),
    },
    unreachable: {
      rows: unreachable.slice(0, MAX_LISTED),
      truncated: unreachable.length > MAX_LISTED,
    },
    rows: { state: openRows.ok && running.ok ? "ok" : "unreadable" },
  };
}

// ============================================
// Public status component
// ============================================

export type GpuComputeStatus = "operational" | "paused";

/**
 * The one thing the public status page says about GPU compute: whether new
 * deployments are being accepted. Null = Nosana access is not configured, and
 * the component is left out. A wallet pays per deployment from its own vault,
 * so there is no shared balance to pause on. With an API key, an unreadable
 * balance pauses (the deploy gate would refuse too).
 */
export async function gpuComputeStatus(deps: {
  mode: () => NosanaPrimaryMode;
  readCredits: () => Promise<Pick<CreditBalance, "availableMicroUsd">>;
  minimumDeployCredits: () => Promise<bigint | null>;
  floorMicroUsd: () => bigint;
}): Promise<GpuComputeStatus | null> {
  const mode = deps.mode();
  if (mode === "none") return null;
  if (mode === "wallet") return "operational";
  try {
    const [balance, minimum] = await Promise.all([deps.readCredits(), deps.minimumDeployCredits()]);
    return balance.availableMicroUsd < (minimum ?? deps.floorMicroUsd()) ? "paused" : "operational";
  } catch {
    return "paused";
  }
}

// ============================================
// Route
// ============================================

export function createPlatformComputeRoutes(deps: PlatformComputeDeps): FastifyPluginAsync {
  return async (app) => {
    app.get(
      "/compute",
      {
        schema: {
          tags: ["Platform"],
          description:
            "Operator view of the platform's GPU compute account (x-admin-key). Read-only.",
        },
      },
      async (request, reply) => {
        const adminKey = deps.adminKey();
        if (!adminKey) {
          return reply.status(503).send({
            error: "platform_admin_not_configured",
            message: "PLATFORM_ADMIN_KEY is not set on this deployment.",
          });
        }
        if (!adminKeyMatches(request.headers["x-admin-key"], adminKey)) {
          return reply.status(401).send({ error: "invalid_admin_key" });
        }
        reply.header("Cache-Control", "no-store");
        return computePlatformCompute(deps);
      },
    );
  };
}
