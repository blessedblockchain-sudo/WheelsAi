import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import type { Prisma } from "@wheelsai/db";

import {
  AGENT_PAUSED_MESSAGE,
  LISTING_PAUSED_START_MESSAGE,
  listingPausedNow,
  reconcileListingPauses,
  type ListingPauseDb,
  type ListingPauseDeps,
  type ListingPauseRow,
} from "../services/listingPause.js";

// A listing that sells use of its agent is paused while the model the agent
// runs on, one its organization runs itself, is not running. What these pin:
// the one rule for "paused", which listings a reconcile looks at, that the
// marker is set once and cleared once, and that a month paid for is made
// longer exactly once, by the time the listing was paused during that month.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const HOSTED = { externalModel: "wheelsai/llama-3.1-8b" };

// ============================================
// In-memory database
// ============================================

interface Sub {
  id: string;
  listingId: string;
  subscriberId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

interface State {
  listings: ListingPauseRow[];
  subs: Sub[];
  installs: Array<{ listingId: string; buyerId: string; kind: string }>;
}

/** A Prisma `where`, read as Prisma reads it. It knows nothing of the rule under test. */
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Array<Record<string, any>>).every((w) => matches(row, w));
    if (key === "OR") return (cond as Array<Record<string, any>>).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond !== "object") return value === cond;
    if ("string_starts_with" in cond || "string_contains" in cond) {
      const found = (cond.path as string[]).reduce((v: any, k) => (v && typeof v === "object" ? v[k] : undefined), value);
      if (typeof found !== "string") return false;
      return "string_contains" in cond ? found.includes(cond.string_contains) : found.startsWith(cond.string_starts_with);
    }
    if ("not" in cond) return cond.not === null ? value !== null : value !== cond.not;
    if ("gt" in cond) return value > cond.gt;
    return value !== null && typeof value === "object" && matches(value, cond);
  });
}

const sqlText = (query: Prisma.Sql) => query.strings.join("?").replace(/\s+/g, " ").trim();

// The one statement that lengthens the months, as it is sent. Changing the
// statement fails this, on purpose: it moves money and has to be read again.
const EXTEND_SQL =
  `UPDATE "agent_subscriptions" AS s ` +
  `SET "current_period_end" = s."current_period_end" + ( ` +
  `?::bigint - GREATEST(?::bigint, ROUND(EXTRACT(EPOCH FROM s."current_period_start") * 1000)::bigint) ` +
  `)::double precision * INTERVAL '1 millisecond', ` +
  `"updated_at" = CURRENT_TIMESTAMP ` +
  `FROM "agent_installs" AS i ` +
  `WHERE s."listing_id" = ?::uuid ` +
  `AND i."listing_id" = s."listing_id" ` +
  `AND i."buyer_id" = s."subscriber_id" ` +
  `AND i."kind" = 'use' ` +
  `AND s."status" IN ('active', 'past_due') ` +
  `AND ?::bigint > GREATEST(?::bigint, ROUND(EXTRACT(EPOCH FROM s."current_period_start") * 1000)::bigint)`;

