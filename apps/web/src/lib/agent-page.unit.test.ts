/**
 * The rules of the agent page's tabs. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-page.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CRON,
  GPU_MESSAGES,
  RUN_MESSAGES,
  SCHEDULE_MESSAGES,
  USAGE_SOURCE_LABELS,
  agentHasToken,
  appendRuns,
  checkScheduleForm,
  codeOf,
  deleteWarning,
  gpuTierLabel,
  kindChangeConfirm,
  listingForAgent,
  listAgentHref,
  agentToListFirst,
  listingStatus,
  mergeLatestRuns,
  otherTasksLine,
  rebaseForm,
  resultPreview,
  runCostLine,
  runInRefusal,
  runRefusal,
  runTookLine,
  sameSchedule,
  scheduleBodyOf,
  scheduleFieldErrors,
  scheduleFormOf,
  sentenceOf,
  statusOf,
  suggestedScheduleSentence,
  usageSourceLabel,
  withRun,
} from "./agent-page";

const refusal = (status: number, data: unknown) => ({ status, data });

const SCHEDULE = {
  enabled: false,
  cronExpression: "30 7 * * 1-5",
  timezone: "Europe/Berlin",
  prompt: "Write the briefing.",
  stampTime: false,
  deliver: { channelId: "ch_1", name: "Team Slack", type: "slack" },
  timeoutSeconds: 300,
  maxRetries: 1,
};

test("a refusal is read by its shape", () => {
  const err = refusal(409, { error: "schedule_changed", message: "It was changed somewhere else." });
  assert.equal(statusOf(err), 409);
  assert.equal(codeOf(err), "schedule_changed");
  assert.equal(sentenceOf(err), "It was changed somewhere else.");
  assert.equal(statusOf(new Error("offline")), null);
  assert.equal(codeOf(null), null);
  assert.equal(sentenceOf(refusal(500, "<html>")), null);
});

test("the form of an existing schedule is the schedule", () => {
  const form = scheduleFormOf({ schedule: SCHEDULE, suggested: null }, "UTC");
  assert.deepEqual(form, {
    enabled: false,
    cronExpression: "30 7 * * 1-5",
    timezone: "Europe/Berlin",
    prompt: "Write the briefing.",
    stampTime: false,
    channelId: "ch_1",
    timeoutSeconds: "300",
    maxRetries: "1",
  });
});

test("an older task with no cron line starts on every day at 09:00", () => {
  const form = scheduleFormOf({ schedule: { ...SCHEDULE, cronExpression: null }, suggested: null }, "UTC");
  assert.equal(form.cronExpression, DEFAULT_CRON);
  assert.equal(DEFAULT_CRON, "0 9 * * *");
});

test("with no schedule the form starts from the suggestion, else from the default in the viewer's zone", () => {
  const suggested = scheduleFormOf(
    { schedule: null, suggested: { schedule: { cronExpression: "0 8 * * 1" }, prompt: "Check the site." } },
    "Africa/Lagos",
  );
  assert.equal(suggested.cronExpression, "0 8 * * 1");
  assert.equal(suggested.timezone, "Africa/Lagos");
  assert.equal(suggested.prompt, "Check the site.");
  assert.equal(suggested.enabled, true);
  assert.equal(suggested.stampTime, true);
  assert.equal(suggested.channelId, null);

  const zoned = scheduleFormOf(
    { schedule: null, suggested: { schedule: { cronExpression: "0 8 * * 1", timezone: "Asia/Tokyo" } } },
    "Africa/Lagos",
  );
  assert.equal(zoned.timezone, "Asia/Tokyo");

  const plain = scheduleFormOf({ schedule: null, suggested: null }, "");
  assert.equal(plain.cronExpression, DEFAULT_CRON);
  assert.equal(plain.timezone, "UTC");
});

test("the body carries the whole schedule", () => {
  const form = scheduleFormOf({ schedule: SCHEDULE, suggested: null }, "UTC");
  assert.deepEqual(scheduleBodyOf({ ...form, enabled: true }), {
    enabled: true,
    cronExpression: "30 7 * * 1-5",
    timezone: "Europe/Berlin",
    prompt: "Write the briefing.",
    stampTime: false,
    deliver: { channelId: "ch_1" },
    timeoutSeconds: 300,
    maxRetries: 1,
  });
});

test("the body clears the place for Only here and leaves out what was not typed", () => {
  const form = scheduleFormOf({ schedule: null, suggested: null }, "UTC");
  const body = scheduleBodyOf(form);
  assert.equal(body.deliver, null);
  // The line is always sent. Empty means "the standard line" to the API, so a
  // cleared box is saved as that and not silently put back to the old line.
  assert.equal(body.prompt, "");
  assert.equal(scheduleBodyOf({ ...form, prompt: "  Write the briefing.  " }).prompt, "Write the briefing.");
  assert.equal(scheduleBodyOf({ ...form, prompt: "   " }).prompt, "");
  assert.equal("timeoutSeconds" in body, false);
  assert.equal("maxRetries" in body, false);
  assert.equal(body.stampTime, true);
});

test("the time limit and the tries are checked before sending", () => {
  const form = scheduleFormOf({ schedule: SCHEDULE, suggested: null }, "UTC");
  assert.deepEqual(checkScheduleForm(form), {});
  assert.deepEqual(checkScheduleForm({ ...form, timeoutSeconds: "", maxRetries: "" }), {});
  assert.deepEqual(checkScheduleForm({ ...form, timeoutSeconds: "4" }), { timeoutSeconds: SCHEDULE_MESSAGES.timeoutSeconds });
  assert.deepEqual(checkScheduleForm({ ...form, timeoutSeconds: "3601" }), { timeoutSeconds: SCHEDULE_MESSAGES.timeoutSeconds });
  assert.deepEqual(checkScheduleForm({ ...form, maxRetries: "1.5" }), { maxRetries: SCHEDULE_MESSAGES.maxRetries });
  assert.deepEqual(checkScheduleForm({ ...form, maxRetries: "6" }), { maxRetries: SCHEDULE_MESSAGES.maxRetries });
  assert.deepEqual(checkScheduleForm({ ...form, timeoutSeconds: "5", maxRetries: "0" }), {});
});

test("server sentences go under their inputs", () => {
  assert.deepEqual(
    scheduleFieldErrors({
      cronExpression: "These times are not valid.",
      timezone: "That time zone is not known.",
      prompt: "Too long.",
      "deliver.channelId": "That place was not found.",
      timeoutSeconds: "Too short.",
      maxRetries: "Too many.",
      body: "Send a schedule.",
      enabled: "Second problem of the form.",
    }),
    {
      cronExpression: "These times are not valid.",
      timezone: "That time zone is not known.",
      prompt: "Too long.",
      deliver: "That place was not found.",
      timeoutSeconds: "Too short.",
      maxRetries: "Too many.",
      form: "Send a schedule.",
    },
  );
});

test("a form is unchanged until something that would be sent changes", () => {
  const form = scheduleFormOf({ schedule: SCHEDULE, suggested: null }, "UTC");
  assert.equal(sameSchedule(form, { ...form }), true);
  assert.equal(sameSchedule(form, { ...form, prompt: "Write the briefing.  " }), true);
  assert.equal(sameSchedule(form, { ...form, channelId: null }), false);
  assert.equal(sameSchedule(form, { ...form, maxRetries: "" }), false);
  assert.equal(sameSchedule(form, { ...form, enabled: true }), false);
});

test("a buyer's copy says its suggested times in the plan's words", () => {
  assert.equal(
    suggestedScheduleSentence({ schedule: { cronExpression: "0 9 * * *" } }),
    "This agent is set up to run every day at 09:00. Turn the schedule on to start. You choose the times and where results go.",
  );
  assert.equal(
    suggestedScheduleSentence({ schedule: { cronExpression: "30 7 * * 1-5" } }),
    "This agent is set up to run on weekdays at 07:30. Turn the schedule on to start. You choose the times and where results go.",
  );
  assert.match(suggestedScheduleSentence({ schedule: { cronExpression: "*/5 * * * *" } }) ?? "", /^This agent is set up to run at custom times \(\*\/5 \* \* \* \*\)\. Turn the schedule on/);
  assert.equal(suggestedScheduleSentence({ prompt: "Only a line." }), null);
  assert.equal(suggestedScheduleSentence(null), null);
});

