/**
 * PATCH and DELETE /api/agents/:id while the agent is on sale.
 *
 * An agent whose use is sold keeps what its buyers rely on. Three changes
 * are refused with 409 on_sale_for_use, each before anything is written:
 *
 *   isPublic: false       its page stays on
 *   entrypoint: "graph"   it keeps answering from its instructions
 *   agentKind: scheduled  only while a price per use is set
 *
 * And an agent people have paid for is not deleted: 409 agent_has_buyers
 * while its listing, whatever it sells, holds an install or a subscription
 * row, or a sale paid from a wallet through the x402 door, before anything
 * is stopped or deleted. With a listing and no buyers it deletes as it
 * always did.
 *
 * Hermetic: the global prisma's delegates are replaced for each test, and
 * every delegate a refusal must not reach fails the test when touched.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { AGENT_HAS_BUYERS_MESSAGE, createAgentRoutes, ON_SALE_FOR_USE_MESSAGES } from "../routes/agents.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";

type Row = Record<string, any>;

function storedAgent(over: Row = {}): Row {
  return {
    id: AGENT_ID,
    orgId: ORG,
    name: "Reviewer",
    slug: "reviewer",
    version: "1.2.3",
    systemPrompt: "Be brief.",
    tools: [],
    modelConfig: { temperature: 0.7, maxTokens: 4096 },
    entrypoint: "chat",
    env: null,
    agentKind: "conversation",
    kindConfig: null,
    isPublic: true,
    publicHandle: "reviewer",
    ...over,
  };
}

/** The agent's listing row, as both reads see it. */
function listingOf(over: Row = {}): Row {
  return {
    id: "listing-1",
    slug: "reviewer-listing",
    title: "Reviewer",
    agentId: AGENT_ID,
    publisherId: ORG,
    status: "published",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    monthlyPriceCents: null,
    useAllowedTools: [],
    installs: 0,
    subscriptions: 0,
    ...over,
  };
}
const MONTHLY = { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n };
const FREE = { pricingModel: "free", pricePerRequestCents: null };

/**
 * The sale and payment rows the delete may look at. A sale paid from a wallet
 * has payerWallet set and no buyer; a held or failed payment from a wallet is
 * an x402_payments row with the listing and never a sale.
 */
interface MoneyRows {
  revenue?: Row[];
  x402Payments?: Row[];
}

/** Prisma's where, for the few shapes these reads use. */
function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === "object" && "not" in cond) return (row[key] ?? null) !== cond.not;
    return (row[key] ?? null) === cond;
  });
}

async function appWith(
  agent: Row | null,
  listing: Row | null,
  options: { listingReadFails?: boolean } & MoneyRows = {},
) {
  const calls: string[] = [];
  const names = [
    "agent",
    "agentListing",
    "agentGraph",
    "knowledgeBase",
    "widgetKey",
    "scheduledTask",
    "taskExecution",
    "openClawChannel",
    "webhook",
    "marketplaceRevenue",
    "x402Payment",
    "$transaction",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, (prisma as any)[name]]));
  const world = { agent, listing, deleted: false };

  (prisma as any).agent = {
    findFirst: async ({ where }: Row) => {
      calls.push("agent.findFirst");
      const row = world.agent;
      return row && row.id === where.id && row.orgId === where.orgId ? { ...row, deployments: [] } : null;
    },
    update: async ({ data }: Row) => {
      calls.push("agent.update");
      Object.assign(world.agent!, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return { ...world.agent };
    },
    updateMany: async () => {
      calls.push("agent.updateMany");
      return { count: 1 };
    },
    delete: async () => {
      calls.push("agent.delete");
      world.deleted = true;
      return {};
    },
  };
  (prisma as any).agentListing = {
    findFirst: async ({ where, select }: Row) => {
      if (options.listingReadFails) throw new Error("the listing could not be read");
      const row = world.listing;
      if (!row || row.agentId !== where.agentId) return null;
      if (select._count) {
        // The delete's read: the listing whatever it sells, with its buyers counted.
        calls.push("agentListing.findFirst(buyers)");
        assert.deepEqual(where, { agentId: AGENT_ID });
        return { id: row.id, _count: { installs: row.installs, subscriptions: row.subscriptions } };
      }
      // findUseListing: published, sells use.
      calls.push("agentListing.findFirst(use)");
      assert.deepEqual(where, { agentId: AGENT_ID, status: "published", sells: "use" });
      return row.status === "published" && row.sells === "use" ? { ...row } : null;
    },
  };
  (prisma as any).marketplaceRevenue = {
    findFirst: async ({ where, select }: Row) => {
      calls.push("marketplaceRevenue.findFirst(wallet)");
      assert.deepEqual(select, { id: true });
      const row = (options.revenue ?? []).find((r) => matchesWhere(r, where));
      return row ? { id: row.id } : null;
    },
  };
  // A payment that never became a sale is not a buyer: reading these rows
  // would be the wrong question, so each read is recorded and answered.
  const payments = (method: string) => async ({ where }: Row) => {
    calls.push(`x402Payment.${method}`);
    const rows = (options.x402Payments ?? []).filter((r) => matchesWhere(r, where ?? {}));
    return method === "count" ? rows.length : method === "findMany" ? rows : (rows[0] ?? null);
  };
  (prisma as any).x402Payment = {
    findFirst: payments("findFirst"),
    findMany: payments("findMany"),
    count: payments("count"),
  };
  (prisma as any).agentGraph = {
    findUnique: async () => {
      calls.push("agentGraph.findUnique");
      return { nodes: [{ id: "n1" }] };
    },
  };
  const recorded = (name: string, answers: Row) =>
    new Proxy(
      {},
      {
        get: (_target, method) => async () => {
          calls.push(`${name}.${String(method)}`);
          return answers[String(method)] ?? { count: 0 };
        },
      },
    );
  (prisma as any).widgetKey = recorded("widgetKey", {});
  (prisma as any).scheduledTask = recorded("scheduledTask", { findMany: [] });
  (prisma as any).taskExecution = recorded("taskExecution", {});
  (prisma as any).openClawChannel = recorded("openClawChannel", { findMany: [] });
  (prisma as any).webhook = { findMany: async () => [] };
  (prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push("$transaction");
    return fn(prisma);
  };

  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1", type: "jwt", role: "owner" };
      },
      publicApiUrl: () => "https://api.example.test",
    }),
  );
  await app.ready();
  return {
    world,
    calls,
    /** Everything but reads: what a refusal must leave empty. */
    writes: () => calls.filter((call) => !/\.(findFirst|findUnique|findMany|count)(\(|$)/.test(call)),
    patch: (payload: object) => app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload }),
    remove: () => app.inject({ method: "DELETE", url: `/${AGENT_ID}` }),
    close: async () => {
      await app.close();
      await new Promise((resolve) => setImmediate(resolve));
      for (const name of names) (prisma as any)[name] = saved[name];
    },
  };
}

