import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { paidUseOpenAiError } from "../services/openaiCompat.js";
import {
  PAID_USE_MESSAGES,
  paidRefusalBody,
  runPaidChat,
  runPaidTask,
  type PaidChatResult,
  type PaidSubscription,
  type PaidTaskResult,
} from "../services/paidUse.js";
import { readOffers, readPlanOffers } from "../services/planOffers.js";
import { takeIncludedUse } from "../services/planUse.js";
import { PLAN_RESET_HEADER, refusalUsageHeadersOf, usageHeadersOf } from "../services/usageHeaders.js";
import {
  HANDLE,
  KEY_CALLER,
  LEAK,
  LICENCE,
  LISTING,
  MONTHLY_LICENCE,
  MONTHLY_LISTING,
  NOW,
  PAID_MONTH,
  paidHarness,
  PLAN_LICENCE,
  PLAN_SUB,
  SESSION,
  TASK_FORM,
  type PaidHarness,
  type PaidHarnessOptions,
} from "./paidUseHarness.js";
import {
  BUYER,
  DAY,
  LISTING_ID,
  makeWorld,
  noMoney,
  ON_OFFER,
  PER_USE,
  PUBLISHER,
  STARTER,
  STARTER_ID,
  TRIAL,
  TRIAL_ID,
  withApp,
  type Row,
  type World,
} from "./trialWorld.js";

// A use on a listing's free trial, and how a trial ends. The uses run on the
// real paid service, chat core and metering (tests/paidUseHarness.ts); the
// starts, the move and the renewal run over an in-memory marketplace
// (tests/trialWorld.ts). What these pin: a trial's use is an included use of
// a plan that never touches money; past its uses it stops with its own
// sentence and tells no time at which it starts again; it sends no warning; a
// paid plan is started over it at any time and charged once, whatever
// happens at the same moment; it cannot be moved from; and when its 7 days
// are over it is closed, uncharged, and the buyer is asked to choose unless
// they agreed to a price per use themselves. Agreeing to the price per use
// takes effect whenever it is said: it is written on the licence while the
// trial runs, and past the trial's uses that buyer, and nobody else, goes on
// at that price.

const CHAT = { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false };
const TRIAL_ENDS = new Date("2026-10-15T00:00:00.000Z");

/** A buyer on a free trial of 20 uses, 3 of them used, 2 days in. The listing is sold per use at $0.05. */
const TRIAL_SUB: PaidSubscription = {
  status: "active",
  currentPeriodStart: new Date("2026-10-08T00:00:00.000Z"),
  currentPeriodEnd: TRIAL_ENDS,
  // What a trial start writes: never renewed, a price of nothing, no extra price.
  cancelAtPeriodEnd: true,
  endReason: null,
  priceCents: 0n,
  id: "sub-1",
  planId: "plan-trial",
  includedUses: 20,
  usedInPeriod: 3,
  carriedUses: 0,
  extraUsePriceCents: null,
  planName: "Free trial",
  trialUsedAt: new Date("2026-10-08T00:00:00.000Z"),
};
const trialHarness = (sub: Partial<PaidSubscription> = {}, options: PaidHarnessOptions = {}) =>
  paidHarness({ licence: PLAN_LICENCE, balance: 500n, ...options, sub: { ...TRIAL_SUB, ...sub } });

const chat = (h: PaidHarness, body: unknown = CHAT, caller = SESSION, signal = new AbortController().signal) =>
  runPaidChat({ caller, handle: HANDLE, body, signal }, h.deps);
const refusalIn = (result: PaidChatResult | PaidTaskResult) => (result.kind === "refused" ? result.refusal : result.kind);
const countOf = (h: PaidHarness, entry: string) => h.log.filter((e) => e === entry).length;

/** What moved for one request: credits, every money row, the key's spend, the trial's count and the model. */
const movedOf = (h: PaidHarness) => ({
  balance: h.money.balance,
  ledger: h.money.ledger.length,
  revenue: h.money.revenue.length,
  earnings: h.money.earnings.length,
  creatorOwed: h.money.publisherPending,
  keySpent: h.money.keySpent,
  charges: countOf(h, "charge"),
  used: h.sub?.usedInPeriod,
  takes: countOf(h, "take"),
  givenBack: countOf(h, "giveBack"),
  modelCalls: countOf(h, "model"),
});
const NO_MONEY = { balance: 500n, ledger: 0, revenue: 0, earnings: 0, creatorOwed: 0n, keySpent: 0n, charges: 0 };

// ============================================
// A use on a trial
// ============================================

