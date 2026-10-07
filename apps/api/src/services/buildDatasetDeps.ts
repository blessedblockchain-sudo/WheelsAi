/**
 * Composition root for the dataset service (services/dataset.ts): binds its
 * pure core to Prisma, the configured object store and the dataset limits.
 *
 * Everything is resolved per call, not captured at build time, so a process
 * whose storage is not configured still builds its deps and the routes answer
 * the honest 503 themselves.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@wheelsai/db";

import { getTrainingConfig } from "../config/training.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import {
  DatasetNameTakenError,
  FINISHED_TRAINING_JOB_STATUSES,
  type DatasetDb,
  type DatasetDeps,
} from "./dataset.js";
import { getObjectStore, issueTransferUrl } from "./objectStore.js";

type DatasetPrisma = Pick<PrismaClient, "dataset" | "trainingJob">;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

const UNFINISHED = { status: { notIn: [...FINISHED_TRAINING_JOB_STATUSES] } };

/**
 * What a list reads: every column but sampleRows and validationErrors. Those
 * two are JSON written from uploaded content; loading them for every dataset
 * of an organization to drop them again is memory the list has no use for.
 */
export const DATASET_SUMMARY_SELECT = {
  id: true,
  orgId: true,
  name: true,
  description: true,
  storageType: true,
  storageUrl: true,
  format: true,
  fileType: true,
  schemaFormat: true,
  sizeBytes: true,
  rowCount: true,
  rowCountKnown: true,
  avgTokensPerRow: true,
  totalTokens: true,
  contentSha256: true,
  contentEtag: true,
  isValidated: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

/**
 * Prisma behind DatasetDb. Every read and write carries `deletedAt: null`: a
 * soft-deleted dataset cannot be listed, validated or deleted twice.
 */
export function prismaDatasetDb(prisma: DatasetPrisma): DatasetDb {
  return {
    list: (orgId) =>
      prisma.dataset.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: DATASET_SUMMARY_SELECT,
      }),

    find: (orgId, datasetId) =>
      prisma.dataset.findFirst({ where: { id: datasetId, orgId, deletedAt: null } }),

    nameTaken: async (orgId, name) =>
      (await prisma.dataset.findFirst({
        where: { orgId, liveName: name },
        select: { id: true },
      })) !== null,

    create: async (data) => {
      try {
        return await prisma.dataset.create({
          data: {
            ...data,
            // The unique index is on (orgId, liveName).
            liveName: data.name,
            sizeBytes: BigInt(0),
            rowCount: 0,
            isValidated: false,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new DatasetNameTakenError();
        throw err;
      }
    },

    saveValidation: async (orgId, datasetId, update) => {
      const { count } = await prisma.dataset.updateMany({
        where: { id: datasetId, orgId, deletedAt: null },
        data: {
          isValidated: update.isValidated,
          rowCount: update.rowCount,
          rowCountKnown: update.rowCountKnown,
          sizeBytes: update.sizeBytes,
          ...(update.schemaFormat !== undefined ? { schemaFormat: update.schemaFormat } : {}),
          avgTokensPerRow: update.avgTokensPerRow,
          totalTokens: update.totalTokens,
          contentSha256: update.contentSha256,
          contentEtag: update.contentEtag,
          // DbNull, not undefined: a clean validation must clear the errors
          // the previous one left.
          validationErrors:
            update.validationErrors === null
              ? Prisma.DbNull
              : (update.validationErrors as unknown as Prisma.InputJsonValue),
          sampleRows: update.sampleRows as Prisma.InputJsonValue,
        },
      });
      return count > 0;
    },

    countUnfinishedJobs: (datasetId) =>
      prisma.trainingJob.count({ where: { datasetId, ...UNFINISHED } }),

    softDeleteIfUnused: async (orgId, datasetId, now) => {
      // One statement: the "no unfinished job" test and the write cannot be
      // separated by another request.
      const { count } = await prisma.dataset.updateMany({
        where: {
          id: datasetId,
          orgId,
          deletedAt: null,
          trainingJobs: { none: UNFINISHED },
        },
        data: { deletedAt: now, liveName: null },
      });
      return count > 0;
    },
  };
}

export function buildDatasetDeps(prisma: DatasetPrisma = defaultPrisma): DatasetDeps {
  return {
    db: prismaDatasetDb(prisma),
    getStore: () => getObjectStore(),
    getLimits: () => {
      const config = getTrainingConfig();
      return { maxBytes: config.datasetMaxBytes, maxRows: config.datasetMaxRows };
    },
    issueUploadUrl: (args) => issueTransferUrl({ op: "put", ...args }),
    now: () => new Date(),
    newId: randomUUID,
  };
}
