import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_TRAINING_STATES,
  CANCELLABLE_TRAINING_STATES,
  TERMINAL_TRAINING_STATES,
  TRAINING_FAILURE_CODES,
  TRAINING_STATES,
  TRAINING_TRANSITIONS,
  canTransition,
  classifyTrainingOutcome,
  isTerminalTrainerEvent,
  isTerminalTrainingState,
  isTrainingState,
  parseTrainerCallbackBody,
  parseTrainerEvent,
  parseTrainerEventLine,
  parseTrainerEventsFromLog,
  transitionSources,
  type TrainingOutcomeFacts,
  type TrainingState,
} from "../services/trainingStateMachine.js";

// ============================================
// States and transitions
// ============================================

const ALLOWED: Array<[TrainingState, TrainingState]> = [
  ["pending", "submitting"],
  ["pending", "cancelled"],
  ["submitting", "queued"],
  ["submitting", "failed"],
  ["submitting", "cancelling"],
  ["queued", "running"],
  ["queued", "failed"],
  ["queued", "cancelling"],
  ["running", "finalizing"],
  ["running", "failed"],
  ["running", "cancelling"],
  ["finalizing", "completed"],
  ["finalizing", "failed"],
  ["cancelling", "cancelled"],
  // Only for a run that had completed before the cancel was requested (R2).
  ["cancelling", "finalizing"],
];

test("the nine states, three of them terminal", () => {
  assert.deepEqual([...TRAINING_STATES], [
    "pending",
    "submitting",
    "queued",
    "running",
    "finalizing",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
  ]);
  assert.deepEqual([...TERMINAL_TRAINING_STATES], ["completed", "failed", "cancelled"]);
  assert.deepEqual(
    [...ACTIVE_TRAINING_STATES],
    ["pending", "submitting", "queued", "running", "finalizing", "cancelling"],
    "what the per-organization limit counts",
  );
  assert.equal(isTrainingState("finalizing"), true);
  assert.equal(isTrainingState("paused"), false);
  assert.equal(isTrainingState(undefined), false);
  assert.equal(isTerminalTrainingState("failed"), true);
  assert.equal(isTerminalTrainingState("cancelling"), false);
});

test("the transition table is exactly the allowed list", () => {
  assert.deepEqual(
    TRAINING_TRANSITIONS.map((t) => `${t.from}>${t.to}`).sort(),
    ALLOWED.map(([from, to]) => `${from}>${to}`).sort(),
  );
  for (const transition of TRAINING_TRANSITIONS) {
    assert.ok(transition.when.length > 0, `${transition.from}>${transition.to} says who writes it`);
  }
});

for (const [from, to] of ALLOWED) {
  test(`allowed: ${from} -> ${to}`, () => {
    assert.equal(canTransition(from, to), true);
  });
}

// Every other ordered pair, one test each: nothing is allowed by omission.
for (const from of TRAINING_STATES) {
  for (const to of TRAINING_STATES) {
    if (ALLOWED.some(([a, b]) => a === from && b === to)) continue;
    test(`refused: ${from} -> ${to}`, () => {
      assert.equal(canTransition(from, to), false);
    });
  }
}