test("a use on a free trial charges nothing, moves the count, and writes no money row at all", async () => {
  for (const caller of [SESSION, KEY_CALLER]) {
    // No credits, and a key whose caps a priced use would break: neither is asked.
    const h = trialHarness({}, { balance: 0n, keyCaps: { maxUse: 1n, daily: 1n } });
    const result = await chat(h, CHAT, caller);
    assert.equal(result.kind, "answer");
    assert.deepEqual(result.kind === "answer" && result.billing, {
      chargedCents: 0,
      balanceCents: 0,
      access: "subscribed",
      plan: {
        id: "plan-trial",
        use: "included",
        trial: true,
        includedUses: 20,
        carriedUses: 0,
        usedUses: 4,
        remainingUses: 16,
        extraUsePriceCents: null,
        // No time at which a count starts again: a trial's never does.
        warning: null,
      },
    });
    assert.deepEqual(movedOf(h), { ...NO_MONEY, balance: 0n, used: 4, takes: 1, givenBack: 0, modelCalls: 1 });
    // Taken just before the model runs.
    assert.ok(h.log.indexOf("take") < h.log.indexOf("model"));
    // Held to the trial's count and the minute, like any plan holder: the day's limit is not asked.
    assert.ok(!h.log.some((entry) => entry.startsWith("limit:pu:b:d")), h.log.join(","));
  }

  // A paid run is one use as a message is.
  const task = trialHarness({}, { agent: { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" } });
  const ran = await runPaidTask(
    { caller: SESSION, handle: HANDLE, body: { input: { topic: "Launch plan" }, stream: false }, signal: new AbortController().signal },
    task.deps,
  );
  assert.deepEqual(ran.kind === "result" && [ran.billing.chargedCents, ran.billing.plan?.use, ran.billing.plan?.trial], [0, "included", true]);
  assert.deepEqual(movedOf(task), { ...NO_MONEY, used: 4, takes: 1, givenBack: 0, modelCalls: 1 });

  // A paid plan in the same place says it is not a trial.
  const paid = paidHarness({ licence: PLAN_LICENCE, sub: PLAN_SUB });
  const answered = await chat(paid);
  assert.equal(answered.kind === "answer" && answered.billing.plan?.trial, false);
});

test("a trial's answer carries the usage headers a plan's does, with no time at which the count starts again", async () => {
  const h = trialHarness();
  const result = await chat(h);
  assert.ok(result.kind === "answer");
  const headers = usageHeadersOf(result.billing);
  assert.deepEqual(headers, {
    "x-wheelsai-charged-cents": "0",
    "x-wheelsai-balance-cents": "500",
    "x-wheelsai-plan": "plan-trial",
    "x-wheelsai-plan-limit": "20",
    "x-wheelsai-plan-used": "4",
    "x-wheelsai-plan-remaining": "16",
  });
  assert.equal(PLAN_RESET_HEADER in headers, false);
});

test("a use on a trial is given back, once, when no answer is delivered, and no money row is written", async () => {
  const givenBack = { ...NO_MONEY, used: 3, takes: 1, givenBack: 1, modelCalls: 1 };

  // A withheld answer. No refund is spoken of: nothing was charged.
  const withheld = trialHarness({}, { answer: LEAK });
  assert.deepEqual(refusalIn(await chat(withheld)), {
    status: 502,
    code: "answer_withheld",
    message: "This answer could not be shown.",
  });
  assert.deepEqual(movedOf(withheld), givenBack);

  // The model fails.
  const failed = trialHarness({}, { outcome: { ok: false, error: "quota exceeded", toolCalls: [], code: "provider_error" } });
  assert.deepEqual(refusalIn(await chat(failed)), {
    status: 502,
    code: "model_error",
    message: "The agent could not answer just now. Please try again.",
  });
  assert.deepEqual(movedOf(failed), givenBack);

  // The caller left while the answer was produced.
  const abort = new AbortController();
  const gone = trialHarness({}, { abortDuringRun: abort });
  assert.deepEqual(refusalIn(await chat(gone, CHAT, SESSION, abort.signal)), {
    status: 499,
    code: "client_closed_request",
    message: "The request was cancelled.",
  });
  assert.deepEqual(movedOf(gone), givenBack);
});

// ============================================
// Past its uses
// ============================================

const OFFER_ROW = { id: "plan-1", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n };
const OFFER = { id: "plan-1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 };
const TRIAL_USED_UP = {
  status: 429,
  code: "plan_used_up",
  message: "You have used all 20 uses of your free trial. Choose a plan or pay per use to keep using it. Nothing was charged.",
  plans: [OFFER],
  planCount: { id: "plan-trial", includedUses: 20, carriedUses: 0, usedUses: 20 },
};
const withOffers = (h: PaidHarness) => {
  h.deps.loadPlans = async () => [OFFER_ROW];
  return h;
};

test("past its uses a trial stops with its own sentence, no time at which it starts again, and the plans on offer, in both shapes", async () => {
  const h = withOffers(trialHarness({ usedInPeriod: 20 }));
  const result = await chat(h);
  const refusal = refusalIn(result);
  assert.deepEqual(refusal, TRIAL_USED_UP);
  // Nothing was charged, no use was taken, and the model was not called.
  assert.deepEqual(movedOf(h), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });
  assert.ok(result.kind === "refused");

  // The page's shape: the sentence and the plans, no time and no wait.
  const body = paidRefusalBody(result.refusal);
  assert.deepEqual(body, { error: "plan_used_up", message: TRIAL_USED_UP.message, plans: [OFFER] });
  assert.equal("resetsAt" in body || "retryAfterSeconds" in body, false);

  // OpenAI's shape: the same sentence and plans on the error, and no Retry-After.
  const openAi = paidUseOpenAiError(result.refusal);
  assert.equal(openAi.status, 429);
  assert.equal(openAi.body.error.message, TRIAL_USED_UP.message);
  assert.equal(openAi.body.error.code, "plan_used_up");
  assert.deepEqual((openAi.body.error as Row).plans, [OFFER]);
  assert.equal("resetsAt" in openAi.body.error, false);
  assert.equal("retry-after" in openAi.headers, false);

  // The usage headers of the refusal: the count, and no reset.
  const headers = refusalUsageHeadersOf(result.refusal);
  assert.equal(headers["x-wheelsai-plan-remaining"], "0");
  assert.equal(PLAN_RESET_HEADER in headers, false);

  // A paid plan that stops, in the same place, tells when it starts again: the trial's words are its own.
  const paid = withOffers(paidHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, usedInPeriod: 500, extraUsePriceCents: null } }));
  const paidRefusal = refusalIn(await chat(paid)) as Row;
  assert.equal(paidRefusal.message, "You have used all 500 uses. It starts again on 1 Nov. Nothing was charged.");
  assert.equal(typeof paidRefusal.resetsAt, "string");
  assert.equal(typeof paidRefusal.retryAfterSeconds, "number");
});

test("the last use of a trial taken by another request at the same moment: this one is stopped with the trial's sentence, uncharged", async () => {
  // Read with one use left; another request takes it before this one does.
  const h = withOffers(
    trialHarness(
      { usedInPeriod: 19 },
      {
        beforeTake: (row) => {
          row.usedInPeriod = 20;
        },
      },
    ),
  );
  assert.deepEqual(refusalIn(await chat(h)), TRIAL_USED_UP);
  assert.deepEqual(movedOf(h), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });
});

test("a trial of one use reads right, and the extra price on a trial's row is never billed to anybody", async () => {
  const one = trialHarness({ includedUses: 1, usedInPeriod: 1 });
  assert.equal(
    (refusalIn(await chat(one)) as Row).message,
    "You have used the 1 use of your free trial. Choose a plan or pay per use to keep using it. Nothing was charged.",
  );
  // A buyer who agreed to a price per use is not charged it while the trial runs: its uses come first.
  const agreed = trialHarness({ usedInPeriod: 5 }, { licence: LICENCE });
  const answered = await chat(agreed);
  assert.deepEqual(answered.kind === "answer" && [answered.billing.chargedCents, answered.billing.plan?.trial], [0, true]);
  assert.deepEqual(movedOf(agreed), { ...NO_MONEY, used: 6, takes: 1, givenBack: 0, modelCalls: 1 });

  // A trial row that carried a price for an extra use (a start never writes one) bills nothing to a buyer
  // who agreed to no price per use: read used up, and with its last use taken by another request at the same moment.
  const priced = withOffers(trialHarness({ usedInPeriod: 20, extraUsePriceCents: 3n }));
  assert.equal((refusalIn(await chat(priced)) as Row).message, TRIAL_USED_UP.message);
  assert.deepEqual(movedOf(priced), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });

  const raced = withOffers(
    trialHarness(
      { usedInPeriod: 19, extraUsePriceCents: 3n },
      {
        beforeTake: (row) => {
          row.usedInPeriod = 20;
        },
      },
    ),
  );
  assert.equal((refusalIn(await chat(raced)) as Row).message, TRIAL_USED_UP.message);
  assert.deepEqual(movedOf(raced), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });

  // And to a buyer who agreed to the listing's $0.05 a use it is that price that is charged, never the row's $0.03.
  const perUse = trialHarness({ usedInPeriod: 20, extraUsePriceCents: 3n }, { licence: LICENCE });
  const paid = await chat(perUse);
  assert.equal(paid.kind === "answer" && paid.billing.chargedCents, 5);
  assert.deepEqual(perUse.money.revenue.map((r) => r.gross), [5n]);
});

