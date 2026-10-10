import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiKeySpendCapError,
  ApiKeyUseCapError,
  peekApiKeySpend,
  reserveApiKeySpend,
  spendDay,
  type ApiKeySpendReadDb,
  type ApiKeySpendTx,
} from "../services/apiKeySpend.js";
import { hireJob, JobFundingError, type OfferingForHire } from "../services/jobEscrow.js";
import { makeJobsDb } from "./jobsDb.js";

// The per-key spend caps, inside the hire transaction, over the in-memory
// jobs database.

const NOW = new Date("2026-10-06T15:30:00Z");
const KEY = "key_1";

const OFFERING: OfferingForHire = {
  id: "off_1",
  title: "Competitor teardown",
  publisherId: "org_pub",
  listingId: null,
  priceCents: 2_000n,
  slaSeconds: 3_600,
};

function setup(caps: { perJob: bigint | null; perDay: bigint | null }, balance = 1_000_000n) {
  return makeJobsDb({
    balance,
    apiKeys: { [KEY]: { orgId: "org_buyer", maxJobPriceCents: caps.perJob, dailySpendCapCents: caps.perDay } },
  });
}

const hire = (db: ReturnType<typeof makeJobsDb>, now = NOW) =>
  db.inTransaction(async (tx) => {
    await reserveApiKeySpend(tx, { apiKeyId: KEY, orgId: "org_buyer", priceCents: OFFERING.priceCents, now });
    return hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now, hiredByApiKeyId: KEY });
  });

const spent = (db: ReturnType<typeof makeJobsDb>, day = NOW) =>
  db.state.spendWindows.get(`${KEY}|${spendDay(day).toISOString()}`);

test("the spend window is the UTC day", () => {
  assert.equal(spendDay(new Date("2026-10-06T23:59:59Z")).toISOString(), "2026-10-06T00:00:00.000Z");
  assert.equal(spendDay(new Date("2026-10-07T00:00:00Z")).toISOString(), "2026-10-07T00:00:00.000Z");
});

test("a job that costs more than the key's per-job cap is refused and nothing is charged", async () => {
  const db = setup({ perJob: 1_999n, perDay: 100_000n });
  await assert.rejects(hire(db), (err: unknown) => {
    assert.ok(err instanceof ApiKeySpendCapError);
    assert.equal(err.code, "api_key_job_price_cap_exceeded");
    return true;
  });
  assert.equal(db.state.balances.get("org_buyer"), 1_000_000n);
  assert.equal(db.state.jobs.size, 0);
  assert.equal(spent(db), undefined);
});

test("the day's total stops at the cap, and a new day starts a new total", async () => {
  const db = setup({ perJob: 2_000n, perDay: 5_000n });
  await hire(db);
  await hire(db);
  assert.equal(spent(db), 4_000n);

  // A third would make 6,000 against a cap of 5,000.
  await assert.rejects(hire(db), (err: unknown) => {
    assert.ok(err instanceof ApiKeySpendCapError);
    assert.equal(err.code, "api_key_daily_cap_exceeded");
    return true;
  });
  assert.equal(spent(db), 4_000n);
  assert.equal(db.state.jobs.size, 2);
  assert.equal(db.state.balances.get("org_buyer"), 996_000n);

  const tomorrow = new Date("2026-10-07T00:00:01Z");
  await hire(db, tomorrow);
  assert.equal(spent(db, tomorrow), 2_000n);
});

test("concurrent hires on one key never overshoot the daily cap", async () => {
  const db = setup({ perJob: 2_000n, perDay: 6_000n });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => hire(db)));

  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 3);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") assert.ok(outcome.reason instanceof ApiKeySpendCapError);
  }
  assert.equal(spent(db), 6_000n);
  assert.equal(db.state.jobs.size, 3);
  assert.equal(db.state.balances.get("org_buyer"), 994_000n);
});

test("a hire that fails after the reservation gives the allowance back", async () => {
  // The key may spend, the organization cannot pay.
  const db = setup({ perJob: 2_000n, perDay: 10_000n }, 100n);
  await assert.rejects(hire(db), JobFundingError);
  assert.equal(spent(db), undefined);
  assert.equal(db.state.jobs.size, 0);
  assert.equal(db.state.balances.get("org_buyer"), 100n);
});

test("a key with no caps, or another organization's key, cannot hire at all", async () => {
  for (const caps of [
    { perJob: null, perDay: 10_000n },
    { perJob: 2_000n, perDay: null },
  ]) {
    await assert.rejects(hire(setup(caps)), (err: unknown) => {
      assert.ok(err instanceof ApiKeySpendCapError);
      assert.equal(err.code, "api_key_spend_caps_missing");
      return true;
    });
  }
  const db = setup({ perJob: 2_000n, perDay: 10_000n });
  await assert.rejects(
    db.inTransaction((tx) =>
      reserveApiKeySpend(tx, { apiKeyId: KEY, orgId: "org_other", priceCents: 2_000n, now: NOW }),
    ),
    ApiKeySpendCapError,
  );
  await assert.rejects(
    db.inTransaction((tx) =>
      reserveApiKeySpend(tx, { apiKeyId: "key_missing", orgId: "org_buyer", priceCents: 2_000n, now: NOW }),
    ),
    ApiKeySpendCapError,
  );
});