test("other tasks are counted in one line", () => {
  assert.equal(otherTasksLine(0), null);
  assert.equal(otherTasksLine(1), "1 other scheduled task uses this agent.");
  assert.equal(otherTasksLine(3), "3 other scheduled tasks use this agent.");
});

test("a new run goes first and a known run is redrawn in place", () => {
  const runs = [{ id: "b", n: 1 }, { id: "a", n: 1 }];
  assert.deepEqual(withRun(runs, { id: "c", n: 1 }).map((r) => r.id), ["c", "b", "a"]);
  assert.deepEqual(withRun(runs, { id: "a", n: 2 }), [{ id: "b", n: 1 }, { id: "a", n: 2 }]);
  assert.deepEqual(appendRuns(runs, [{ id: "a", n: 9 }, { id: "z", n: 1 }]).map((r) => r.id), ["b", "a", "z"]);
});

test("a failed Send again carries the run", () => {
  const run = { id: "r1", status: "finished" };
  assert.deepEqual(runInRefusal(refusal(502, { error: "delivery_failed", message: "Not sent.", run })), run);
  assert.equal(runInRefusal(refusal(502, { error: "delivery_failed" })), null);
  assert.equal(runInRefusal(new Error("offline")), null);
});

test("a long result starts collapsed and a short one does not", () => {
  assert.deepEqual(resultPreview("One line."), { text: "One line.", cut: false });
  const long = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
  const preview = resultPreview(long);
  assert.equal(preview.cut, true);
  assert.equal(preview.text.split("\n").length, 6);
  assert.ok(preview.text.endsWith("…"));
  const wide = resultPreview("x".repeat(2000));
  assert.equal(wide.cut, true);
  assert.ok(wide.text.length <= 601);
});