// ============================================
// Past its uses, for a buyer who agreed to pay per use
// ============================================

/** At 20 of 20, on a licence that agreed to the listing's $0.05 a use. */
const agreedAtCount = (sub: Partial<PaidSubscription> = {}, options: PaidHarnessOptions = {}) =>
  trialHarness({ usedInPeriod: 20, ...sub }, { licence: LICENCE, ...options });

test("past a trial's uses a buyer who agreed to pay per use is answered and charged that price once, split 90 and 10, and the trial's count does not move", async () => {
  // The agreement this rests on is the buyer's own, to exactly the price that is charged.
  assert.deepEqual(
    [LICENCE.acceptedPricingModel, LICENCE.acceptedPricePerRequestCents, LISTING.pricePerRequestCents],
    ["per_request", 5n, 5n],
  );
  for (const caller of [SESSION, KEY_CALLER]) {
    const h = agreedAtCount({}, { keyCaps: { maxUse: 50n, daily: 100n } });
    const result = await chat(h, CHAT, caller);
    assert.equal(result.kind, "answer");
    assert.deepEqual(result.kind === "answer" && result.billing, {
      chargedCents: 5,
      balanceCents: 495,
      access: "subscribed",
      plan: {
        id: "plan-trial",
        use: "extra",
        trial: true,
        includedUses: 20,
        carriedUses: 0,
        usedUses: 20,
        remainingUses: 0,
        // The trial's own row has no extra price: what was charged is the price per use, told as charged.
        extraUsePriceCents: null,
        warning: 100,
      },
    });
    assert.equal(h.money.balance, 495n);
    assert.deepEqual(h.money.revenue.map((r) => [r.type, r.status, r.gross, r.creator, r.platformFee]), [["per_request", "settled", 5n, 4n, 1n]]);
    assert.deepEqual(h.money.ledger.map((l) => [l.type, l.amountCents]), [["marketplace_usage", -5n]]);
    assert.equal(h.money.publisherPending, 4n);
    assert.equal(h.money.keySpent, caller === KEY_CALLER ? 5n : 0n);
    // One debit, held before the model ran; no use of the trial was taken or given back.
    assert.deepEqual([countOf(h, "charge"), countOf(h, "settle"), countOf(h, "model")], [1, 1, 1]);
    assert.ok(h.log.indexOf("charge") < h.log.indexOf("model"));
    assert.deepEqual([h.sub?.usedInPeriod, countOf(h, "take"), countOf(h, "giveBack")], [20, 0, 0]);
    // Held to the day as a buyer who pays per use is, and sent no warning as on any use of a trial.
    assert.ok(h.log.some((entry) => entry.startsWith("limit:pu:b:d")), h.log.join(","));
    await h.warnings.settled();
    assert.deepEqual([h.warnings.asked.length, h.warnings.claims, h.warnings.emails.length], [0, 0, 0]);
  }

  // The last use of the trial went to another request at the same moment: this one is the first paid one.
  const raced = trialHarness(
    { usedInPeriod: 19 },
    {
      licence: LICENCE,
      beforeTake: (row) => {
        row.usedInPeriod = 20;
      },
    },
  );
  const result = await chat(raced);
  assert.deepEqual(result.kind === "answer" && [result.billing.chargedCents, result.billing.plan?.use], [5, "extra"]);
  assert.deepEqual([raced.money.balance, raced.money.revenue.length, raced.sub?.usedInPeriod, countOf(raced, "take")], [495n, 1, 20, 0]);

  // A price the creator lowered is the price charged: never more than was agreed.
  const lowered = agreedAtCount({}, { listing: { ...LISTING, pricePerRequestCents: 2n } });
  const cheaper = await chat(lowered);
  assert.equal(cheaper.kind === "answer" && cheaper.billing.chargedCents, 2);
  assert.equal(lowered.money.balance, 498n);
});

test("that use is given back in full when no answer is delivered, and the trial's count is left alone", async () => {
  const back = { ...NO_MONEY, charges: 1, revenue: 1, ledger: 2, used: 20, takes: 0, givenBack: 0, modelCalls: 1 };

  const withheld = agreedAtCount({}, { answer: LEAK });
  assert.deepEqual(refusalIn(await chat(withheld)), {
    status: 502,
    code: "answer_withheld",
    message: "This answer could not be shown. Your $0.05 was refunded.",
    refundedCents: 5,
  });
  assert.deepEqual(movedOf(withheld), back);
  assert.deepEqual(withheld.money.revenue.map((r) => r.status), ["refunded"]);

  const failed = agreedAtCount({}, { outcome: { ok: false, error: "quota exceeded", toolCalls: [], code: "provider_error" } });
  assert.equal((refusalIn(await chat(failed)) as Row).refundedCents, 5);
  assert.deepEqual(movedOf(failed), back);
  assert.deepEqual(failed.money.revenue.map((r) => r.status), ["refunded"]);
});

test("that use is refused, with nothing charged, by a key's cap per use, by too few credits and when the trial's row moved", async () => {
  const nothing = { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 };

  // A key that may pay at most $0.04 a use.
  const capped = agreedAtCount({}, { keyCaps: { maxUse: 4n, daily: 1_000n } });
  const cap = refusalIn(await chat(capped, CHAT, KEY_CALLER)) as Row;
  assert.deepEqual([cap.status, cap.code], [403, "api_key_use_price_cap_exceeded"]);
  assert.deepEqual(movedOf(capped), nothing);
  // The key's day is full.
  const spent = agreedAtCount({}, { keyCaps: { maxUse: 50n, daily: 100n, spent: 98n } });
  assert.equal((refusalIn(await chat(spent, CHAT, KEY_CALLER)) as Row).status, 403);
  assert.deepEqual(movedOf(spent), { ...nothing, keySpent: 98n });

  // Too few credits for the price per use.
  const broke = agreedAtCount({}, { balance: 4n });
  const short = refusalIn(await chat(broke)) as Row;
  assert.deepEqual([short.status, short.code, short.priceCents, short.balanceCents], [402, "insufficient_credits", 5, 4]);
  assert.deepEqual(movedOf(broke), { ...nothing, balance: 4n });

  // A paid plan took the row over between the read and the charge: the claim misses and nothing is debited.
  const moved = agreedAtCount(
    {},
    {
      beforeCharge: (row) => {
        Object.assign(row, { planId: "plan-1", priceCents: 900n, includedUses: 500, usedInPeriod: 0, extraUsePriceCents: 4n });
      },
    },
  );
  assert.equal((refusalIn(await chat(moved)) as Row).status, 503);
  assert.deepEqual([moved.money.balance, moved.money.revenue.length, moved.money.ledger.length, countOf(moved, "model")], [500n, 0, 0, 0]);
});

