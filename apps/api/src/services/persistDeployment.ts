/**
 * Prisma-backed persistDeployment (plan A7).
 *
 * Production impl of the dep the launch route hands off to. Wraps every
 * write in a single $transaction so a partial failure never leaves a
 * dangling Agent / OpenClawDeployment / channel row.
 *
 * Encryption is dependency-injected (the caller provides the AES-256-GCM
 * helper from openclaw.ts). This module never touches the encryption key
 * directly, which keeps it unit-testable and means a future KMS swap
 * doesn't require a schema change.
 *
 * Each OpenClawChannel row only gets the slice of env values that channel
 * needs — Discord channel rows never see the Telegram bot token, etc.
 * That's the only place the secrets are scoped per platform; the full env
 * blob lives encrypted on OpenClawDeployment.envEncrypted for the runtime
 * to load on boot.
 */

import type { ResourcePlan } from "./deployPlan.js";
import type {
  PersistDeploymentInput,
  PersistDeploymentResult,
} from "../routes/launch.js";

interface TxClient {
  agent: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  openClawDeployment: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  openClawChannel: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  agentDeployment: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

interface PrismaWithTx {
  $transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
}

export interface PersistDeploymentDeps {
  prisma: PrismaWithTx;
  encryptConfig: (cfg: Record<string, unknown>) => string;
}

function pickKeys(
  source: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

export async function persistDeploymentByPrisma(
  input: PersistDeploymentInput,
  deps: PersistDeploymentDeps,
): Promise<PersistDeploymentResult> {
  const resource = input.resourcePlan as ResourcePlan;

  return deps.prisma.$transaction(async (tx) => {
    const agent = await tx.agent.create({
      data: {
        orgId: input.orgId,
        name: input.characterName,
        slug: input.agentSlug,
        framework: "elizaos",
        sourceType: "inline",
        modelConfig: {},
      },
    });

    const envCipher = deps.encryptConfig({ ...input.envValues });
    const openClawDeployment = await tx.openClawDeployment.create({
      data: {
        agentId: agent.id,
        envEncrypted: envCipher,
      },
    });

    for (const channel of input.channels) {
      const slice = pickKeys(input.envValues, channel.envKeys);
      const channelCipher = deps.encryptConfig(slice);
      await tx.openClawChannel.create({
        data: {
          deploymentId: openClawDeployment.id,
          platform: channel.platform,
          configEncrypted: channelCipher,
          enabled: true,
        },
      });
    }

    const agentDeployment = await tx.agentDeployment.create({
      data: {
        agentId: agent.id,
        gpuTier: resource.tier,
        replicas: resource.replicas,
        status: "pending",
        nosanaJobIds: [],
      },
    });

    return {
      deploymentId: agentDeployment.id,
      agentId: agent.id,
    };
  });
}
