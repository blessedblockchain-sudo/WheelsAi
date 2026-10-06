import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Wiring pins for marketplace per-request metering (W2 money keystone).
//
// `recordMarketplaceUsage` sat in the codebase for months with ZERO
// callers — the money-IN half of the marketplace loop existed as a
// function nobody invoked. These tests pin the replacement to its actual
// call sites so it cannot quietly become dead code again, and pin the
// behaviour every one of those sites depends on: no charge for ordinary
// agents, no execution for a buyer who cannot pay, refund when execution
// fails.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

function source(relative: string): string {
  return readFileSync(path.join(SRC, relative), "utf8");
}

async function withStubbedPrisma<T>(
  stub: {
    install?: unknown;
    tx?: Record<string, unknown>;
  },
  body: (calls: { transactions: number }) => Promise<T>,
): Promise<T> {
  setupEnv();
  const { prisma } = (await import("../lib/prisma.js")) as unknown as {
    prisma: Record<string, any>;
  };
  const originalFindFirst = prisma.agentInstall?.findFirst;
  const originalSubscriptionFind = prisma.agentSubscription?.findUnique;
  const originalTransaction = prisma.$transaction;
  const calls = { transactions: 0 };

  prisma.agentInstall = {
    ...(prisma.agentInstall ?? {}),
    findFirst: async () => stub.install ?? null,
  };
  // Billing checks for a paid-up monthly subscription first; these installs
  // have none.
  prisma.agentSubscription = {
    ...(prisma.agentSubscription ?? {}),
    findUnique: async () => null,
  };
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => {
    calls.transactions += 1;
    return fn(stub.tx ?? {});
  };

  try {
    return await body(calls);
  } finally {
    if (originalFindFirst) prisma.agentInstall.findFirst = originalFindFirst;
    if (originalSubscriptionFind) prisma.agentSubscription.findUnique = originalSubscriptionFind;
    prisma.$transaction = originalTransaction;
  }
}

const INSTALL_ROW = {
  id: "ins_1",
  listingId: "lst_1",
  buyerId: "org_buyer",
  status: "active",
  listing: {
    title: "Support Triage",
    status: "published",
    publisherId: "org_pub",
    pricingModel: "per_request",
    pricePerRequestCents: 250n,
  },
};

test("an agent that is not a marketplace install is never charged", async () => {
  await withStubbedPrisma({ install: null }, async (calls) => {
    const { withMarketplaceMetering } = await import(
      "../services/marketplaceMeteringProduction.js"
    );
    const result = await withMarketplaceMetering(
      { agentId: "agent_1", orgId: "org_1" },
      async () => "ran",
    );
    assert.equal(result, "ran");
    // No transaction opened at all — ordinary inference pays no billing
    // tax beyond one indexed lookup.
    assert.equal(calls.transactions, 0);
  });
});

test("a buyer who cannot pay is refused and the agent never runs", async () => {
  let ran = false;
  await withStubbedPrisma(
    {
      install: INSTALL_ROW,
      tx: {
        creditBalance: {
          updateMany: async () => ({ count: 0 }),
          findUnique: async () => ({ balanceCents: 10n }),
        },
        marketplaceRevenue: { create: async () => ({ id: "rev_1" }) },
        creditTransaction: { create: async () => ({}) },
      },
    },
    async () => {
      const { withMarketplaceMetering } = await import(
        "../services/marketplaceMeteringProduction.js"
      );
      const { MarketplacePaymentRequiredError } = await import(
        "../services/marketplaceMetering.js"
      );

      await assert.rejects(
        withMarketplaceMetering({ agentId: "a", orgId: "o" }, async () => {
          ran = true;
          return "should not happen";
        }),
        (err: unknown) => {
          assert.ok(err instanceof MarketplacePaymentRequiredError);
          assert.equal(err.requiredCents, 250n);
          assert.equal(err.balanceCents, 10n);
          return true;
        },
      );
    },
  );
  assert.equal(ran, false);
});

test("an uninstalled clone refuses to run instead of running for free", async () => {
  let ran = false;
  await withStubbedPrisma(
    { install: { ...INSTALL_ROW, status: "uninstalled" } },
    async (calls) => {
      const { withMarketplaceMetering } = await import(
        "../services/marketplaceMeteringProduction.js"
      );
      const { MarketplaceLicenceRevokedError } = await import(
        "../services/marketplaceMetering.js"
      );
      await assert.rejects(
        withMarketplaceMetering({ agentId: "a", orgId: "o" }, async () => {
          ran = true;
          return "leaked";
        }),
        (err: unknown) => err instanceof MarketplaceLicenceRevokedError,
      );
      // Refusal, not a charge — the buyer is not billed for a request the
      // platform declined to run.
      assert.equal(calls.transactions, 0);
    },
  );
  assert.equal(ran, false);
});

test("execution that throws is refunded, not settled", async () => {
  const statuses: string[] = [];
  await withStubbedPrisma(
    {
      install: INSTALL_ROW,
      tx: {
        creditBalance: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async () => ({ balanceCents: 750n }),
          update: async () => ({ balanceCents: 1000n }),
        },
        marketplaceRevenue: {
          create: async () => ({ id: "rev_1" }),
          updateMany: async (args: { data: { status: string } }) => {
            statuses.push(args.data.status);
            return { count: 1 };
          },
        },
        creditTransaction: { create: async () => ({}) },
        publisherProfile: { update: async () => ({}) },
        agentInstall: { update: async () => ({}) },
        agentListing: { update: async () => ({}) },
      },
    },
    async () => {
      const { withMarketplaceMetering } = await import(
        "../services/marketplaceMeteringProduction.js"
      );
      await assert.rejects(
        withMarketplaceMetering({ agentId: "a", orgId: "o" }, async () => {
          throw new Error("model exploded");
        }),
        /model exploded/,
      );
    },
  );
  assert.deepEqual(statuses, ["refunded"]);
});