test("nobody who did not agree to that price is charged it past a trial: they are stopped with the trial's sentence", async () => {
  const notAgreed: Array<[string, typeof LICENCE]> = [
    ["no agreement at all", PLAN_LICENCE],
    ["an agreement to a month", { ...LICENCE, acceptedPricingModel: "monthly", acceptedPricePerRequestCents: null }],
    ["a price with no pricing model agreed", { ...LICENCE, acceptedPricingModel: null }],
    ["an agreement on a suspended licence", { ...LICENCE, status: "suspended" }],
  ];
  for (const [what, licence] of notAgreed) {
    for (const caller of [SESSION, KEY_CALLER]) {
      const h = withOffers(trialHarness({ usedInPeriod: 20 }, { licence, keyCaps: { maxUse: 50n, daily: 100n } }));
      assert.deepEqual(refusalIn(await chat(h, CHAT, caller)), TRIAL_USED_UP, what);
      assert.deepEqual(movedOf(h), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 }, what);
    }
  }
});

test("a buyer whose agreed price no longer covers the listing's is refused as a price that changed, and nothing is charged", async () => {
  // Agreed to $0.05; the listing asks $0.09 now.
  const raised = { ...LISTING, pricePerRequestCents: 9n };
  const h = withOffers(agreedAtCount({}, { listing: raised }));
  assert.deepEqual(refusalIn(await chat(h)), {
    status: 409,
    code: "pricing_changed",
    message: "The owner changed the price to $0.09 per message. You agreed to $0.05. Nothing is charged until you accept the new price.",
    access: "pricing_changed",
    terms: { pricingModel: "per_request", pricePerRequestCents: 9, monthlyPriceCents: null, unit: "message", keepsCopy: false },
  });
  assert.deepEqual(movedOf(h), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });

  // While a use of the trial is left it still runs, free.
  const running = trialHarness({ usedInPeriod: 19 }, { licence: LICENCE, listing: raised });
  const last = await chat(running);
  assert.deepEqual(last.kind === "answer" && [last.billing.chargedCents, last.billing.plan?.use], [0, "included"]);
  assert.deepEqual(movedOf(running), { ...NO_MONEY, used: 20, takes: 1, givenBack: 0, modelCalls: 1 });

  // Read with one use left and beaten to it: stopped, uncharged. The higher price is never taken.
  const raced = withOffers(
    trialHarness(
      { usedInPeriod: 19 },
      {
        licence: LICENCE,
        listing: raised,
        beforeTake: (row) => {
          row.usedInPeriod = 20;
        },
      },
    ),
  );
  assert.equal((refusalIn(await chat(raced)) as Row).code, "plan_used_up");
  assert.deepEqual(movedOf(raced), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });
});

test("a paid plan that stops still stops for a buyer who agreed per use, and a month and a buyer with no subscription are what they were", async () => {
  // The plan's terms say it stops: the price per use the buyer agreed to is not charged in its place.
  const stops = paidHarness({ licence: LICENCE, sub: { ...PLAN_SUB, usedInPeriod: 500, extraUsePriceCents: null } });
  const refusal = refusalIn(await chat(stops)) as Row;
  assert.deepEqual([refusal.status, refusal.code], [429, "plan_used_up"]);
  assert.equal(refusal.message, "You have used all 500 uses. It starts again on 1 Nov. Nothing was charged.");
  assert.deepEqual([stops.money.balance, stops.money.revenue.length, countOf(stops, "charge"), countOf(stops, "model")], [500n, 0, 0, 0]);
  // A plan with an extra price charges that price, $0.04, not the listing's $0.05.
  const extra = paidHarness({ licence: LICENCE, sub: { ...PLAN_SUB, usedInPeriod: 500 } });
  const charged = await chat(extra);
  assert.deepEqual(charged.kind === "answer" && [charged.billing.chargedCents, charged.billing.plan?.trial], [4, false]);

  // A month with no count: nothing is charged and no plan is named.
  const month = paidHarness({ listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: PAID_MONTH });
  const inMonth = await chat(month);
  assert.deepEqual(inMonth.kind === "answer" && inMonth.billing, { chargedCents: 0, balanceCents: 500, access: "subscribed" });
  assert.equal(month.money.revenue.length, 0);

  // No subscription at all: one use at the price agreed.
  const perUse = paidHarness();
  const used = await chat(perUse);
  assert.deepEqual(used.kind === "answer" && used.billing, { chargedCents: 5, balanceCents: 495, access: "listing_pricing" });
  assert.deepEqual(perUse.money.revenue.map((r) => [r.type, r.status, r.gross, r.creator, r.platformFee]), [["per_request", "settled", 5n, 4n, 1n]]);
});

// ============================================
// No warning
// ============================================

test("a trial sends no warning: nothing is asked, claimed or sent at 85% or at 100% of its uses", async () => {
  // The 17th use of 20 is 85%; the 20th is all of them.
  for (const usedInPeriod of [16, 19]) {
    for (const stream of [false, true]) {
      const h = trialHarness({ usedInPeriod });
      const result = await chat(h, { ...CHAT, stream });
      if (result.kind === "stream") {
        await new Response(result.chat.stream).text();
        await result.finished({ ok: true, usage: null, toolCalls: [] });
        assert.equal(result.billing.plan?.warning, usedInPeriod === 16 ? 85 : 100);
      } else {
        // The level is still told in the answer, as on a plan: only the email is not sent.
        assert.equal(result.kind === "answer" && result.billing.plan?.warning, usedInPeriod === 16 ? 85 : 100);
      }
      await h.warnings.settled();
      assert.deepEqual([h.warnings.asked.length, h.warnings.claims, h.warnings.emails.length, h.warnings.level], [0, 0, 0, 0]);
    }
  }

  // The same count on a paid plan does ask, claim and send: the trial is what is exempt.
  const paid = paidHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, includedUses: 20, usedInPeriod: 16 } });
  await chat(paid);
  await paid.warnings.settled();
  assert.deepEqual([paid.warnings.asked.length, paid.warnings.claims, paid.warnings.emails.length, paid.warnings.level], [1, 1, 1, 85]);
});

