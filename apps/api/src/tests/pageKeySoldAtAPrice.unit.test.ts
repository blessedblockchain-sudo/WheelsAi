import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { createWidgetRoutes } from "../routes/widget.js";
import { bindPublicChatDeps, type PublicChatPrisma } from "../services/buildPublicChatDeps.js";
import { runPublicChat, type PublicWidgetKey } from "../services/publicChat.js";
import { runPublicTask } from "../services/publicTask.js";
import { APP_ORIGIN, fakeChat, KEY, LIMITS, NOW, PAGE_KEY, PUBLIC_KEY, SECRET, type FakeChat } from "./publicChatHarness.js";

// The key of an agent's public page must not answer while a published
// listing sells use of that agent at a price, whatever the key's own switch
// says: the switch is kept right when a listing is published or repriced,
// but two such edits can cross and leave it on. So the listing is read where
// use is admitted. Driven here through the real key load of
// services/buildPublicChatDeps.ts and routes/widgetBindings.ts over one
// in-memory database, on the three doors a page key opens: chat, run and
// the widget's configuration.

type Row = Record<string, any>;

const AGENT_ID = KEY.agentId;
const IP = "203.0.113.7";

const listingOf = (over: Row = {}): Row => ({
  id: "listing-1",
  slug: "brief-writer",
  title: "Brief Writer",
  agentId: AGENT_ID,
  publisherId: KEY.orgId,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 25n,
  monthlyPriceCents: null,
  useAllowedTools: [],
  ...over,
});

interface World {
  h: FakeChat;
  /** Every where clause a listing was read with. */
  listingReads: Row[];
  /** Runs the body with the process's Prisma client reading this world (the configuration's binding uses it). */
  withPrisma<T>(body: () => Promise<T>): Promise<T>;
}

function makeWorld(opts: { key: PublicWidgetKey; listing?: Row | null; listingReadFails?: boolean }): World {
  const listingReads: Row[] = [];
  const models = {
    widgetKey: {
      // The chat side and the configuration side each read their own
      // columns of the same row.
      findUnique: async (args: Row) => {
        if (args.where.publicKey !== PUBLIC_KEY) return null;
        if (!args.select.title) return { ...opts.key };
        return {
          orgId: opts.key.orgId,
          allowedOrigins: opts.key.allowedOrigins,
          title: null,
          greeting: null,
          primaryColor: null,
          position: "bottom-right",
          storeTranscripts: opts.key.storeTranscripts,
          hideBranding: false,
          enabled: opts.key.enabled,
          revokedAt: opts.key.revokedAt,
          pageOfAgentId: opts.key.pageOfAgentId ?? null,
          agent: { name: opts.key.agent?.name ?? "Agent", isPublic: opts.key.agent?.isPublic ?? false },
        };
      },
      updateMany: async () => ({ count: 1 }),
    },
    agentListing: {
      // As findUseListing asks: this agent, published, selling use.
      findFirst: async (args: Row) => {
        listingReads.push(args.where);
        if (opts.listingReadFails) throw new Error("the database is away");
        const listing = opts.listing ?? null;
        if (!listing) return null;
        const hit = Object.entries(args.where).every(([column, value]) => listing[column] === value);
        return hit ? { ...listing } : null;
      },
    },
  };

  const h = fakeChat();
  const bound = bindPublicChatDeps({
    prisma: models as unknown as PublicChatPrisma,
    limiter: h.limiter,
    limits: LIMITS,
    secret: SECRET,
    appOrigins: [APP_ORIGIN],
    turnstileConfigured: false,
    freeModelIds: () => [],
    meterApiCall: async () => ({}),
    agentChatDeps: () => {
      throw new Error("the harness stands in for agent chat");
    },
    now: () => NOW,
    logger: { warn: () => {}, error: () => {} } as never,
  });
  // The harness's stand-in for agent chat, behind the real key load.
  h.deps.loadWidgetKey = bound.loadWidgetKey;

  const withPrisma = async <T>(body: () => Promise<T>): Promise<T> => {
    const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
    const originals: Row = {};
    for (const [name, fake] of Object.entries(models)) {
      originals[name] = prisma[name];
      prisma[name] = fake;
    }
    try {
      return await body();
    } finally {
      for (const [name, original] of Object.entries(originals)) prisma[name] = original;
    }
  };
  return { h, listingReads, withPrisma };
}

