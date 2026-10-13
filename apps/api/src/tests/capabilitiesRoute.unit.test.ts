import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import {
  createCapabilitiesRoutes,
  readCapabilities,
  readPaidUse,
  type CapabilitiesReads,
} from "../routes/capabilities.js";
import { buildCapabilitiesDeps, type CapabilitiesEnv } from "../routes/capabilitiesBindings.js";
import { resolveAgentModelId } from "../services/agentModelResolution.js";
import {
  MAX_INCLUDED_USES,
  MAX_PAID_PLANS,
  MAX_TRIAL_USES,
  MIN_EXTRA_USE_PRICE_CENTS,
  MIN_PLAN_PRICE_CENTS,
  TRIAL_DAYS,
} from "../services/listingPlans.js";
import { installTestAuth } from "./jobsApiFakes.js";

// GET /api/capabilities: each answer follows the thing that decides it, a
// caller with no credentials gets 401, and the body names no key, setting,
// address or reason.

/** Catalog entries as config/free-models.ts holds them, secrets-shaped fields included. */
const GROQ = {
  id: "free/groq/llama-3.3-70b",
  provider: "groq",
  modelName: "openai/gpt-oss-120b",
  displayName: "GPT-OSS 120B (Groq)",
  contextLength: 131072,
  baseUrl: "https://api.groq.com/openai/v1",
  envKey: "GROQ_API_KEY",
  notes: "Best free option, fast inference",
} as const;
const GEMINI = {
  id: "free/gemini/gemini-2.5-flash",
  provider: "google",
  modelName: "gemini-2.5-flash",
  displayName: "Gemini 2.5 Flash (Google)",
  contextLength: 1_000_000,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  envKey: "GOOGLE_GEMINI_API_KEY",
  notes: "Large context window",
} as const;

const ALL_OFF: CapabilitiesEnv = {
  PAYOUTS_ENABLED: false,
  PAYOUT_EXECUTOR_INTERVAL_MS: 0,
  AGENT_GPU_ENABLED: false,
  JOB_RUNNER_CONCURRENCY: 0,
};

const OWNER = { "x-test-auth": JSON.stringify({ type: "jwt", orgId: "org_1", userId: "user_owner" }) };
const API_KEY = {
  "x-test-auth": JSON.stringify({ type: "api_key", orgId: "org_1", scopes: ["agents:read"], apiKeyId: "key_1" }),
};

/** The production wiring over settings a test can change between requests. */
async function build() {
  const world = {
    env: { ...ALL_OFF } as CapabilitiesEnv,
    models: [] as Array<typeof GROQ | typeof GEMINI>,
    email: false,
    /** The plan's multiple of the free-model limits, per organization. */
    multiplier: (async () => 1) as (orgId: string) => Promise<number>,
  };
  const app = Fastify();
  installTestAuth(app);
  await app.register(
    createCapabilitiesRoutes(
      buildCapabilitiesDeps({
        env: () => world.env,
        availableFreeModels: () => world.models,
        emailConfigured: () => world.email,
        planRateMultiplier: (orgId) => world.multiplier(orgId),
        auth: async (request: FastifyRequest, reply: FastifyReply) => {
          if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
        },
      }),
    ),
    { prefix: "/api/capabilities" },
  );
  const get = (headers: Record<string, string> = OWNER) =>
    app.inject({ method: "GET", url: "/api/capabilities", headers });
  return { app, world, get };
}

test("with nothing switched on, nothing is available and the shape is still whole", async () => {
  const { app, get } = await build();
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    chat: { models: [], defaultModel: null },
    payouts: { available: false },
    emailDelivery: { available: false },
    agentGpu: { available: false },
    paidTasks: { available: false },
    // Numbers, not switches: they hold whatever is on. ALL_OFF names no daily limit.
    paidUse: {
      perBuyerPerMinute: 10,
      perBuyerPerDay: 200,
      minPricePerUseCents: 5,
      maxPlans: 4,
      maxIncludedUses: 100_000,
      minPlanPriceCents: 100,
      minExtraUsePriceCents: 5,
      maxTrialUses: 50,
      trialDays: 7,
      freeModelDailyAllowance: null,
    },
  });
  await app.close();
});

test("chat lists the models that can answer now, and the default is the one an agent with no model gets", async () => {
  const { app, world, get } = await build();

  world.models = [GROQ, GEMINI];
  let chat = (await get()).json().chat;
  assert.deepEqual(chat.models, [
    { id: GROQ.id, label: "GPT-OSS 120B (Groq)" },
    { id: GEMINI.id, label: "Gemini 2.5 Flash (Google)" },
  ]);
  assert.equal(chat.defaultModel, GROQ.id);

  // The first provider is gone: the list and the default both follow.
  world.models = [GEMINI];
  chat = (await get()).json().chat;
  assert.deepEqual(chat.models, [{ id: GEMINI.id, label: "Gemini 2.5 Flash (Google)" }]);
  assert.equal(chat.defaultModel, GEMINI.id);
  // The same model agent chat itself picks for an agent that names none.
  assert.equal(
    chat.defaultModel,
    resolveAgentModelId({ override: null, modelConfig: {}, availableFreeModelIds: world.models.map((m) => m.id) }),
  );

  world.models = [];
  chat = (await get()).json().chat;
  assert.deepEqual(chat, { models: [], defaultModel: null });
  await app.close();
});

