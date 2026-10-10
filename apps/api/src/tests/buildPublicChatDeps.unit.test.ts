import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentChatDeps } from "../services/agentChat.js";
import {
  bindPublicChatDeps,
  widgetConversationSessionId,
  type PublicChatBindings,
  type PublicChatPrisma,
} from "../services/buildPublicChatDeps.js";
import { createFailClosedLimiter, createMemoryLimiterStore } from "../services/failClosedLimiter.js";
import { PlanLimitError } from "../services/plans.js";
import { runPublicChat, type PublicChatLimitConfig } from "../services/publicChat.js";
import { issueTrialSession } from "../services/trialSession.js";
import { hashBucket, ipBucket } from "../services/widgetKeys.js";

// Drives services/buildPublicChatDeps.ts, the composition root of public
// chat, over a fake Prisma: which rows it reads, how it scopes them, and how
// a transcript is written.

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const PUBLIC_KEY = `wpk_${"b".repeat(32)}`;

const LIMITS: PublicChatLimitConfig = {
  widget: { perIpPerMinute: 5, perIpPerDay: 50, perKeyPerMinute: 20, defaultDailyCap: 100 },
  trial: { perIpPerHour: 30, messagesPerSession: 3, signedInPerDay: 4, globalPerMinute: 100, baseDailyMessages: 2 },
  maxOutputTokens: 1024,
  maxToolRounds: 3,
};

const KEY_ROW = {
  id: "key-1",
  orgId: "org-owner",
  agentId: "agent-1",
  allowedOrigins: ["https://shop.example.com"],
  dailyMessageCap: null,
  perIpPerMinute: null,
  storeTranscripts: true,
  enabled: true,
  revokedAt: null,
  lastUsedAt: null,
};

function fakePrisma() {
  const calls: Array<[string, any]> = [];
  let messageCount = 4;
  const prisma: PublicChatPrisma = {
    widgetKey: {
      findUnique: async (args) => {
        calls.push(["widgetKey.findUnique", args]);
        return args.where.publicKey === PUBLIC_KEY ? KEY_ROW : null;
      },
      updateMany: async (args) => {
        calls.push(["widgetKey.updateMany", args]);
        return { count: 1 };
      },
    },
    agentListing: {
      // Two readers: Try it by slug, and a page key's use listing by agent
      // (covered in pageKeySoldAtAPrice.unit.test.ts).
      findFirst: (async (args: { where: { slug?: string } }) => {
        calls.push(["agentListing.findFirst", args]);
        if (args.where.slug !== "support-pro") return null;
        return {
          id: "listing-1",
          slug: "support-pro",
          agentId: "agent-pub",
          publisherId: "org-publisher",
          trialFundedDailyCap: 25,
          sells: "use",
          agent: { orgId: "org-publisher", entrypoint: "chat", systemPrompt: "Be brief." },
        };
      }) as PublicChatPrisma["agentListing"]["findFirst"],
    },
    conversation: {
      upsert: async (args) => {
        calls.push(["conversation.upsert", args]);
        return { id: "conv-1" };
      },
    },
    trialDailyUsage: {
      upsert: async (args) => {
        calls.push(["trialDailyUsage.upsert", args]);
        return {};
      },
    },
    $transaction: async (fn) => {
      calls.push(["$transaction:begin", null]);
      const result = await fn({
        conversation: {
          update: async (args) => {
            calls.push(["tx.conversation.update", args]);
            messageCount += args.data.messageCount.increment;
            return { messageCount };
          },
        },
        message: {
          createMany: async (args) => {
            calls.push(["tx.message.createMany", args]);
            return { count: args.data.length };
          },
        },
      });
      calls.push(["$transaction:commit", null]);
      return result;
    },
  };
  return { prisma, calls };
}

function bindings(over: Partial<PublicChatBindings> = {}) {
  const { prisma, calls } = fakePrisma();
  const bound: PublicChatBindings = {
    prisma,
    limiter: createFailClosedLimiter(createMemoryLimiterStore(() => NOW.getTime())),
    limits: LIMITS,
    secret: SECRET,
    appOrigins: ["https://app.wheelsai.test"],
    turnstileConfigured: false,
    freeModelIds: () => ["free/groq/llama-3.3-70b", "free/google/gemini-flash"],
    meterApiCall: async () => ({ used: 1, limit: 1000 }),
    agentChatDeps: () => {
      throw new Error("agent chat deps must not be built until a chat is prepared");
    },
    now: () => NOW,
    ...over,
  };
  return { deps: bindPublicChatDeps(bound), calls };
}

test("building the deps opens nothing: agent chat is bound on first use", () => {
  const { deps, calls } = bindings();
  assert.equal(typeof deps.prepareChat, "function");
  assert.deepEqual(calls, []);
});

