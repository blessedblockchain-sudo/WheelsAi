/**
 * The editor's pure model. Run with:
 *   cd apps/web && npx tsx --test src/components/dashboard/workflows/*.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestrationDetail, OrchestrationStep } from "@/lib/api";
import {
  autoLayout,
  definitionFromDraft,
  draftFromWorkflow,
  emptyDraft,
  localIssues,
  newStep,
  planSignature,
  readableSteps,
  removeStep,
  renameStep,
  runOrder,
  variablesFor,
  wouldCycle,
} from "./workflow-model";

const AGENT = "25bc2504-946c-46ab-b1e7-ca82f182cf7e";

function step(name: string, stepOrder: number, extra: Partial<OrchestrationStep> = {}): OrchestrationStep {
  return {
    id: `id-${name}`,
    orchestrationId: "wf",
    name,
    stepOrder,
    stepType: "agent",
    agentId: AGENT,
    deploymentId: null,
    modelId: null,
    knowledgeBaseId: null,
    promptTemplate: null,
    inputMapping: null,
    outputMapping: null,
    outputFormat: "text",
    condition: null,
    loop: null,
    onError: "fail",
    fallbackAgentId: null,
    maxRetries: 0,
    timeoutMs: null,
    dependsOn: [],
    ...extra,
  };
}

function workflow(steps: OrchestrationStep[], extra: Partial<OrchestrationDetail> = {}): OrchestrationDetail {
  return {
    id: "wf",
    orgId: "org",
    name: "Triage",
    executionMode: "parallel",
    maxConcurrency: 3,
    timeout: 300_000,
    retryPolicy: null,
    inputSchema: null,
    outputSchema: null,
    layout: null,
    isEnabled: true,
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    steps,
    executions: [],
    schedules: [],
    ...extra,
  };
}

const triage = () =>
  workflow([
    step("classify", 0, { outputFormat: "json", promptTemplate: "Classify {{input.prompt}}" }),
    step("billing", 1, {
      dependsOn: ["classify"],
      condition: { left: "$.steps.classify.output.category", op: "equals", right: "billing" },
    }),
    step("followups", 2, {
      dependsOn: ["classify"],
      loop: { forEach: "$.steps.classify.output.questions", maxItems: 5 },
      promptTemplate: "Rewrite {{item}}",
    }),
    step("reply", 3, {
      dependsOn: ["billing", "followups"],
      promptTemplate: "Billing: {{steps.billing.output}} Questions: {{steps.followups.output}}",
      outputMapping: { answer: "$.steps.reply.output" },
    }),
  ]);

test("a stored workflow survives the round trip through the draft unchanged", () => {
  const draft = draftFromWorkflow(triage());
  assert.deepEqual(localIssues(draft), []);
  const definition = definitionFromDraft(draft);

  assert.equal(definition.executionMode, "parallel");
  assert.equal(definition.timeout, 300_000);
  assert.deepEqual(
    definition.steps.map((s) => [s.name, s.dependsOn]),
    [
      ["classify", []],
      ["billing", ["classify"]],
      ["followups", ["classify"]],
      ["reply", ["billing", "followups"]],
    ]
  );
  assert.deepEqual(definition.steps[1]!.condition, {
    left: "$.steps.classify.output.category",
    op: "equals",
    right: "billing",
  });
  assert.deepEqual(definition.steps[2]!.loop, { forEach: "$.steps.classify.output.questions", maxItems: 5 });
  assert.deepEqual(definition.steps[3]!.outputMapping, { answer: "$.steps.reply.output" });
  // Nothing the strict server schema would refuse.
  assert.equal("retryPolicy" in definition, false);
  assert.equal("inputSchema" in definition, false);
  assert.equal(Object.keys(definition.layout?.positions ?? {}).length, 4);
});

test("a typed comparison keeps its type: equals is strict on the server", () => {
  const draft = draftFromWorkflow(
    workflow([
      step("score", 0, { outputFormat: "json" }),
      step("escalate", 1, { dependsOn: ["score"], condition: { left: "$.steps.score.output.risk", op: "gte", right: 0.8 } }),
      step("flag", 2, { dependsOn: ["score"], condition: { left: "$.steps.score.output.urgent", op: "equals", right: true } }),
      step("seen", 3, { dependsOn: ["score"], condition: { left: "$.steps.score.output.note", op: "exists" } }),
    ])
  );
  const [, escalate, flag, seen] = definitionFromDraft(draft).steps;
  assert.equal(escalate!.condition!.right, 0.8);
  assert.equal(flag!.condition!.right, true);
  assert.equal("right" in seen!.condition!, false);
});

test("the form reports what it can tell is wrong, naming the step", () => {
  assert.deepEqual(
    localIssues(emptyDraft()).map((i) => i.field),
    ["name", "steps"]
  );

  const draft = draftFromWorkflow(triage());
  const reply = draft.steps[3]!;
  reply.agentId = "";
  reply.maxRetries = "9";
  reply.inputMapping = "{ not json";
  draft.steps[1]!.name = "classify";
  const issues = localIssues(draft);
  assert.ok(issues.some((i) => i.stepKey === reply.key && i.field === "agentId"));
  assert.ok(issues.some((i) => i.stepKey === reply.key && i.field === "maxRetries"));
  assert.ok(issues.some((i) => i.stepKey === reply.key && i.field === "inputMapping"));
  assert.ok(issues.some((i) => i.field === "name" && i.message.includes('Two steps are named "classify"')));

  const dotted = draftFromWorkflow(triage());
  dotted.steps[0]!.name = "a.b";
  assert.ok(localIssues(dotted).some((i) => i.message.includes("cannot contain")));
});

test("a dependency that would close a circle is refused", () => {
  const draft = draftFromWorkflow(triage());
  const [classify, billing, , reply] = draft.steps;
  assert.equal(wouldCycle(draft.steps, reply!.key, classify!.key), true);
  assert.equal(wouldCycle(draft.steps, classify!.key, classify!.key), true);
  assert.equal(wouldCycle(draft.steps, billing!.key, reply!.key), false);
});

test("renaming a step rewrites the references other steps make to it", () => {
  const draft = draftFromWorkflow(triage());
  const renamed = definitionFromDraft(renameStep(draft, draft.steps[0]!.key, "sort"));
  assert.deepEqual(renamed.steps[1]!.dependsOn, ["sort"]);
  assert.equal(renamed.steps[1]!.condition!.left, "$.steps.sort.output.category");
  assert.deepEqual(renamed.steps[2]!.loop, { forEach: "$.steps.sort.output.questions", maxItems: 5 });

  // "bill" must not be rewritten inside "billing".
  const partial = renameStep(draft, draft.steps[1]!.key, "bill");
  const again = definitionFromDraft(renameStep(partial, partial.steps[1]!.key, "invoice"));
  assert.match(again.steps[3]!.promptTemplate!, /\{\{steps\.invoice\.output\}\}/);
  assert.match(again.steps[3]!.promptTemplate!, /\{\{steps\.followups\.output\}\}/);
});

test("removing a step removes it from the steps that waited for it", () => {
  const draft = draftFromWorkflow(triage());
  const without = definitionFromDraft(removeStep(draft, draft.steps[1]!.key));
  assert.deepEqual(without.steps.find((s) => s.name === "reply")!.dependsOn, ["followups"]);
});

test("a step may read its ancestors in parallel mode and every earlier step otherwise", () => {
  const parallel = draftFromWorkflow(triage());
  const names = (draft: typeof parallel, name: string) =>
    readableSteps(draft, draft.steps.find((s) => s.name === name)!.key).map((s) => s.name);
  assert.deepEqual(names(parallel, "billing"), ["classify"]);
  assert.deepEqual(names(parallel, "reply"), ["classify", "billing", "followups"]);

  const sequential = draftFromWorkflow(triage());
  sequential.executionMode = "sequential";
  assert.deepEqual(names(sequential, "followups"), ["classify", "billing"]);
  assert.deepEqual(
    runOrder(sequential.steps).map((s) => s.name),
    ["classify", "billing", "followups", "reply"]
  );
});

test("the variable chips offer only what the step can read, and loop variables inside a loop", () => {
  const draft = draftFromWorkflow(triage());
  draft.inputSchema = JSON.stringify({ type: "object", properties: { prompt: {}, topic: {} } });
  const chips = (name: string) =>
    variablesFor(draft, draft.steps.find((s) => s.name === name)!.key).map((v) => v.template);
  assert.deepEqual(chips("classify"), ["{{input.prompt}}", "{{input.topic}}"]);
  assert.deepEqual(chips("followups"), [
    "{{input.prompt}}",
    "{{input.topic}}",
    "{{steps.classify.output}}",
    "{{item}}",
    "{{index}}",
  ]);
});

test("steps without stored positions are laid out by dependency level", () => {
  const draft = draftFromWorkflow(triage());
  const [classify, billing, followups, reply] = draft.steps.map((s) => s.position);
  assert.ok(classify!.x < billing!.x && billing!.x < reply!.x);
  assert.equal(billing!.x, followups!.x);
  assert.notEqual(billing!.y, followups!.y);

  // One-at-a-time with no arrows: a single row, in run order.
  const row = autoLayout(
    [
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: [] },
    ],
    "sequential"
  );
  assert.equal(row.get("a")!.y, row.get("b")!.y);
  assert.ok(row.get("a")!.x < row.get("b")!.x);

  const stored = draftFromWorkflow(triage()).steps.length;
  const kept = draftFromWorkflow(workflow(triage().steps, { layout: { positions: { classify: { x: 7, y: 9 } } } }));
  assert.equal(kept.steps.length, stored);
  assert.deepEqual(kept.steps[0]!.position, { x: 7, y: 9 });
});

test("moving the canvas is not a change to the workflow the engine runs", () => {
  const draft = draftFromWorkflow(triage());
  const before = planSignature(definitionFromDraft(draft));
  draft.steps[0]!.position = { x: 500, y: 500 };
  draft.viewport = { x: 10, y: 10, zoom: 1.2 };
  assert.equal(planSignature(definitionFromDraft(draft)), before);
  draft.steps.push(newStep(draft.steps, { x: 0, y: 0 }));
  assert.notEqual(planSignature(definitionFromDraft(draft)), before);
});
