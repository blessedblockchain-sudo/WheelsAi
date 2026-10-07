import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import "./unitEnv.js";

// Wiring pins for the web chat channel and Try it, in the style of
// channelStackWiring: the routes, the reaper and the CORS policy are
// complete and unit-tested on fakes, and none of that matters if index.ts
// does not mount them or the production factories do not reach Prisma.
// Un-mounting any of it must fail here, not in a demo.
//
// Nothing below opens a network connection: the fail-closed limiter's Redis
// is opened on first use, and no test here consumes from it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(HERE, "..", relative), "utf8");

async function getPrisma(): Promise<any> {
  const { prisma } = await import("@wheelsai/db");
  return prisma;
}

test("index.ts registers CORS through the per-path policy", () => {
  const index = source("index.ts");
  assert.match(index, /import \{ corsOptionsFor \} from "\.\/lib\/corsPolicy\.js"/);
  assert.match(index, /delegator: \(request, callback\) => callback\(null, corsOptionsFor\(request, corsConfig\)\)/);
  assert.match(index, /corsConfig = \{ corsOrigin: env\.CORS_ORIGIN, isDev: env\.NODE_ENV === "development" \}/);
  // No second, static registration left beside it.
  assert.equal(index.split("app.register(cors").length - 1, 1);
  assert.ok(!/origin: env\.NODE_ENV === "development" \? true : env\.CORS_ORIGIN/.test(index));
});

test("index.ts mounts the widget, the owner's web channel routes and Try it, after the auth plugin and the error handler", () => {
  const index = source("index.ts");
  const at = (needle: string | RegExp) => {
    const position = typeof needle === "string" ? index.indexOf(needle) : index.search(needle);
    assert.ok(position > 0, `index.ts is missing ${needle}`);
    return position;
  };
  const widget = at('app.register(createWidgetRoutesProduction(), { prefix: "/api/widget" })');
  const owner = at('app.register(createWebChannelRoutesProduction(), { prefix: "/api/channels/web" })');
  const tryIt = at('app.register(createTryItRoutesProduction(), { prefix: "/api/marketplace" })');
  const authPlugin = at("await registerAuthPlugins(app)");
  const errorHandler = at("app.setErrorHandler(globalErrorHandler)");
  for (const mount of [widget, owner, tryIt]) {
    assert.ok(mount > authPlugin, "a route plugin inherits only the hooks present when it registers");
    assert.ok(mount > errorHandler);
  }
});

test("index.ts starts and stops the trial-charge reaper and closes the public chat limiter", () => {
  const index = source("index.ts");
  assert.match(index, /await startTrialChargeReapQueue\(\);/);
  assert.match(index, /await stopTrialChargeReapQueue\(\);/);
  assert.match(index, /await closePublicChatConnections\(\);/);
  // Opened before traffic: a limiter asked while still connecting refuses.
  assert.match(index, /await warmPublicChatLimiter\(\);/);
});

test("the queues barrel exports the reaper's start and stop", async () => {
  const queues = await import("../queues/index.js");
  assert.equal(typeof queues.startTrialChargeReapQueue, "function");
  assert.equal(typeof queues.stopTrialChargeReapQueue, "function");
});

test("the widget's production deps read the key through Prisma, by its public key", async () => {
  const p = await getPrisma();
  const original = p.widgetKey.findUnique;
  const queried: any[] = [];
  try {
    p.widgetKey.findUnique = async (args: any) => {
      queried.push(args);
      if (args.where.publicKey !== "wpk_known") return null;
      return args.select.agent
        ? {
            orgId: "org-1",
            allowedOrigins: ["https://shop.example.com"],
            title: null,
            greeting: null,
            primaryColor: null,
            position: "bottom-right",
            storeTranscripts: false,
            hideBranding: false,
            enabled: true,
            revokedAt: null,
            agent: { name: "Support Bot" },
          }
        : { id: "key-1", orgId: "org-1", agentId: "agent-1" };
    };
    const { buildWidgetRouteDeps } = await import("../routes/widgetBindings.js");
    const deps = buildWidgetRouteDeps();

    const config = await deps.config.loadKeyConfig("wpk_known");
    assert.equal(config?.agentName, "Support Bot");
    assert.equal(config?.orgId, "org-1");
    assert.ok(!("agent" in (config as object)));
    assert.equal(await deps.config.loadKeyConfig("wpk_unknown"), null);

    // The chat side: the same table, through the public chat composition root.
    const key = await deps.chat.loadWidgetKey("wpk_known");
    assert.equal(key?.id, "key-1");
    assert.deepEqual(
      queried.map((args) => args.where),
      [{ publicKey: "wpk_known" }, { publicKey: "wpk_unknown" }, { publicKey: "wpk_known" }],
    );
  } finally {
    p.widgetKey.findUnique = original;
  }
});

test("the widget and Try it share one set of public chat deps (one limiter, one set of counters)", async () => {
  const { buildWidgetRouteDeps } = await import("../routes/widgetBindings.js");
  const { buildTryItRouteDeps } = await import("../routes/tryItBindings.js");
  const { buildWebChannelDeps } = await import("../routes/webChannelBindings.js");
  const { publicChatLimiter } = await import("../services/buildPublicChatDeps.js");
  const widget = buildWidgetRouteDeps();
  const tryIt = buildTryItRouteDeps();
  assert.equal(widget.chat, tryIt.chat);
  assert.equal(widget.chat.limiter, publicChatLimiter);
  assert.equal(widget.config.limiter, publicChatLimiter);
  assert.equal(tryIt.sessions.limiter, publicChatLimiter);
  // The owner's "today" reads the counter the chat counts on.
  assert.equal(buildWebChannelDeps().limiter, publicChatLimiter);
});