// ============================================
// Paid use: the per-use cap, on the same day's window
// ============================================

interface UseCaps {
  perJob?: bigint | null;
  perUse: bigint | null;
  perDay: bigint | null;
}

function setupUse(caps: UseCaps) {
  return makeJobsDb({
    apiKeys: {
      [KEY]: {
        orgId: "org_buyer",
        maxJobPriceCents: caps.perJob ?? null,
        dailySpendCapCents: caps.perDay,
        maxUsePriceCents: caps.perUse,
      } as never,
    },
  });
}

const reserveUse = (db: ReturnType<typeof makeJobsDb>, priceCents: bigint, now = NOW) =>
  db.inTransaction((tx) => reserveApiKeySpend(tx, { apiKeyId: KEY, orgId: "org_buyer", priceCents, now, cap: "use" }));

/** What peekApiKeySpend reads, over the same in-memory rows. It has no way to write. */
function readDb(db: ReturnType<typeof makeJobsDb>): ApiKeySpendReadDb {
  return {
    apiKey: { findUnique: async ({ where }) => (db.state.apiKeys.get(where.id) as never) ?? null },
    apiKeySpendWindow: {
      findUnique: async ({ where }) => {
        const spentCents = db.state.spendWindows.get(`${where.apiKeyId_day.apiKeyId}|${where.apiKeyId_day.day.toISOString()}`);
        return spentCents === undefined ? null : { spentCents };
      },
    },
  };
}

test("the hire path asks for the same columns and writes the same statements as before", async () => {
  const statements: Array<[string, unknown]> = [];
  const tx: ApiKeySpendTx = {
    apiKey: {
      async findUnique(args) {
        statements.push(["apiKey.findUnique", args]);
        return { orgId: "org_buyer", maxJobPriceCents: 2_000n, dailySpendCapCents: 5_000n };
      },
    },
    apiKeySpendWindow: {
      async createMany(args) {
        statements.push(["apiKeySpendWindow.createMany", args]);
        return { count: 1 };
      },
      async updateMany(args) {
        statements.push(["apiKeySpendWindow.updateMany", args]);
        return { count: 1 };
      },
    },
  };
  // No `cap`: a caller that predates paid use.
  await reserveApiKeySpend(tx, { apiKeyId: KEY, orgId: "org_buyer", priceCents: 2_000n, now: NOW });
  const day = spendDay(NOW);
  assert.deepEqual(statements, [
    ["apiKey.findUnique", { where: { id: KEY }, select: { orgId: true, maxJobPriceCents: true, dailySpendCapCents: true } }],
    ["apiKeySpendWindow.createMany", { data: [{ apiKeyId: KEY, day }], skipDuplicates: true }],
    [
      "apiKeySpendWindow.updateMany",
      { where: { apiKeyId: KEY, day, spentCents: { lte: 3_000n } }, data: { spentCents: { increment: 2_000n } } },
    ],
  ]);

  // And its refusals are the errors, codes and words they were.
  const refused = setup({ perJob: 1_999n, perDay: 100_000n });
  await assert.rejects(hire(refused), (err: unknown) => {
    assert.ok(err instanceof ApiKeySpendCapError);
    assert.ok(!(err instanceof ApiKeyUseCapError));
    assert.equal(err.message, "This job costs more than this API key may spend on one job ($19.99).");
    assert.deepEqual(err.extra, { priceCents: 2_000, maxJobPriceCents: 1_999 });
    return true;
  });
  const overDay = setup({ perJob: 2_000n, perDay: 1_000n });
  await assert.rejects(hire(overDay), (err: unknown) => {
    assert.ok(err instanceof ApiKeySpendCapError);
    assert.equal(err.message, "This job would take this API key past what it may spend in one day ($10.00).");
    return true;
  });
  await assert.rejects(hire(setup({ perJob: null, perDay: 1_000n })), (err: unknown) => {
    assert.ok(err instanceof ApiKeySpendCapError);
    assert.equal(err.message, "This API key has no spend caps, so it cannot hire. Create a key with jobs:hire and both caps.");
    return true;
  });
});

test("a use over the key's per-use cap is refused and reserves nothing", async () => {
  const db = setupUse({ perUse: 5n, perDay: 100n });
  await assert.rejects(reserveUse(db, 6n), (err: unknown) => {
    assert.ok(err instanceof ApiKeyUseCapError);
    assert.equal(err.code, "api_key_use_price_cap_exceeded");
    assert.equal(err.message, "This use costs more than this API key may spend on one use ($0.05).");
    assert.deepEqual(err.extra, { priceCents: 6, maxUsePriceCents: 5 });
    return true;
  });
  assert.equal(spent(db), undefined);
  await reserveUse(db, 5n);
  assert.equal(spent(db), 5n);
});