/** What each of the three doors answers: the status of a refusal, or 200. */
async function doors(world: World): Promise<{ chat: number; run: number; config: number }> {
  const signal = new AbortController().signal;
  const chat = await runPublicChat(
    {
      surface: { kind: "widget", publicKey: PUBLIC_KEY, origin: APP_ORIGIN },
      ip: IP,
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      signal,
    },
    world.h.deps,
  );
  const run = await runPublicTask(
    { publicKey: PUBLIC_KEY, origin: APP_ORIGIN, ip: IP, body: { input: { topic: "Returns" }, stream: false }, signal },
    world.h.deps,
  );
  const config = await world.withPrisma(async () => {
    const { buildWidgetRouteDeps } = await import("../routes/widgetBindings.js");
    const app = Fastify();
    await app.register(
      createWidgetRoutes({
        chat: world.h.deps,
        config: {
          limiter: world.h.limiter,
          perIpPerMinute: 60,
          // The production read of the key's configuration.
          loadKeyConfig: buildWidgetRouteDeps().config.loadKeyConfig,
          whiteLabel: async () => false,
        },
      }),
      { prefix: "/api/widget" },
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/widget/${PUBLIC_KEY}/config`,
      headers: { origin: APP_ORIGIN },
    });
    if (res.statusCode === 404) assert.equal(res.json().error, "widget_key_not_found");
    await app.close();
    return res.statusCode;
  });
  const status = (result: { kind: string }) =>
    result.kind === "refused" ? (result as unknown as { refusal: { status: number; code: string } }).refusal : { status: 200, code: "" };
  for (const answer of [status(chat), status(run)]) {
    if (answer.status !== 200) assert.equal(answer.code, "widget_key_not_found");
  }
  return { chat: status(chat).status, run: status(run).status, config };
}

const ALL_REFUSED = { chat: 404, run: 404, config: 404 };
const ALL_OPEN = { chat: 200, run: 200, config: 200 };

test("an enabled page key under a published listing that sells use at a price answers 404 on chat, run and config", async () => {
  for (const listing of [
    listingOf(),
    listingOf({ pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 500n }),
  ]) {
    const world = makeWorld({ key: PAGE_KEY, listing });
    assert.equal(PAGE_KEY.enabled, true, "the stored switch was left on");
    assert.deepEqual(await doors(world), ALL_REFUSED, listing.pricingModel);
    // Nothing of the agent ran, and nothing was spent of the key or the plan.
    assert.deepEqual(world.h.chatInputs, []);
    assert.deepEqual(world.h.log, []);
    assert.deepEqual(world.h.keyUsed, []);
    // Read the way every other reader of the listing reads it.
    assert.deepEqual(world.listingReads[0], { agentId: AGENT_ID, status: "published", sells: "use" });
    assert.equal(world.listingReads.length, 3, "once per door");
  }
});

test("the same key works under no listing, a free listing, a priced draft and a listing that sells copies", async () => {
  const cases: Array<[string, Row | null]> = [
    ["no listing", null],
    ["free", listingOf({ pricingModel: "free", pricePerRequestCents: null })],
    ["a price of nothing", listingOf({ pricePerRequestCents: 0n })],
    ["priced draft", listingOf({ status: "draft" })],
    ["priced, archived", listingOf({ status: "archived" })],
    ["copies at a price", listingOf({ sells: "copies" })],
  ];
  for (const [name, listing] of cases) {
    const world = makeWorld({ key: PAGE_KEY, listing });
    assert.deepEqual(await doors(world), ALL_OPEN, name);
    assert.equal(world.h.chatInputs.length, 2, name);
    assert.equal(world.listingReads.length, 3, name);
  }
});

test("a listing that cannot be read leaves the page key not found: it fails closed", async () => {
  const world = makeWorld({ key: PAGE_KEY, listing: null, listingReadFails: true });
  assert.deepEqual(await doors(world), ALL_REFUSED);
  assert.deepEqual(world.h.chatInputs, []);
  assert.equal(world.listingReads.length, 3);
});

test("a key made for a website is not held to the listing and costs no listing read", async () => {
  // The owner's own embed of an agent whose use is sold at a price.
  const websiteKey: PublicWidgetKey = {
    ...KEY,
    allowedOrigins: [],
    pageOfAgentId: null,
    agent: { isPublic: true, agentKind: "task", kindConfig: PAGE_KEY.agent!.kindConfig, name: "Brief Writer" },
  };
  for (const listingReadFails of [false, true]) {
    const world = makeWorld({ key: websiteKey, listing: listingOf(), listingReadFails });
    assert.deepEqual(await doors(world), ALL_OPEN);
    assert.deepEqual(world.listingReads, []);
    const loaded = await world.h.deps.loadWidgetKey(PUBLIC_KEY);
    assert.deepEqual(loaded, websiteKey, "the key is handed over exactly as stored");
  }
});

test("a page key that is switched off or revoked answers 404 as before, with no listing read", async () => {
  for (const key of [
    { ...PAGE_KEY, enabled: false },
    { ...PAGE_KEY, revokedAt: NOW },
  ]) {
    const world = makeWorld({ key, listing: listingOf() });
    assert.deepEqual(await doors(world), ALL_REFUSED);
    assert.deepEqual(world.listingReads, []);
  }
});

test("a page key of an agent that is no longer public answers 404 whatever the listing says", async () => {
  const world = makeWorld({ key: { ...PAGE_KEY, agent: { ...PAGE_KEY.agent!, isPublic: false } }, listing: null });
  assert.deepEqual(await doors(world), ALL_REFUSED);
});
