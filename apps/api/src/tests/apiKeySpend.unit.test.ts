import assert from "node:assert/strict";
import test from "node:test";

import { ApiKeySpendCapError, reserveApiKeySpend, spendDay } from "../services/apiKeySpend.js";
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