test("a run's refusal: 422 lists the answers, 413 is the length sentence, the rest is the server's", () => {
  const invalid = runRefusal(
    refusal(422, {
      error: "input_invalid",
      message: "ignored",
      details: [{ path: "/topic", field: "topic", label: "Topic", message: "This is required" }, "junk"],
    }),
  );
  assert.equal(invalid.message, "Some answers need another look.");
  assert.deepEqual(invalid.details, [{ path: "/topic", message: "This is required" }]);

  assert.deepEqual(runRefusal(refusal(413, { error: "input_too_large" })), {
    message: "Your answers are too long. Shorten them and try again.",
    details: [],
  });
  assert.equal(runRefusal(refusal(402, { message: "You do not have enough credits." })).message, "You do not have enough credits.");
  assert.equal(runRefusal(new Error("boom")).message, RUN_MESSAGES.failed);
});

test("a buyer's copy says what the run cost, and a free run says nothing", () => {
  assert.equal(
    runCostLine({ listingTitle: "Research Summarizer", chargedCents: 5 }),
    "This run cost $0.05, paid to Research Summarizer.",
  );
  assert.equal(runCostLine({ listingTitle: "", chargedCents: 1200 }), "This run cost $12.00.");
  assert.equal(runCostLine({ listingTitle: "Free one", chargedCents: 0 }), null);
  assert.equal(runCostLine(null), null);
});

test("how long a run took", () => {
  assert.equal(runTookLine(850), "Took 850 ms.");
  assert.equal(runTookLine(1500), "Took 1.5 s.");
  assert.equal(runTookLine(120_000), "Took 2.0 min.");
  assert.equal(runTookLine(null), null);
  assert.equal(runTookLine(-1), null);
});

test("a kind change asks first, and names the schedule only when leaving a self-running agent", () => {
  assert.equal(kindChangeConfirm("task", "task"), null);
  assert.equal(
    kindChangeConfirm("conversation", "task")?.description,
    "Its other settings are kept, so you can switch back.",
  );
  assert.equal(
    kindChangeConfirm("scheduled", "conversation")?.description,
    "Its other settings are kept, so you can switch back. Its schedule will be turned off.",
  );
  assert.equal(
    kindChangeConfirm("task", "scheduled")?.description,
    "Its other settings are kept, so you can switch back.",
  );
  assert.equal(kindChangeConfirm("task", "scheduled")?.title, 'Change to "It runs on its own"?');
});

test("the delete dialog names the schedule and the other tasks", () => {
  assert.equal(deleteWarning(null), "Its deployments are stopped and it cannot be recovered.");
  assert.match(deleteWarning({ hasSchedule: true, otherTasks: 0 }), /Its schedule and its saved results are deleted too\.$/);
  assert.match(deleteWarning({ hasSchedule: false, otherTasks: 1 }), /1 scheduled task uses this agent and will be deleted too\.$/);
  const both = deleteWarning({ hasSchedule: true, otherTasks: 2 });
  assert.match(both, /Its schedule and its saved results are deleted too\. 2 scheduled tasks use this agent and will be deleted too\.$/);
});

