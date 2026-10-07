import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { openJson, sealJson } from "../lib/secretBox.js";
import { rowAccessMode } from "../config/nosanaAccess.js";
import {
  NosanaOneShotUnavailableError,
  getNosanaClient,
  type NosanaJobDefinition,
} from "./nosana.js";
import {
  registerTelegramWebhook,
  telegramWebhookUrl,
  unregisterTelegramWebhook,
  type TelegramWebhookResult,
} from "./telegramWebhook.js";
import { generatePublicKey } from "./widgetKeys.js";

const logger = createLogger("openclaw-service");


const OPENCLAW_PORT = 8000;

const OPENCLAW_GPU_TIER_MAP: Record<string, string> = {
  basic: "3060",
  standard: "4070",
  premium: "4090",
  "rtx-3060": "3060",
  "rtx-4070": "4070",
  "rtx-4090": "4090",
};

export const SUPPORTED_PLATFORMS = [
  "discord",
  "telegram",
  "slack",
  "twitter",
  "whatsapp",
  "line",
  "messenger",
  "web",
  "api",
  "email",
] as const;

type OpenClawDeploymentRecord = Awaited<ReturnType<typeof getDeployment>>;

/**
 * The web chat channel is not an OpenClaw channel row: nothing reads one.
 * It is a web chat key (services/webChannel.ts) for the deployment's agent,
 * served by routes/widget.ts. Choosing "Web Chat" here creates that key.
 */
export const WEB_CHAT_PLATFORM = "web";

/** The name a key made from the OpenClaw screens starts with. */
export const OPENCLAW_WEB_KEY_NAME = "Web chat";

/**
 * The look the OpenClaw "Web Chat" form asks for, as web chat key columns.
 * Anything that is not a usable title or a #RRGGBB colour is left out, so
 * the key falls back to the widget's defaults instead of failing the deploy.
 */
