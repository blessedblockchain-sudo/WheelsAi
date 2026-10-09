/**
 * The run and delivery sentences of the Runs tab. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-runs.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunDelivery, RunView } from "./api";
import {
  RUN_ALREADY_RUNNING,
  RUN_FAILURE_FALLBACK,
  canSendAgain,
  deliveryLine,
  formatRunTime,
  latestDelivery,
  runDelivery,
  runDurationLabel,
  runFailureLine,
  runNowNote,
  runStatusLabel,
  runStatusTone,
  runWhenLine,
  startedByLabel,
} from "./agent-runs";

const UTC = { timeZone: "UTC" };

function delivery(over: Partial<RunDelivery> = {}): RunDelivery {
  return { channelId: "c1", name: "Team Slack", type: "slack", status: "sent", at: "2026-10-12T09:02:05.000Z", ...over };
}

function run(over: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    status: "finished",
    startedAt: "2026-10-12T09:00:00.000Z",
    finishedAt: "2026-10-12T09:02:00.000Z",
    durationMs: 120_000,
    startedBy: "schedule",
    text: "The briefing.",
    failure: null,
    delivery: [],
    ...over,
  };
}

test("a run's state in the plan's words", () => {
  assert.equal(runStatusLabel("running"), "Running");
  assert.equal(runStatusLabel("finished"), "Finished");
  assert.equal(runStatusLabel("did_not_finish"), "Did not finish");
  assert.equal(runStatusLabel("stopped"), "Stopped");
  assert.deepEqual(
    (["running", "finished", "did_not_finish", "stopped"] as const).map(runStatusTone),
    ["info", "success", "danger", "warning"],
  );
});

test("a sent result names its place", () => {
  assert.equal(deliveryLine(delivery()), "Sent to Team Slack.");
  assert.equal(deliveryLine(delivery({ name: "" })), "Sent.");
});

test("a result that was not sent says why, in the record's own reason", () => {
  assert.equal(
    deliveryLine(delivery({ status: "failed", reason: "it did not accept the message" })),
    "Not sent to Team Slack: it did not accept the message. The result is saved here.",
  );
  assert.equal(
    deliveryLine(delivery({ status: "skipped", name: "Ops Discord", reason: "this place is turned off" })),
    "Not sent to Ops Discord: this place is turned off. The result is saved here.",
  );
});

test("a place with no name leaves the name out", () => {
  assert.equal(
    deliveryLine(delivery({ status: "skipped", name: "", type: "email", reason: "email delivery is temporarily unavailable" })),
    "Not sent: email delivery is temporarily unavailable. The result is saved here.",
  );
});

test("a reason never doubles the full stop, and a missing one still reads as a sentence", () => {
  assert.equal(
    deliveryLine(delivery({ status: "failed", reason: "it could not be reached. " })),
    "Not sent to Team Slack: it could not be reached. The result is saved here.",
  );
  assert.equal(
    deliveryLine(delivery({ status: "failed", reason: undefined })),
    "Not sent to Team Slack: it could not be reached. The result is saved here.",
  );
});

test("the newest try is the one shown", () => {
  assert.equal(latestDelivery(run()), null);
  const tries = [delivery({ status: "failed", reason: "it did not accept the message" }), delivery({ at: "2026-10-12T10:00:00.000Z" })];
  assert.equal(latestDelivery(run({ delivery: tries })), tries[1]);
  assert.deepEqual(runDelivery(run({ delivery: tries }), { name: "Team Slack" }), {
    line: "Sent to Team Slack.",
    sent: true,
    sendAgain: true,
  });
});

test("Send again is offered for a finished run whose schedule has a place", () => {
  const place = { name: "Team Slack" };
  assert.equal(canSendAgain(run(), place), true);
  assert.equal(canSendAgain(run(), null), false);
  assert.equal(canSendAgain(run(), undefined), false);
  for (const status of ["running", "did_not_finish", "stopped"] as const) {
    assert.equal(canSendAgain(run({ status, text: null }), place), false, status);
  }
  // A place that was removed is still the schedule's place: the API words the refusal.
  assert.equal(canSendAgain(run(), { name: "" }), true);
});

test("what the Runs tab says under one run", () => {
  assert.deepEqual(runDelivery(run(), null), { line: null, sent: null, sendAgain: false });
  assert.deepEqual(
    runDelivery(run({ delivery: [delivery({ status: "failed", reason: "it did not accept the message" })] }), { name: "Team Slack" }),
    {
      line: "Not sent to Team Slack: it did not accept the message. The result is saved here.",
      sent: false,
      sendAgain: true,
    },
  );
  assert.deepEqual(runDelivery(run({ status: "did_not_finish", text: null }), { name: "Team Slack" }), {
    line: null,
    sent: null,
    sendAgain: false,
  });
});

test("Run now says where the result also goes", () => {
  assert.equal(runNowNote({ name: "Team Slack" }), "This also sends the result to Team Slack.");
  assert.equal(runNowNote(null), null);
  assert.equal(runNowNote(undefined), null);
  assert.equal(runNowNote({ name: "" }), null);
  assert.equal(RUN_ALREADY_RUNNING, "This agent is already running. Wait for it to finish.");
});

test("why a run did not finish is the API's sentence, with one fallback", () => {
  const why = "This run took longer than its time limit and was stopped.";
  assert.equal(runFailureLine(run({ status: "did_not_finish", failure: why })), why);
  assert.equal(runFailureLine(run({ status: "did_not_finish", failure: null })), "This run could not be completed.");
  assert.equal(runFailureLine(run({ status: "did_not_finish", failure: "  " })), RUN_FAILURE_FALLBACK);
  assert.equal(runFailureLine(run()), null);
  assert.equal(runFailureLine(run({ status: "running" })), null);
  assert.equal(runFailureLine(run({ status: "stopped" })), null);
});

test("who started a run", () => {
  assert.equal(startedByLabel("schedule"), "On schedule");
  assert.equal(startedByLabel("person"), "Started by hand");
});

test("times read as day, month and a 24-hour clock, in the zone asked for", () => {
  assert.equal(formatRunTime("2026-10-12T09:00:00.000Z", UTC), "12 Oct, 09:00");
  assert.equal(formatRunTime("2026-10-12T00:05:00.000Z", UTC), "12 Oct, 00:05");
  assert.equal(formatRunTime("2026-10-12T09:00:00.000Z", { timeZone: "Europe/Berlin" }), "12 Oct, 11:00");
  assert.equal(formatRunTime(null), "");
  assert.equal(formatRunTime("not a date"), "");
  // An unknown zone falls back to the viewer's zone and does not throw.
  assert.match(formatRunTime("2026-10-12T09:00:00.000Z", { timeZone: "Mars/Olympus" }), /^\d{1,2} \w{3}, \d{2}:\d{2}$/);
});

test("the when line of a run", () => {
  assert.equal(runWhenLine(run({ status: "running", finishedAt: null, durationMs: null }), UTC), "Started 12 Oct, 09:00.");
  assert.equal(runWhenLine(run(), UTC), "Started 12 Oct, 09:00. Finished 09:02, after 2.0 min.");
  assert.equal(
    runWhenLine(run({ status: "did_not_finish", finishedAt: "2026-10-12T09:00:30.000Z", durationMs: 30_000 }), UTC),
    "Started 12 Oct, 09:00. Ended 09:00, after 30.0 s.",
  );
  assert.equal(
    runWhenLine(run({ status: "stopped", finishedAt: "2026-10-12T09:01:00.000Z", durationMs: 60_000 }), UTC),
    "Started 12 Oct, 09:00. Stopped 09:01, after 1.0 min.",
  );
  // Over midnight the end carries its date.
  assert.equal(
    runWhenLine(run({ startedAt: "2026-10-12T23:59:00.000Z", finishedAt: "2026-10-13T00:01:00.000Z", durationMs: 120_000 }), UTC),
    "Started 12 Oct, 23:59. Finished 13 Oct, 00:01, after 2.0 min.",
  );
  // A length the API left out is worked out from the two times.
  assert.equal(runWhenLine(run({ durationMs: null }), UTC), "Started 12 Oct, 09:00. Finished 09:02, after 2.0 min.");
  assert.equal(runWhenLine(run({ startedAt: "nope" }), UTC), "");
});

test("a run's length", () => {
  assert.equal(runDurationLabel(run({ durationMs: 850 })), "850 ms");
  assert.equal(runDurationLabel(run({ durationMs: 1500 })), "1.5 s");
  assert.equal(runDurationLabel(run({ finishedAt: null, durationMs: null })), null);
});