test("refused in particular: nothing leaves a terminal state, nothing goes back, nothing skips", () => {
  for (const terminal of TERMINAL_TRAINING_STATES) {
    for (const to of TRAINING_STATES) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
  assert.equal(canTransition("running", "queued"), false, "no way back");
  assert.equal(canTransition("queued", "finalizing"), false, "a finished queued job goes through running");
  assert.equal(canTransition("running", "completed"), false, "completion goes through finalizing");
  assert.equal(canTransition("pending", "failed"), false, "a pending row is claimed before it can fail");
  assert.equal(canTransition("finalizing", "cancelling"), false, "a finished run cannot be cancelled");
  assert.equal(canTransition("cancelling", "completed"), false);
  assert.equal(canTransition("cancelling", "failed"), false);
  assert.equal(canTransition("running", "cancelled"), false, "a cancel waits for the stop");
  assert.equal(canTransition("unknown", "running"), false);
  assert.equal(canTransition("running", ""), false);
});

test("transitionSources gives the `status in` list of a compare-and-set", () => {
  assert.deepEqual(transitionSources("failed").sort(), ["finalizing", "queued", "running", "submitting"]);
  assert.deepEqual(transitionSources("cancelled").sort(), ["cancelling", "pending"]);
  assert.deepEqual(transitionSources("completed"), ["finalizing"]);
  assert.deepEqual(transitionSources("cancelling").sort(), ["queued", "running", "submitting"]);
  assert.deepEqual(transitionSources("finalizing").sort(), ["cancelling", "running"]);
  assert.deepEqual(transitionSources("pending"), []);
});

test("a user can cancel exactly where a cancel transition exists", () => {
  for (const state of TRAINING_STATES) {
    const hasCancel = canTransition(state, "cancelling") || canTransition(state, "cancelled");
    assert.equal(
      CANCELLABLE_TRAINING_STATES.includes(state),
      hasCancel && state !== "cancelling",
      state,
    );
  }
});

// ============================================
// Who pays (decision D4): one test per row
// ============================================

const base: TrainingOutcomeFacts = {
  exitCode: null,
  terminalEvent: null,
  deploymentState: "ended",
  stopRequestedByUs: false,
};
const failedEvent = (exitCode: number, code: string) => ({ type: "failed" as const, exitCode, code });
const completedEvent = (stopReason: "finished" | "max_steps" | "max_runtime") => ({
  type: "completed" as const,
  stopReason,
});

// --- charged for the seconds run ---

test("D4 charged: a job that completed", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 0, terminalEvent: completedEvent("finished") }),
    { status: "completed", failureCode: null, charge: "seconds_run", partial: false },
  );
  assert.equal(
    classifyTrainingOutcome({ ...base, exitCode: 0, terminalEvent: completedEvent("max_steps") }).charge,
    "seconds_run",
  );
});

test("D4 charged: a job the trainer stopped at its own run limit (partial adapter, exit 0)", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 0, terminalEvent: completedEvent("max_runtime") }),
    { status: "completed", failureCode: null, charge: "seconds_run", partial: true },
  );
});

test("D4 charged: exit 0 with no event read is a completion", () => {
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 0 }), {
    status: "completed",
    failureCode: null,
    charge: "seconds_run",
    partial: false,
  });
});

test("D4 charged: a job the user cancelled, whatever the process then reported", () => {
  const cancelled = { status: "cancelled", failureCode: null, charge: "seconds_run" };
  assert.deepEqual(classifyTrainingOutcome({ ...base, stopRequestedByUs: true }), cancelled);
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      stopRequestedByUs: true,
      exitCode: 30,
      terminalEvent: failedEvent(30, "interrupted"),
    }),
    cancelled,
    "the SIGTERM our stop caused is not a failure",
  );
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, stopRequestedByUs: true, exitCode: 137, deploymentState: "error" }),
    cancelled,
  );
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      stopRequestedByUs: true,
      exitCode: 0,
      terminalEvent: completedEvent("finished"),
    }),
    cancelled,
    "a run that finished while the cancel was landing is still the cancel the user asked for",
  );
});

test("D4 charged: a dataset error", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 11, terminalEvent: failedEvent(11, "dataset_row_invalid") }),
    { status: "failed", failureCode: "dataset_row_invalid", charge: "seconds_run" },
  );
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      exitCode: 11,
      terminalEvent: failedEvent(11, "dataset_checksum_mismatch"),
    }),
    { status: "failed", failureCode: "dataset_checksum_mismatch", charge: "seconds_run" },
  );
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 11 }),
    { status: "failed", failureCode: "dataset_error", charge: "seconds_run" },
    "by exit code alone, when every callback and the log were lost",
  );
});

test("D4 charged: a loss that diverged", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 14, terminalEvent: failedEvent(14, "loss_not_finite") }),
    { status: "failed", failureCode: "loss_not_finite", charge: "seconds_run" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 14 }), {
    status: "failed",
    failureCode: "loss_not_finite",
    charge: "seconds_run",
  });
});

// --- charged nothing ---

test("D4 free: a submit that failed", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, deploymentState: "unknown", platformFinding: "submit_failed" }),
    { status: "failed", failureCode: "submit_failed", charge: "none" },
  );
});

test("D4 free: no node within the queue timeout", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, deploymentState: "running", platformFinding: "no_capacity" }),
    { status: "failed", failureCode: "no_capacity", charge: "none" },
  );
});

