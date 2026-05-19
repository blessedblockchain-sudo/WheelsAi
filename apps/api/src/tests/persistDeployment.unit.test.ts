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

// Drives apps/api/src/services/persistDeployment.ts — the Prisma-backed impl
// the launch route's persistDeployment dep delegates to in production.
//
// Responsibilities:
//   - $transaction over: Agent + OpenClawDeployment + OpenClawChannel[] +
//     AgentDeployment  (so a partial write never leaves a dangling agent)
//   - AES-256-GCM encryption of the full env blob (OpenClawDeployment) AND
//     of each channel's slice of the env (OpenClawChannel.configEncrypted)
//   - Channel rows scope env values down to that channel's envKeys only
//     (Discord channel never sees the Telegram bot token, etc.)
//   - Returns { deploymentId, agentId }

interface CapturedTx {
  agentCreate?: any;
  openClawDeploymentCreate?: any;
  openClawChannelCreates: any[];
  agentDeploymentCreate?: any;
}

function makePrismaStub() {
  const captured: CapturedTx = { openClawChannelCreates: [] };

  const txClient = {
    agent: {
      async create(args: any) {
        captured.agentCreate = args;
        return { id: "agent_new" };
      },
    },
    openClawDeployment: {
      async create(args: any) {
        captured.openClawDeploymentCreate = args;
        return { id: "openclaw_dep_new" };
      },
    },
    openClawChannel: {
      async create(args: any) {
        captured.openClawChannelCreates.push(args);
        return { id: `chan_${captured.openClawChannelCreates.length}` };
      },
    },
    agentDeployment: {
      async create(args: any) {
        captured.agentDeploymentCreate = args;
        return { id: "agent_dep_new" };
      },
    },
  };

  let txCalls = 0;
  const prisma = {
    async $transaction<T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> {
      txCalls += 1;
      return fn(txClient);
    },
  };

  return {
    prisma,
    captured,
    txCalls: () => txCalls,
  };
}

const happyInput = () => ({
  orgId: "org_1",
  agentSlug: "eliza",
  characterName: "Eliza",
  jobDefinition: { version: "0.1", type: "container", meta: { trigger: "x" }, ops: [] },
  channels: [
    { platform: "discord", envKeys: ["DISCORD_API_TOKEN", "DISCORD_APPLICATION_ID"] },
    { platform: "telegram", envKeys: ["TELEGRAM_BOT_TOKEN"] },
  ],
  envValues: {
    OPENAI_API_KEY: "sk-test",
    DISCORD_API_TOKEN: "disc-test",
    DISCORD_APPLICATION_ID: "app-test",
    TELEGRAM_BOT_TOKEN: "tg-test",
  },
  resourcePlan: {
    market: "MKT-A",
    pricePerSecondUsd: 0.00025,
    replicas: 2,
    tier: "4090",
  },
});

// ============================================
// Agent row
// ============================================

test("persistDeploymentByPrisma creates the Agent row with the right shape", async () => {
  setupEnv();
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();
  const encryptCalls: unknown[] = [];

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => {
      encryptCalls.push(cfg);
      return `cipher:${JSON.stringify(cfg)}`;
    },
  });

  const ac = stub.captured.agentCreate;
  assert.ok(ac, "agent.create should be called");
  assert.equal(ac.data.orgId, "org_1");
  assert.equal(ac.data.name, "Eliza");
  assert.equal(ac.data.slug, "eliza");
  assert.equal(ac.data.framework, "elizaos");
  assert.equal(ac.data.sourceType, "inline");
});

// ============================================
// OpenClawDeployment row
// ============================================

test("persistDeploymentByPrisma encrypts the env blob into OpenClawDeployment.envEncrypted", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();
  const encryptCalls: any[] = [];

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => {
      encryptCalls.push(cfg);
      return `cipher:${JSON.stringify(cfg)}`;
    },
  });

  const opc = stub.captured.openClawDeploymentCreate;
  assert.ok(opc, "openClawDeployment.create should be called");
  assert.equal(opc.data.agentId, "agent_new");
  // The full env blob (every key the character requires) is encrypted into one ciphertext.
  const envCipher = opc.data.envEncrypted;
  assert.ok(envCipher.startsWith("cipher:"));
  const envCfg = JSON.parse(envCipher.slice("cipher:".length));
  assert.equal(envCfg.OPENAI_API_KEY, "sk-test");
  assert.equal(envCfg.DISCORD_API_TOKEN, "disc-test");
});