test("a widget key is found by its publishable key, with only the columns chat reads", async () => {
  const { deps, calls } = bindings();
  assert.deepEqual(await deps.loadWidgetKey(PUBLIC_KEY), KEY_ROW);
  assert.equal(await deps.loadWidgetKey(`wpk_${"c".repeat(32)}`), null);
  // A key made for a website is not held to a listing: no listing is read.
  assert.deepEqual(calls.map(([name]) => name), ["widgetKey.findUnique", "widgetKey.findUnique"]);
  const [, args] = calls[0]!;
  assert.deepEqual(args.where, { publicKey: PUBLIC_KEY });
  assert.deepEqual(Object.keys(args.select).sort(), [
    "agent",
    "agentId",
    "allowedOrigins",
    "dailyMessageCap",
    "enabled",
    "id",
    "lastUsedAt",
    "orgId",
    "pageOfAgentId",
    "perIpPerMinute",
    "revokedAt",
    "storeTranscripts",
  ]);
  // Of the agent: whether its page is public (what a page key is held to)
  // and what a task run reads. Not its instructions, tools or secrets.
  assert.deepEqual(args.select.agent, {
    select: { isPublic: true, agentKind: true, kindConfig: true, name: true },
  });
});

test("Try it reads published listings only, and runs the agent in the agent's own organization", async () => {
  const { deps, calls } = bindings();
  assert.deepEqual(await deps.loadTrialListing("support-pro"), {
    id: "listing-1",
    slug: "support-pro",
    agentId: "agent-pub",
    agentOrgId: "org-publisher",
    publisherId: "org-publisher",
    agentEntrypoint: "chat",
    trialFundedDailyCap: 25,
    // What the listing sells, and what a held answer is checked against.
    sells: "use",
    agentInstructions: "Be brief.",
  });
  assert.equal(await deps.loadTrialListing("draft-listing"), null);
  assert.deepEqual(calls[0]![1].where, { slug: "support-pro", status: "published" });
});

test("addresses are bucketed and keyed; a session is verified with the same secret and bucket", () => {
  const { deps } = bindings();
  const bucket = deps.bucketOf("2001:db8:1:2::1");
  assert.equal(bucket, hashBucket(ipBucket("2001:db8:1:2:ffff::9"), SECRET), "one /64, one bucket");
  assert.ok(!bucket.includes("2001"));
  assert.notEqual(bucket, deps.bucketOf("2001:db8:1:3::1"));
  assert.equal(deps.bucketOf(undefined), hashBucket("unknown", SECRET));

  const { token } = issueTrialSession(
    { listingId: "listing-1", orgId: null, ipBucketHash: bucket },
    { secret: SECRET, now: () => NOW },
  );
  assert.equal(deps.verifyTrialSession({ token, listingId: "listing-1", ipBucketHash: bucket }).ok, true);
  assert.deepEqual(deps.verifyTrialSession({ token, listingId: "listing-1", ipBucketHash: deps.bucketOf("203.0.113.7") }), {
    ok: false,
    reason: "network_changed",
  });
});

test("anonymous Try it is allowed only while Turnstile is configured; the trial model is the first free one", () => {
  assert.equal(bindings().deps.anonymousTrialAllowed(), false);
  assert.equal(bindings({ turnstileConfigured: true }).deps.anonymousTrialAllowed(), true);
  assert.equal(bindings().deps.trialModelId(), "free/groq/llama-3.3-70b");
  assert.equal(bindings({ freeModelIds: () => [] }).deps.trialModelId(), null);
});