test("the GPU sentence is the plan's, word for word", () => {
  assert.equal(
    GPU_MESSAGES.beingBuilt,
    "Dedicated GPUs for agents are being built. Nothing was reserved or charged. Your agent keeps answering on WheelsAI.",
  );
});

test("tier ids read as GPU names", () => {
  assert.deepEqual(["3060", "4070", "4090", "a100", "h100", "rtx-4070"].map(gpuTierLabel), [
    "RTX 3060",
    "RTX 4070",
    "RTX 4090",
    "A100",
    "H100",
    "RTX 4070",
  ]);
});

test("an agent has a token when it has a treasury", () => {
  assert.equal(agentHasToken({ treasuryAddress: "7xKX…" }), true);
  assert.equal(agentHasToken({ treasuryAddress: null }), false);
  assert.equal(agentHasToken(null), false);
});

test("the agent's listing is found, the live one first", () => {
  const listings = [
    { id: "1", agentId: "other", status: "published" },
    { id: "2", agentId: "mine", status: "archived" },
    { id: "3", agentId: "mine", status: "draft" },
    { id: "4", agentId: "mine", status: "published" },
  ];
  assert.equal(listingForAgent(listings, "mine")?.id, "4");
  assert.equal(listingForAgent(listings.slice(0, 3), "mine")?.id, "3");
  assert.equal(listingForAgent(listings.slice(0, 2), "mine")?.id, "2");
  assert.equal(listingForAgent(listings, "none"), null);
  assert.equal(listingStatus("published").label, "On the marketplace");
  assert.equal(listingStatus("something_new").label, "Listed");
});

test("all nine usage sources have a label", () => {
  const sources = ["playground", "api", "widget", "trial", "scheduled", "job", "test", "hired", "paid"];
  assert.deepEqual(Object.keys(USAGE_SOURCE_LABELS).sort(), [...sources].sort());
  for (const source of sources) assert.notEqual(usageSourceLabel(source), source);
  assert.equal(usageSourceLabel("paid"), "Paid use");
  assert.equal(usageSourceLabel("later_source"), "later_source");
});

test("a one-thing save keeps the edits that were not part of it", () => {
  const before = scheduleFormOf({ schedule: SCHEDULE, suggested: null }, "UTC");
  const typed = { ...before, prompt: "A new line, not saved yet.", enabled: true };
  const after = scheduleFormOf({ schedule: { ...SCHEDULE, enabled: true, maxRetries: 2 }, suggested: null }, "UTC");
  const next = rebaseForm(typed, before, after);
  assert.equal(next.prompt, "A new line, not saved yet.");
  assert.equal(next.enabled, true);
  assert.equal(next.maxRetries, "2");
  assert.equal(sameSchedule(next, after), false);
  assert.deepEqual(rebaseForm(before, before, after), after);
});

test("reading the newest page again updates those runs and keeps the older ones", () => {
  const shown = [{ id: "c", s: "running" }, { id: "b", s: "finished" }, { id: "a", s: "finished" }];
  const latest = [{ id: "d", s: "running" }, { id: "c", s: "finished" }, { id: "b", s: "finished" }];
  assert.deepEqual(mergeLatestRuns(shown, latest), [
    { id: "d", s: "running" },
    { id: "c", s: "finished" },
    { id: "b", s: "finished" },
    { id: "a", s: "finished" },
  ]);
});

test("List this agent opens the wizard with that agent, when it is one the person may list", () => {
  assert.equal(listAgentHref("a-1"), "/dashboard/marketplace/publish?agent=a-1");
  const agents = [{ id: "a-1" }, { id: "a-2" }];
  assert.equal(agentToListFirst("a-2", agents, false), "a-2");
  assert.equal(agentToListFirst(" a-2 ", agents, false), "a-2");
  // Someone else's agent, or none named: the wizard starts with nothing chosen.
  assert.equal(agentToListFirst("a-9", agents, false), null);
  assert.equal(agentToListFirst(null, agents, false), null);
  assert.equal(agentToListFirst("a-1", [], false), null);
  // An existing listing keeps its own agent.
  assert.equal(agentToListFirst("a-2", agents, true), null);
});

test("the running-now line and the empty-line hint are plain sentences", () => {
  assert.equal(SCHEDULE_MESSAGES.runningNow, "Running now. The result shows here when it is done.");
  assert.equal(SCHEDULE_MESSAGES.promptEmpty, "Left empty, it is told the standard line.");
});
