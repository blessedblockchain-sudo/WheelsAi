/**
 * Fine-tuned models: the adapters an organization's training jobs produced,
 * and what it takes to serve one.
 *
 * A FineTunedModel row is written by the training job service when a job is
 * finalised; this file only reads it, deletes it, and prepares a model
 * deployment that serves it (routes/deployments.ts, modelDeploymentLifecycle).
 *
 * SERVING. The deployment is an ordinary vLLM deployment of the base model
 * whose container fetches the adapter archive at start (services/nosana.ts:
 * vllmAdapterJobDefinition). It fetches it from THIS API, not from a
 * presigned object URL: a service deployment is re-listed on a new host days
 * after it was submitted, with the same stored definition and without our
 * submit path running, and a presigned URL would have expired by then. So the
 * URL in the definition never expires. It is signed for one (fine-tuned
 * model, deployment, run generation) and authorised when it is used, by
 * reading the deployment row: still active, still that run, still serving
 * that model. Stopping the deployment is what revokes it.
 *
 * Everything that reaches the job definition is checked against a strict
 * pattern first (assertValidAdapterConfig).
 *
 * A GPU node must be able to reach the address it fetches from, and the
 * bucket the route redirects it to: adapterServingOperatorBlockers says when
 * it cannot, and a deployment is refused before anything is reserved.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { prisma as defaultPrisma } from "@wheelsai/db";

import { nosanaNodesAreLocal } from "../config/nosanaAccess.js";
import { resolveGpuFacingApiUrl } from "../config/training.js";
import { findTrainableModel } from "../config/trainingCatalog.js";
import { classifyGpuFacingUrl, gpuFacingOrigin, gpuFacingRefusal } from "../lib/gpuFacingUrl.js";
import { createLogger } from "../utils/logger.js";
import {
  InvalidAdapterConfigError,
  adapterNameForSlug,
  assertValidAdapterConfig,
  type VllmAdapterConfig,
} from "./nosana.js";
import { MARKETS } from "./nosanaMarkets.js";
import { customS3EndpointOrigin, getObjectStore, type ObjectStore } from "./objectStore.js";

const logger = createLogger("fine-tuned-models");

type Db = typeof defaultPrisma;

/** Where routes/fineTunedModels.ts is mounted (index.ts). */
export const FINE_TUNED_MODELS_PREFIX = "/api/training/fine-tuned-models";

/**
 * Deployment statuses in which a run may fetch its adapter, and which keep a
 * fine-tuned model from being deleted. The same list as ACTIVE_STATUSES in
 * modelDeploymentLifecycle.ts (which imports this file, so it is repeated
 * here and pinned by a test).
 */
export const ADAPTER_SERVING_STATUSES = [
  "pending",
  "building",
  "deploying",
  "provisioning",
  "running",
  "degraded",
];

// ============================================
// The adapter URL
// ============================================

/** What one adapter URL is good for. */
export interface AdapterGrant {
  fineTunedModelId: string;
  deploymentId: string;
  /** Deployment.runGeneration of the run the URL was built for. */
  runGeneration: number;
}

const ADAPTER_GRANT_DOMAIN = "adapter-download-v1";

function adapterGrantMac(grant: AdapterGrant, secret: string): Buffer {
  // The domain string keeps this MAC apart from every other use of the same
  // server secret (sessions, storage transfer tokens).
  return createHmac("sha256", secret)
    .update(
      `${ADAPTER_GRANT_DOMAIN}\n${grant.fineTunedModelId}\n${grant.deploymentId}\n${grant.runGeneration}`,
    )
    .digest();
}

export function signAdapterGrant(grant: AdapterGrant, secret: string): string {
  return adapterGrantMac(grant, secret).toString("hex");
}