test("D4 free: a base model that could not be pulled", () => {
  for (const code of ["base_model_not_found", "base_model_gated", "base_model_download_failed", "no_chat_template"]) {
    assert.deepEqual(
      classifyTrainingOutcome({ ...base, exitCode: 12, terminalEvent: failedEvent(12, code) }),
      { status: "failed", failureCode: code, charge: "none" },
    );
  }
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 12 }), {
    status: "failed",
    failureCode: "base_model_error",
    charge: "none",
  });
});

test("D4 free: an image that could not be pulled (the container never ran: no exit code)", () => {
  assert.deepEqual(classifyTrainingOutcome({ ...base, deploymentState: "error" }), {
    status: "failed",
    failureCode: "nosana_error",
    charge: "none",
  });
});

test("D4 free: an upload that failed", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 20, terminalEvent: failedEvent(20, "adapter_upload_failed") }),
    { status: "failed", failureCode: "adapter_upload_failed", charge: "none" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 20 }), {
    status: "failed",
    failureCode: "upload_failed",
    charge: "none",
  });
});

test("D4 free: a dataset URL that could not be downloaded is ours, not the data's", () => {
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      exitCode: 11,
      terminalEvent: failedEvent(11, "dataset_download_failed"),
    }),
    { status: "failed", failureCode: "dataset_download_failed", charge: "none" },
  );
});

test("D4 free: a missing adapter, even after the trainer said completed", () => {
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      exitCode: 0,
      terminalEvent: completedEvent("finished"),
      platformFinding: "adapter_missing",
    }),
    { status: "failed", failureCode: "adapter_missing", charge: "none" },
  );
});

test("D4 free: an invalid adapter", () => {
  assert.deepEqual(
    classifyTrainingOutcome({
      ...base,
      exitCode: 0,
      terminalEvent: completedEvent("finished"),
      platformFinding: "adapter_invalid",
    }),
    { status: "failed", failureCode: "adapter_invalid", charge: "none" },
  );
});

test("D4 free: an unexpected crash", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 1, terminalEvent: failedEvent(1, "unexpected") }),
    { status: "failed", failureCode: "unexpected", charge: "none" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 1 }), {
    status: "failed",
    failureCode: "unexpected",
    charge: "none",
  });
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 137 }), {
    status: "failed",
    failureCode: "killed",
    charge: "none",
  });
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 2 }), {
    status: "failed",
    failureCode: "unexpected_exit",
    charge: "none",
  });
});

test("D4 free: a configuration the trainer refused (the API built it)", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 10, terminalEvent: failedEvent(10, "unknown_hyperparameter") }),
    { status: "failed", failureCode: "unknown_hyperparameter", charge: "none" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 10 }), {
    status: "failed",
    failureCode: "invalid_config",
    charge: "none",
  });
});

test("D4 free: an interruption we did not ask for", () => {
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 30, terminalEvent: failedEvent(30, "interrupted") }),
    { status: "failed", failureCode: "interrupted", charge: "none" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 30 }), {
    status: "failed",
    failureCode: "interrupted",
    charge: "none",
  });
});

test("an interruption is never charged, whenever it came: the trainer's own stop at the limit exits 0", () => {
  // Nosana's timeout can land after a slow image pull pushed the trainer's
  // own deadline past it: that is the node, not the user's run limit (R1).
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 30, terminalEvent: failedEvent(30, "interrupted") }),
    { status: "failed", failureCode: "interrupted", charge: "none" },
  );
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 143 }).charge, "none");
  // Only the user's own cancel makes the seconds run chargeable.
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 30, stopRequestedByUs: true }),
    { status: "cancelled", failureCode: null, charge: "seconds_run" },
  );
});

test("D4 free: out of memory on a tier and settings the API accepted", () => {
  for (const code of ["gpu_out_of_memory", "host_out_of_memory"]) {
    assert.deepEqual(
      classifyTrainingOutcome({ ...base, exitCode: 13, terminalEvent: failedEvent(13, code) }),
      { status: "failed", failureCode: code, charge: "none" },
    );
  }
  assert.deepEqual(classifyTrainingOutcome({ ...base, exitCode: 13 }), {
    status: "failed",
    failureCode: "out_of_memory",
    charge: "none",
  });
});