// ============================================
// A paid plan started over a running trial
// ============================================

/** A world whose buyer started the trial some days ago and has used some of it. */
function onTrial(over: Row = {}, world: World = makeWorld({ balance: 10_000n })) {
  const startedAt = new Date(Date.now() - 2 * DAY);
  world.state.installs.push({
    id: "ins_1",
    listingId: LISTING_ID,
    buyerId: BUYER,
    kind: "use",
    status: "active",
    clonedAgentId: null,
    uninstalledAt: null,
    totalRequests: 0n,
    totalSpentCents: 0n,
    acceptedPricingModel: null,
    acceptedPricePerRequestCents: null,
    pricingAcceptedAt: null,
  });
  world.state.subs.push({
    id: "sub_1",
    listingId: LISTING_ID,
    subscriberId: BUYER,
    status: "active",
    currentPeriodStart: startedAt,
    currentPeriodEnd: new Date(startedAt.getTime() + 7 * DAY),
    cancelAtPeriodEnd: true,
    cancelledAt: null,
    priceCents: 0n,
    endReason: null,
    planId: TRIAL_ID,
    includedUses: 20,
    usedInPeriod: 8,
    carriedUses: 0,
    extraUsePriceCents: null,
    warnedLevel: 0,
    trialUsedAt: startedAt,
    ...over,
  });
  world.state.listing.totalInstalls = 1;
  world.state.listing.activeInstalls = 1;
  return { world, startedAt };
}

test("a paid plan started over a running trial charges that plan once, starts 30 days, carries nothing and keeps the day the trial was started", async () => {
  const { world, startedAt } = onTrial();
  const before = Date.now();
  await withApp(world, async (send) => {
    const res = await send({ plan: STARTER });
    assert.equal(res.status, 201);
    assert.equal(res.body.access, "subscribed");
    assert.equal(res.body.subscription.priceCents, 900);
  });
  const sub = world.state.subs[0]!;
  assert.equal(world.state.subs.length, 1);
  assert.deepEqual(
    [sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.extraUsePriceCents, sub.usedInPeriod, sub.carriedUses, sub.warnedLevel],
    ["active", STARTER_ID, 900n, 500, 5n, 0, 0, 0],
  );
  // A plan that renews, for a fresh 30 days from now: nothing of the trial's days or uses is in it.
  assert.equal(sub.cancelAtPeriodEnd, false);
  assert.equal(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime(), 30 * DAY);
  assert.ok(sub.currentPeriodStart.getTime() >= before);
  assert.equal(sub.trialUsedAt.getTime(), startedAt.getTime());

  // Charged once, as any start: the full price, split 90 and 10.
  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual(world.state.ledger.map((row) => [row.type, row.amountCents]), [["marketplace_subscription", -900n]]);
  assert.deepEqual(
    world.state.revenue.map((row) => [row.type, row.grossAmountCents, row.creatorAmountCents, row.platformFeeCents]),
    [["subscription", 900n, 810n, 90n]],
  );
  assert.deepEqual(world.state.earnings.map((row) => [row.orgId, row.amountCents]), [[PUBLISHER, 810n]]);
  // Starting a plan is still no agreement to a price per use, and the buyer is not counted twice.
  assert.deepEqual([world.state.installs[0]!.acceptedPricingModel, world.state.installs[0]!.acceptedPricePerRequestCents], [null, null]);
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("a paid plan over a trial is the normal start: one a buyer cannot pay for charges nothing and leaves the trial as it was", async () => {
  const { world } = onTrial({}, makeWorld({ balance: 100n }));
  const before = structuredClone(world.state.subs);
  await withApp(world, async (send) => {
    const res = await send({ plan: STARTER });
    assert.deepEqual([res.status, res.body.error], [402, "insufficient_credits"]);
  });
  assert.deepEqual(world.state.subs, before);
  // The debit was asked for and refused: the balance and every money table are as they were.
  assert.equal(world.state.balance, 100n);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.earnings.length], [0, 0, 0]);

  // A paid plan while on a paid plan is still refused: only a trial is started over.
  const paid = onTrial({ priceCents: 900n, planId: STARTER_ID, includedUses: 500, cancelAtPeriodEnd: false, extraUsePriceCents: 5n }).world;
  await withApp(paid, async (send) => {
    const res = await send({ plan: STARTER });
    assert.deepEqual([res.status, res.body.error], [409, "already_on_plan"]);
  });
  assert.equal(paid.state.balance, 10_000n);
});

test("two starts of a plan over a trial at the same moment charge one plan", async () => {
  const { world } = onTrial();
  await withApp(world, async (send) => {
    const results = await Promise.all([send({ plan: STARTER }), send({ plan: STARTER })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.ok(["already_on_plan", "subscription_claim_lost"].includes(results.find((r) => r.status === 409)!.body.error));
  });
  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.earnings.length], [1, 1, 1]);
});

