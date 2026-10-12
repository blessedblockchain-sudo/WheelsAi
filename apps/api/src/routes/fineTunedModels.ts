/**
 * /api/training/fine-tuned-models
 *
 *   GET    /             the organization's fine-tuned models
 *   GET    /:id          one of them, with the deployments that serve it and
 *                        the record on Nosana of the job that made it
 *   DELETE /:id          409 model_in_use while an active deployment serves it
 *   GET    /:id/adapter  the adapter archive, for a deployment's container
 *
 * The first three take a session and answer only for the caller's own
 * organization: another organization's model is a 404, like one that does not
 * exist.
 *
 * The last takes no session. Its URL is the whole credential: signed for one
 * (fine-tuned model, deployment, run generation), with no expiry, and
 * authorised on every request against the deployment row
 * (services/fineTunedModels.ts: authoriseAdapterDownload). With the s3 driver
 * it redirects to a presigned URL that lives five minutes; with the local
 * driver it streams the object. Every refusal is the same 404: a caller with
 * a bad URL learns nothing about which part was wrong.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

import { prisma as defaultPrisma } from "@wheelsai/db";

import { requireAuth } from "../middleware/auth.js";
import {
  ADAPTER_REDIRECT_TTL_SECONDS,
  authoriseAdapterDownload,
  deleteFineTunedModel,
  getFineTunedModel,
  listFineTunedModels,
  type AdapterDownloadDeps,
  type FineTunedModelsDeps,
} from "../services/fineTunedModels.js";
import { nosanaNetworkOfCredential } from "../services/nosanaExplorer.js";
import { ObjectNotFoundError, getObjectStore } from "../services/objectStore.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("fine-tuned-model-routes");

export interface FineTunedModelRouteDeps extends FineTunedModelsDeps {
  /** Verifies adapter URLs: the secret adapterDownloadUrl signs with. */
  signingSecret: AdapterDownloadDeps["signingSecret"];
}

export function buildFineTunedModelRouteDeps(): FineTunedModelRouteDeps {
  return {
    prisma: defaultPrisma,
    getStore: () => getObjectStore(),
    nosanaNetwork: (credential) => nosanaNetworkOfCredential(credential),
    now: () => new Date(),
    signingSecret: () => {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("JWT_SECRET is required to verify adapter download URLs");
      return secret;
    },
  };
}

const idParams = z.object({ id: z.string().uuid() });
const adapterQuery = z.object({
  d: z.string().uuid(),
  // Digits only: "1e3" and " 1" are not run generations.
  g: z.string().regex(/^(0|[1-9][0-9]{0,8})$/),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

function modelNotFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: "fine_tuned_model_not_found",
    message: "Fine-tuned model not found",
  });
}

export function createFineTunedModelRoutes(deps: FineTunedModelRouteDeps): FastifyPluginAsync {
  // The one answer of the adapter route when it does not serve.
  const adapterNotFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: "not_found", message: "Not found" });

  return async (app) => {
    app.get("/", { preHandler: [requireAuth] }, async (request) => {
      const { orgId } = request.auth!;
      const fineTunedModels = await listFineTunedModels(deps, orgId);
      return { fineTunedModels, total: fineTunedModels.length };
    });

    app.get("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
      const { orgId } = request.auth!;
      const params = idParams.safeParse(request.params);
      if (!params.success) return modelNotFound(reply);
      const fineTunedModel = await getFineTunedModel(deps, { orgId, id: params.data.id });
      if (!fineTunedModel) return modelNotFound(reply);
      return { fineTunedModel };
    });

    app.delete("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
      const { orgId } = request.auth!;
      const params = idParams.safeParse(request.params);
      if (!params.success) return modelNotFound(reply);
      const result = await deleteFineTunedModel(deps, { orgId, id: params.data.id });
      if (result.ok) return { deleted: true };
      if (result.code === "not_found") return modelNotFound(reply);
      return reply.status(409).send({
        error: result.code,
        message: result.message,
        deployments: result.deployments,
      });
    });

    app.get("/:id/adapter", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const query = adapterQuery.safeParse(request.query);
      if (!params.success || !query.success) return adapterNotFound(reply);

      const grant = {
        fineTunedModelId: params.data.id,
        deploymentId: query.data.d,
        runGeneration: Number(query.data.g),
      };
      const download = await authoriseAdapterDownload(deps, grant, query.data.sig);
      if (!download.ok) {
        // The reason stays here. Neither the signature nor the URL is logged.
        logger.warn(
          { fineTunedModelId: grant.fineTunedModelId, deploymentId: grant.deploymentId, reason: download.reason },
          "Adapter download refused",
        );
        return adapterNotFound(reply);
      }

      const { store, key } = download;
      const presigned = await store.presignGet(key, ADAPTER_REDIRECT_TTL_SECONDS);
      if (presigned) {
        // The redirect target is a credential of its own: never cached.
        return reply.header("Cache-Control", "no-store").redirect(302, presigned);
      }

      // A driver that cannot presign (local, development): stream it.
      const head = await store.head(key);
      if (!head) {
        logger.error({ fineTunedModelId: grant.fineTunedModelId }, "Adapter archive is missing from storage");
        return adapterNotFound(reply);
      }
      try {
        const stream = await store.getStream(key);
        return reply
          .header("Content-Type", "application/gzip")
          .header("Content-Length", head.size)
          .header("Cache-Control", "no-store")
          .send(stream);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) return adapterNotFound(reply);
        throw err;
      }
    });
  };
}

export function createFineTunedModelRoutesProduction(): FastifyPluginAsync {
  return createFineTunedModelRoutes(buildFineTunedModelRouteDeps());
}