test("a use that would pass the day's cap is refused and reserves nothing", async () => {
  const db = setupUse({ perUse: 5n, perDay: 12n });
  await reserveUse(db, 5n);
  await reserveUse(db, 5n);
  await assert.rejects(reserveUse(db, 5n), (err: unknown) => {
    assert.ok(err instanceof ApiKeyUseCapError);
    assert.equal(err.code, "api_key_daily_cap_exceeded");
    assert.equal(err.message, "This use would take this API key past what it may spend in one day ($0.12).");
    return true;
  });
  assert.equal(spent(db), 10n);
  // A cheaper use still fits what is left of the day.
  await reserveUse(db, 2n);
  assert.equal(spent(db), 12n);

  // Many at once never pass the cap either.
  const many = setupUse({ perUse: 5n, perDay: 20n });
  const outcomes = await Promise.allSettled(Array.from({ length: 9 }, () => reserveUse(many, 5n)));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 4);
  assert.equal(spent(many), 20n);
});

test("the day is shared between jobs and uses, and each price is held to its own cap", async () => {
  const db = setupUse({ perJob: 2_000n, perUse: 50n, perDay: 2_040n });
  await hire(db);
  assert.equal(spent(db), 2_000n);
  await reserveUse(db, 40n);
  assert.equal(spent(db), 2_040n);
  // The job took most of the day: one more cent of use does not fit.
  await assert.rejects(reserveUse(db, 1n), ApiKeyUseCapError);
  await assert.rejects(hire(db), ApiKeySpendCapError);
  assert.equal(spent(db), 2_040n);

  // A use is never held to the job cap, nor a job to the use cap.
  const caps = setupUse({ perJob: 2_000n, perUse: 50n, perDay: 100_000n });
  await assert.rejects(reserveUse(caps, 51n), ApiKeyUseCapError);
  await hire(caps);
  assert.equal(spent(caps), 2_000n);
});

test("a key without the use caps, or another organization's key, cannot pay for use", async () => {
  for (const caps of [
    // A key that can hire, and was never granted agents:use.
    { perJob: 2_000n, perUse: null, perDay: 10_000n },
    { perUse: 5n, perDay: null },
  ]) {
    const db = setupUse(caps);
    await assert.rejects(reserveUse(db, 5n), (err: unknown) => {
      assert.ok(err instanceof ApiKeyUseCapError);
      assert.equal(err.code, "api_key_spend_caps_missing");
      return true;
    });
    assert.equal(spent(db), undefined);
  }
  // A key that can pay for use, and was never granted jobs:hire, cannot hire.
  await assert.rejects(hire(setupUse({ perUse: 5n, perDay: 10_000n })), ApiKeySpendCapError);

  const db = setupUse({ perUse: 5n, perDay: 100n });
  await assert.rejects(
    db.inTransaction((tx) =>
      reserveApiKeySpend(tx, { apiKeyId: KEY, orgId: "org_other", priceCents: 5n, now: NOW, cap: "use" }),
    ),
    ApiKeyUseCapError,
  );
  await assert.rejects(
    db.inTransaction((tx) =>
      reserveApiKeySpend(tx, { apiKeyId: "key_missing", orgId: "org_buyer", priceCents: 5n, now: NOW, cap: "use" }),
    ),
    ApiKeyUseCapError,
  );
});

test("peek says whether a use would fit, in the reservation's words, and reserves nothing", async () => {
  const db = setupUse({ perUse: 5n, perDay: 12n });
  const peek = (priceCents: bigint, over: { apiKeyId?: string; orgId?: string; now?: Date } = {}) =>
    peekApiKeySpend(readDb(db), { apiKeyId: KEY, orgId: "org_buyer", priceCents, now: NOW, cap: "use", ...over });

  assert.deepEqual(await peek(5n), { ok: true });
  // Asking is not reserving: no window row, however often it is asked.
  await peek(5n);
  assert.equal(spent(db), undefined);

  assert.deepEqual(await peek(6n), {
    ok: false,
    code: "api_key_use_price_cap_exceeded",
    message: "This use costs more than this API key may spend on one use ($0.05).",
    extra: { priceCents: 6, maxUsePriceCents: 5 },
  });

  await reserveUse(db, 5n);
  await reserveUse(db, 5n);
  assert.deepEqual(await peek(2n), { ok: true });
  assert.deepEqual(await peek(3n), {
    ok: false,
    code: "api_key_daily_cap_exceeded",
    message: "This use would take this API key past what it may spend in one day ($0.12).",
    extra: { priceCents: 3, dailySpendCapCents: 12 },
  });
  assert.equal(spent(db), 10n);
  // A new day is a new total.
  assert.deepEqual(await peek(5n, { now: new Date("2026-10-07T00:00:01Z") }), { ok: true });

  // Caps that cannot be read do not fit.
  for (const over of [{ orgId: "org_other" }, { apiKeyId: "key_missing" }]) {
    const refused = await peek(1n, over);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "api_key_spend_caps_missing");
  }
  // Without `cap` it is the job cap that is asked about, and this key has none.
  const asJob = await peekApiKeySpend(readDb(db), { apiKeyId: KEY, orgId: "org_buyer", priceCents: 1n, now: NOW });
  assert.equal(!asJob.ok && asJob.code, "api_key_spend_caps_missing");
});