/** Constant time. Says only whether the signature is ours for this grant. */
export function verifyAdapterGrant(grant: AdapterGrant, signature: unknown, secret: string): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const presented = Buffer.from(signature, "hex");
  const expected = adapterGrantMac(grant, secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * The URL a deployment's container fetches its adapter from. No expiry: see
 * the file comment. `gpuFacingApiUrl` is the address a GPU node reaches this
 * API at (GPU_FACING_API_URL, else PUBLIC_API_URL).
 */
export function adapterDownloadUrl(gpuFacingApiUrl: string, grant: AdapterGrant, secret: string): string {
  const origin = gpuFacingApiUrl.trim().replace(/\/+$/, "");
  return (
    `${origin}${FINE_TUNED_MODELS_PREFIX}/${grant.fineTunedModelId}/adapter` +
    `?d=${grant.deploymentId}&g=${grant.runGeneration}&sig=${signAdapterGrant(grant, secret)}`
  );
}

// ============================================
// Serving: what a deployment of a fine-tuned model needs
// ============================================

export interface AdapterServingDeps {
  /**
   * Where a container on a GPU node reaches this API: GPU_FACING_API_URL,
   * else PUBLIC_API_URL.
   */
  gpuFacingApiUrl: () => string | undefined;
  /**
   * The "GPU nodes" run on this machine (the development stand-in for
   * Nosana), so a local address is reachable from them.
   */
  gpuNodesAreLocal: () => boolean;
  /**
   * The store the download route reads. With the s3 driver the route
   * redirects the node to the bucket, so a custom S3_ENDPOINT must be
   * reachable too; the local driver's bytes are streamed by the route itself.
   */
  getStore: () => ObjectStore | null;
  /** Signs adapter URLs (JWT_SECRET, under its own domain string). */
  signingSecret: () => string;
  /** GB of GPU memory of a tier, or null for a tier that does not exist. */
  tierVramGb: (tier: string) => number | null;
}

/** Production wiring, read lazily so tests can set the environment first. */
export function buildAdapterServingDeps(): AdapterServingDeps {
  return {
    gpuFacingApiUrl: () => resolveGpuFacingApiUrl(process.env) ?? undefined,
    gpuNodesAreLocal: () => nosanaNodesAreLocal(),
    getStore: () => getObjectStore(),
    signingSecret: () => {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("JWT_SECRET is required to sign adapter download URLs");
      return secret;
    },
    tierVramGb: (tier) => (Object.hasOwn(MARKETS, tier) ? MARKETS[tier]!.vram : null),
  };
}

/**
 * GB of GPU memory planned for SERVING a base model with vLLM, which loads it
 * unquantised in bf16: about 2 GB per billion parameters, plus room for the
 * adapter and the first activations.
 *
 * A PLANNING FIGURE, like every number in config/trainingCatalog.ts: no
 * adapter has been served on a GPU yet.
 */
export function servingVramGbForParams(paramsBillions: number): number {
  return Math.ceil(paramsBillions * 2 + 1);
}

/** The columns of a FineTunedModel a deployment is built from. */
export interface ServableFineTunedModel {
  id: string;
  slug: string;
  baseModelId: string;
  baseModelHfId: string;
  loraR: number;
  adapterSha256: string;
  adapterBytes: bigint;
}

export type AdapterServingRefusal = {
  ok: false;
  status: 400 | 404 | 409 | 503;
  code:
    | "fine_tuned_model_not_found"
    | "fine_tuned_model_not_ready"
    | "engine_not_supported_for_adapters"
    | "unknown_gpu_tier"
    | "tier_too_small_for_serving"
    | "fine_tuned_model_not_servable"
    | AdapterServingOperatorBlocker["code"];
  message: string;
  requiredVramGb?: number;
};

export type AdapterServingResult =
  | { ok: true; fineTunedModel: ServableFineTunedModel; adapterName: string }
  | AdapterServingRefusal;

// A placeholder run for checking a URL's form before any row exists; real
// ids are UUIDs, so they pass whatever this passes.
const PROBE_GRANT: AdapterGrant = {
  fineTunedModelId: "00000000-0000-4000-8000-000000000000",
  deploymentId: "00000000-0000-4000-8000-000000000000",
  runGeneration: 0,
};

/** A platform-side reason no fine-tuned model can be deployed, as the operator reads it. */
export interface AdapterServingOperatorBlocker {
  code:
    | "adapter_download_not_configured"
    | "adapter_download_not_reachable"
    | "adapter_storage_not_reachable";
  message: string;
}

/**
 * Why a GPU node could not fetch an adapter on this deployment, in operator
 * language: the operator view (GET /api/platform/compute) and the start-up
 * log read it, and prepareAdapterServing and adapterForRun refuse on the
 * first entry, so what is refused and what is reported cannot differ.
 * Customers only ever see the code and one calm sentence.
 *
 * `store` is the store the download route reads (the server's own when
 * omitted). Neither "not reachable" blocker applies when the nodes are local.
 */
export function adapterServingOperatorBlockers(
  serving: Pick<AdapterServingDeps, "gpuFacingApiUrl" | "gpuNodesAreLocal" | "getStore">,
  store: ObjectStore | null = serving.getStore(),
): AdapterServingOperatorBlocker[] {
  const blockers: AdapterServingOperatorBlocker[] = [];
  const gpuFacingApiUrl = serving.gpuFacingApiUrl();
  const nodesAreLocal = serving.gpuNodesAreLocal();
  if (!gpuFacingApiUrl) {
    blockers.push({
      code: "adapter_download_not_configured",
      message:
        "Neither GPU_FACING_API_URL nor PUBLIC_API_URL is set, so a GPU node has nowhere to fetch a fine-tuned model's adapter from.",
    });
  } else if (!nodesAreLocal && !classifyGpuFacingUrl(gpuFacingApiUrl).reachable) {
    blockers.push({
      code: "adapter_download_not_reachable",
      message: `A GPU node cannot reach ${gpuFacingOrigin(gpuFacingApiUrl)}, where a deployment fetches its adapter: it is ${gpuFacingRefusal(gpuFacingApiUrl)}. Set GPU_FACING_API_URL (or PUBLIC_API_URL) to a public address.`,
    });
  }
  const redirectOrigin = customS3EndpointOrigin(store);
  if (!nodesAreLocal && redirectOrigin !== null && !classifyGpuFacingUrl(redirectOrigin).reachable) {
    blockers.push({
      code: "adapter_storage_not_reachable",
      message: `A GPU node cannot reach ${gpuFacingOrigin(redirectOrigin)} (S3_ENDPOINT), where the adapter download is redirected: it is ${gpuFacingRefusal(redirectOrigin)}.`,
    });
  }
  return blockers;
}

function adapterConfig(
  serving: AdapterServingDeps,
  gpuFacingApiUrl: string,
  model: ServableFineTunedModel,
  adapterName: string,
  grant: AdapterGrant,
): VllmAdapterConfig {
  return {
    name: adapterName,
    downloadUrl: adapterDownloadUrl(gpuFacingApiUrl, grant, serving.signingSecret()),
    maxRank: model.loraR,
    sha256: model.adapterSha256,
    bytes: Number(model.adapterBytes),
  };
}

/**
 * Decides whether `orgId` may deploy (or restart a deployment of) a
 * fine-tuned model on `gpuTier`, before any row or credit moves. Refusals in
 * order: 404 not found (another organization's model is not found), 409 not
 * ready, 400 engine, 400 tier, 409 not servable, 503 no address a GPU node
 * can fetch the adapter from (not set, or not reachable from a node), 503 a
 * bucket a GPU node cannot reach. Read-only.
 */
export async function prepareAdapterServing(
  deps: { prisma: Pick<Db, "fineTunedModel">; serving: AdapterServingDeps },
  args: { orgId: string; fineTunedModelId: string; engine: string; gpuTier: string },
): Promise<AdapterServingResult> {
  const row = await deps.prisma.fineTunedModel.findFirst({
    where: { id: args.fineTunedModelId, orgId: args.orgId },
    include: { baseModel: { select: { parameters: true, minGpuTier: true } } },
  });
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: "fine_tuned_model_not_found",
      message: "Fine-tuned model not found",
    };
  }
  if (row.status !== "ready") {
    return {
      ok: false,
      status: 409,
      code: "fine_tuned_model_not_ready",
      message: "This fine-tuned model has been deleted and can no longer be deployed.",
    };
  }
  if (args.engine !== "vllm") {
    return {
      ok: false,
      status: 400,
      code: "engine_not_supported_for_adapters",
      message: "A fine-tuned model is served with the vLLM engine only.",
    };
  }

  const tierVram = deps.serving.tierVramGb(args.gpuTier);
  if (tierVram === null) {
    return {
      ok: false,
      status: 400,
      code: "unknown_gpu_tier",
      message: `GPU tier '${args.gpuTier}' is not available`,
    };
  }
  // The larger of the planning figure for the base model's size and the
  // catalog's own minimum tier for it.
  const paramsBillions =
    findTrainableModel(row.baseModelId)?.paramsBillions ??
    (row.baseModel?.parameters ? Number(row.baseModel.parameters) / 1e9 : null);
  const catalogFloor = row.baseModel?.minGpuTier
    ? (deps.serving.tierVramGb(row.baseModel.minGpuTier) ?? 0)
    : 0;
  const requiredVramGb = Math.max(
    paramsBillions !== null ? servingVramGbForParams(paramsBillions) : 0,
    catalogFloor,
  );
  if (tierVram < requiredVramGb) {
    return {
      ok: false,
      status: 400,
      code: "tier_too_small_for_serving",
      message: `Serving a fine-tune of ${row.baseModelId} needs ${requiredVramGb} GB of GPU memory; '${args.gpuTier}' has ${tierVram} GB`,
      requiredVramGb,
    };
  }

  const fineTunedModel: ServableFineTunedModel = {
    id: row.id,
    slug: row.slug,
    baseModelId: row.baseModelId,
    baseModelHfId: row.baseModelHfId,
    loraR: row.loraR,
    adapterSha256: row.adapterSha256,
    adapterBytes: row.adapterBytes,
  };
  const notServable = (message: string): AdapterServingRefusal => ({
    ok: false,
    status: 409,
    code: "fine_tuned_model_not_servable",
    message,
  });
  const adapterName = adapterNameForSlug(row.slug);
  if (!adapterName) {
    return notServable("This fine-tuned model's name cannot be served. Contact support.");
  }

  const gpuFacingApiUrl = deps.serving.gpuFacingApiUrl();
  // One customer sentence for every platform-side reason; which setting is
  // wrong is said to the operator, in the log and in the operator view.
  const unavailable = (code: AdapterServingOperatorBlocker["code"]): AdapterServingRefusal => ({
    ok: false,
    status: 503,
    code,
    message: "Deploying fine-tuned models is temporarily unavailable. Nothing was reserved. Try again later.",
  });
  const blocker = adapterServingOperatorBlockers(deps.serving)[0];
  if (blocker || !gpuFacingApiUrl) {
    const code = blocker?.code ?? "adapter_download_not_configured";
    logger.warn(
      { fineTunedModelId: row.id, code },
      `Fine-tuned model deploy refused: ${blocker?.message ?? "no address a GPU node can fetch the adapter from"}`,
    );
    return unavailable(code);
  }

  // The same check the job definition makes at submit, made here so that a
  // value it would refuse is refused before anything is reserved.
  try {
    assertValidAdapterConfig(
      { hfModelId: row.baseModelHfId },
      adapterConfig(deps.serving, gpuFacingApiUrl, fineTunedModel, adapterName, PROBE_GRANT),
    );
  } catch (err) {
    if (!(err instanceof InvalidAdapterConfigError)) throw err;
    if (err.field === "adapter.downloadUrl") {
      logger.warn(
        { fineTunedModelId: row.id },
        "Fine-tuned model deploy refused: GPU_FACING_API_URL (or PUBLIC_API_URL) is not a plain http(s) address a GPU node can fetch the adapter from",
      );
      return unavailable("adapter_download_not_configured");
    }
    logger.error({ fineTunedModelId: row.id, field: err.field }, "Fine-tuned model is not servable");
    return notServable("This fine-tuned model's stored details cannot be served. Contact support.");
  }

  return { ok: true, fineTunedModel, adapterName };
}