test("D4 free: a deployment that went to error", () => {
  assert.deepEqual(classifyTrainingOutcome({ ...base, deploymentState: "error" }), {
    status: "failed",
    failureCode: "nosana_error",
    charge: "none",
  });
});

test("D4 free: a deployment that ran out of platform funds", () => {
  assert.deepEqual(classifyTrainingOutcome({ ...base, deploymentState: "insufficient_funds" }), {
    status: "failed",
    failureCode: "nosana_insufficient_funds",
    charge: "none",
  });
});

test("D4 free: anything with no exit code", () => {
  for (const deploymentState of ["ended", "unknown", "running"] as const) {
    assert.deepEqual(classifyTrainingOutcome({ ...base, deploymentState }), {
      status: "failed",
      failureCode: "no_exit_code",
      charge: "none",
    });
  }
});

test("the trainer's terminal event is trusted over the exit code when both are known", () => {
  // Printed `completed`, then killed while its callbacks drained.
  assert.equal(
    classifyTrainingOutcome({ ...base, exitCode: 1, terminalEvent: completedEvent("finished") }).status,
    "completed",
  );
  assert.equal(
    classifyTrainingOutcome({
      ...base,
      exitCode: 137,
      deploymentState: "error",
      terminalEvent: completedEvent("finished"),
    }).status,
    "completed",
  );
  // The event names the cause; the exit code Nosana kept says something else.
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 0, terminalEvent: failedEvent(14, "loss_not_finite") }),
    { status: "failed", failureCode: "loss_not_finite", charge: "seconds_run" },
  );
  assert.deepEqual(
    classifyTrainingOutcome({ ...base, exitCode: 1, terminalEvent: failedEvent(11, "dataset_empty") }),
    { status: "failed", failureCode: "dataset_empty", charge: "seconds_run" },
  );
});

test("every generic failure code the classifier can return has a description", () => {
  const facts: TrainingOutcomeFacts[] = [
    ...[1, 2, 10, 11, 12, 13, 14, 20, 30, 137].map((exitCode) => ({ ...base, exitCode })),
    { ...base, deploymentState: "error" },
    { ...base, deploymentState: "insufficient_funds" },
    { ...base },
    ...(["submit_failed", "no_capacity", "adapter_missing", "adapter_invalid"] as const).map(
      (platformFinding) => ({ ...base, platformFinding }),
    ),
  ];
  for (const fact of facts) {
    const outcome = classifyTrainingOutcome(fact);
    assert.equal(outcome.status, "failed");
    assert.ok(
      Object.hasOwn(TRAINING_FAILURE_CODES, outcome.failureCode!),
      `${outcome.failureCode} is described`,
    );
  }
});

// ============================================
// Trainer events
// ============================================