test("each flag follows its own dependency and no other", async () => {
  const { app, world, get } = await build();
  const flags = async () => {
    const body = (await get()).json();
    return {
      payouts: body.payouts.available,
      emailDelivery: body.emailDelivery.available,
      agentGpu: body.agentGpu.available,
      paidTasks: body.paidTasks.available,
    };
  };
  const off = { payouts: false, emailDelivery: false, agentGpu: false, paidTasks: false };
  assert.deepEqual(await flags(), off);

  world.env = { ...ALL_OFF, PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 60_000 };
  assert.deepEqual(await flags(), { ...off, payouts: true });
  // The switch alone settles nothing: no worker is scheduled to pay out.
  world.env = { ...ALL_OFF, PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 0 };
  assert.deepEqual(await flags(), off);
  // And a scheduled worker with the switch off never runs.
  world.env = { ...ALL_OFF, PAYOUTS_ENABLED: false, PAYOUT_EXECUTOR_INTERVAL_MS: 60_000 };
  assert.deepEqual(await flags(), off);

  world.env = { ...ALL_OFF };
  world.email = true;
  assert.deepEqual(await flags(), { ...off, emailDelivery: true });
  world.email = false;

  world.env = { ...ALL_OFF, AGENT_GPU_ENABLED: true };
  assert.deepEqual(await flags(), { ...off, agentGpu: true });

  world.env = { ...ALL_OFF, JOB_RUNNER_CONCURRENCY: 2 };
  assert.deepEqual(await flags(), { ...off, paidTasks: true });

  world.env = { PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 1, AGENT_GPU_ENABLED: true, JOB_RUNNER_CONCURRENCY: 1 };
  world.email = true;
  assert.deepEqual(await flags(), { payouts: true, emailDelivery: true, agentGpu: true, paidTasks: true });
  await app.close();
});

test("a caller with no credentials gets 401 and nothing is read; a session and an API key both get the answer", async () => {
  const { app, world, get } = await build();
  let reads = 0;
  const env = world.env;
  Object.defineProperty(world, "env", {
    get: () => {
      reads += 1;
      return env;
    },
  });

  const anonymous = await get({});
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().chat, undefined);
  assert.equal(reads, 0);

  assert.equal((await get(OWNER)).statusCode, 200);
  const byKey = await get(API_KEY);
  assert.equal(byKey.statusCode, 200);
  assert.deepEqual(Object.keys(byKey.json()), ["chat", "payouts", "emailDelivery", "agentGpu", "paidTasks", "paidUse"]);
  assert.ok(reads > 0);
  await app.close();
});