/**
 * The adapter part of one run's job definition. Built on every submit and
 * restart: the URL names the run generation, so a previous run's URL stops
 * working when the run does. Makes the checks of prepareAdapterServing
 * again and throws when the address a GPU node fetches from has gone, or
 * can no longer be reached from a node, since the deployment was accepted.
 */
export function adapterForRun(
  serving: AdapterServingDeps,
  model: ServableFineTunedModel,
  run: { deploymentId: string; runGeneration: number },
): VllmAdapterConfig {
  const gpuFacingApiUrl = serving.gpuFacingApiUrl();
  const adapterName = adapterNameForSlug(model.slug);
  if (!gpuFacingApiUrl || adapterServingOperatorBlockers(serving).length > 0) {
    throw new InvalidAdapterConfigError("adapter.downloadUrl");
  }
  if (!adapterName) throw new InvalidAdapterConfigError("adapter.name");
  return adapterConfig(serving, gpuFacingApiUrl, model, adapterName, {
    fineTunedModelId: model.id,
    deploymentId: run.deploymentId,
    runGeneration: run.runGeneration,
  });
}

/**
 * Inside the transaction that creates or restarts a deployment of a
 * fine-tuned model: confirms the model is still ready AND takes its row lock,
 * so a delete running at the same moment either sees this deployment or makes
 * this return false. False means roll back.
 */