// Copied from infra/training/README.md ("CPU proof on a real model").
const README_LINES = [
  'WHEELSAI_EVENT {"v":1,"seq":1,"ts":"2026-10-07T04:31:30.565Z","type":"started","gpu":null,"vramGb":null,"device":"cpu","method":"lora","baseModel":"HuggingFaceTB/SmolLM2-135M-Instruct","trainerVersion":"1.0.0"}',
  'WHEELSAI_EVENT {"v":1,"seq":2,"ts":"2026-10-07T04:31:30.565Z","type":"phase","phase":"download_dataset"}',
  'WHEELSAI_EVENT {"v":1,"seq":3,"ts":"2026-10-07T04:31:30.575Z","type":"phase","phase":"load_model"}',
  'WHEELSAI_EVENT {"v":1,"seq":4,"ts":"2026-10-07T04:31:43.323Z","type":"phase","phase":"tokenize"}',
  'WHEELSAI_EVENT {"v":1,"seq":5,"ts":"2026-10-07T04:31:43.344Z","type":"phase","phase":"train"}',
  'WHEELSAI_EVENT {"v":1,"seq":6,"ts":"2026-10-07T04:31:45.818Z","type":"step","step":1,"totalSteps":27,"epoch":0.1111,"loss":2.77095,"lr":0.001,"tokensPerSecond":147.7,"etaSeconds":47}',
  'WHEELSAI_EVENT {"v":1,"seq":7,"ts":"2026-10-07T04:31:56.159Z","type":"eval","step":9,"evalLoss":0.399689}',
  'WHEELSAI_EVENT {"v":1,"seq":8,"ts":"2026-10-07T04:31:57.508Z","type":"step","step":10,"totalSteps":27,"epoch":1.1111,"loss":0.420555,"lr":0.0006666666666666666,"tokensPerSecond":200.0,"etaSeconds":23}',
  'WHEELSAI_EVENT {"v":1,"seq":9,"ts":"2026-10-07T04:32:08.057Z","type":"step","step":18,"totalSteps":27,"epoch":2.0,"loss":0.18263,"lr":0.00037037037037037035,"tokensPerSecond":202.2,"etaSeconds":12}',
  'WHEELSAI_EVENT {"v":1,"seq":10,"ts":"2026-10-07T04:32:08.537Z","type":"eval","step":18,"evalLoss":0.347226}',
  'WHEELSAI_EVENT {"v":1,"seq":11,"ts":"2026-10-07T04:32:18.305Z","type":"step","step":26,"totalSteps":27,"epoch":2.8889,"loss":0.169381,"lr":7.407407407407407e-05,"tokensPerSecond":204.8,"etaSeconds":1}',
  'WHEELSAI_EVENT {"v":1,"seq":12,"ts":"2026-10-07T04:32:19.819Z","type":"step","step":27,"totalSteps":27,"epoch":3.0,"loss":0.173087,"lr":3.7037037037037037e-05,"tokensPerSecond":203.8,"etaSeconds":0}',
  'WHEELSAI_EVENT {"v":1,"seq":13,"ts":"2026-10-07T04:32:20.568Z","type":"eval","step":27,"evalLoss":0.315895}',
  'WHEELSAI_EVENT {"v":1,"seq":14,"ts":"2026-10-07T04:32:20.581Z","type":"phase","phase":"upload"}',
  'WHEELSAI_EVENT {"v":1,"seq":15,"ts":"2026-10-07T04:32:21.485Z","type":"uploaded","adapterBytes":18092371,"adapterSha256":"ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9"}',
  'WHEELSAI_EVENT {"v":1,"seq":16,"ts":"2026-10-07T04:32:21.485Z","type":"completed","finalTrainLoss":0.182407,"finalEvalLoss":0.315895,"trainSeconds":36.57,"steps":27,"totalSteps":27,"stopReason":"finished"}',
];

// Printed by the trainer's own EventEmitter (wheelsai_trainer/events.py) on
// 2026-10-07, with the detail fields its error paths attach.
const FAILED_LINES = [
  'WHEELSAI_EVENT {"v":1,"seq":2,"ts":"2026-10-07T06:37:18.661Z","type":"failed","exitCode":11,"code":"dataset_download_failed","message":"Could not download the dataset: HTTP 403","phase":"download_dataset","httpStatus":403}',
  'WHEELSAI_EVENT {"v":1,"seq":4,"ts":"2026-10-07T06:37:18.662Z","type":"failed","exitCode":11,"code":"dataset_row_invalid","message":"Row 7: output must be a string","phase":"tokenize","row":7,"field":"output"}',
  'WHEELSAI_EVENT {"v":1,"seq":5,"ts":"2026-10-07T06:37:18.662Z","type":"failed","exitCode":30,"code":"interrupted","message":"Stopped by SIGTERM","phase":"tokenize","signal":"SIGTERM"}',
  'WHEELSAI_EVENT {"v":1,"seq":6,"ts":"2026-10-07T06:37:18.662Z","type":"failed","exitCode":14,"code":"loss_not_finite","message":"The loss is not a finite number","phase":"tokenize","step":12}',
  'WHEELSAI_EVENT {"v":1,"seq":7,"ts":"2026-10-07T06:37:18.662Z","type":"failed","exitCode":11,"code":"dataset_no_usable_rows","message":"No usable rows","phase":"tokenize","skipReasons":{"empty_output":3,"no_assistant_turn":1}}',
];
const NULL_RATE_STEP =
  'WHEELSAI_EVENT {"v":1,"seq":8,"ts":"2026-10-07T06:37:18.662Z","type":"step","step":1,"totalSteps":3,"epoch":0.3333,"loss":2.5,"lr":0.0002,"tokensPerSecond":null,"etaSeconds":4}';

const eventOf = (line: string) => JSON.parse(line.slice("WHEELSAI_EVENT ".length)) as Record<string, unknown>;