test("the body names no key, setting, address or reason, whatever is on or off", async () => {
  const { app, world, get } = await build();
  const bodies: string[] = [];
  bodies.push((await get()).body);
  world.models = [GROQ, GEMINI];
  world.email = true;
  world.env = { PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 60_000, AGENT_GPU_ENABLED: true, JOB_RUNNER_CONCURRENCY: 2 };
  bodies.push((await get()).body);
  world.env = { ...ALL_OFF };
  bodies.push((await get()).body);

  for (const body of bodies) {
    // Setting and key names are written in capitals with underscores.
    assert.doesNotMatch(body, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
    assert.doesNotMatch(body, /api[_-]?key|secret|token|password|envKey|baseUrl|modelName/i);
    // No address of any kind: a URL, a host or a wallet.
    assert.doesNotMatch(body, /https?:|:\/\/|www\.|\.com|\.xyz|\.googleapis|localhost|\d+\.\d+\.\d+\.\d+/i);
    assert.doesNotMatch(body, /[1-9A-HJ-NP-Za-km-z]{32,44}/);
    // What, never why.
    assert.doesNotMatch(body, /reason|because|not configured|disabled|missing|error|message/i);

    // Every leaf is one of the documented ones.
    const json = JSON.parse(body) as Record<string, any>;
    assert.deepEqual(Object.keys(json), ["chat", "payouts", "emailDelivery", "agentGpu", "paidTasks", "paidUse"]);
    assert.deepEqual(Object.keys(json.paidUse), [
      "perBuyerPerMinute",
      "perBuyerPerDay",
      "minPricePerUseCents",
      "maxPlans",
      "maxIncludedUses",
      "minPlanPriceCents",
      "minExtraUsePriceCents",
      "maxTrialUses",
      "trialDays",
      "freeModelDailyAllowance",
    ]);
    assert.deepEqual(Object.keys(json.chat), ["models", "defaultModel"]);
    for (const model of json.chat.models) assert.deepEqual(Object.keys(model), ["id", "label"]);
    for (const key of ["payouts", "emailDelivery", "agentGpu", "paidTasks"]) {
      assert.deepEqual(Object.keys(json[key]), ["available"]);
      assert.equal(typeof json[key].available, "boolean");
    }
  }
  await app.close();
});

test("a fact that cannot be read is answered as not available, not as an error", () => {
  const boom = (): never => {
    throw new Error("GROQ_API_KEY is not set at https://api.groq.com/openai/v1");
  };
  const reads: CapabilitiesReads = {
    chatModels: boom,
    payouts: boom,
    emailDelivery: () => true,
    agentGpu: boom,
    paidTasks: () => "yes" as unknown as boolean,
  };
  assert.deepEqual(readCapabilities(reads), {
    chat: { models: [], defaultModel: null },
    payouts: { available: false },
    emailDelivery: { available: true },
    agentGpu: { available: false },
    // Only a real true counts.
    paidTasks: { available: false },
  });
});

test("only the id and the label of a model leave the server", () => {
  const body = readCapabilities({
    chatModels: () => [GROQ, { id: "", label: "nameless" }, GROQ, { id: "free/x/y", label: "" }] as any,
    payouts: () => false,
    emailDelivery: () => false,
    agentGpu: () => false,
    paidTasks: () => false,
  });
  // GROQ carries no `label` here (the wiring maps displayName to it): the id
  // stands in, a model with no id is left out, and a repeat is listed once.
  assert.deepEqual(body.chat.models, [
    { id: GROQ.id, label: GROQ.id },
    { id: "free/x/y", label: "free/x/y" },
  ]);
  assert.equal(body.chat.defaultModel, GROQ.id);
});

// ============================================
// paidUse: the numbers a Sell screen and a buyer's page show
// ============================================

test("paidUse carries the buyer's limits, the smallest price of a use, and the caller's own allowance on its plan", async () => {
  const { app, world, get } = await build();
  const asked: string[] = [];
  world.env = { ...ALL_OFF, FREE_TIER_RPD: 200 };
  world.multiplier = async (orgId) => {
    asked.push(orgId);
    return 1;
  };
  assert.deepEqual((await get()).json().paidUse, {
    perBuyerPerMinute: 10,
    perBuyerPerDay: 200,
    minPricePerUseCents: 5,
    // The numbers of a plan, from the rules that check one (services/listingPlans.ts).
    maxPlans: MAX_PAID_PLANS,
    maxIncludedUses: MAX_INCLUDED_USES,
    minPlanPriceCents: Number(MIN_PLAN_PRICE_CENTS),
    minExtraUsePriceCents: Number(MIN_EXTRA_USE_PRICE_CENTS),
    // The numbers of a free trial, from the same rules.
    maxTrialUses: MAX_TRIAL_USES,
    trialDays: TRIAL_DAYS,
    freeModelDailyAllowance: 200,
  });
  assert.deepEqual(
    [MAX_PAID_PLANS, MAX_INCLUDED_USES, MIN_PLAN_PRICE_CENTS, MIN_EXTRA_USE_PRICE_CENTS, MAX_TRIAL_USES, TRIAL_DAYS],
    [4, 100_000, 100n, 5n, 50, 7],
  );
  // The caller's organization, never one named in the request.
  assert.deepEqual(asked, ["org_1"]);

  // A plan with a multiple, as the chat core's own check multiplies it.
  world.multiplier = async () => 5;
  assert.equal((await get(API_KEY)).json().paidUse.freeModelDailyAllowance, 1000);

  // A plan that cannot be read counts as the Starter multiple, as it does there.
  world.multiplier = async () => {
    throw new Error("PLAN_LOOKUP_NEVER_SHOWN");
  };
  const res = await get();
  assert.equal(res.json().paidUse.freeModelDailyAllowance, 200);
  assert.ok(!res.body.includes("PLAN_LOOKUP_NEVER_SHOWN"));
  await app.close();
});

test("paidUse fails closed on the allowance alone: an unreadable or senseless number is null, the limits stay", async () => {
  const fixed = {
    perBuyerPerMinute: 10,
    perBuyerPerDay: 200,
    minPricePerUseCents: 5,
    maxPlans: 4,
    maxIncludedUses: 100_000,
    minPlanPriceCents: 100,
    minExtraUsePriceCents: 5,
    maxTrialUses: 50,
    trialDays: 7,
  };
  const boom = async () => {
    throw new Error("down");
  };
  assert.deepEqual(await readPaidUse({ freeModelDailyAllowance: boom }, "org_1"), { ...fixed, freeModelDailyAllowance: null });
  for (const senseless of [Number.NaN, Number.POSITIVE_INFINITY, -1, "200" as unknown as number]) {
    assert.deepEqual(await readPaidUse({ freeModelDailyAllowance: async () => senseless }, "org_1"), {
      ...fixed,
      freeModelDailyAllowance: null,
    });
  }
  assert.equal((await readPaidUse({ freeModelDailyAllowance: async () => 0 }, "org_1")).freeModelDailyAllowance, 0);
  assert.equal((await readPaidUse({ freeModelDailyAllowance: async () => 300.9 }, "org_1")).freeModelDailyAllowance, 300);
});