export async function lockReadyFineTunedModel(
  tx: { fineTunedModel: { updateMany: (args: any) => Promise<{ count: number }> } },
  args: { id: string; orgId: string; now: Date },
): Promise<boolean> {
  const locked = await tx.fineTunedModel.updateMany({
    where: { id: args.id, orgId: args.orgId, status: "ready" },
    data: { updatedAt: args.now },
  });
  return locked.count > 0;
}

/** The fine-tuned model was deleted while its deployment was being admitted. */
export class FineTunedModelGoneError extends Error {
  constructor() {
    super("fine_tuned_model_not_ready");
  }
}

// ============================================
// List, detail, delete
// ============================================

export interface FineTunedModelsDeps {
  prisma: Pick<Db, "fineTunedModel" | "deployment" | "$transaction">;
  /** null when object storage is not configured. */
  getStore: () => ObjectStore | null;
  now: () => Date;
}

export interface FineTunedModelView {
  id: string;
  name: string;
  slug: string;
  baseModelId: string;
  baseModelHfId: string;
  baseModelName: string | null;
  method: string;
  loraR: number;
  adapterBytes: number;
  adapterSha256: string;
  metrics: unknown;
  trainingJobId: string;
  trainingJob: { id: string; name: string; status: string; completedAt: Date | null } | null;
  /** Every deployment that names the model, whatever its status. */
  deployments: Array<{ id: string; name: string; slug: string; status: string }>;
  /** How many of them are active: the model cannot be deleted while above 0. */
  activeDeployments: number;
  createdAt: Date;
}