test("a used-up plan is 'false'; any other meter failure is not swallowed", async () => {
  assert.equal(await bindings().deps.meterOwnerCall("org-owner"), true);
  const exhausted = bindings({
    meterApiCall: async () => {
      throw new PlanLimitError("The Starter plan includes 1,000 API calls", "starter", "monthlyApiCalls");
    },
  });
  assert.equal(await exhausted.deps.meterOwnerCall("org-owner"), false);
  const broken = bindings({
    meterApiCall: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(broken.deps.meterOwnerCall("org-owner"), /boom/);
});

test("funded holds are bound only when the caller brings them", () => {
  assert.equal(bindings().deps.holdFundedMessage, undefined);
  const hold = async () => ({ ok: false as const });
  assert.equal(bindings({ holdFundedMessage: hold }).deps.holdFundedMessage, hold);
});

test("a transcript is one conversation per key and visitor session, in the owner's organization", async () => {
  const { deps, calls } = bindings();
  await deps.writeTranscript!({
    orgId: "org-owner",
    agentId: "agent-1",
    widgetKeyId: "key-1",
    sessionId: "visitor-session-0001",
    origin: "https://shop.example.com",
    userMessage: "what are your hours?",
    assistantMessage: "9 to 5.",
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["conversation.upsert", "$transaction:begin", "tx.conversation.update", "tx.message.createMany", "$transaction:commit"],
    "the upsert, which can hit the unique constraint, runs outside the transaction",
  );
  const upsert = calls[0]![1];
  assert.deepEqual(upsert.where, {
    orgId_sessionId: { orgId: "org-owner", sessionId: "web:key-1:visitor-session-0001" },
  });
  assert.deepEqual(upsert.create.metadata, {
    channel: "web",
    origin: "https://shop.example.com",
    widgetKeyId: "key-1",
  });
  assert.equal(upsert.create.agentId, "agent-1");
  assert.deepEqual(upsert.update, {}, "an existing conversation is not rewritten");

  // Sequence numbers come from the atomic increment (4 -> 6): 5 and 6.
  assert.deepEqual(calls[2]![1].data, { messageCount: { increment: 2 }, lastMessageAt: NOW });
  assert.deepEqual(calls[3]![1].data, [
    { conversationId: "conv-1", role: "user", content: "what are your hours?", sequenceNum: 5 },
    { conversationId: "conv-1", role: "assistant", content: "9 to 5.", sequenceNum: 6 },
  ]);

  // No session id from the client: still stored, as a conversation of its own.
  const first = widgetConversationSessionId("key-1", null);
  assert.match(first, /^web:key-1:anon-[0-9a-f-]{36}$/);
  assert.notEqual(first, widgetConversationSessionId("key-1", null));
});

test("lastUsedAt is a compare-and-set on the value that was read; a platform trial message is counted per day", async () => {
  const { deps, calls } = bindings();
  const previous = new Date("2026-10-10T11:00:00.000Z");
  await deps.markKeyUsed!({ id: "key-1", previous, at: NOW });
  assert.deepEqual(calls[0], [
    "widgetKey.updateMany",
    { where: { id: "key-1", lastUsedAt: previous }, data: { lastUsedAt: NOW } },
  ]);

  await deps.recordPlatformTrialMessage!({ listingId: "listing-1", day: "2026-10-10" });
  assert.deepEqual(calls[1], [
    "trialDailyUsage.upsert",
    {
      where: { listingId_day: { listingId: "listing-1", day: "2026-10-10" } },
      create: { listingId: "listing-1", day: "2026-10-10", baseCount: 1 },
      update: { baseCount: { increment: 1 } },
    },
  ]);
});

test("bound end to end: a widget message reaches agent chat as a public caller of the key's organization", async () => {
  const seen: unknown[] = [];
  const chatDeps = {
    loadAgent: async (where: unknown) => {
      seen.push(where);
      return null;
    },
    skillKeys: () => [],
  } as unknown as AgentChatDeps;
  const { deps } = bindings({ agentChatDeps: () => chatDeps });
  const result = await runPublicChat(
    {
      surface: { kind: "widget", publicKey: PUBLIC_KEY, origin: "https://shop.example.com" },
      ip: "203.0.113.7",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      signal: new AbortController().signal,
    },
    deps,
  );
  // The agent was looked up scoped to the key's own organization, and is gone.
  assert.deepEqual(seen, [{ orgId: "org-owner", id: "agent-1" }]);
  assert.deepEqual(result, {
    kind: "refused",
    refusal: { status: 404, code: "widget_key_not_found", message: "Not found." },
  });
});

// Wiring pins, in the style of the other composition-root tests.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(HERE, "..", relative), "utf8");

test("the production deps use the fail-closed Redis limiter and the one agent-chat composition root", () => {
  const root = source("services/buildPublicChatDeps.ts");
  assert.match(root, /limiter: publicChatLimiter,/);
  // Opened on first use, and never asked before its connection attempt is
  // over: a command sent to a client that is still connecting would fail,
  // and failing closed would refuse the first visitors after every start.
  assert.match(root, /consume: async \(rules\) => \(await connectedLimiter\(\)\)\.consume\(rules\)/);
  assert.match(root, /limiterConnected = limiterRedis\.connect\(\)\.catch\(/);
  assert.match(root, /await limiterConnected;/);
  assert.match(root, /createFailClosedLimiter\(createRedisLimiterStore\(/);
  assert.match(root, /enableOfflineQueue: false/);
  assert.match(root, /commandTimeout: 500/);
  assert.match(root, /defineCommand\(LIMITER_COMMAND, \{ lua: LIMITER_LUA \}\)/);
  assert.match(root, /buildAgentChatDeps\(\{ continuations: false \}\)/);
  assert.match(root, /prepareAgentChat\(input, bindings\.agentChatDeps\(\)\)/);
  assert.match(root, /turnstileConfigured: Boolean\(env\.TURNSTILE_SITE_KEY && env\.TURNSTILE_SECRET_KEY\)/);
});

test("agent chat's own deps pass a public caller's fail-closed flag to the free-tier limiter", () => {
  const root = source("services/buildAgentChatDeps.ts");
  assert.match(root, /checkFreeTierLimit: \(orgId, \{ failClosed \}\) => checkFreeTierLimit\(orgId, \{ failClosed \}\)/);
  // Try it runs on the platform's allowance: not the organization's usage.
  assert.match(root, /if \(record\.source === "trial"\) return;/);
});