// ============================================
// PATCH
// ============================================

test("the sentences say what to do first, and the page one is the plan's", () => {
  assert.equal(ON_SALE_FOR_USE_MESSAGES.page, "This agent is on sale, so its page stays on. Stop selling it first.");
  assert.equal(
    ON_SALE_FOR_USE_MESSAGES.graph,
    "This agent is on sale, so it cannot be switched to answer through its graph. Stop selling it first.",
  );
  assert.equal(
    ON_SALE_FOR_USE_MESSAGES.scheduled,
    "This agent is sold per use, so it cannot be changed to run on its own. Sell it by the month or stop selling it first.",
  );
  assert.equal(
    AGENT_HAS_BUYERS_MESSAGE,
    "People have paid for this agent, so it cannot be deleted. Stop selling it instead: it leaves the marketplace, and subscribers keep access until the month they paid for ends.",
  );
  for (const sentence of [...Object.values(ON_SALE_FOR_USE_MESSAGES), AGENT_HAS_BUYERS_MESSAGE]) {
    assert.ok(!sentence.includes("—"), "no em dash in a sentence a customer reads");
  }
});

test("isPublic: false is refused while use is on sale, free or priced, before any write", async () => {
  for (const pricing of [{}, MONTHLY, FREE]) {
    const { patch, writes, world, close } = await appWith(storedAgent(), listingOf(pricing));
    try {
      const res = await patch({ isPublic: false, name: "Renamed" });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json(), { error: "on_sale_for_use", message: ON_SALE_FOR_USE_MESSAGES.page });
      assert.deepEqual(writes(), []);
      assert.equal(world.agent!.isPublic, true);
      assert.equal(world.agent!.name, "Reviewer", "nothing else in the same request was saved either");
    } finally {
      await close();
    }
  }
});

test("entrypoint: graph is refused while use is on sale, before any write", async () => {
  for (const pricing of [{}, MONTHLY, FREE]) {
    const { patch, writes, world, close } = await appWith(storedAgent(), listingOf(pricing));
    try {
      const res = await patch({ entrypoint: "graph" });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json(), { error: "on_sale_for_use", message: ON_SALE_FOR_USE_MESSAGES.graph });
      assert.deepEqual(writes(), []);
      assert.equal(world.agent!.entrypoint, "chat");
    } finally {
      await close();
    }
  }
});