test("the claim of a plan over a trial names the trial row as it was read: whatever moved the row first makes it miss before anything is charged", async () => {
  const { startPlanSubscription, SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
  const plan = { planId: STARTER_ID, priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n };
  const listing = { id: LISTING_ID, title: "Research Analyst", publisherId: PUBLISHER };

  // Each of these happens between the claim's read of the row and its write.
  const inBetween: Array<[string, (row: Row) => void]> = [
    // The trial's 7 days ended and the renewal closed it.
    ["the trial's end", (row) => Object.assign(row, { status: "cancelled", cancelledAt: new Date(), endReason: "plan_ended" })],
    // Another start of a plan took the row: a second charge would be a double charge.
    [
      "another start",
      (row) =>
        Object.assign(row, {
          priceCents: 2900n,
          planId: "plan_pro",
          includedUses: 2000,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * DAY),
          cancelAtPeriodEnd: false,
        }),
    ],
    // The buyer stopped using the agent.
    ["a stop", (row) => Object.assign(row, { status: "cancelled", cancelledAt: new Date(), cancelAtPeriodEnd: false })],
  ];
  for (const [what, change] of inBetween) {
    const { world } = onTrial();
    const tx = {
      ...world.models,
      agentSubscription: {
        ...world.models.agentSubscription,
        findUnique: async (args: Row) => {
          const read = await world.models.agentSubscription.findUnique(args);
          change(world.state.subs[0]!);
          return read;
        },
      },
    };
    const after = structuredClone(world.state.subs);
    change(after[0]!);
    await assert.rejects(
      startPlanSubscription(tx as never, { listing, plan, buyerId: BUYER, licence: { id: "ins_1", kind: "use" } }),
      SubscriptionClaimLostError,
      what,
    );
    // Not charged, and the row is what the other writer made it.
    assert.equal(world.state.balance, 10_000n, what);
    assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.earnings.length], [0, 0, 0], what);
    assert.deepEqual(
      [world.state.subs[0]!.status, world.state.subs[0]!.planId, world.state.subs[0]!.priceCents],
      [after[0]!.status, after[0]!.planId, after[0]!.priceCents],
      what,
    );
  }

  // A use that took one of the trial's uses in between does not stand in the way: nothing of the trial is carried.
  const { world } = onTrial();
  const tx = {
    ...world.models,
    agentSubscription: {
      ...world.models.agentSubscription,
      findUnique: async (args: Row) => {
        const read = await world.models.agentSubscription.findUnique(args);
        world.state.subs[0]!.usedInPeriod += 1;
        return read;
      },
    },
  };
  await startPlanSubscription(tx as never, { listing, plan, buyerId: BUYER, licence: { id: "ins_1", kind: "use" } });
  assert.deepEqual([world.state.subs[0]!.planId, world.state.subs[0]!.usedInPeriod, world.state.balance], [STARTER_ID, 0, 9_100n]);
  assert.equal(world.state.ledger.length, 1);
});

test("a use decided on the trial, and the trial's end, that land after the plan was started change nothing of the plan", async () => {
  const { renewSubscription } = await import("../services/marketplaceSubscriptions.js");
  const { world } = onTrial();
  const trial = structuredClone(world.state.subs[0]!);
  await withApp(world, async (send) => {
    assert.equal((await send({ plan: STARTER })).status, 201);
  });
  const money = [world.state.balance, world.state.ledger.length, world.state.revenue.length];

  // A use that read the trial row takes nothing from the plan's count: it names the trial's period and terms.
  const taken = await takeIncludedUse(world.models as never, {
    subscriptionId: trial.id,
    periodStart: trial.currentPeriodStart,
    includedUses: trial.includedUses,
    carriedUses: 0,
  });
  assert.deepEqual(taken, { taken: false });
  assert.equal(world.state.subs[0]!.usedInPeriod, 0);

  // The renewal that loaded the trial row, at the trial's end, closes nothing and charges nothing.
  const outcome = await renewSubscription(world.models as never, {
    sub: { ...trial, licenceKind: "use" } as never,
    listing: { id: LISTING_ID, title: "Research Analyst", publisherId: PUBLISHER, monthlyPriceCents: 0n, pricingModel: "per_request", status: "published", sells: "use", pausedSince: null },
    now: new Date(trial.currentPeriodEnd.getTime() + 1),
  });
  assert.deepEqual(outcome, { kind: "lost_race" });
  assert.deepEqual([world.state.subs[0]!.status, world.state.subs[0]!.planId], ["active", STARTER_ID]);
  assert.equal(world.state.installs[0]!.status, "active");
  assert.deepEqual([world.state.balance, world.state.ledger.length, world.state.revenue.length], money);
});

// ============================================
// No move from a trial
// ============================================

test("switchNow on a trial is refused with its own code and sentence, and nothing is charged", async () => {
  const { world } = onTrial();
  const before = structuredClone(world.state.subs);
  await withApp(world, async (send) => {
    const res = await send({ plan: STARTER, switchNow: true });
    assert.deepEqual([res.status, res.body], [
      409,
      {
        error: "trial_cannot_move",
        message: "You are on a free trial. Start the plan you want: nothing of the trial is carried over.",
      },
    ]);
    // Whatever plan is named, the trial itself included.
    const self = await send({ plan: TRIAL, switchNow: true });
    assert.deepEqual([self.status, self.body.error], [409, "trial_cannot_move"]);
  });
  assert.deepEqual(world.state.subs, before);
  noMoney(world, 10_000n);

  // The claim judges the row again: a trial is refused there too, before any charge.
  const { judgePlanMove, movePlanSubscription, PlanMoveRefusedError } = await import("../services/marketplaceSubscriptions.js");
  const target = { planId: STARTER_ID, priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n };
  assert.deepEqual(judgePlanMove({ ...before[0]!, planRetired: false } as never, target, new Date()), { ok: false, refusal: "on_trial" });
  await assert.rejects(
    movePlanSubscription(world.models as never, {
      listing: { id: LISTING_ID, title: "Research Analyst", publisherId: PUBLISHER },
      plan: target,
      buyerId: BUYER,
      licenceId: "ins_1",
    }),
    (err: unknown) => err instanceof PlanMoveRefusedError && err.reason === "on_trial",
  );
  noMoney(world, 10_000n);
  // A paid plan in the same place can move: the trial is what is refused.
  assert.deepEqual(
    judgePlanMove({ ...before[0]!, priceCents: 500n, planRetired: false } as never, target, new Date()),
    { ok: true, carriedUses: 12 },
  );
});

// ============================================
// The end of a trial
// ============================================

const BILLING_LISTING = {
  id: LISTING_ID,
  title: "Research Analyst",
  publisherId: PUBLISHER,
  monthlyPriceCents: 0n,
  pricingModel: "per_request",
  status: "published",
  sells: "use",
  pausedSince: null,
};