const VIEW_INCLUDE = {
  baseModel: { select: { displayName: true } },
  trainingJob: { select: { id: true, name: true, status: true, completedAt: true } },
  deployments: {
    select: { id: true, name: true, slug: true, status: true },
    orderBy: { createdAt: "desc" as const },
  },
};

function toView(row: any): FineTunedModelView {
  const deployments: FineTunedModelView["deployments"] = (row.deployments ?? []).map((d: any) => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    status: d.status,
  }));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    baseModelId: row.baseModelId,
    baseModelHfId: row.baseModelHfId,
    baseModelName: row.baseModel?.displayName ?? null,
    method: row.method,
    loraR: row.loraR,
    // At most TRAINING_ADAPTER_MAX_BYTES (2 GiB): exact as a number.
    adapterBytes: Number(row.adapterBytes),
    adapterSha256: row.adapterSha256,
    metrics: row.metrics ?? null,
    trainingJobId: row.trainingJobId,
    trainingJob: row.trainingJob
      ? {
          id: row.trainingJob.id,
          name: row.trainingJob.name,
          status: row.trainingJob.status,
          completedAt: row.trainingJob.completedAt ?? null,
        }
      : null,
    deployments,
    activeDeployments: deployments.filter((d) => ADAPTER_SERVING_STATUSES.includes(d.status)).length,
    createdAt: row.createdAt,
  };
}