test("agentKind: scheduled is refused only while a price per use is set", async () => {
  const perUse = await appWith(storedAgent(), listingOf());
  try {
    const res = await perUse.patch({ agentKind: "scheduled" });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "on_sale_for_use", message: ON_SALE_FOR_USE_MESSAGES.scheduled });
    assert.deepEqual(perUse.writes(), []);
    assert.equal(perUse.world.agent!.agentKind, "conversation");
    // Another kind is no business of the listing.
    assert.equal((await perUse.patch({ agentKind: "task" })).statusCode, 200);
  } finally {
    await perUse.close();
  }

  // By the month a self-running agent sells its results; free is the public link.
  for (const pricing of [MONTHLY, FREE, { pricePerRequestCents: 0n }]) {
    const allowed = await appWith(storedAgent(), listingOf(pricing));
    try {
      const res = await allowed.patch({ agentKind: "scheduled" });
      assert.equal(res.statusCode, 200, JSON.stringify(pricing, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
      assert.equal(allowed.world.agent!.agentKind, "scheduled");
    } finally {
      await allowed.close();
    }
  }
});

test("a listing that sells copies, a draft, an archived one or none refuses nothing", async () => {
  for (const listing of [null, listingOf({ sells: "copies" }), listingOf({ status: "draft" }), listingOf({ status: "archived" })]) {
    const { patch, world, close } = await appWith(storedAgent(), listing);
    try {
      assert.equal((await patch({ entrypoint: "graph" })).statusCode, 200);
      assert.equal((await patch({ agentKind: "scheduled" })).statusCode, 200);
      assert.equal((await patch({ isPublic: false })).statusCode, 200);
      assert.equal(world.agent!.isPublic, false);
    } finally {
      await close();
    }
  }
});

test("a change that touches none of the three never reads the listing; one that changes nothing is not refused", async () => {
  const { patch, calls, close } = await appWith(storedAgent({ agentKind: "task", entrypoint: "chat" }), listingOf());
  try {
    assert.equal((await patch({ name: "Renamed", systemPrompt: "Be kind.", isPublic: true })).statusCode, 200);
    // Instructions reach paying users at once: there are no copies to update.
    assert.ok(!calls.some((call) => call.startsWith("agentListing.")), calls.join(", "));
    // Its settings are saved while its kind stays what it is.
    assert.equal(
      (await patch({ kindConfig: { task: { fields: [{ key: "code", label: "Code", type: "long_text", required: true }] } } })).statusCode,
      200,
    );
    assert.ok(!calls.some((call) => call.startsWith("agentListing.")), calls.join(", "));
  } finally {
    await close();
  }
});

test("a listing that cannot be read fails the change, and nothing is written", async () => {
  const { patch, writes, world, close } = await appWith(storedAgent(), listingOf(), { listingReadFails: true });
  try {
    const res = await patch({ isPublic: false });
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("could not be read"), "no internal text in the answer");
    assert.deepEqual(writes(), []);
    assert.equal(world.agent!.isPublic, true);
  } finally {
    await close();
  }
});

// ============================================
// DELETE
// ============================================

test("delete is refused while the listing has buyers, of either kind, before anything is stopped or deleted", async () => {
  const cases: Array<[string, Row]> = [
    ["someone uses it", { installs: 1 }],
    ["someone subscribed", { subscriptions: 1 }],
    ["both", { installs: 3, subscriptions: 2 }],
    ["a copy was installed", { sells: "copies", installs: 1 }],
    ["withdrawn, and a subscriber is still inside the month", { status: "archived", subscriptions: 1 }],
  ];
  for (const [name, over] of cases) {
    const { remove, calls, world, close } = await appWith(storedAgent(), listingOf(over));
    try {
      const res = await remove();
      assert.equal(res.statusCode, 409, name);
      assert.deepEqual(res.json(), { error: "agent_has_buyers", message: AGENT_HAS_BUYERS_MESSAGE }, name);
      // Two reads, and nothing after them: no bot lookup, no stop, no delete.
      assert.deepEqual(calls, ["agent.findFirst", "agentListing.findFirst(buyers)"], name);
      assert.equal(world.deleted, false, name);
    } finally {
      await close();
    }
  }
});

test("an agent with a listing and no buyers deletes as before, and so does one with no listing", async () => {
  for (const listing of [listingOf(), listingOf({ sells: "copies" }), listingOf(MONTHLY), null]) {
    const { remove, calls, world, close } = await appWith(storedAgent(), listing);
    try {
      const res = await remove();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { message: "Agent deleted" });
      assert.equal(world.deleted, true);
      assert.equal(calls.at(-1), "agent.delete");
    } finally {
      await close();
    }
  }
});

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** A sale of one use paid from a wallet, as the x402 door writes it. */
function walletSale(over: Row = {}): Row {
  return {
    id: "revenue-wallet-1",
    listingId: "listing-1",
    buyerId: null,
    payerWallet: WALLET,
    x402PaymentId: "payment-1",
    type: "x402",
    status: "settled",
    ...over,
  };
}

