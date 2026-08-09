/**
 * OpenClaw channel config resolvers (plan A6).
 *
 * These bridge the webhook route / worker and the OpenClawChannel +
 * OpenClawDeployment rows. Two exports, matching the two sides of the
 * conversation:
 *
 *   resolveChannelConfig      — credentials the INBOUND verify step needs.
 *                               Discord: publicKeyHex
 *                               Telegram: botToken (used for HMAC)
 *                               Slack: signingSecret (distinct from botToken)
 *
 *   resolveOutboundCredentials — credentials the OUTBOUND dispatch needs,
 *                               plus the running OpenClaw node URL so the
 *                               worker can POST {nodeUrl}/message.
 *
 * Prisma and the decrypt helper are injected so unit tests never actually
 * touch the DB or the encryption key.
 */

import type {
  ChannelConfig as InboundChannelConfig,
} from "../routes/channelWebhooks.js";
import type {
  OutboundBinding,
} from "../queues/agent-message.worker.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("channel-config");

type DecryptFn = (cipher: string) => Record<string, unknown>;

interface PrismaStub {
  openClawChannel: {
    findFirst: (args: {
      // Either key: by our deployment, or by the platform's own
      // workspace id (the distributed-app events path).
      where:
        | { deploymentId: string; platform: string }
        | { platform: string; externalId: string };
    }) => Promise<
      | {
          id: string;
          deploymentId: string;
          platform: string;
          enabled: boolean;
          configEncrypted: string;
        }
      | null
    >;
  };
  openClawDeployment: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ id: string; publicUrl: string | null } | null>;
  };
}


export interface ChannelConfigDeps {
  prisma: PrismaStub;
  decryptConfig: DecryptFn;
}

function decryptOrWarn(
  cipher: string,
  deps: ChannelConfigDeps,
  context: Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    return deps.decryptConfig(cipher);
  } catch (error) {
    logger.warn({ error, ...context }, "failed to decrypt channel config");
    return null;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ============================================
// Inbound: resolveChannelConfig
// ============================================

export async function resolveChannelConfig(
  deploymentId: string,
  platform: string,
  deps: ChannelConfigDeps,
): Promise<InboundChannelConfig | null> {
  const row = await deps.prisma.openClawChannel.findFirst({
    where: { deploymentId, platform },
  });
  if (!row || !row.enabled) return null;
  return decodeInboundConfig(row, deploymentId, platform, deps);
}

/**
 * Resolves a channel by the PLATFORM's own workspace id rather than by
 * our deploymentId.
 *
 * A distributed Slack app has exactly one Events Request URL, so an
 * inbound event cannot carry a deploymentId — it identifies itself by
 * `team_id`. This is the lookup that makes one shared events endpoint
 * possible without a second copy of the channel stack.
 */
export async function resolveChannelConfigByExternalId(
  platform: string,
  externalId: string,
  deps: ChannelConfigDeps,
): Promise<InboundChannelConfig | null> {
  const row = await deps.prisma.openClawChannel.findFirst({
    where: { platform, externalId },
  });
  if (!row || !row.enabled) return null;
  return decodeInboundConfig(row, row.deploymentId, platform, deps);
}

function decodeInboundConfig(
  row: { configEncrypted: string; deploymentId: string },
  deploymentId: string,
  platform: string,
  deps: ChannelConfigDeps,
): InboundChannelConfig | null {

  const config = decryptOrWarn(row.configEncrypted, deps, {
    deploymentId,
    platform,
  });
  if (!config) return null;

  if (platform === "discord") {
    const publicKeyHex = config.publicKey ?? config.publicKeyHex;
    if (!isNonEmptyString(publicKeyHex)) return null;
    return {
      deploymentId,
      platform: "discord",
      credentials: { kind: "discord", publicKeyHex },
    };
  }

  if (platform === "telegram") {
    const botToken = config.botToken;
    if (!isNonEmptyString(botToken)) return null;
    return {
      deploymentId,
      platform: "telegram",
      credentials: { kind: "telegram", botToken },
    };
  }

  if (platform === "slack") {
    const signingSecret = config.signingSecret;
    if (!isNonEmptyString(signingSecret)) return null;
    return {
      deploymentId,
      platform: "slack",
      credentials: { kind: "slack", signingSecret },
    };
  }

  return null;
}

// ============================================
// Outbound: resolveOutboundCredentials
// ============================================

export async function resolveOutboundCredentials(
  deploymentId: string,
  platform: string,
  deps: ChannelConfigDeps,
): Promise<OutboundBinding | null> {
  const [row, deployment] = await Promise.all([
    deps.prisma.openClawChannel.findFirst({
      where: { deploymentId, platform },
    }),
    deps.prisma.openClawDeployment.findUnique({ where: { id: deploymentId } }),
  ]);
  if (!row || !row.enabled) return null;
  if (!deployment || !isNonEmptyString(deployment.publicUrl)) return null;

  const config = decryptOrWarn(row.configEncrypted, deps, {
    deploymentId,
    platform,
  });
  if (!config) return null;

  const botToken = config.botToken;
  if (!isNonEmptyString(botToken)) return null;

  if (platform === "discord") {
    return {
      nodeUrl: deployment.publicUrl,
      credentials: { kind: "discord-bot", botToken },
    };
  }
  if (platform === "telegram") {
    return {
      nodeUrl: deployment.publicUrl,
      credentials: { kind: "telegram-bot", botToken },
    };
  }
  if (platform === "slack") {
    return {
      nodeUrl: deployment.publicUrl,
      credentials: { kind: "slack-bot", botToken },
    };
  }
  return null;
}
