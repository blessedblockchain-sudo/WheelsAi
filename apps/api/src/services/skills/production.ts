/**
 * Composition root for the skills registry: binds the built-ins to the real
 * environment (config/skills.ts), the dataset object store and the knowledge
 * retrieval deps.
 *
 * Imported LAZILY by the chat runtime and the skills route so that pure
 * unit tests of the tool loop, the registry and the interpreter never pull
 * in Prisma or the AWS SDK.
 */

import { Redis } from "ioredis";

import { env } from "../../config/env.js";
import { getSkillsConfig } from "../../config/skills.js";
import { createLogger } from "../../utils/logger.js";
import { buildAgentRetrievalDeps } from "../buildAgentRetrievalDeps.js";
import { getDatasetStorageHandle } from "../dataset.js";
import { makeRedisAgentFileLock, type AgentFileLock } from "./agentFileLock.js";
import { S3AgentFileStore } from "./agentFileStore.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import { SkillRegistry, createSkillRegistry } from "./registry.js";
import { createSandboxRunner, type SandboxRunner } from "./sandboxRunner.js";

const logger = createLogger("skills");

let sandbox: { key: string; runner: SandboxRunner | null } | null = null;

export function getSandboxRunner(): SandboxRunner | null {
  const { config } = getSkillsConfig();
  const key = config.sandbox ? JSON.stringify(config.sandbox) : "";
  if (!sandbox || sandbox.key !== key) {
    sandbox = { key, runner: createSandboxRunner(config.sandbox) };
  }
  return sandbox.runner;
}

let lockRedis: Redis | null = null;

function getLockRedis(): Redis {
  if (!lockRedis) {
    lockRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    lockRedis.connect().catch((err) => {
      logger.error({ err }, "Failed to connect to Redis for the agent file lock");
    });
  }
  return lockRedis;
}

// The closures keep it lazy: Redis is dialled on the first file write, not
// at import - most processes that load the registry never write a file.
const redisFileLock: AgentFileLock = makeRedisAgentFileLock({
  set: (key, value, px, ttlMs, nx) => getLockRedis().set(key, value, px, ttlMs, nx),
  runScript: (script, keys, args) => getLockRedis().eval(script, keys.length, ...keys, ...args),
});

export function buildProductionSkillDeps(): BuiltinSkillDeps {
  return {
    getConfig: getSkillsConfig,
    fileLock: redisFileLock,
    getFileStore: () => {
      const handle = getDatasetStorageHandle();
      return handle ? new S3AgentFileStore(handle.client, handle.bucket) : null;
    },
    getSandbox: getSandboxRunner,
    knowledge: buildAgentRetrievalDeps(),
  };
}

let registry: SkillRegistry | null = null;

export function getDefaultRegistry(): SkillRegistry {
  registry ??= createSkillRegistry(buildProductionSkillDeps());
  return registry;
}
