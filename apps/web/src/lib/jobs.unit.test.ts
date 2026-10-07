/**
 * How jobs, escrow and API-key grants are worded. Run with:
 *   cd apps/web && npx tsx --test src/lib/jobs.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  JOB_STATUS,
  ORDINARY_SCOPES,
  SPEND_SCOPES,
  describeKeyAccess,
  dollarsToCents,
  formatCents,
  formatDuration,
  isFinished,
  jobTimeline,
  keyGrantProblem,
  newIdempotencyKey,
  termsChangedMessage,
  termsOf,
} from "./jobs";

const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:00:02.000Z";
const T2 = "2026-10-06T10:00:09.000Z";
const T3 = "2026-10-06T11:00:00.000Z";
const DUE = "2026-10-06T10:10:00.000Z";
const REVIEW = "2026-10-09T10:00:09.000Z";

const base = {
  fundedAt: T0,
  startedAt: null as string | null,
  submittedAt: null as string | null,
  completedAt: null as string | null,
  deadlineAt: DUE as string | null,
  reviewDeadlineAt: null as string | null,
};

const shape = (steps: ReturnType<typeof jobTimeline>) => steps.map((s) => `${s.key}:${s.state}`);

test("money and time read the way a person says them", () => {
  assert.equal(formatCents(50), "$0.50");
  assert.equal(formatCents(100_000), "$1,000.00");
  assert.equal(formatDuration(300), "5 minutes");
  assert.equal(formatDuration(5400), "1 hour 30 minutes");
  assert.equal(formatDuration(604_800), "7 days");
  assert.equal(formatDuration(90_061), "1 day 1 hour");
  assert.equal(formatDuration(1), "1 second");
  assert.equal(formatDuration(0), "0 seconds");
});

test("a queued job shows what is still to come, and when it is due", () => {
  const steps = jobTimeline({ ...base, status: "funded" });
  assert.deepEqual(shape(steps), ["funded:done", "running:pending", "submitted:pending", "ended:pending"]);
  assert.deepEqual(steps[1]!.until, { label: "Due by", at: DUE });
});

test("a running job", () => {
  const steps = jobTimeline({ ...base, status: "running", startedAt: T1 });
  assert.deepEqual(shape(steps), ["funded:done", "running:current", "submitted:pending", "ended:pending"]);
});

test("a submitted job waits on the buyer and says when it completes by itself", () => {
  const steps = jobTimeline({ ...base, status: "submitted", startedAt: T1, submittedAt: T2, reviewDeadlineAt: REVIEW });
  assert.deepEqual(shape(steps), ["funded:done", "running:done", "submitted:current", "ended:pending"]);
  assert.deepEqual(steps[2]!.until, { label: "Completes by itself on", at: REVIEW });
  assert.equal(steps[1]!.until, undefined);
});

test("a completed job is done at every step", () => {
  const steps = jobTimeline({ ...base, status: "completed", startedAt: T1, submittedAt: T2, completedAt: T3 });
  assert.deepEqual(shape(steps), ["funded:done", "running:done", "submitted:done", "ended:done"]);
  assert.equal(steps[3]!.label, "Completed, publisher paid");
  assert.equal(steps[3]!.at, T3);
});

test("a refunded job ends where it had got to; steps that never happened are not shown", () => {
  const rejected = jobTimeline({ ...base, status: "rejected", startedAt: T1, submittedAt: T2, completedAt: T3 });
  assert.deepEqual(shape(rejected), ["funded:done", "running:done", "submitted:done", "ended:failed"]);
  assert.equal(rejected[3]!.label, "Rejected, refunded");

  const failed = jobTimeline({ ...base, status: "failed", startedAt: T1, completedAt: T3 });
  assert.deepEqual(shape(failed), ["funded:done", "running:done", "ended:failed"]);
  assert.equal(failed[2]!.label, "Failed, refunded");

  // Never started: a worker outage, or the buyer changed their mind.
  assert.deepEqual(shape(jobTimeline({ ...base, status: "expired", completedAt: T3 })), ["funded:done", "ended:failed"]);
  assert.deepEqual(shape(jobTimeline({ ...base, status: "cancelled", completedAt: T3 })), ["funded:done", "ended:failed"]);
});

test("every status has a label, and only three are still open", () => {
  const open = Object.keys(JOB_STATUS).filter((status) => !isFinished(status as keyof typeof JOB_STATUS));
  assert.deepEqual(open.sort(), ["funded", "running", "submitted"]);
});

test("each hire attempt gets its own key", () => {
  const a = newIdempotencyKey();
  assert.match(a, /^web-.{8,}$/);
  assert.ok(a.length <= 100);
  assert.notEqual(a, newIdempotencyKey());
});

test("a key with no scopes or * is everything except spending", () => {
  assert.deepEqual(describeKeyAccess([]), { summary: "All except spending", spends: [] });
  assert.deepEqual(describeKeyAccess(undefined), { summary: "All except spending", spends: [] });
  assert.deepEqual(describeKeyAccess(["*"]), { summary: "All except spending", spends: [] });
  assert.deepEqual(describeKeyAccess(["*", "jobs:hire"]), { summary: "All except spending", spends: ["jobs:hire"] });
  assert.deepEqual(describeKeyAccess(["jobs:read", "jobs:review"]), { summary: "Limited", spends: ["jobs:review"] });
});

test("dollar amounts are whole cents or nothing", () => {
  assert.equal(dollarsToCents("12.50"), 1250);
  assert.equal(dollarsToCents(" 5 "), 500);
  assert.equal(dollarsToCents("0.07"), 7);
  assert.equal(dollarsToCents("19.99"), 1999);
  for (const bad of ["", "abc", "1.234", "-5", "1e3", "$5"]) assert.equal(dollarsToCents(bad), null, bad);
});

test("a key that can hire needs both caps, in range and in order", () => {
  assert.equal(keyGrantProblem({ scopes: ["jobs:read"], maxJobPrice: "", dailySpendCap: "" }), null);
  assert.match(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "", dailySpendCap: "10" })!, /both spend caps/);
  assert.match(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "0", dailySpendCap: "10" })!, /one job may cost/);
  assert.match(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "1000.01", dailySpendCap: "2000" })!, /one job may cost/);
  assert.match(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "5", dailySpendCap: "100000.01" })!, /daily cap/);
  assert.match(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "20", dailySpendCap: "10" })!, /cannot be more/);
  assert.equal(keyGrantProblem({ scopes: ["jobs:hire"], maxJobPrice: "5", dailySpendCap: "20" }), null);
});

test("the scopes the page offers are the scopes the API defines, spend scopes apart", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const api = readFileSync(join(here, "../../../api/src/config/apiKeyScopes.ts"), "utf8");
  const defined = /API_KEY_SCOPES = \[([^\]]+)\]/.exec(api)![1]!.match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
  const spend = /SPEND_SCOPES[^=]*= \[([^\]]+)\]/.exec(api)![1]!.match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
  assert.deepEqual(SPEND_SCOPES.map((o) => o.scope).sort(), [...spend].sort());
  assert.deepEqual(
    [...ORDINARY_SCOPES, ...SPEND_SCOPES].map((o) => o.scope).sort(),
    defined.filter((s) => s !== "*").sort(),
  );
});

test("a hire carries the terms on screen, and a refused one says what the publisher changed", () => {
  const offering = { id: "o1", title: "Brief", priceCents: 500, slaSeconds: 3600, termsVersion: "aaaa" };
  // Only the three terms: nothing else of the offering rides along.
  assert.deepEqual(termsOf(offering), { priceCents: 500, slaSeconds: 3600, termsVersion: "aaaa" });

  const shown = termsOf(offering);
  const price = termsChangedMessage(shown, { current: { priceCents: 100_000, slaSeconds: 3600, termsVersion: "bbbb" } });
  assert.match(price, /nothing was charged/);
  assert.match(price, /The price changed from \$5\.00 to \$1,000\.00\./);
  assert.ok(!price.includes("delivery time"));

  const both = termsChangedMessage(shown, { current: { priceCents: 400, slaSeconds: 7200, termsVersion: "bbbb" } });
  assert.match(both, /from \$5\.00 to \$4\.00/);
  assert.match(both, /The delivery time changed from 1 hour to 2 hours\./);

  // Same price and time: the checks, the description or the instructions moved.
  const other = termsChangedMessage(shown, { current: { priceCents: 500, slaSeconds: 3600, termsVersion: "bbbb" } });
  assert.match(other, /changed what this offering promises, what it asks for or how the result is checked/);
  // A body without the terms still explains itself and invents no numbers.
  for (const data of [null, {}, { current: null }, "oops"]) {
    const vague = termsChangedMessage(shown, data);
    assert.match(vague, /nothing was charged/);
    assert.ok(!vague.includes("$"));
  }
});

test("the hire panel sends the terms it shows and reloads the offering when they were refused", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, "../components/marketplace/hire-panel.tsx"), "utf8");
  assert.match(panel, /offeringsApi\.hire\(offering\.id, input, attemptKey\.current, termsOf\(offering\)\)/);
  assert.match(panel, /"offering_terms_changed"/);
  assert.match(panel, /onTermsChanged\?\.\(\)/);
  const api = readFileSync(join(here, "api.ts"), "utf8");
  // `expected` is a required argument of the client: a dashboard hire cannot leave it out.
  assert.match(api, /idempotencyKey: string,\n\s+expected: OfferingTerms,\n/);
  assert.match(api, /body: \{ input, expected \}/);
});