test("parser: every line of the README's real run is accepted, field for field", () => {
  for (const line of README_LINES) {
    const result = parseTrainerEventLine(line);
    assert.equal(result.ok, true, line);
    if (!result.ok) continue;
    assert.equal(result.jobId, null);
    const { details: _details, ...printed } = result.event as unknown as Record<string, unknown>;
    assert.deepEqual(printed, eventOf(line));
  }
});

test("parser: the timestamp stays the trainer's string", () => {
  const result = parseTrainerEventLine(README_LINES[5]!);
  assert.ok(result.ok);
  assert.equal(result.event.ts, "2026-10-07T04:31:45.818Z");
  assert.equal(typeof result.event.ts, "string");
});

test("parser: failed events keep their code, phase and details", () => {
  const parsed = FAILED_LINES.map((line) => {
    const result = parseTrainerEventLine(line);
    assert.ok(result.ok, line);
    assert.equal(result.event.type, "failed");
    return result.event;
  });
  const [download, row, interrupted, diverged, unusable] = parsed;
  assert.ok(download?.type === "failed" && row?.type === "failed");
  assert.ok(interrupted?.type === "failed" && diverged?.type === "failed" && unusable?.type === "failed");
  assert.equal(download.exitCode, 11);
  assert.equal(download.code, "dataset_download_failed");
  assert.equal(download.phase, "download_dataset");
  assert.deepEqual(download.details, { httpStatus: 403 });
  assert.deepEqual(row.details, { row: 7, field: "output" });
  assert.deepEqual(interrupted.details, { signal: "SIGTERM" });
  assert.deepEqual(diverged.details, { step: 12 });
  assert.deepEqual(unusable.details, { skipReasons: { empty_output: 3, no_assistant_turn: 1 } });
  assert.equal(isTerminalTrainerEvent(download), true);
});

test("parser: a step with no rate yet, a failure before any phase, a list detail", () => {
  assert.ok(parseTrainerEventLine(NULL_RATE_STEP).ok);
  const early = parseTrainerEvent({
    v: 1,
    seq: 1,
    ts: "2026-10-07T06:37:18.662Z",
    type: "failed",
    exitCode: 10,
    code: "unknown_hyperparameter",
    message: "Unknown hyperparameter",
    phase: null,
    fields: ["quantizationBits", "warmupSteps"],
  });
  assert.ok(early.ok && early.event.type === "failed");
  assert.deepEqual(early.event.details, { fields: ["quantizationBits", "warmupSteps"] });
  assert.equal(early.event.phase, null);
});

test("parser: a callback body is the event plus jobId", () => {
  const body = JSON.stringify({ ...eventOf(README_LINES[15]!), jobId: "5b0b0e5e-2c1c-4a43-9d4e-3a1e0d7f1a11" });
  const result = parseTrainerCallbackBody(body);
  assert.ok(result.ok);
  assert.equal(result.jobId, "5b0b0e5e-2c1c-4a43-9d4e-3a1e0d7f1a11");
  assert.equal(result.event.type, "completed");
  assert.equal(Object.hasOwn(result.event, "jobId"), false, "jobId is returned beside the event, not in it");
  assert.equal(isTerminalTrainerEvent(result.event), true);

  const withoutJob = parseTrainerCallbackBody(JSON.stringify(eventOf(README_LINES[15]!)));
  assert.equal(withoutJob.ok, false, "a callback names its job");
  assert.equal(parseTrainerCallbackBody("{not json").ok, false);
  assert.equal(parseTrainerCallbackBody(`{"pad":"${"x".repeat(70_000)}"}`).ok, false, "over 64 KB");
});

test("parser: a log line never carries jobId, and must begin with the prefix", () => {
  const withJob = `WHEELSAI_EVENT ${JSON.stringify({ ...eventOf(README_LINES[1]!), jobId: "j" })}`;
  assert.equal(parseTrainerEventLine(withJob).ok, false);
  assert.equal(parseTrainerEventLine(` ${README_LINES[1]}`).ok, false, "leading space");
  assert.equal(parseTrainerEventLine(`log: ${README_LINES[1]}`).ok, false, "quoted inside another line");
  assert.equal(parseTrainerEventLine(README_LINES[1]!.slice("WHEELSAI_EVENT ".length)).ok, false, "no prefix");
  assert.equal(parseTrainerEventLine("WHEELSAI_EVENT {broken").ok, false);
  assert.equal(parseTrainerEventLine("WHEELSAI_EVENT []").ok, false);
  assert.ok(parseTrainerEventLine(`${README_LINES[1]}\r`).ok, "a trailing carriage return is tolerated");
});