/** The organization's fine-tuned models, newest first. Deleted ones are gone. */
export async function listFineTunedModels(
  deps: Pick<FineTunedModelsDeps, "prisma">,
  orgId: string,
): Promise<FineTunedModelView[]> {
  const rows = await deps.prisma.fineTunedModel.findMany({
    where: { orgId, status: "ready" },
    include: VIEW_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView);
}

/** One model of `orgId`, or null: another organization's, deleted, or unknown. */
export async function getFineTunedModel(
  deps: Pick<FineTunedModelsDeps, "prisma">,
  args: { orgId: string; id: string },
): Promise<FineTunedModelView | null> {
  const row = await deps.prisma.fineTunedModel.findFirst({
    where: { id: args.id, orgId: args.orgId, status: "ready" },
    include: VIEW_INCLUDE,
  });
  return row ? toView(row) : null;
}

class FineTunedModelInUseError extends Error {
  constructor(readonly deployments: number) {
    super("model_in_use");
  }
}

export type DeleteFineTunedModelResult =
  /** `objectsRemoved` false: the row is deleted, the stored archive is not (logged). */
  | { ok: true; objectsRemoved: boolean }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "model_in_use"; message: string; deployments: number };

/**
 * The objects of a fine-tuned model: its archive, and everything beside it
 * when the archive sits in a directory that belongs to its training job alone
 * (the last path segment is the job's id) - the metrics file is there.
 */
async function removeAdapterObjects(
  store: ObjectStore,
  model: { adapterKey: string; trainingJobId: string },
): Promise<void> {
  const cut = model.adapterKey.lastIndexOf("/");
  const directory = cut > 0 ? model.adapterKey.slice(0, cut) : "";
  if (directory.split("/").pop() === model.trainingJobId) {
    await store.deletePrefix(`${directory}/`);
    return;
  }
  await store.delete(model.adapterKey);
}

/**
 * Deletes a fine-tuned model of `orgId`: refused while an active deployment
 * serves it; then the row is marked deleted (it stays, because stopped
 * deployments and the training job still name it) and its stored objects are
 * removed.
 *
 * The row first, the objects after: an active deployment can never be left
 * pointing at an archive that is gone. The claim and the in-use count share a
 * transaction with the claim FIRST, so it holds the row lock that a
 * deployment being created at the same moment must take
 * (lockReadyFineTunedModel): whichever commits first, the other sees it.
 */