test("delete is refused, in the same words, when the only buyer paid from a wallet", async () => {
  const { remove, calls, world, close } = await appWith(storedAgent(), listingOf(), { revenue: [walletSale()] });
  try {
    const res = await remove();
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "agent_has_buyers", message: AGENT_HAS_BUYERS_MESSAGE });
    // Three reads, and nothing after them: no bot lookup, no stop, no delete.
    assert.deepEqual(calls, ["agent.findFirst", "agentListing.findFirst(buyers)", "marketplaceRevenue.findFirst(wallet)"]);
    assert.equal(world.deleted, false);
  } finally {
    await close();
  }

  // The same answer as an agent with an install, word for word.
  const installed = await appWith(storedAgent(), listingOf({ installs: 1 }));
  try {
    const walletRefusal = await appWith(storedAgent(), listingOf({ status: "archived" }), { revenue: [walletSale()] });
    try {
      const a = await installed.remove();
      const b = await walletRefusal.remove();
      assert.equal(b.statusCode, a.statusCode);
      assert.equal(b.body, a.body);
    } finally {
      await walletRefusal.close();
    }
  } finally {
    await installed.close();
  }
});

test("a listing whose only wallet payments are held or failed does not hold the delete", async () => {
  const x402Payments = [
    { id: "payment-held", listingId: "listing-1", status: "held", payerAddress: WALLET },
    { id: "payment-failed", listingId: "listing-1", status: "failed", payerAddress: WALLET },
  ];
  // A wallet sale of another listing, and a sale of this one with a buyer
  // (paid in credits, its install since gone), are not this listing's wallet sales.
  const revenue = [
    walletSale({ id: "revenue-other", listingId: "listing-2" }),
    { id: "revenue-buyer", listingId: "listing-1", buyerId: ORG, payerWallet: null, type: "per_request", status: "settled" },
  ];
  const { remove, calls, world, close } = await appWith(storedAgent(), listingOf(), { revenue, x402Payments });
  try {
    const res = await remove();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: "Agent deleted" });
    assert.equal(world.deleted, true);
    assert.ok(!calls.some((call) => call.startsWith("x402Payment.")), calls.join(", "));
  } finally {
    await close();
  }
});

test("a wallet sales read that fails deletes nothing", async () => {
  const { remove, world, close } = await appWith(storedAgent(), listingOf(), {
    revenue: [
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("the sales could not be read");
          },
        },
      ),
    ],
  });
  try {
    assert.equal((await remove()).statusCode, 500);
    assert.equal(world.deleted, false);
  } finally {
    await close();
  }
});

test("another organization's agent is not found, and its listing is never read", async () => {
  const { remove, patch, calls, close } = await appWith(storedAgent({ orgId: "99999999-9999-4999-8999-999999999999" }), listingOf({ installs: 1 }));
  try {
    assert.equal((await remove()).statusCode, 404);
    assert.equal((await patch({ isPublic: false })).statusCode, 404);
    assert.ok(!calls.some((call) => call.startsWith("agentListing.")));
  } finally {
    await close();
  }
});

test("a buyers read that fails deletes nothing", async () => {
  const { remove, world, calls, close } = await appWith(storedAgent(), listingOf(), { listingReadFails: true });
  try {
    assert.equal((await remove()).statusCode, 500);
    assert.equal(world.deleted, false);
    assert.deepEqual(calls, ["agent.findFirst"]);
  } finally {
    await close();
  }
});

// ============================================
// The order, in the source
// ============================================

test("in the source: each refusal stands before the first write, stop or delete of its handler", () => {
  const source = readFileSync(fileURLToPath(new URL("../routes/agents.ts", import.meta.url)), "utf8");

  const patchStart = source.indexOf('app.patch("/:agentId"');
  const patchEnd = source.indexOf('"/:agentId/usage"', patchStart);
  const patchBody = source.slice(patchStart, patchEnd);
  const refusal = patchBody.indexOf('error: "on_sale_for_use"');
  assert.ok(refusal > 0);
  for (const write of ["assignPublicHandle(", "db.agent.update(", "prisma.$transaction(", "setPageUse(", "setOwnScheduleEnabled("]) {
    const at = patchBody.indexOf(write);
    assert.ok(at > refusal, `${write} comes after the refusal`);
  }

  const deleteStart = source.indexOf('app.delete("/:agentId"');
  const deleteEnd = source.indexOf('app.post("/:agentId/deploy"', deleteStart);
  const deleteBody = source.slice(deleteStart, deleteEnd);
  const buyers = deleteBody.indexOf('error: "agent_has_buyers"');
  assert.ok(buyers > 0);
  for (const step of ["getNosanaClient()", "stopDeployment(", "recordNosanaOrphan(", "collectAgentTelegramWebhooks(", "prisma.agent.delete("]) {
    const at = deleteBody.indexOf(step);
    assert.ok(at > buyers, `${step} comes after the refusal`);
  }
});
