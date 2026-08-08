import assert from "node:assert/strict";
import test from "node:test";

import {
  OrchestrationPlanError,
  planOrchestration,
  planOrder,
  type PlannableStep,
} from "../services/orchestrationPlan.js";

// Drives apps/api/src/services/orchestrationPlan.ts (W2). The property
// that matters: a step NEVER runs before the step whose output it reads —
// running early would feed an agent missing input and produce confidently
// wrong output rather than an error.

function step(
  name: string,
  stepOrder: number,
  dependsOn: string[] = [],
): PlannableStep {
  return { id: `id-${name}`, name, stepOrder, dependsOn };
}

test("independent steps form one level and keep author order", () => {
  const plan = planOrchestration(
    [step("b", 1), step("a", 0), step("c", 2)],
    "parallel",
    5,
  );
  assert.equal(plan.levels.length, 1);
  assert.deepEqual(
    plan.levels[0]!.map((s) => s.name),
    ["a", "b", "c"],
    "ties break on stepOrder, so a no-dependency workflow runs as written",
  );
});

test("dependencies split into ordered levels", () => {
  const plan = planOrchestration(
    [
      step("fetch", 0),
      step("summarize", 1, ["fetch"]),
      step("translate", 2, ["summarize"]),
    ],
    "parallel",
    5,
  );
  assert.deepEqual(
    plan.levels.map((l) => l.map((s) => s.name)),
    [["fetch"], ["summarize"], ["translate"]],
  );
});

test("a diamond dependency puts both middles in one level and the join after", () => {
  const plan = planOrchestration(
    [
      step("start", 0),
      step("left", 1, ["start"]),
      step("right", 2, ["start"]),
      step("join", 3, ["left", "right"]),
    ],
    "parallel",
    5,
  );
  assert.deepEqual(
    plan.levels.map((l) => l.map((s) => s.name)),
    [["start"], ["left", "right"], ["join"]],
  );
  assert.deepEqual(planOrder(plan).map((s) => s.name), [
    "start",
    "left",
    "right",
    "join",
  ]);
});

test("a dependency cycle is a plan-time error naming the stuck steps", () => {
  assert.throws(
    () =>
      planOrchestration(
        [step("a", 0, ["b"]), step("b", 1, ["a"])],
        "sequential",
        1,
      ),
    (err: unknown) =>
      err instanceof OrchestrationPlanError && /cycle.*a, b/.test(err.message),
  );
});

test("a self-dependency is refused", () => {
  assert.throws(
    () => planOrchestration([step("a", 0, ["a"])], "sequential", 1),
    /depends on itself/,
  );
});

test("a typo'd dependency name is refused rather than silently ignored", () => {
  assert.throws(
    () =>
      planOrchestration(
        [step("a", 0), step("b", 1, ["summarise"])],
        "sequential",
        1,
      ),
    /unknown step "summarise"/,
  );
});

test("duplicate step names are refused — references would be ambiguous", () => {
  assert.throws(
    () => planOrchestration([step("a", 0), step("a", 1)], "sequential", 1),
    /duplicate step name/,
  );
});

test("an empty orchestration is refused", () => {
  assert.throws(() => planOrchestration([], "sequential", 1), /no steps/);
});

test("only parallel mode gets concurrency > 1 — modes never override dependencies", () => {
  const steps = [step("a", 0), step("b", 1)];
  assert.equal(planOrchestration(steps, "parallel", 4).concurrency, 4);
  for (const mode of ["sequential", "conditional", "pipeline", "anything"]) {
    assert.equal(
      planOrchestration(steps, mode, 4).concurrency,
      1,
      `${mode} must run one step at a time`,
    );
  }
  // Levels are identical regardless of mode: the DAG is the DAG.
  assert.deepEqual(
    planOrchestration(steps, "sequential", 4).levels.map((l) => l.length),
    planOrchestration(steps, "parallel", 4).levels.map((l) => l.length),
  );
});