function makeDb(seed: Partial<State> = {}) {
  const state: State = { listings: [], subs: [], installs: [], ...seed };
  const calls = { findMany: [] as Array<Record<string, any>>, extend: [] as Prisma.Sql[], writes: [] as string[] };
  let failExtend: Error | null = null;

  const updateMany = async (args: { where: Record<string, any>; data: { pausedSince: Date | null } }) => {
    calls.writes.push(`listing ${args.where.id} -> ${args.data.pausedSince?.toISOString() ?? "null"}`);
    let count = 0;
    for (const l of state.listings) {
      if (matches(l, args.where)) {
        l.pausedSince = args.data.pausedSince;
        count++;
      }
    }
    return { count };
  };

  const db: ListingPauseDb = {
    agentListing: {
      async findMany(args) {
        calls.findMany.push(args);
        // Copies: what a caller holds is what it read, whatever is written after.
        return state.listings
          .filter((l) => matches(l, args.where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, args.take)
          .map((l) => ({ ...l, agent: { ...l.agent } }));
      },
      updateMany,
    },
    // Snapshot and restore stand in for a transaction's rollback.
    async $transaction(fn) {
      const snapshot = structuredClone({ listings: state.listings, subs: state.subs });
      try {
        return await fn({
          agentListing: { updateMany },
          async $executeRaw(query) {
            calls.extend.push(query);
            if (failExtend) throw failExtend;
            // What the statement says, for the statement asserted below.
            assert.equal(sqlText(query), EXTEND_SQL);
            const [nowMs, sinceMs, listingId, nowAgain, sinceAgain] = query.values as [bigint, bigint, string, bigint, bigint];
            assert.equal(nowAgain, nowMs);
            assert.equal(sinceAgain, sinceMs);
            let count = 0;
            for (const s of state.subs) {
              const licence = state.installs.find((i) => i.listingId === s.listingId && i.buyerId === s.subscriberId);
              if (s.listingId !== listingId || licence?.kind !== "use") continue;
              if (s.status !== "active" && s.status !== "past_due") continue;
              const from = Math.max(Number(sinceMs), s.currentPeriodStart.getTime());
              if (!(Number(nowMs) > from)) continue;
              s.currentPeriodEnd = new Date(s.currentPeriodEnd.getTime() + (Number(nowMs) - from));
              count++;
            }
            return count;
          },
        });
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
  };
  return {
    state,
    db,
    calls,
    failExtendWith: (err: Error | null) => {
      failExtend = err;
    },
    listing: (id: string) => state.listings.find((l) => l.id === id)!,
    sub: (id: string) => state.subs.find((s) => s.id === id)!,
  };
}

function listing(id: string, over: Partial<ListingPauseRow> & { orgId?: string; modelConfig?: unknown } = {}): ListingPauseRow {
  const { orgId, modelConfig, ...rest } = over;
  return {
    id,
    status: "published",
    sells: "use",
    pausedSince: null,
    agent: { orgId: orgId ?? "org_a", modelConfig: modelConfig ?? HOSTED },
    ...rest,
  };
}

function useSub(id: string, listingId: string, over: Partial<Sub> = {}): Sub {
  return {
    id,
    listingId,
    subscriberId: `buyer_${id}`,
    status: "active",
    currentPeriodStart: at(0),
    currentPeriodEnd: at(30),
    ...over,
  };
}

/** Which of an organization's models answer. Everything asked is recorded. */
function models(running: Record<string, boolean | Error>) {
  const asked: Array<{ orgId: string; modelId: string }> = [];
  const resolveHostedModel: NonNullable<ListingPauseDeps["resolveHostedModel"]> = async (args) => {
    asked.push(args);
    const answer = running[`${args.orgId}:${args.modelId}`] ?? running[args.orgId] ?? false;
    if (answer instanceof Error) throw answer;
    return { ok: answer };
  };
  return { asked, resolveHostedModel };
}

const quiet = { info: () => {}, warn: () => {} };

function deps(db: ReturnType<typeof makeDb>, m: ReturnType<typeof models>, now: Date): ListingPauseDeps {
  return { db: db.db, resolveHostedModel: m.resolveHostedModel, now: () => now, logger: quiet };
}

// ============================================
// The sentences
// ============================================

test("the two sentences a buyer reads", () => {
  assert.equal(
    LISTING_PAUSED_START_MESSAGE,
    "This agent is paused right now, so nothing was started and nothing was charged. Try again later.",
  );
  assert.equal(AGENT_PAUSED_MESSAGE, "This agent is paused right now. Nothing was charged.");
});

// ============================================
// The rule
// ============================================

const PUBLISHED_USE = { status: "published", sells: "use" };

test("paused: published, sells use, on a model its organization runs, and that model does not answer", async () => {
  const m = models({ org_a: false });
  assert.equal(
    await listingPausedNow({ listing: PUBLISHED_USE, agent: { orgId: "org_a", modelConfig: HOSTED } }, m),
    true,
  );
  // Asked of the agent's own organization, for the model the agent resolves to.
  assert.deepEqual(m.asked, [{ orgId: "org_a", modelId: "wheelsai/llama-3.1-8b" }]);
});

test("not paused when the model answers", async () => {
  const m = models({ org_a: true });
  assert.equal(
    await listingPausedNow({ listing: PUBLISHED_USE, agent: { orgId: "org_a", modelConfig: HOSTED } }, m),
    false,
  );
  assert.equal(m.asked.length, 1);
});

for (const [name, listingOver, modelConfig] of [
  ["is archived", { status: "archived" }, HOSTED],
  ["is a draft", { status: "draft" }, HOSTED],
  ["sells copies", { sells: "copies" }, HOSTED],
  ["runs on a free model", {}, { externalModel: "groq/llama-3.3-70b-versatile" }],
  ["runs on an own-key model", {}, { externalModel: "openai/gpt-4o" }],
  ["has no model set", {}, {}],
  ["has no model configuration", {}, null],
  // The agent resolves to externalModel first: the legacy field is not its model.
  ["moved to another model over a hosted legacy one", {}, { externalModel: "openai/gpt-4o", model: "wheelsai/llama-3.1-8b" }],
  ["names a model that only contains the prefix", {}, { externalModel: "openai/wheelsai/x" }],
] as const) {
  test(`a listing that ${name} is never paused, and its model is never asked about`, async () => {
    const m = models({ org_a: false });
    const paused = await listingPausedNow(
      { listing: { ...PUBLISHED_USE, ...listingOver }, agent: { orgId: "org_a", modelConfig } },
      m,
    );
    assert.equal(paused, false);
    assert.deepEqual(m.asked, []);
  });
}

test("the legacy model field counts when it is the model the agent resolves to", async () => {
  const m = models({ org_a: false });
  assert.equal(
    await listingPausedNow(
      { listing: PUBLISHED_USE, agent: { orgId: "org_a", modelConfig: { model: "wheelsai/ft-support" } } },
      m,
    ),
    true,
  );
  assert.deepEqual(m.asked, [{ orgId: "org_a", modelId: "wheelsai/ft-support" }]);
});

test("when the question cannot be answered it throws: an unknown is not an answer", async () => {
  const m = models({ org_a: new Error("database unreachable") });
  await assert.rejects(
    listingPausedNow({ listing: PUBLISHED_USE, agent: { orgId: "org_a", modelConfig: HOSTED } }, m),
    /database unreachable/,
  );
});

// ============================================
// Candidates
// ============================================

test("a reconcile looks at marked listings and at published use listings on a hosted model, and at no others", async () => {
  const db = makeDb({
    listings: [
      listing("l1_hosted"),
      listing("l2_free", { modelConfig: { externalModel: "groq/llama-3.3-70b-versatile" } }),
      listing("l3_ownkey", { modelConfig: { externalModel: "openai/gpt-4o" } }),
      listing("l4_copies", { sells: "copies" }),
      listing("l5_archived", { status: "archived" }),
      listing("l6_archived_marked", { status: "archived", pausedSince: at(1) }),
      listing("l7_free_marked", { modelConfig: { externalModel: "openai/gpt-4o" }, pausedSince: at(1) }),
      listing("l8_legacy_hosted", { modelConfig: { model: "wheelsai/llama-3.1-8b" } }),
    ],
  });
  const m = models({ org_a: false });
  const result = await reconcileListingPauses({ all: true }, deps(db, m, at(5)));
  assert.equal(result.examined, 4);
  // Only the two listings the rule can pause are asked about.
  assert.equal(m.asked.length, 2);
  assert.deepEqual(
    db.state.listings.map((l) => [l.id, l.pausedSince?.getTime() ?? null]),
    [
      ["l1_hosted", at(5).getTime()],
      ["l2_free", null],
      ["l3_ownkey", null],
      ["l4_copies", null],
      ["l5_archived", null],
      ["l6_archived_marked", null],
      ["l7_free_marked", null],
      ["l8_legacy_hosted", at(5).getTime()],
    ],
  );
  assert.deepEqual(result, { examined: 4, paused: 2, resumed: 2, extendedSubscriptions: 0, errors: 0 });
});

// A model is stored as it was sent and trimmed when the agent runs
// (agentModelResolution.ts), so " wheelsai/x" is a model the organization
// runs. If the reconcile did not look at such a listing it would never get a
// marker, and its subscribers would be renewed while it cannot answer.
test("a listing whose stored model has spaces around it is marked when its model stops, like any other", async () => {
  const db = makeDb({
    listings: [
      listing("l1_spaces", { modelConfig: { externalModel: "  wheelsai/llama-3.1-8b " } }),
      listing("l2_legacy_spaces", { modelConfig: { externalModel: "   ", model: "\twheelsai/llama-3.1-8b" } }),
      // The prefix inside another provider's model is looked at and is not a pause.
      listing("l3_inside", { modelConfig: { externalModel: "openai/wheelsai/x" } }),
    ],
  });
  const m = models({ org_a: false });
  const result = await reconcileListingPauses({ all: true }, deps(db, m, at(5)));
  assert.deepEqual(result, { examined: 3, paused: 2, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.equal(db.listing("l1_spaces").pausedSince?.getTime(), at(5).getTime());
  assert.equal(db.listing("l2_legacy_spaces").pausedSince?.getTime(), at(5).getTime());
  assert.equal(db.listing("l3_inside").pausedSince, null);
  // Asked about by the trimmed id, the one the agent runs on.
  assert.deepEqual(m.asked, [
    { orgId: "org_a", modelId: "wheelsai/llama-3.1-8b" },
    { orgId: "org_a", modelId: "wheelsai/llama-3.1-8b" },
  ]);
});

test("a reconcile for one organization never reads, asks about or writes another's listings", async () => {
  const db = makeDb({
    listings: [
      listing("l_a"),
      listing("l_b", { orgId: "org_b" }),
      listing("l_b_marked", { orgId: "org_b", status: "archived", pausedSince: at(1) }),
    ],
    subs: [useSub("s_b", "l_b_marked")],
    installs: [{ listingId: "l_b_marked", buyerId: "buyer_s_b", kind: "use" }],
  });
  const m = models({ org_a: false, org_b: false });
  const result = await reconcileListingPauses({ orgId: "org_a" }, deps(db, m, at(5)));
  assert.deepEqual(result, { examined: 1, paused: 1, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.deepEqual(m.asked, [{ orgId: "org_a", modelId: "wheelsai/llama-3.1-8b" }]);
  assert.equal(db.listing("l_b").pausedSince, null);
  assert.equal(db.listing("l_b_marked").pausedSince?.getTime(), at(1).getTime());
  assert.equal(db.sub("s_b").currentPeriodEnd.getTime(), at(30).getTime());
});

test("a reconcile for one listing touches that listing only", async () => {
  const db = makeDb({ listings: [listing("l_1"), listing("l_2")] });
  const m = models({ org_a: false });
  const result = await reconcileListingPauses({ listingId: "l_2" }, deps(db, m, at(5)));
  assert.equal(result.examined, 1);
  assert.equal(db.listing("l_1").pausedSince, null);
  assert.equal(db.listing("l_2").pausedSince?.getTime(), at(5).getTime());
});

test("every listing is worked through in batches, each looked at once", async () => {
  const many = Array.from({ length: 450 }, (_, i) => listing(`l_${String(i).padStart(4, "0")}`));
  const db = makeDb({ listings: many });
  const m = models({ org_a: false });
  const result = await reconcileListingPauses({ all: true }, deps(db, m, at(5)));
  assert.equal(result.examined, 450);
  assert.equal(result.paused, 450);
  // Three reads of at most 200, each after the last id of the one before:
  // marking a listing does not bring it back in a later batch.
  assert.deepEqual(
    db.calls.findMany.map((q) => q.take),
    [200, 200, 200],
  );
  assert.deepEqual(
    db.calls.findMany.map((q) => q.where.AND.find((w: Record<string, any>) => "id" in w)?.id.gt ?? null),
    [null, "l_0199", "l_0399"],
  );
  assert.equal(new Set(db.calls.writes).size, 450);
});

// ============================================
// The marker is set once
// ============================================

test("a pause is marked once: a later reconcile does not move when it began", async () => {
  const db = makeDb({ listings: [listing("l_1")] });
  const m = models({ org_a: false });
  assert.equal((await reconcileListingPauses({ all: true }, deps(db, m, at(5)))).paused, 1);
  const again = await reconcileListingPauses({ all: true }, deps(db, m, at(9)));
  assert.deepEqual(again, { examined: 1, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.equal(db.listing("l_1").pausedSince?.getTime(), at(5).getTime());
  assert.equal(db.calls.writes.length, 1);
});

/** Holds every caller until `n` of them are waiting, so they all act on the same read. */
function together(n: number, inner: NonNullable<ListingPauseDeps["resolveHostedModel"]>) {
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async (args: { orgId: string; modelId: string }) => {
    if (++waiting === n) release();
    await gate;
    return inner(args);
  };
}

test("two reconciles that read the same unmarked listing set the marker once", async () => {
  const db = makeDb({ listings: [listing("l_1")] });
  const m = models({ org_a: false });
  const resolveHostedModel = together(2, m.resolveHostedModel);
  const [a, b] = await Promise.all([
    reconcileListingPauses({ all: true }, { ...deps(db, m, at(5)), resolveHostedModel }),
    reconcileListingPauses({ all: true }, { ...deps(db, m, at(6)), resolveHostedModel }),
  ]);
  assert.equal(a.paused + b.paused, 1);
  // The loser's write matched nothing: the first moment stands.
  assert.equal(db.listing("l_1").pausedSince?.getTime(), at(5).getTime());
});

// ============================================
// The pause ends: the marker is cleared once, the months lengthened once
// ============================================

function pausedListing() {
  return makeDb({
    listings: [listing("l_1", { pausedSince: at(20) })],
    subs: [
      // Paid before the pause began.
      useSub("s_whole", "l_1"),
      // A month that began during the pause.
      useSub("s_began_during", "l_1", { currentPeriodStart: at(25), currentPeriodEnd: at(55) }),
      // Its month ran out during the pause; renewal waited for it.
      useSub("s_ran_out", "l_1", { currentPeriodStart: at(-8), currentPeriodEnd: at(22) }),
      useSub("s_past_due", "l_1", { status: "past_due", currentPeriodStart: at(-9), currentPeriodEnd: at(21) }),
      useSub("s_cancelled", "l_1", { status: "cancelled" }),
      useSub("s_expired", "l_1", { status: "expired" }),
      // A copy on the same listing, and a subscription with no licence row.
      useSub("s_copy", "l_1"),
      useSub("s_no_licence", "l_1"),
      // Use of another listing.
      useSub("s_other", "l_2"),
    ],
    installs: [
      ...["s_whole", "s_began_during", "s_ran_out", "s_past_due", "s_cancelled", "s_expired"].map((id) => ({
        listingId: "l_1",
        buyerId: `buyer_${id}`,
        kind: "use",
      })),
      { listingId: "l_1", buyerId: "buyer_s_copy", kind: "copy" },
      { listingId: "l_2", buyerId: "buyer_s_other", kind: "use" },
    ],
  });
}

const ends = (db: ReturnType<typeof makeDb>) =>
  Object.fromEntries(db.state.subs.map((s) => [s.id, (s.currentPeriodEnd.getTime() - T0.getTime()) / DAY]));

test("when the model answers again the marker is cleared and each month of use is longer by its own paused time", async () => {
  const db = pausedListing();
  const m = models({ org_a: true });
  const result = await reconcileListingPauses({ all: true }, deps(db, m, at(28)));
  assert.deepEqual(result, { examined: 1, paused: 0, resumed: 1, extendedSubscriptions: 4, errors: 0 });
  assert.equal(db.listing("l_1").pausedSince, null);
  assert.deepEqual(ends(db), {
    // Paused from day 20 to day 28: eight days.
    s_whole: 38,
    // Began on day 25: only the three days of its own month.
    s_began_during: 58,
    s_ran_out: 30,
    s_past_due: 29,
    // Closed subscriptions, a copy, a row with no licence and another
    // listing's subscriber are not touched.
    s_cancelled: 30,
    s_expired: 30,
    s_copy: 30,
    s_no_licence: 30,
    s_other: 30,
  });
});

test("the lengthening is one statement with every value a parameter, in whole milliseconds", async () => {
  const db = makeDb({
    listings: [listing("3f0c9a52-7d1e-4b8a-9c56-0e2f4a6b8c1d", { pausedSince: new Date(at(20).getTime() + 123) })],
  });
  const now = new Date(at(28).getTime() + 456);
  await reconcileListingPauses({ all: true }, deps(db, models({ org_a: true }), now));
  assert.equal(db.calls.extend.length, 1);
  const query = db.calls.extend[0]!;
  assert.equal(sqlText(query), EXTEND_SQL);
  assert.equal(sqlText(query).includes(";"), false);
  assert.deepEqual(query.values, [
    BigInt(now.getTime()),
    BigInt(at(20).getTime() + 123),
    "3f0c9a52-7d1e-4b8a-9c56-0e2f4a6b8c1d",
    BigInt(now.getTime()),
    BigInt(at(20).getTime() + 123),
  ]);
  // Nothing that was read is written into the statement's text.
  for (const text of query.strings) {
    assert.equal(/3f0c9a52|\d{10,}/.test(text), false);
  }
});

test("two reconciles that read the same marker clear it once and lengthen each month exactly once", async () => {
  const db = pausedListing();
  const m = models({ org_a: true });
  const resolveHostedModel = together(2, m.resolveHostedModel);
  const [a, b] = await Promise.all([
    reconcileListingPauses({ all: true }, { ...deps(db, m, at(28)), resolveHostedModel }),
    reconcileListingPauses({ all: true }, { ...deps(db, m, at(28)), resolveHostedModel }),
  ]);
  // Both held the marker of day 20; one clear matched it.
  assert.equal(a.examined + b.examined, 2);
  assert.equal(a.resumed + b.resumed, 1);
  assert.equal(a.extendedSubscriptions + b.extendedSubscriptions, 4);
  assert.equal(a.errors + b.errors, 0);
  assert.equal(db.calls.extend.length, 1);
  assert.equal(ends(db).s_whole, 38);
  assert.equal(ends(db).s_began_during, 58);
});

test("a reconcile after the pause has been cleared lengthens nothing", async () => {
  const db = pausedListing();
  const m = models({ org_a: true });
  await reconcileListingPauses({ all: true }, deps(db, m, at(28)));
  const again = await reconcileListingPauses({ all: true }, deps(db, m, at(29)));
  assert.deepEqual(again, { examined: 1, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.equal(db.calls.extend.length, 1);
  assert.equal(ends(db).s_whole, 38);
});

test("a listing that is still paused keeps its marker and no month moves", async () => {
  const db = pausedListing();
  const result = await reconcileListingPauses({ all: true }, deps(db, models({ org_a: false }), at(28)));
  assert.deepEqual(result, { examined: 1, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.equal(db.listing("l_1").pausedSince?.getTime(), at(20).getTime());
  assert.deepEqual(db.calls.writes, []);
  assert.equal(ends(db).s_whole, 30);
});

test("a listing that is not paused and has no marker is left alone", async () => {
  const db = makeDb({ listings: [listing("l_1")] });
  const result = await reconcileListingPauses({ all: true }, deps(db, models({ org_a: true }), at(5)));
  assert.deepEqual(result, { examined: 1, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.deepEqual(db.calls.writes, []);
});

for (const [name, change] of [
  ["was archived", { status: "archived" }],
  ["sells copies now", { sells: "copies" }],
  ["has an agent that moved to another model", { agent: { orgId: "org_a", modelConfig: { externalModel: "openai/gpt-4o" } } }],
] as const) {
  test(`a marked listing that ${name} has its marker cleared and its months lengthened, without asking about a model`, async () => {
    const db = pausedListing();
    Object.assign(db.listing("l_1"), change);
    // The model is still down: it is not what decides here.
    const m = models({ org_a: false });
    const result = await reconcileListingPauses({ all: true }, deps(db, m, at(28)));
    assert.deepEqual(result, { examined: 1, paused: 0, resumed: 1, extendedSubscriptions: 4, errors: 0 });
    assert.equal(db.listing("l_1").pausedSince, null);
    assert.deepEqual(m.asked, []);
    assert.equal(ends(db).s_whole, 38);
    assert.equal(ends(db).s_copy, 30);
  });
}

test("a marker in the future is cleared and lengthens nothing", async () => {
  const db = pausedListing();
  db.listing("l_1").pausedSince = at(40);
  const before = ends(db);
  const result = await reconcileListingPauses({ all: true }, deps(db, models({ org_a: true }), at(28)));
  assert.deepEqual(result, { examined: 1, paused: 0, resumed: 1, extendedSubscriptions: 0, errors: 0 });
  assert.equal(db.listing("l_1").pausedSince, null);
  assert.deepEqual(ends(db), before);
});

// ============================================
// Failure
// ============================================

test("a listing whose model cannot be asked about is left exactly as it is, and the others are still done", async () => {
  const db = makeDb({
    listings: [
      listing("l_1_unknown_marked", { orgId: "org_x", pausedSince: at(20) }),
      listing("l_2_unknown", { orgId: "org_x" }),
      listing("l_3_down"),
      listing("l_4_back", { orgId: "org_up", pausedSince: at(20) }),
    ],
    subs: [useSub("s_x", "l_1_unknown_marked"), useSub("s_up", "l_4_back")],
    installs: [
      { listingId: "l_1_unknown_marked", buyerId: "buyer_s_x", kind: "use" },
      { listingId: "l_4_back", buyerId: "buyer_s_up", kind: "use" },
    ],
  });
  const warned: Array<Record<string, unknown>> = [];
  const failure = new Error("database unreachable");
  const m = models({ org_x: failure, org_a: false, org_up: true });
  const result = await reconcileListingPauses(
    { all: true },
    { ...deps(db, m, at(28)), logger: { info: () => {}, warn: (fields) => void warned.push(fields) } },
  );
  assert.deepEqual(result, { examined: 4, paused: 1, resumed: 1, extendedSubscriptions: 1, errors: 2 });
  // Neither a pause nor a resume: the marker that was there stays, none is set.
  assert.equal(db.listing("l_1_unknown_marked").pausedSince?.getTime(), at(20).getTime());
  assert.equal(db.listing("l_2_unknown").pausedSince, null);
  assert.equal(db.sub("s_x").currentPeriodEnd.getTime(), at(30).getTime());
  assert.equal(db.listing("l_3_down").pausedSince?.getTime(), at(28).getTime());
  assert.equal(db.listing("l_4_back").pausedSince, null);
  assert.equal(db.sub("s_up").currentPeriodEnd.getTime(), at(38).getTime());
  assert.deepEqual(
    warned.map((w) => [w.listingId, w.error]),
    [
      ["l_1_unknown_marked", failure],
      ["l_2_unknown", failure],
    ],
  );
});

test("if the months cannot be lengthened the marker stays, and the next reconcile lengthens them once", async () => {
  const db = pausedListing();
  const m = models({ org_a: true });
  db.failExtendWith(new Error("deadlock detected"));
  const failed = await reconcileListingPauses({ all: true }, deps(db, m, at(28)));
  assert.deepEqual(failed, { examined: 1, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 1 });
  // The clear rolled back with the statement: the pause is still on the clock.
  assert.equal(db.listing("l_1").pausedSince?.getTime(), at(20).getTime());
  assert.equal(ends(db).s_whole, 30);

  db.failExtendWith(null);
  const next = await reconcileListingPauses({ all: true }, deps(db, m, at(29)));
  assert.equal(next.resumed, 1);
  assert.equal(ends(db).s_whole, 39);
});

test("a reconcile whose listings cannot be read throws: the caller decides what happens next", async () => {
  const db = makeDb();
  db.db.agentListing.findMany = async () => {
    throw new Error("connection reset");
  };
  await assert.rejects(reconcileListingPauses({ all: true }, deps(db, models({}), at(5))), /connection reset/);
});