test("execution that succeeds settles exactly once", async () => {
  const statuses: string[] = [];
  await withStubbedPrisma(
    {
      install: INSTALL_ROW,
      tx: {
        creditBalance: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async () => ({ balanceCents: 750n }),
          update: async () => ({ balanceCents: 1000n }),
        },
        marketplaceRevenue: {
          create: async () => ({ id: "rev_1" }),
          updateMany: async (args: { data: { status: string } }) => {
            statuses.push(args.data.status);
            return { count: 1 };
          },
        },
        creditTransaction: { create: async () => ({}) },
        publisherProfile: { update: async () => ({}) },
        agentInstall: { update: async () => ({}) },
        agentListing: { update: async () => ({}) },
      },
    },
    async () => {
      const { withMarketplaceMetering } = await import(
        "../services/marketplaceMeteringProduction.js"
      );
      assert.equal(
        await withMarketplaceMetering({ agentId: "a", orgId: "o" }, async () => "answer"),
        "answer",
      );
    },
  );
  assert.deepEqual(statuses, ["settled"]);
});

// ============================================
// Call-site pins
// ============================================

test("every real inference path meters", () => {
  // Interactive chat — the path a buyer actually uses. The metering lives
  // in the shared agent-chat service (the playground and the /v1 agent API
  // both run through it), bound to the real charge in its composition root.
  const agentChat = source("services/agentChat.ts");
  assert.match(agentChat, /await deps\.beginMetering\(\{ agentId, orgId \}\)/);
  assert.match(agentChat, /meter\?\.settle\(\)/);
  assert.match(agentChat, /meter\?\.refund\(/);
  assert.match(agentChat, /kind: "payment_required"/);
  assert.match(agentChat, /kind: "licence_revoked"/);
  assert.ok(
    agentChat.indexOf("await deps.beginMetering(") < agentChat.indexOf("deps.runChat("),
    "the buyer is charged (or refused) before the model is called",
  );
  assert.match(
    source("services/buildAgentChatDeps.ts"),
    /beginMetering: beginMarketplaceMetering,/,
    "the production binding is the real charge, not a stub",
  );

  // The playground is an adapter over that service: it must go through it,
  // answer a buyer who cannot pay with 402/403, and hand the stream's charge
  // to the forwarder that settles on delivery.
  const playground = source("routes/playground.ts");
  assert.match(playground, /await prepareAgentChat\(/);
  assert.doesNotMatch(playground, /runChat\(|runChatStream\(/, "no chat path that bypasses the service");
  assert.match(playground, /status\(402\)/);
  assert.match(playground, /status\(403\)/);
  assert.match(playground, /session\.complete\(\)/);
  assert.match(playground, /streamToReply\(reply, started\.chat, \{ meter: session\.meter, abort \}\)/);

  // So is the OpenAI-compatible /v1 agent API, which the unified
  // /v1/chat/completions route reaches through the same handler.
  const v1 = source("routes/agentCompletions.ts");
  assert.match(v1, /await prepareAgentChat\(/);
  assert.doesNotMatch(v1, /runChat\(|runChatStream\(|beginMarketplaceMetering/, "no chat path that bypasses the service");
  assert.match(v1, /openAiError\("marketplace_payment_required"/);
  assert.match(v1, /openAiError\("licence_revoked"/);
  assert.match(v1, /session\.complete\(\)/);
  assert.match(v1, /streamToReply\(reply, started\.chat, \{\n\s+meter: session\.meter,\n\s+abort,/);
  const unified = source("routes/openaiV1.ts");
  assert.match(unified, /completeAgent\(request, reply, \{ agentSlug: target\.slug/);
  assert.doesNotMatch(unified, /prepareAgentChat|runChat\(|runChatStream\(/, "the unified route adds no chat path of its own");

  const sseReply = source("services/sseReply.ts");
  assert.match(sseReply, /forwardAndSettle\(\{/);
  assert.match(sseReply, /\n\s+meter,\n/);
  assert.match(sseReply, /meter\?\.refund\(CLIENT_GONE\)/);

  // Scheduler, "trigger now", orchestration and the test runner all share
  // this one binding, so metering it once covers all four.
  const executor = source("services/scheduledTaskExecutorProduction.ts");
  assert.match(executor, /withMarketplaceMetering/);
  assert.match(executor, /orgId: true/);

  // Graph runs bill per RUN, and refund when the run failed.
  const graph = source("services/runAgentGraph.ts");
  assert.match(graph, /beginMarketplaceMetering/);
  assert.match(graph, /meter\?\.refund\(/);
  assert.match(graph, /meter\?\.settle\(\)/);
});

test("the fabricating usage writer is gone", () => {
  const marketplace = source("services/marketplace.ts");
  assert.doesNotMatch(
    marketplace,
    /export async function recordMarketplaceUsage/,
    "recordMarketplaceUsage accrued creator revenue without debiting a buyer — it must not come back",
  );
});