test("without the Turnstile keys the production Try it has no anonymous door; without a price it has no funded messages", async () => {
  const { env } = await import("../config/env.js");
  const { buildTryItRouteDeps } = await import("../routes/tryItBindings.js");
  const { fundedHoldFromEnv } = await import("../services/buildPublicChatDeps.js");
  const deps = buildTryItRouteDeps();
  assert.equal(deps.sessions.turnstile === null, !(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY));
  assert.equal(deps.chat.anonymousTrialAllowed(), Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY));
  assert.equal(deps.fundedMessageCents, env.TRIAL_FUNDED_MESSAGE_CENTS ?? null);
  assert.equal(fundedHoldFromEnv() === undefined, env.TRIAL_FUNDED_MESSAGE_CENTS === undefined);

  const bindings = source("routes/tryItBindings.ts");
  assert.match(bindings, /expectedAction: TRY_IT_TURNSTILE_ACTION/);
  assert.match(bindings, /expectedCdata: listingId/);
  assert.match(bindings, /registry\.modeBlock\(skill, \{ mode: "public" \}\)/);
  const root = source("services/buildPublicChatDeps.ts");
  assert.match(root, /buildPublicChatDeps\(\{ holdFundedMessage: fundedHoldFromEnv\(\) \}\)/);
  assert.match(root, /createTrialFunding\(prisma as unknown as TrialFundingDb/);
});

test("the production Try it route answers availability for a published listing through Prisma, and 404 otherwise", async () => {
  const p = await getPrisma();
  const original = p.agentListing.findFirst;
  const queried: any[] = [];
  try {
    p.agentListing.findFirst = async (args: any) => {
      queried.push(args.where);
      if (args.where.slug !== "support-pro") return null;
      return {
        id: "11111111-1111-4111-8111-111111111111",
        agent: {
          entrypoint: "chat",
          modelConfig: { externalModel: "openai/gpt-4o" },
          tools: [{ name: "calculator" }, { name: "file_write" }, { name: "http_request" }, { name: "file_read" }],
        },
      };
    };
    const { createTryItRoutesProduction } = await import("../routes/tryItBindings.js");
    const app = Fastify();
    app.decorateRequest("auth", null);
    await app.register(createTryItRoutesProduction(), { prefix: "/api/marketplace" });

    const res = await app.inject({ method: "GET", url: "/api/marketplace/listings/support-pro/try" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // Published only: the status is part of the query.
    assert.deepEqual(queried, [{ slug: "support-pro", status: "published" }]);
    // What the real skills registry withholds from a public audience.
    assert.deepEqual(body.disabledTools, ["file_write", "http_request", "file_read"]);
    assert.ok(body.gate === "signin" || body.gate === "turnstile");
    assert.equal(typeof body.limits.messagesPerSession, "number");
    if (body.model) assert.equal(body.model.substituted, true);

    const missing = await app.inject({ method: "GET", url: "/api/marketplace/listings/nope/try" });
    assert.equal(missing.statusCode, 404);

    // The publisher's routes are behind the real auth guard.
    const settings = await app.inject({
      method: "GET",
      url: "/api/marketplace/listings/11111111-1111-4111-8111-111111111111/trial",
    });
    assert.equal(settings.statusCode, 401);
  } finally {
    p.agentListing.findFirst = original;
  }
});

test("the production owner routes exist and refuse a caller with no identity", async () => {
  const { createWebChannelRoutesProduction, snippetAddresses } = await import("../routes/webChannelBindings.js");
  const app = Fastify();
  app.decorateRequest("auth", null);
  await app.register(createWebChannelRoutesProduction(), { prefix: "/api/channels/web" });
  assert.equal((await app.inject({ method: "GET", url: "/api/channels/web/keys" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/channels/web/keys" })).statusCode, 401);

  // Development falls back to local addresses; anywhere else it is the
  // environment or nothing.
  const bindings = source("routes/webChannelBindings.ts");
  assert.match(bindings, /env\.PUBLIC_WEB_URL \?\? \(dev \? env\.CORS_ORIGIN : null\)/);
  assert.match(bindings, /env\.PUBLIC_API_URL \?\? \(dev \? `http:\/\/localhost:\$\{env\.API_PORT\}` : null\)/);
  assert.equal(typeof snippetAddresses().webUrl, "string");
});

test("the public stats and each agent's public page name the web channel from one constant", async () => {
  const { LIVE_CHAT_CHANNELS, LIVE_CHANNEL_PLATFORMS, WEB_CHAT_CHANNEL } = await import("../routes/channelWebhooks.js");
  assert.deepEqual([...LIVE_CHAT_CHANNELS], [...LIVE_CHANNEL_PLATFORMS, "web"]);
  assert.equal(WEB_CHAT_CHANNEL, "web");
  // Webhook routing does not accept "web": the widget has routes of its own.
  assert.ok(!(LIVE_CHANNEL_PLATFORMS as readonly string[]).includes("web"));
  assert.match(source("routes/publicStats.ts"), /channelPlatforms: \[\.\.\.LIVE_CHAT_CHANNELS\]/);
  assert.match(source("services/loadPublicAgent.ts"), /WEB_CHAT_CHANNEL/);
});