test("at the end of its 7 days a trial is closed, uncharged, and its licence is left as it is", async () => {
  const { renewSubscription } = await import("../services/marketplaceSubscriptions.js");
  // Closed whatever its flag says: a trial never renews.
  for (const cancelAtPeriodEnd of [true, false]) {
    const { world } = onTrial({ cancelAtPeriodEnd });
    const row = () => ({ ...world.state.subs[0]!, licenceKind: "use" }) as never;
    const end = world.state.subs[0]!.currentPeriodEnd as Date;

    // Inside its days nothing happens.
    assert.deepEqual(
      await renewSubscription(world.models as never, { sub: row(), listing: BILLING_LISTING, now: new Date(end.getTime() - 1) }),
      { kind: "not_due" },
    );
    assert.equal(world.state.subs[0]!.status, "active");

    const outcome = await renewSubscription(world.models as never, { sub: row(), listing: BILLING_LISTING, now: end });
    assert.deepEqual(outcome, { kind: "cancelled" });
    const sub = world.state.subs[0]!;
    assert.deepEqual([sub.status, sub.endReason, sub.priceCents, sub.planId], ["cancelled", "plan_ended", 0n, TRIAL_ID]);
    // The same period: it was not moved on, and the day the trial was started is still there.
    assert.equal(sub.currentPeriodEnd.getTime(), end.getTime());
    assert.ok(sub.trialUsedAt instanceof Date);
    // Not suspended: a buyer who agreed to a price per use goes on at that price.
    assert.equal(world.state.installs[0]!.status, "active");
    noMoney(world, 10_000n);

    // A second tick finds nothing to close.
    assert.deepEqual(await renewSubscription(world.models as never, { sub: row(), listing: BILLING_LISTING, now: end }), {
      kind: "lost_race",
    });
  }

  // A trial has no days of grace: found long after its end, it is closed the same way and never charged.
  const late = onTrial().world;
  const lateEnd = late.state.subs[0]!.currentPeriodEnd as Date;
  assert.deepEqual(
    await renewSubscription(late.models as never, {
      sub: { ...late.state.subs[0]!, licenceKind: "use" } as never,
      listing: BILLING_LISTING,
      now: new Date(lateEnd.getTime() + 20 * DAY),
    }),
    { kind: "cancelled" },
  );
  noMoney(late, 10_000n);
});

const TRIAL_ENDED = {
  status: 402,
  code: "plan_ended",
  message: "Your free trial ended. Choose a plan or pay per use to keep using it.",
  access: "plan_ended",
  terms: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null, unit: "message", keepsCopy: false },
  plans: [OFFER],
};

test("after a trial the next use is refused with the trial's sentence, the price per use and the plans to choose from, and nothing is charged", async () => {
  const ended: Array<[string, Partial<PaidSubscription>]> = [
    // Its 7 days are over and the renewal has not closed it yet: no days of grace.
    ["past its end, still open", { currentPeriodEnd: new Date(NOW.getTime() - 1000) }],
    // Closed by the renewal.
    ["closed", { status: "cancelled", endReason: "plan_ended", currentPeriodEnd: new Date(NOW.getTime() - DAY) }],
    // Closed with uses left: the days decide, not the count.
    ["closed with uses left", { status: "cancelled", endReason: "plan_ended", usedInPeriod: 0, currentPeriodEnd: new Date(NOW.getTime() - DAY) }],
  ];
  for (const [what, sub] of ended) {
    const h = withOffers(trialHarness(sub));
    assert.deepEqual(refusalIn(await chat(h)), TRIAL_ENDED, what);
    assert.deepEqual(movedOf(h), { ...NO_MONEY, used: h.sub?.usedInPeriod, takes: 0, givenBack: 0, modelCalls: 0 }, what);
  }

  // A paid plan that ended says so in the plan's words: the sentence follows what the row was.
  const plan = withOffers(
    paidHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, status: "cancelled", endReason: "plan_ended", currentPeriodEnd: new Date(NOW.getTime() - DAY) } }),
  );
  assert.equal((refusalIn(await chat(plan)) as Row).message, "Your plan ended. Choose a plan or pay per use to keep using it.");
});

test("a buyer who agreed to a price per use goes on at that price when the trial is over, and was charged nothing while it ran", async () => {
  // While the trial runs its uses come first.
  const running = trialHarness({}, { licence: LICENCE });
  const during = await chat(running);
  assert.deepEqual(during.kind === "answer" && [during.billing.chargedCents, during.billing.access], [0, "subscribed"]);
  assert.deepEqual(movedOf(running), { ...NO_MONEY, used: 4, takes: 1, givenBack: 0, modelCalls: 1 });

  // Over: the price they agreed to, $0.05, charged once and split 90 and 10. No plan is named.
  for (const sub of [
    { currentPeriodEnd: new Date(NOW.getTime() - 1000) },
    { status: "cancelled", endReason: "plan_ended", currentPeriodEnd: new Date(NOW.getTime() - DAY) },
  ]) {
    const h = trialHarness(sub, { licence: LICENCE });
    const after = await chat(h);
    assert.deepEqual(after.kind === "answer" && after.billing, { chargedCents: 5, balanceCents: 495, access: "listing_pricing" });
    assert.equal(h.money.balance, 495n);
    assert.deepEqual(h.money.revenue.map((r) => [r.status, r.gross, r.creator, r.platformFee]), [["settled", 5n, 4n, 1n]]);
    // The trial's count is not touched by a use that is paid for.
    assert.deepEqual([h.sub?.usedInPeriod, countOf(h, "take")], [3, 0]);
  }
  assert.equal(LISTING.pricePerRequestCents, 5n);
});

const agreementOf = (world: World) => {
  const licence = world.state.installs[0]!;
  return [licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt];
};