test("parser: anything the trainer does not emit is refused", () => {
  const good = eventOf(README_LINES[5]!); // a step
  const refused = (change: Record<string, unknown>, why: string, source: Record<string, unknown> = good) => {
    const result = parseTrainerEvent({ ...source, ...change });
    assert.equal(result.ok, false, why);
    if (!result.ok) assert.equal(result.code, "invalid_trainer_event");
  };
  assert.ok(parseTrainerEvent(good).ok);

  refused({ v: 2 }, "another version");
  refused({ v: "1" }, "version as a string");
  refused({ seq: 0 }, "seq starts at 1");
  refused({ seq: 1.5 }, "fractional seq");
  refused({ seq: "6" }, "seq as a string");
  refused({ ts: 1759811505818 }, "a numeric timestamp");
  refused({ ts: "2026-10-07T04:31:45Z" }, "no milliseconds");
  refused({ ts: "2026-10-07T04:31:45.818+00:00" }, "an offset in place of Z");
  refused({ ts: "2026-13-45T04:31:45.818Z" }, "not a date");
  refused({ type: "progress" }, "an unknown type");
  refused({ type: "constructor" }, "a type that is only an object property");
  refused({ loss: "2.77" }, "a number as a string");
  refused({ loss: null }, "loss is never null");
  refused({ step: -1 }, "a negative step");
  refused({ totalSteps: 2.5 }, "a fractional count");
  refused({ extra: 1 }, "a field the type does not have");
  refused({ jobId: "" }, "an empty jobId");
  refused({ jobId: 7 }, "a jobId that is not a string");

  const { loss: _loss, ...missing } = good;
  assert.equal(parseTrainerEvent(missing).ok, false, "a missing field");

  for (const notAnObject of [null, undefined, "x", 5, [], [good]]) {
    assert.equal(parseTrainerEvent(notAnObject).ok, false);
  }

  refused({ phase: "warmup" }, "an unknown phase", eventOf(README_LINES[1]!));
  refused({ method: "full" }, "a method the trainer does not run", eventOf(README_LINES[0]!));
  refused({ adapterSha256: "EE9275" }, "not a sha256", eventOf(README_LINES[14]!));
  refused({ adapterBytes: -5 }, "a negative size", eventOf(README_LINES[14]!));
  refused({ stopReason: "bored" }, "an unknown stop reason", eventOf(README_LINES[15]!));

  const failedOne = eventOf(FAILED_LINES[0]!);
  refused({ exitCode: 0 }, "a failure with exit code 0", failedOne);
  refused({ exitCode: 99 }, "an exit code the trainer does not use", failedOne);
  refused({ code: "Dataset Failed!" }, "a code that is not a machine string", failedOne);
  refused({ message: "x".repeat(501) }, "a message over the trainer's cut", failedOne);
  refused({ phase: "nowhere" }, "an unknown phase", failedOne);
  refused({ nested: { a: { b: 1 } } }, "a nested detail", failedOne);
  refused({ "bad key": 1 }, "a detail key that is not a name", failedOne);
  refused({ big: Array.from({ length: 33 }, () => 1) }, "an oversized detail", failedOne);
});

test("parser: a whole log is read back in order; noise and repeats are skipped", () => {
  const log = [
    "Downloading shards: 100%",
    ...README_LINES.slice(0, 6),
    "Traceback (most recent call last):",
    'WHEELSAI_EVENT {"v":1,"seq":3,"ts":"2026-10-07T04:31:30.575Z","type":"phase","phase":"upload"}', // seq goes back
    "WHEELSAI_EVENT {truncated",
    ...README_LINES.slice(6),
    "",
  ].join("\n");
  const events = parseTrainerEventsFromLog(log);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(events.at(-1)?.type, "completed");
  assert.deepEqual(parseTrainerEventsFromLog(""), []);
  assert.deepEqual(parseTrainerEventsFromLog("no events here\nat all"), []);
  assert.equal(parseTrainerEventsFromLog(README_LINES.join("\r\n")).length, 16, "CRLF logs");
});