export async function deleteFineTunedModel(
  deps: FineTunedModelsDeps,
  args: { orgId: string; id: string },
): Promise<DeleteFineTunedModelResult> {
  const { prisma } = deps;
  const model = await prisma.fineTunedModel.findFirst({
    where: { id: args.id, orgId: args.orgId, status: "ready" },
    select: { id: true, adapterKey: true, trainingJobId: true },
  });
  const notFound = { ok: false as const, code: "not_found" as const, message: "Fine-tuned model not found" };
  if (!model) return notFound;

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.fineTunedModel.updateMany({
        where: { id: model.id, orgId: args.orgId, status: "ready" },
        // liveSlug cleared: the slug is free for a new model of the same name.
        data: { status: "deleted", liveSlug: null, deletedAt: deps.now() },
      });
      // Another delete won; to this caller the model is already gone.
      if (claimed.count === 0) throw new FineTunedModelGoneError();

      const inUse = await tx.deployment.count({
        where: { fineTunedModelId: model.id, status: { in: ADAPTER_SERVING_STATUSES } },
      });
      if (inUse > 0) throw new FineTunedModelInUseError(inUse);
    });
  } catch (err) {
    if (err instanceof FineTunedModelGoneError) return notFound;
    if (err instanceof FineTunedModelInUseError) {
      return {
        ok: false,
        code: "model_in_use",
        deployments: err.deployments,
        message: `This fine-tuned model is served by ${err.deployments} active deployment${
          err.deployments === 1 ? "" : "s"
        }. Stop ${err.deployments === 1 ? "it" : "them"} first.`,
      };
    }
    throw err;
  }

  // Best effort: the model is deleted either way, and a leftover archive is
  // unreachable (the download route answers only for a ready model).
  let objectsRemoved = false;
  try {
    const store = deps.getStore();
    if (store) {
      await removeAdapterObjects(store, model);
      objectsRemoved = true;
    } else {
      logger.error({ fineTunedModelId: model.id }, "No object store: a deleted model's archive was left in storage");
    }
  } catch (err) {
    logger.error({ err, fineTunedModelId: model.id }, "Failed to remove a deleted model's stored objects");
  }
  return { ok: true, objectsRemoved };
}

// ============================================
// The download, authorised
// ============================================

export interface AdapterDownloadDeps {
  prisma: Pick<Db, "deployment">;
  getStore: () => ObjectStore | null;
  signingSecret: () => string;
}

/** How long the presigned object URL a download is redirected to lives. */
export const ADAPTER_REDIRECT_TTL_SECONDS = 300;

export type AdapterDownload =
  | { ok: true; store: ObjectStore; key: string; bytes: number }
  /** One answer for every refusal; `reason` is for the server's log only. */
  | { ok: false; reason: string };

/**
 * Whether the presenter of `signature` may have the adapter now. The
 * signature first, in constant time, before any lookup; then the deployment
 * row as it is at this moment.
 */
export async function authoriseAdapterDownload(
  deps: AdapterDownloadDeps,
  grant: AdapterGrant,
  signature: unknown,
): Promise<AdapterDownload> {
  if (!verifyAdapterGrant(grant, signature, deps.signingSecret())) {
    return { ok: false, reason: "bad_signature" };
  }
  const deployment = await deps.prisma.deployment.findFirst({
    where: {
      id: grant.deploymentId,
      fineTunedModelId: grant.fineTunedModelId,
      runGeneration: grant.runGeneration,
      status: { in: ADAPTER_SERVING_STATUSES },
    },
    select: {
      orgId: true,
      fineTunedModel: {
        select: { orgId: true, status: true, adapterKey: true, adapterBytes: true },
      },
    },
  });
  if (!deployment) return { ok: false, reason: "no_active_run" };
  const model = deployment.fineTunedModel;
  // The organization is compared too: a deployment row can only name its own
  // organization's model, and this holds even if one ever did not.
  if (!model || model.status !== "ready" || model.orgId !== deployment.orgId) {
    return { ok: false, reason: "model_not_ready" };
  }
  const store = deps.getStore();
  if (!store) return { ok: false, reason: "storage_not_configured" };
  return { ok: true, store, key: model.adapterKey, bytes: Number(model.adapterBytes) };
}