test("agreeing to pay per use while a trial runs is written on the licence once, answers 201, and the trial is what it was with no money moved", async () => {
  const { world } = onTrial();
  const before = structuredClone(world.state.subs);
  const started = Date.now();
  await withApp(world, async (send) => {
    const res = await send({ expected: PER_USE });
    assert.equal(res.status, 201);
    // The trial is what runs; the price agreed is what comes after its uses.
    assert.equal(res.body.access, "subscribed");
    assert.deepEqual([res.body.acceptedPricing.pricingModel, res.body.acceptedPricing.pricePerRequestCents], ["per_request", 5]);
    const [model, price, at] = agreementOf(world);
    assert.deepEqual([model, price], ["per_request", 5n]);
    assert.ok(at instanceof Date && at.getTime() >= started);

    // Said again: the licence already carries it. 200, and the day it was agreed is not moved.
    const again = await send({ expected: PER_USE });
    assert.equal(again.status, 200);
    assert.deepEqual(agreementOf(world), [model, price, at]);
  });
  // Nothing of the trial changed: not its count, its days, its flag or the day it was started.
  assert.deepEqual(world.state.subs, before);
  noMoney(world, 10_000n);
  const licence = world.state.installs[0]!;
  assert.deepEqual([licence.kind, licence.status, licence.clonedAgentId], ["use", "active", null]);
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("two requests to pay per use during a trial at the same moment write the agreement once", async () => {
  const { world } = onTrial();
  const before = structuredClone(world.state.subs);
  // Both requests read the licence, with no agreement on it, before either writes.
  const findUnique = world.models.agentInstall.findUnique;
  let waiting = 0;
  let release = () => {};
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  world.models.agentInstall.findUnique = async (args: Row) => {
    const row = await findUnique(args);
    if (++waiting <= 2) {
      if (waiting === 2) release();
      await bothRead;
    }
    return row;
  };
  let writes = 0;
  const updateMany = world.models.agentInstall.updateMany;
  world.models.agentInstall.updateMany = async (args: Row) => {
    const result = await updateMany(args);
    writes += result.count;
    return result;
  };
  await withApp(world, async (send) => {
    const results = await Promise.all([send({ expected: PER_USE }), send({ expected: PER_USE })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
    // Both are told the state as it stands.
    for (const res of results) {
      assert.deepEqual([res.body.access, res.body.acceptedPricing.pricePerRequestCents], ["subscribed", 5]);
    }
  });
  assert.equal(writes, 1);
  assert.deepEqual(world.state.subs, before);
  noMoney(world, 10_000n);
});

test("during a trial, terms that are not the listing's are refused and nothing is agreed to; so is a member who may not spend", async () => {
  const { world } = onTrial();
  const before = structuredClone(world.state.subs);
  await withApp(world, async (send) => {
    // Shown $0.04 or $0.06 where the listing asks $0.05, or a month.
    for (const expected of [
      { ...PER_USE, pricePerRequestCents: 4 },
      { ...PER_USE, pricePerRequestCents: 6 },
      { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 },
    ]) {
      const res = await send({ expected });
      assert.deepEqual([res.status, res.body.error], [409, "pricing_changed"]);
      // The price as it is now comes with the refusal.
      assert.equal(JSON.stringify(res.body).includes('"pricePerRequestCents":5'), true);
    }
    const none = await send({});
    assert.deepEqual([none.status, none.body.error], [400, "expected_terms_required"]);
    const member = await send({ expected: PER_USE }, { userId: "u_member", orgId: BUYER, type: "jwt" });
    assert.deepEqual([member.status, member.body.error], [403, "insufficient_role"]);
  });
  assert.deepEqual(agreementOf(world), [null, null, null]);
  assert.deepEqual(world.state.subs, before);
  noMoney(world, 10_000n);
});

test("a buyer told at the trial's count that the price changed accepts the new price, and the next use is charged it once", async () => {
  // Agreed to $0.05 themselves; the listing asks $0.09 now. At 20 of 20 they are told to accept it.
  const raised = { ...LISTING, pricePerRequestCents: 9n };
  const told = withOffers(agreedAtCount({}, { listing: raised }));
  assert.equal((refusalIn(await chat(told)) as Row).code, "pricing_changed");
  assert.deepEqual(movedOf(told), { ...NO_MONEY, used: 20, takes: 0, givenBack: 0, modelCalls: 0 });

  // Accepting it while the trial still runs is written on the licence, and nothing else moves.
  const { world } = onTrial({ usedInPeriod: 20 });
  world.state.listing.pricePerRequestCents = 9n;
  const agreedAt = new Date(0);
  Object.assign(world.state.installs[0]!, { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n, pricingAcceptedAt: agreedAt });
  const before = structuredClone(world.state.subs);
  const NEW_PRICE = { ...PER_USE, pricePerRequestCents: 9 };
  await withApp(world, async (send) => {
    // Sending the price without saying it is accepted raises nothing.
    const silent = await send({ expected: NEW_PRICE });
    assert.equal(silent.status, 200);
    assert.deepEqual(agreementOf(world), ["per_request", 5n, agreedAt]);
    // Accepting the price they agreed to before, not the listing's, is refused.
    const old = await send({ expected: PER_USE, acceptNewPricing: true });
    assert.deepEqual([old.status, old.body.error], [409, "pricing_changed"]);
    assert.deepEqual(agreementOf(world), ["per_request", 5n, agreedAt]);

    const res = await send({ expected: NEW_PRICE, acceptNewPricing: true });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.access, res.body.acceptedPricing.pricePerRequestCents], ["subscribed", 9]);
    const [model, price, at] = agreementOf(world);
    assert.deepEqual([model, price], ["per_request", 9n]);
    assert.ok(at instanceof Date && at.getTime() > agreedAt.getTime());
    assert.equal((await send({ expected: NEW_PRICE, acceptNewPricing: true })).status, 200);
    assert.deepEqual(agreementOf(world), [model, price, at]);
  });
  assert.deepEqual(world.state.subs, before);
  noMoney(world, 10_000n);

  // On the licence as that left it, the use at 20 of 20 is answered and charged $0.09, once.
  const h = agreedAtCount({}, { listing: raised, licence: { ...LICENCE, acceptedPricePerRequestCents: 9n } });
  const result = await chat(h);
  assert.deepEqual(result.kind === "answer" && [result.billing.chargedCents, result.billing.plan?.use, result.billing.plan?.trial], [9, "extra", true]);
  assert.equal(h.money.balance, 491n);
  assert.deepEqual(h.money.revenue.map((r) => [r.type, r.status, r.gross]), [["per_request", "settled", 9n]]);
  assert.deepEqual([countOf(h, "charge"), h.sub?.usedInPeriod, countOf(h, "take")], [1, 20, 0]);
});

test("the offers in a trial's refusals are the paid plans as they are: the trial is not among them", async () => {
  // A listing with a trial on offer, a trial its creator ended and another listing's trial beside one paid plan.
  const world = makeWorld();
  const offered = await readPlanOffers(world.models as never, LISTING_ID);
  assert.deepEqual(offered.map((plan) => plan.id), [STARTER_ID]);
  const both = await readOffers(world.models as never, LISTING_ID);
  assert.deepEqual(both.plans.map((plan) => plan.id), [STARTER_ID]);
  assert.deepEqual(both.trial, { id: TRIAL_ID, includedUses: 20 });

  // The same read behind a used-up trial's refusal and an ended trial's: the paid plan, and no trial.
  for (const sub of [{ usedInPeriod: 20 }, { currentPeriodEnd: new Date(NOW.getTime() - 1000) }]) {
    const h = trialHarness(sub);
    h.deps.loadPlans = (listingId) => readPlanOffers(world.models as never, listingId === LISTING.id ? LISTING_ID : listingId);
    const refusal = refusalIn(await chat(h)) as Row;
    assert.deepEqual(refusal.plans, ON_OFFER);
    assert.equal(JSON.stringify(refusal).includes(TRIAL_ID), false);
    assert.equal(JSON.stringify(refusal).includes("unlimited"), false);
  }

  // The sentences a buyer reads, as the service holds them.
  assert.equal(PAID_USE_MESSAGES.trialUsedUp(20), TRIAL_USED_UP.message);
  assert.equal(PAID_USE_MESSAGES.trialEnded, TRIAL_ENDED.message);
  for (const sentence of [PAID_USE_MESSAGES.trialUsedUp(20), PAID_USE_MESSAGES.trialUsedUp(1), PAID_USE_MESSAGES.trialEnded]) {
    assert.doesNotMatch(sentence, /_|[^\x20-\x7e]/);
  }
});