export function webChatKeyLook(config: Record<string, string>): { title?: string; primaryColor?: string } {
  const title = typeof config.widgetTitle === "string" ? config.widgetTitle.trim().slice(0, 60) : "";
  const color = typeof config.primaryColor === "string" ? config.primaryColor.trim() : "";
  return {
    ...(title && { title }),
    ...(/^#[0-9a-fA-F]{6}$/.test(color) && { primaryColor: color.toLowerCase() }),
  };
}

/** The columns of a new key for an agent: no site allowed yet, so only the dashboard preview works. */
function webChatKeyData(orgId: string, agentId: string, config: Record<string, string>) {
  return {
    orgId,
    agentId,
    publicKey: generatePublicKey(),
    name: OPENCLAW_WEB_KEY_NAME,
    allowedOrigins: [] as string[],
    ...webChatKeyLook(config),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeGpuTier(rawTier: unknown): string {
  if (typeof rawTier !== "string" || rawTier.trim().length === 0) {
    return "3060";
  }
  const normalized = rawTier.trim().toLowerCase();
  return OPENCLAW_GPU_TIER_MAP[normalized] ?? normalized;
}

function toEnvValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStringEnvVars(input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key) continue;
    output[key] = toEnvValue(value);
  }
  return output;
}

function decryptConfigSafely(
  encrypted: string,
  context: { deploymentId: string; channelId?: string }
): Record<string, unknown> {
  try {
    return decryptConfig(encrypted);
  } catch (error) {
    logger.warn({ error, ...context }, "Failed to decrypt OpenClaw config");
    return {};
  }
}

// ============================================
// Telegram webhook release
// ============================================

/** A bot that may still be pointed at one of our deployments. */
export interface TelegramWebhookTarget {
  deploymentId: string;
  botToken: string;
}

/**
 * The Telegram bots registered for these channel rows. Read BEFORE the
 * rows are deleted (directly or by a cascade from the deployment or the
 * agent): afterwards the tokens needed to release them are gone.
 */
export function telegramWebhookTargets(
  channels: Array<{ id: string; deploymentId: string; platform: string; configEncrypted: string }>
): TelegramWebhookTarget[] {
  const targets: TelegramWebhookTarget[] = [];
  for (const channel of channels) {
    if (channel.platform !== "telegram") continue;
    const config = decryptConfigSafely(channel.configEncrypted, {
      deploymentId: channel.deploymentId,
      channelId: channel.id,
    });
    const botToken = String(config.botToken ?? "");
    if (botToken) targets.push({ deploymentId: channel.deploymentId, botToken });
  }
  return targets;
}

/** Telegram bots on every OpenClaw deployment of an agent; call before deleting the agent. */
export async function collectAgentTelegramWebhooks(agentId: string): Promise<TelegramWebhookTarget[]> {
  const channels = await prisma.openClawChannel.findMany({
    where: { platform: "telegram", deployment: { agentId } },
    select: { id: true, deploymentId: true, platform: true, configEncrypted: true },
  });
  return telegramWebhookTargets(channels);
}

/**
 * Stop Telegram delivering to deployments whose channel rows are gone.
 * Best effort and never throws: the delete it follows has already
 * happened, so a failure here is logged (without the token), not
 * reported as a failed delete. A bot its owner has since pointed
 * somewhere else is left alone (onlyIfUrl).
 */
export async function releaseTelegramWebhooks(
  targets: TelegramWebhookTarget[],
  deps: { publicApiUrl?: string; unregister?: typeof unregisterTelegramWebhook } = {}
): Promise<void> {
  const publicApiUrl = deps.publicApiUrl ?? env.PUBLIC_API_URL;
  if (!publicApiUrl) return;
  const unregister = deps.unregister ?? unregisterTelegramWebhook;
  for (const target of targets) {
    try {
      await unregister({
        botToken: target.botToken,
        onlyIfUrl: telegramWebhookUrl(publicApiUrl, target.deploymentId),
      });
    } catch (error) {
      logger.warn({ error, deploymentId: target.deploymentId }, "Failed to release Telegram webhook");
    }
  }
}

/**
 * After a failed channel insert: should the bot this request registered
 * be pointed away again? Not when the row that exists holds the same bot.
 * The webhook URL and secret depend only on the deployment and the token,
 * so a concurrent add of the same bot made the identical registration,
 * and deleting it would silence the channel that was just saved.
 */
export function shouldRollBackTelegramRegistration(
  botToken: string,
  storedConfig: Record<string, unknown> | null
): boolean {
  return storedConfig === null || String(storedConfig.botToken ?? "") !== botToken;
}

function buildOpenClawJobDefinition(deployment: OpenClawDeploymentRecord): {
  definition: NosanaJobDefinition;
  marketTier: string;
} {
  const modelConfig = asRecord(deployment.agent.modelConfig);
  const marketTier = normalizeGpuTier(modelConfig.gpuTier);
  const decryptedEnv = decryptConfigSafely(deployment.envEncrypted, {
    deploymentId: deployment.id,
  });

  const enabledChannels = deployment.channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.id,
      platform: channel.platform,
      config: decryptConfigSafely(channel.configEncrypted, {
        deploymentId: deployment.id,
        channelId: channel.id,
      }),
    }));

  const definition: NosanaJobDefinition = {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "openclaw",
    },
    ops: [
      {
        type: "container/run",
        id: "openclaw-runtime",
        args: {
          image: deployment.dockerImage || env.OPENCLAW_DEFAULT_IMAGE,
          gpu: true,
          expose: [OPENCLAW_PORT],
          env: {
            ...toStringEnvVars(decryptedEnv),
            OPENCLAW_DEPLOYMENT_ID: deployment.id,
            OPENCLAW_AGENT_ID: deployment.agentId,
            OPENCLAW_AGENT_NAME: deployment.agent.name,
            OPENCLAW_AGENT_SLUG: deployment.agent.slug,
            OPENCLAW_VERSION: deployment.openclawVersion,
            OPENCLAW_SYSTEM_PROMPT: deployment.agent.systemPrompt ?? "",
            OPENCLAW_MODEL_CONFIG: JSON.stringify(modelConfig),
            OPENCLAW_CHANNELS: JSON.stringify(enabledChannels),
            PORT: String(OPENCLAW_PORT),
            NODE_ENV: env.NODE_ENV,
          },
        },
      },
    ],
  };

  return {
    definition,
    marketTier,
  };
}

// Channel configs use the shared sealing helper; the on-disk format is
// unchanged, so existing rows decrypt as before.
export function encryptConfig(data: Record<string, unknown>): string {
  return sealJson(data);
}

export function decryptConfig(encryptedStr: string): Record<string, unknown> {
  return openJson<Record<string, unknown>>(encryptedStr);
}