// ============================================
// OpenClawChannel rows
// ============================================

test("persistDeploymentByPrisma creates one OpenClawChannel per binding with the platform's slice of env", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => `cipher:${JSON.stringify(cfg)}`,
  });

  const created = stub.captured.openClawChannelCreates;
  assert.equal(created.length, 2);
  const byPlatform = Object.fromEntries(created.map((c) => [c.data.platform, c.data]));

  // Discord channel — only Discord env keys, no Telegram bot token leak.
  const discord = byPlatform.discord;
  assert.equal(discord.deploymentId, "openclaw_dep_new");
  assert.equal(discord.enabled, true);
  const discordCfg = JSON.parse(discord.configEncrypted.slice("cipher:".length));
  assert.equal(discordCfg.DISCORD_API_TOKEN, "disc-test");
  assert.equal(discordCfg.DISCORD_APPLICATION_ID, "app-test");
  assert.ok(!("TELEGRAM_BOT_TOKEN" in discordCfg));
  assert.ok(!("OPENAI_API_KEY" in discordCfg));

  // Telegram channel — only Telegram env keys.
  const telegram = byPlatform.telegram;
  const telegramCfg = JSON.parse(telegram.configEncrypted.slice("cipher:".length));
  assert.equal(telegramCfg.TELEGRAM_BOT_TOKEN, "tg-test");
  assert.ok(!("DISCORD_API_TOKEN" in telegramCfg));
});

test("persistDeploymentByPrisma writes no channel rows when the agent has no channels", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();
  const input = { ...happyInput(), channels: [] };
  await persistDeploymentByPrisma(input, {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => `cipher:${JSON.stringify(cfg)}`,
  });
  assert.equal(stub.captured.openClawChannelCreates.length, 0);
});

// ============================================
// AgentDeployment row
// ============================================

test("persistDeploymentByPrisma creates an AgentDeployment row carrying the resource plan", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => `cipher:${JSON.stringify(cfg)}`,
  });

  const ad = stub.captured.agentDeploymentCreate;
  assert.ok(ad, "agentDeployment.create should be called");
  assert.equal(ad.data.agentId, "agent_new");
  assert.equal(ad.data.gpuTier, "4090");
  assert.equal(ad.data.replicas, 2);
  assert.equal(ad.data.status, "pending");
});

// ============================================
// Transaction + return value
// ============================================

test("persistDeploymentByPrisma runs every write inside a single $transaction", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => `cipher:${JSON.stringify(cfg)}`,
  });

  assert.equal(stub.txCalls(), 1);
});

test("persistDeploymentByPrisma returns the agent + AgentDeployment ids", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();

  const result = await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    encryptConfig: (cfg) => `cipher:${JSON.stringify(cfg)}`,
  });

  // deploymentId surfaces the AgentDeployment id (not the OpenClawDeployment id) —
  // that's what the launch route returns to the client and what the runway/billing
  // routes key off via Agent → AgentDeployment.
  assert.equal(result.deploymentId, "agent_dep_new");
  assert.equal(result.agentId, "agent_new");
});

// ============================================
// Encryption injection (no plaintext leaks)
// ============================================

test("persistDeploymentByPrisma never writes plaintext env values to OpenClawDeployment / OpenClawChannel", async () => {
  const { persistDeploymentByPrisma } = await import(
    "../services/persistDeployment.js"
  );
  const stub = makePrismaStub();

  await persistDeploymentByPrisma(happyInput(), {
    prisma: stub.prisma as any,
    // Injected encryptConfig is the only path the values take into Prisma.
    encryptConfig: () => "ENCRYPTED",
  });

  const opc = stub.captured.openClawDeploymentCreate;
  assert.equal(opc.data.envEncrypted, "ENCRYPTED");
  for (const chan of stub.captured.openClawChannelCreates) {
    assert.equal(chan.data.configEncrypted, "ENCRYPTED");
  }
});
