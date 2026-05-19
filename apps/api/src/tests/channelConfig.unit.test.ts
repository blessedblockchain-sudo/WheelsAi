import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/channelConfig.ts — the glue between the
// webhook route/worker and the OpenClawChannel DB rows. Two functions:
//
//   resolveChannelConfig(deploymentId, platform)
//     → returns the credentials the INBOUND verify step needs
//       (publicKeyHex for Discord, botToken for Telegram, signingSecret for Slack)
//
//   resolveOutboundCredentials(deploymentId, platform)
//     → returns the credentials + node URL the OUTBOUND dispatch needs
//       (botToken for each platform — Slack posts via chat.postMessage not the inbound signing secret)
//
// Both inject prisma + decryptConfig so no DB or crypto is actually touched.

function makePrismaStub(rows: Record<string, any>) {
  return {
    openClawChannel: {
      async findFirst({ where }: any) {
        const key = `${where.deploymentId}:${where.platform}`;
        return rows[key] ?? null;
      },
    },
    openClawDeployment: {
      async findUnique({ where }: any) {
        return rows[`deployment:${where.id}`] ?? null;
      },
    },
  };
}

function decryptStub(byCipher: Record<string, any>) {
  return (cipher: string) => {
    if (cipher in byCipher) return byCipher[cipher];
    throw new Error(`unexpected cipher: ${cipher}`);
  };
}

// ============================================
// resolveChannelConfig — inbound
// ============================================

test("resolveChannelConfig returns Discord public key for a matching channel row", async () => {
  setupEnv();
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );

  const prisma = makePrismaStub({
    "dep_1:discord": {
      id: "ch_1",
      deploymentId: "dep_1",
      platform: "discord",
      enabled: true,
      configEncrypted: "CIPHER_D",
    },
  });
  const decrypt = decryptStub({
    CIPHER_D: { publicKey: "aabbccdd" },
  });

  const result = await resolveChannelConfig("dep_1", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    deploymentId: "dep_1",
    platform: "discord",
    credentials: { kind: "discord", publicKeyHex: "aabbccdd" },
  });
});

test("resolveChannelConfig returns Telegram bot token for a matching channel row", async () => {
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_2:telegram": {
      id: "ch_2",
      deploymentId: "dep_2",
      platform: "telegram",
      enabled: true,
      configEncrypted: "CIPHER_T",
    },
  });
  const decrypt = decryptStub({
    CIPHER_T: { botToken: "123:XYZ" },
  });

  const result = await resolveChannelConfig("dep_2", "telegram", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    deploymentId: "dep_2",
    platform: "telegram",
    credentials: { kind: "telegram", botToken: "123:XYZ" },
  });
});

test("resolveChannelConfig returns Slack signing secret for a matching channel row", async () => {
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_3:slack": {
      id: "ch_3",
      deploymentId: "dep_3",
      platform: "slack",
      enabled: true,
      configEncrypted: "CIPHER_S",
    },
  });
  const decrypt = decryptStub({
    CIPHER_S: { signingSecret: "shhh", botToken: "xoxb-outbound" },
  });

  const result = await resolveChannelConfig("dep_3", "slack", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    deploymentId: "dep_3",
    platform: "slack",
    credentials: { kind: "slack", signingSecret: "shhh" },
  });
});

test("resolveChannelConfig returns null when the channel row does not exist", async () => {
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({});
  const decrypt = decryptStub({});
  const result = await resolveChannelConfig("dep_missing", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.equal(result, null);
});

test("resolveChannelConfig returns null for a disabled channel", async () => {
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_1:discord": {
      id: "ch_1",
      deploymentId: "dep_1",
      platform: "discord",
      enabled: false,
      configEncrypted: "CIPHER_D",
    },
  });
  const decrypt = decryptStub({ CIPHER_D: { publicKey: "aa" } });
  const result = await resolveChannelConfig("dep_1", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.equal(result, null);
});

test("resolveChannelConfig returns null when the decrypted config is missing required fields", async () => {
  const { resolveChannelConfig } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_1:discord": {
      id: "ch_1",
      deploymentId: "dep_1",
      platform: "discord",
      enabled: true,
      configEncrypted: "CIPHER_D",
    },
  });
  const decrypt = decryptStub({ CIPHER_D: { notPublicKey: "oops" } });
  const result = await resolveChannelConfig("dep_1", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.equal(result, null);
});

// ============================================
// resolveOutboundCredentials
// ============================================

test("resolveOutboundCredentials returns Discord bot token and the OpenClaw node URL", async () => {
  const { resolveOutboundCredentials } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_1:discord": {
      id: "ch_1",
      deploymentId: "dep_1",
      platform: "discord",
      enabled: true,
      configEncrypted: "CIPHER",
    },
    "deployment:dep_1": {
      id: "dep_1",
      publicUrl: "https://node.example",
    },
  });
  const decrypt = decryptStub({
    CIPHER: { publicKey: "aa", botToken: "disc-bot" },
  });

  const result = await resolveOutboundCredentials("dep_1", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    nodeUrl: "https://node.example",
    credentials: { kind: "discord-bot", botToken: "disc-bot" },
  });
});

test("resolveOutboundCredentials returns null when the deployment has no public URL yet", async () => {
  const { resolveOutboundCredentials } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_1:discord": {
      id: "ch_1",
      deploymentId: "dep_1",
      platform: "discord",
      enabled: true,
      configEncrypted: "CIPHER",
    },
    "deployment:dep_1": { id: "dep_1", publicUrl: null },
  });
  const decrypt = decryptStub({ CIPHER: { publicKey: "aa", botToken: "b" } });
  const result = await resolveOutboundCredentials("dep_1", "discord", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.equal(result, null);
});

test("resolveOutboundCredentials returns Telegram bot token for telegram platform", async () => {
  const { resolveOutboundCredentials } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_2:telegram": {
      id: "ch_2",
      deploymentId: "dep_2",
      platform: "telegram",
      enabled: true,
      configEncrypted: "CIPHER",
    },
    "deployment:dep_2": { id: "dep_2", publicUrl: "https://n2" },
  });
  const decrypt = decryptStub({ CIPHER: { botToken: "1:T" } });
  const result = await resolveOutboundCredentials("dep_2", "telegram", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    nodeUrl: "https://n2",
    credentials: { kind: "telegram-bot", botToken: "1:T" },
  });
});

test("resolveOutboundCredentials returns Slack bot token (distinct from signing secret)", async () => {
  const { resolveOutboundCredentials } = await import(
    "../services/channelConfig.js"
  );
  const prisma = makePrismaStub({
    "dep_3:slack": {
      id: "ch_3",
      deploymentId: "dep_3",
      platform: "slack",
      enabled: true,
      configEncrypted: "CIPHER",
    },
    "deployment:dep_3": { id: "dep_3", publicUrl: "https://n3" },
  });
  const decrypt = decryptStub({
    CIPHER: { signingSecret: "shhh", botToken: "xoxb-bot" },
  });
  const result = await resolveOutboundCredentials("dep_3", "slack", {
    prisma: prisma as any,
    decryptConfig: decrypt,
  });
  assert.deepEqual(result, {
    nodeUrl: "https://n3",
    credentials: { kind: "slack-bot", botToken: "xoxb-bot" },
  });
});