interface CreateDeploymentParams {
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  systemPrompt?: string;
  modelConfig: Record<string, unknown>;
  gpuTier: string;
  openclawVersion?: string;
  envVars: Record<string, string>;
  channels: Array<{
    platform: string;
    config: Record<string, string>;
  }>;
}

export async function createDeployment(params: CreateDeploymentParams) {
  const {
    orgId,
    name,
    slug,
    description,
    systemPrompt,
    modelConfig,
    gpuTier,
    openclawVersion = "latest",
    envVars,
    channels,
  } = params;

  logger.info("Creating OpenClaw deployment", { orgId, name, slug });

  // Validate channels
  for (const channel of channels) {
    if (!SUPPORTED_PLATFORMS.includes(channel.platform as any)) {
      throw new Error(`Unsupported platform: ${channel.platform}`);
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Create the Agent
    const agent = await tx.agent.create({
      data: {
        orgId,
        name,
        slug,
        description: description || "",
        systemPrompt: systemPrompt || "",
        framework: "openclaw",
        sourceType: "inline",
        modelConfig: {
          ...(modelConfig as Record<string, unknown>),
          gpuTier,
        } as any,
      },
    });

    // Encrypt environment variables
    const encryptedEnvVars = encryptConfig(envVars);

    // Create the OpenClawDeployment
    const deployment = await tx.openClawDeployment.create({
      data: {
        agentId: agent.id,
        openclawVersion,
        envEncrypted: encryptedEnvVars,
        status: "PENDING",
      },
    });

    // Create OpenClawChannels. The web chat channel is a key, not a row here.
    const webChat = channels.find((channel) => channel.platform === WEB_CHAT_PLATFORM);
    const webChatKey = webChat
      ? await tx.widgetKey.create({
          data: webChatKeyData(orgId, agent.id, webChat.config),
          select: { id: true },
        })
      : null;
    const createdChannels = await Promise.all(
      channels.filter((channel) => channel.platform !== WEB_CHAT_PLATFORM).map((channel) =>
        tx.openClawChannel.create({
          data: {
            deploymentId: deployment.id,
            platform: channel.platform,
            configEncrypted: encryptConfig(channel.config),
            enabled: true,
          },
        })
      )
    );

    return {
      ...deployment,
      channels: createdChannels,
      agent,
      webChatKey,
    };
  });

  logger.info("OpenClaw deployment created", {
    deploymentId: result.id,
    agentId: result.agentId,
  });

  // Telegram only delivers once the bot is pointed at us. A refusal here
  // leaves the channel saved; saving it again retries the registration.
  for (const channel of channels) {
    if (channel.platform !== "telegram") continue;
    await registerTelegramWebhook({
      botToken: String(channel.config.botToken ?? ""),
      deploymentId: result.id,
      publicApiUrl: env.PUBLIC_API_URL,
    }).catch((err) =>
      logger.warn("Telegram webhook registration failed", {
        deploymentId: result.id,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return result;
}

export async function getDeployment(id: string, orgId: string) {
  logger.info("Getting deployment", { id, orgId });

  const deployment = await prisma.openClawDeployment.findFirst({
    where: {
      id,
      agent: {
        orgId,
      },
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  if (!deployment) {
    throw new Error("Deployment not found or access denied");
  }

  return deployment;
}

export async function getDeployments(orgId: string) {
  logger.info("Getting deployments for org", { orgId });

  const deployments = await prisma.openClawDeployment.findMany({
    where: {
      agent: {
        orgId,
      },
    },
    include: {
      channels: true,
      agent: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return deployments;
}

interface UpdateDeploymentParams {
  envVars?: Record<string, string>;
  openclawVersion?: string;
}

export async function updateDeployment(
  id: string,
  orgId: string,
  params: UpdateDeploymentParams
) {
  logger.info("Updating deployment", { id, orgId, params });

  // Verify ownership
  await getDeployment(id, orgId);

  const updateData: any = {};

  if (params.envVars) {
    updateData.envEncrypted = encryptConfig(params.envVars);
  }

  if (params.openclawVersion) {
    updateData.openclawVersion = params.openclawVersion;
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: updateData,
    include: {
      channels: true,
      agent: true,
    },
  });

  logger.info("Deployment updated", { id });

  return deployment;
}

export async function deleteDeployment(id: string, orgId: string) {
  logger.info("Deleting deployment", { id, orgId });

  // Verify ownership
  const deployment = await getDeployment(id, orgId);

  // The channel rows go with the deployment; read their bots first.
  const telegram = telegramWebhookTargets(deployment.channels);

  await prisma.openClawDeployment.delete({
    where: { id },
  });

  // Otherwise Telegram keeps posting every update to a deployment that no
  // longer exists, and the bot cannot be used elsewhere until its owner
  // clears the webhook by hand.
  await releaseTelegramWebhooks(telegram);

  logger.info("Deployment deleted", { id });

  return { success: true };
}

interface UpdateDeploymentStatusParams {
  nosanaJobId?: string;
  publicUrl?: string;
}

export async function updateDeploymentStatus(
  id: string,
  status: string,
  extra?: UpdateDeploymentStatusParams
) {
  logger.info("Updating deployment status", { id, status, extra });

  const updateData: any = { status };

  if (extra?.nosanaJobId) {
    updateData.nosanaJobId = extra.nosanaJobId;
  }

  if (extra?.publicUrl) {
    updateData.publicUrl = extra.publicUrl;
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: updateData,
  });

  logger.info("Deployment status updated", { id, status });

  return deployment;
}

interface AddChannelParams {
  platform: string;
  config: Record<string, string>;
}

export async function addChannel(
  deploymentId: string,
  orgId: string,
  params: AddChannelParams
) {
  logger.info("Adding channel", { deploymentId, orgId, platform: params.platform });

  // Verify deployment ownership
  await getDeployment(deploymentId, orgId);

  // Validate platform
  if (!SUPPORTED_PLATFORMS.includes(params.platform as any)) {
    throw new Error(`Unsupported platform: ${params.platform}`);
  }
  // A row here would be a channel nothing serves.
  if (params.platform === WEB_CHAT_PLATFORM) {
    throw new Error("The web chat channel is a web chat key. Use addWebChatKey.");
  }

  // One channel per platform per deployment. Checked before Telegram is
  // touched: registering a second bot here would re-point it to this
  // deployment and then fail the insert, leaving it delivering nowhere.
  const existing = await prisma.openClawChannel.findUnique({
    where: { deploymentId_platform: { deploymentId, platform: params.platform } },
    select: { id: true },
  });
  if (existing) {
    throw new Error(`This deployment already has a ${params.platform} channel. Edit that channel instead.`);
  }

  // Register with Telegram first: a token Telegram refuses is reported
  // now instead of being saved as a channel that never receives anything.
  let webhook: TelegramWebhookResult | undefined;
  const botToken = String(params.config.botToken ?? "");
  if (params.platform === "telegram") {
    webhook = await registerTelegramWebhook({
      botToken,
      deploymentId,
      publicApiUrl: env.PUBLIC_API_URL,
    });
  }

  let channel;
  try {
    channel = await prisma.openClawChannel.create({
      data: {
        deploymentId,
        platform: params.platform,
        configEncrypted: encryptConfig(params.config),
        enabled: true,
      },
    });
  } catch (err) {
    // The row was not saved (e.g. a concurrent add won): point the bot
    // back away from this deployment rather than leave it unverifiable,
    // unless the add that won saved this same bot.
    if (webhook?.registered) {
      const winner = await prisma.openClawChannel
        .findUnique({
          where: { deploymentId_platform: { deploymentId, platform: params.platform } },
          select: { id: true, configEncrypted: true },
        })
        .catch(() => null);
      const stored = winner
        ? decryptConfigSafely(winner.configEncrypted, { deploymentId, channelId: winner.id })
        : null;
      if (shouldRollBackTelegramRegistration(botToken, stored)) {
        await unregisterTelegramWebhook({ botToken, onlyIfUrl: webhook.url });
      }
    }
    throw err;
  }

  logger.info("Channel added", { channelId: channel.id, platform: params.platform });

  return { ...channel, webhook };
}

/**
 * "Web Chat" on a deployment: a web chat key for its agent. The owner then
 * lists the sites that may embed it under Integrations, Channels.
 */
export async function addWebChatKey(deploymentId: string, orgId: string, config: Record<string, string>) {
  // Verify deployment ownership
  const deployment = await getDeployment(deploymentId, orgId);
  const key = await prisma.widgetKey.create({
    data: webChatKeyData(orgId, deployment.agentId, config),
    select: { id: true },
  });
  logger.info("Web chat key added", { deploymentId, widgetKeyId: key.id });
  return key;
}

interface UpdateChannelParams {
  config?: Record<string, string>;
  enabled?: boolean;
}

export async function updateChannel(
  channelId: string,
  orgId: string,
  params: UpdateChannelParams
) {
  // Never log `params.config`: it holds bot tokens and signing secrets.
  logger.info("Updating channel", {
    channelId,
    orgId,
    configChanged: params.config !== undefined,
    enabled: params.enabled,
  });

  // Verify ownership through deployment
  const channel = await prisma.openClawChannel.findUnique({
    where: { id: channelId },
    include: {
      deployment: {
        include: {
          agent: true,
        },
      },
    },
  });

  if (!channel || channel.deployment.agent.orgId !== orgId) {
    throw new Error("Channel not found or access denied");
  }

  const updateData: any = {};

  if (params.config) {
    updateData.configEncrypted = encryptConfig(params.config);
  }

  if (params.enabled !== undefined) {
    updateData.enabled = params.enabled;
  }

  let webhook: TelegramWebhookResult | undefined;
  let rollbackNewBot: (() => Promise<unknown>) | null = null;
  let afterSave: (() => Promise<unknown>) | null = null;
  if (channel.platform === "telegram") {
    const current = decryptConfig(channel.configEncrypted);
    const oldToken = String(current.botToken ?? "");
    const botToken = String((params.config ?? current).botToken ?? "");
    const enabled = params.enabled ?? channel.enabled;
    const ourUrl = env.PUBLIC_API_URL ? telegramWebhookUrl(env.PUBLIC_API_URL, channel.deploymentId) : null;
    if (enabled) {
      webhook = await registerTelegramWebhook({
        botToken,
        deploymentId: channel.deploymentId,
        publicApiUrl: env.PUBLIC_API_URL,
      });
      if (webhook.registered && botToken !== oldToken) {
        const registeredUrl = webhook.url;
        // If the save fails, the new bot must not keep pointing here.
        rollbackNewBot = () => unregisterTelegramWebhook({ botToken, onlyIfUrl: registeredUrl });
        // Once saved, the replaced bot stops delivering to this deployment.
        if (oldToken) afterSave = () => unregisterTelegramWebhook({ botToken: oldToken, onlyIfUrl: registeredUrl });
      }
    } else if (ourUrl) {
      afterSave = () => unregisterTelegramWebhook({ botToken: oldToken, onlyIfUrl: ourUrl });
    }
  }

  let updated;
  try {
    updated = await prisma.openClawChannel.update({
      where: { id: channelId },
      data: updateData,
    });
  } catch (err) {
    if (rollbackNewBot) await rollbackNewBot();
    throw err;
  }
  if (afterSave) await afterSave();

  logger.info("Channel updated", { channelId });

  return { ...updated, webhook };
}

export async function removeChannel(channelId: string, orgId: string) {
  logger.info("Removing channel", { channelId, orgId });

  // Verify ownership through deployment
  const channel = await prisma.openClawChannel.findUnique({
    where: { id: channelId },
    include: {
      deployment: {
        include: {
          agent: true,
        },
      },
    },
  });

  if (!channel || channel.deployment.agent.orgId !== orgId) {
    throw new Error("Channel not found or access denied");
  }

  await prisma.openClawChannel.delete({
    where: { id: channelId },
  });

  // After the row is gone, stop Telegram delivering here, but only while
  // the bot still points at this deployment. The channel is already
  // removed: a config that no longer decrypts, or Telegram failing, must
  // not turn that into a reported error.
  await releaseTelegramWebhooks(telegramWebhookTargets([channel]));

  logger.info("Channel removed", { channelId });

  return { success: true };
}

export async function updateHealthStatus(id: string, status: string) {
  logger.info("Updating health status", { id, status });

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      healthStatus: status,
      healthLastCheck: new Date(),
    },
  });

  logger.info("Health status updated", { id, status });

  return deployment;
}

/**
 * OpenClaw runs as a one-shot Nosana job, which only a wallet can list. With
 * API-key access there is no private equivalent yet, so a start is refused by
 * name BEFORE any row moves (the route answers 501). A client that cannot be
 * built at all is left to the start itself, which reports it as it always did.
 */
async function assertOneShotAvailable(): Promise<void> {
  const nosana = await getNosanaClient().catch(() => null);
  if (nosana?.getAccessMode() === "api_key") throw new NosanaOneShotUnavailableError();
}

export async function startDeployment(id: string, orgId: string) {
  logger.info("Starting deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  if (existing.status === "RUNNING" && existing.nosanaJobId) {
    logger.info("Deployment already running with active Nosana job", {
      id,
      jobId: existing.nosanaJobId,
    });
    return existing;
  }

  await assertOneShotAvailable();

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "BUILDING",
      healthStatus: "provisioning",
      healthLastCheck: new Date(),
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  const { definition, marketTier } = buildOpenClawJobDefinition(deployment);

  try {
    const nosana = await getNosanaClient();
    const job = await nosana.submitJob(definition, marketTier);
    const jobStatus = await nosana.getJobStatus(job.id).catch((error) => {
      logger.warn({ error, id, jobId: job.id }, "Failed to fetch immediate Nosana job status");
      return null;
    });

    const updated = await prisma.openClawDeployment.update({
      where: { id },
      data: {
        status: jobStatus?.status === "running" ? "RUNNING" : "DEPLOYING",
        nosanaJobId: job.id,
        // One-shot jobs are listed by the wallet; stored with the id so the
        // stop goes to the same account after a switch of access mode.
        nosanaAccessMode: "wallet",
        // Only a REAL node URL, or nothing. The old fallback invented
        // https://<slug>.openclaw.wheelsai.com — a hostname nothing
        // serves — and the UI rendered it as "Access your deployed
        // agent". No URL until the node reports one.
        publicUrl: jobStatus?.nodeUrl ?? null,
        healthStatus: jobStatus?.status === "running" ? "healthy" : "unknown",
        healthLastCheck: new Date(),
      },
      include: {
        channels: true,
        agent: true,
      },
    });

    logger.info("Deployment submitted to Nosana", {
      id,
      jobId: job.id,
      marketTier,
      publicUrl: updated.publicUrl,
    });

    return updated;
  } catch (error) {
    // No "recoverable" carve-out: the old path treated wallet-not-
    // configured / unknown-market as recoverable and marked the
    // deployment RUNNING with an invented URL — a deployment that never
    // existed anywhere. A submit that didn't reach Nosana is FAILED.
    logger.error({ error, id }, "Failed to start OpenClaw deployment");

    await prisma.openClawDeployment.update({
      where: { id },
      data: {
        status: "FAILED",
        healthStatus: "down",
        healthLastCheck: new Date(),
      },
    });

    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to start deployment: ${message}`);
  }
}

export async function stopDeployment(id: string, orgId: string) {
  logger.info("Stopping deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  if (existing.nosanaJobId) {
    try {
      const nosana = await getNosanaClient();
      await nosana.stopDeployment(
        existing.nosanaJobId,
        rowAccessMode(existing.nosanaAccessMode),
      );
      logger.info("Stopped Nosana job for deployment", { id, jobId: existing.nosanaJobId });
    } catch (error) {
      logger.warn(
        { error, id, jobId: existing.nosanaJobId },
        "Failed to stop Nosana job, continuing with local status update"
      );
    }
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "STOPPED",
      nosanaJobId: null,
      nosanaAccessMode: null,
      publicUrl: null,
      healthStatus: "down",
      healthLastCheck: new Date(),
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  logger.info("Deployment stopped", { id });

  return deployment;
}

export async function restartDeployment(id: string, orgId: string) {
  logger.info("Restarting deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  // Refuse before the running job is stopped: a restart that cannot start
  // again must not take the deployment down.
  await assertOneShotAvailable();

  if (existing.nosanaJobId) {
    try {
      const nosana = await getNosanaClient();
      await nosana.stopDeployment(
        existing.nosanaJobId,
        rowAccessMode(existing.nosanaAccessMode),
      );
      logger.info("Stopped previous Nosana job before restart", {
        id,
        jobId: existing.nosanaJobId,
      });
    } catch (error) {
      logger.warn(
        { error, id, jobId: existing.nosanaJobId },
        "Failed to stop previous Nosana job during restart"
      );
    }
  }

  await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "PENDING",
      nosanaJobId: null,
      nosanaAccessMode: null,
      publicUrl: null,
      healthStatus: "unknown",
      healthLastCheck: new Date(),
    },
  });

  logger.info("Deployment reset completed, starting fresh deployment", { id });
  return startDeployment(id, orgId);
}
