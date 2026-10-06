import assert from "node:assert/strict";
import test from "node:test";

import {
  validateWorkflowDefinition,
  workflowDefinitionSchema,
  workflowPatchSchema,
  type LoadOwnership,
  type WorkflowDefinition,
} from "../services/workflowDefinition.js";

// Drives services/workflowDefinition.ts: what a client may save as a
// workflow. Create and update used to hand the request body to Prisma
// (a client could set orgId or the run counters) and never planned the
// workflow, so a cycle or a typo'd reference only failed at run time.

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const FOREIGN_AGENT = "99999999-9999-4999-8999-999999999999";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333";
const KB = "44444444-4444-4444-8444-444444444444";

type StepInput = WorkflowDefinition["steps"][number];

function step(name: string, over: Partial<StepInput> = {}): StepInput {
  return { name, agentId: AGENT_A, ...over };
}

function definition(steps: StepInput[], over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { name: "Flow", executionMode: "sequential", steps, ...over };
}

/** Everything this org owns; FOREIGN_AGENT belongs to someone else. */
const loadOwnership: LoadOwnership = async (ids) => ({
  agentIds: ids.agentIds.filter((id) => id === AGENT_A || id === AGENT_B),
  deploymentIds: ids.deploymentIds.filter((id) => id === DEPLOYMENT),
  knowledgeBaseIds: ids.knowledgeBaseIds.filter((id) => id === KB),
});

async function issueOf(def: WorkflowDefinition) {
  const result = await validateWorkflowDefinition(def, { loadOwnership });
  assert.equal(result.ok, false, "expected the definition to be refused");
  return result.ok ? null! : result.issue;
}

// ---------- schema ----------

test("the schema rejects unknown keys: orgId, totalRuns, nested writes", () => {
  const base = definition([step("a")]);
  for (const extra of [
    { orgId: "another-org" },
    { totalRuns: 9000 },
    { successfulRuns: 9000 },
    { executions: { deleteMany: {} } },
  ]) {
    const parsed = workflowDefinitionSchema.safeParse({ ...base, ...extra });
    assert.equal(parsed.success, false, `accepted ${Object.keys(extra)[0]}`);
  }
  const nested = workflowDefinitionSchema.safeParse({
    ...base,
    steps: [{ ...step("a"), orchestrationId: "x" }],
  });
  assert.equal(nested.success, false);

  assert.equal(workflowPatchSchema.safeParse({ isEnabled: false }).success, true);
  assert.equal(workflowPatchSchema.safeParse({ orgId: "x" }).success, false);
  assert.equal(workflowPatchSchema.safeParse({ totalRuns: 5 }).success, false);
  assert.equal(workflowPatchSchema.safeParse({ steps: [] }).success, false);
  assert.equal(workflowPatchSchema.safeParse({}).success, false);
});

test("the schema rejects an unknown executionMode", () => {
  const parsed = workflowDefinitionSchema.safeParse({
    ...definition([step("a")]),
    executionMode: "chaotic",
  });
  assert.equal(parsed.success, false);
});

test("bounds are enforced: steps, concurrency, timeout, retries", () => {
  const ok = (over: object) =>
    workflowDefinitionSchema.safeParse({ ...definition([step("a")]), ...over }).success;

  assert.equal(ok({}), true);
  assert.equal(ok({ steps: Array.from({ length: 25 }, (_, i) => step(`s${i}`)) }), true);
  assert.equal(ok({ steps: Array.from({ length: 26 }, (_, i) => step(`s${i}`)) }), false);
  assert.equal(ok({ steps: [] }), false);
  assert.equal(ok({ maxConcurrency: 10 }), true);
  assert.equal(ok({ maxConcurrency: 11 }), false);
  assert.equal(ok({ timeout: 9_999 }), false);
  assert.equal(ok({ timeout: 3_600_001 }), false);
  assert.equal(ok({ retryPolicy: { maxRetries: 5, backoffMs: 60_000 } }), true);
  assert.equal(ok({ retryPolicy: { maxRetries: 6 } }), false);
  assert.equal(ok({ steps: [step("a", { maxRetries: 6 })] }), false);
  assert.equal(ok({ steps: [step("a", { timeoutMs: 999 })] }), false);
  assert.equal(ok({ steps: [step("a", { loop: { forEach: "$.input.items", maxItems: 51 } })] }), false);
  assert.equal(
    ok({ steps: [step("a", { loop: { until: { left: "$.input.x", op: "exists" }, maxIterations: 11 } })] }),
    false,
  );
});

test("step names containing reference delimiters are refused", () => {
  for (const name of ["a.b", "a{b", "a}b", "a|b", " padded "]) {
    const parsed = workflowDefinitionSchema.safeParse(definition([step(name)]));
    assert.equal(parsed.success, false, `accepted step name "${name}"`);
  }
  assert.equal(workflowDefinitionSchema.safeParse(definition([step("Draft notes")])).success, true);
});

// ---------- graph ----------

test("duplicate step names are refused", async () => {
  const issue = await issueOf(definition([step("a"), step("a")]));
  assert.match(issue.message, /duplicate step name: a/);
  assert.equal(issue.step, "a");
});

test("unknown, self and cyclic dependencies are refused, naming the step", async () => {
  const unknown = await issueOf(definition([step("a", { dependsOn: ["ghost"] })]));
  assert.match(unknown.message, /step "a" depends on unknown step "ghost"/);
  assert.equal(unknown.step, "a");
  assert.equal(unknown.field, "dependsOn");

  const self = await issueOf(definition([step("a", { dependsOn: ["a"] })]));
  assert.match(self.message, /step "a" depends on itself/);

  const cycle = await issueOf(
    definition([step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })]),
  );
  assert.match(cycle.message, /dependency cycle among steps: a, b/);
});

// ---------- references ----------

test("a template, mapping or condition that references an unknown step is refused", async () => {
  const template = await issueOf(definition([step("a", { promptTemplate: "{{steps.ghost.output}}" })]));
  assert.match(template.message, /step "a" references unknown step "ghost"/);

  const mapping = await issueOf(
    definition([step("a", { inputMapping: { prompt: "$.steps.ghost.output" } })]),
  );
  assert.match(mapping.message, /unknown step "ghost"/);

  const condition = await issueOf(
    definition([step("a", { condition: { left: "$.steps.ghost.output", op: "exists" } })]),
  );
  assert.match(condition.message, /unknown step "ghost"/);

  const unreadable = await issueOf(
    definition([step("a"), step("b", { inputMapping: { prompt: "$.steps.a.result" } })]),
  );
  assert.match(unreadable.message, /unreadable reference "\$\.steps\.a\.result"/);
  assert.equal(unreadable.field, "inputMapping");
});

test("parallel mode refuses a reference to a step that is not an ancestor", async () => {
  const steps = [step("a"), step("b", { promptTemplate: "Use {{steps.a.output}}" })];
  const issue = await issueOf(definition(steps, { executionMode: "parallel" }));
  assert.match(issue.message, /step "b" reads the output of "a" but does not depend on it/);
  assert.equal(issue.step, "b");

  const fixed = await validateWorkflowDefinition(
    definition([step("a"), step("b", { ...steps[1], dependsOn: ["a"] })], {
      executionMode: "parallel",
    }),
    { loadOwnership },
  );
  assert.equal(fixed.ok, true);
});

test("sequential mode accepts a reference to an earlier step and refuses a later one", async () => {
  const earlier = await validateWorkflowDefinition(
    definition([step("a"), step("b", { promptTemplate: "Use {{steps.a.output}}" })]),
    { loadOwnership },
  );
  assert.equal(earlier.ok, true);

  const later = await issueOf(
    definition([step("a", { promptTemplate: "Use {{steps.b.output}}" }), step("b")]),
  );
  assert.match(later.message, /step "a" reads the output of "b", which runs after it/);
});

test("a step may read its own output only after it ran", async () => {
  const afterwards = await validateWorkflowDefinition(
    definition([
      step("a", {
        outputMapping: { answer: "$.steps.a.output" },
        loop: { until: { left: "$.steps.a.output", op: "contains", right: "DONE" }, maxIterations: 3 },
      }),
    ]),
    { loadOwnership },
  );
  assert.equal(afterwards.ok, true);

  const before = await issueOf(definition([step("a", { promptTemplate: "{{steps.a.output}}" })]));
  assert.match(before.message, /reads its own output before it has run/);
});

test("an unknown template filter is refused when the workflow is saved", async () => {
  const issue = await issueOf(definition([step("a", { promptTemplate: "{{input.x | shout}}" })]));
  assert.match(issue.message, /unknown template filter "shout"/);
  assert.equal(issue.field, "promptTemplate");
});

// ---------- step rules ----------

test("fallback without a fallbackAgentId is refused", async () => {
  const issue = await issueOf(definition([step("a", { onError: "fallback" })]));
  assert.match(issue.message, /uses onError "fallback" but has no fallbackAgentId/);
  assert.equal(issue.field, "fallbackAgentId");
});

test("each step type needs its own resource and refuses another type's", async () => {
  const noAgent = await issueOf(definition([{ name: "a" }]));
  assert.match(noAgent.message, /is an agent step and needs an agentId/);

  const noDeployment = await issueOf(definition([{ name: "m", stepType: "model" }]));
  assert.match(noDeployment.message, /is a model step and needs a deploymentId/);

  const noKb = await issueOf(definition([{ name: "r", stepType: "retrieval" }]));
  assert.match(noKb.message, /is a retrieval step and needs a knowledgeBaseId/);

  const mixed = await issueOf(
    definition([{ name: "m", stepType: "model", deploymentId: DEPLOYMENT, agentId: AGENT_A }]),
  );
  assert.match(mixed.message, /is a model step; agentId belongs to agent steps/);

  const jsonRetrieval = await issueOf(
    definition([{ name: "r", stepType: "retrieval", knowledgeBaseId: KB, outputFormat: "json" }]),
  );
  assert.match(jsonRetrieval.message, /outputFormat applies to agent and model steps/);
});

test("bad loop configurations are refused", async () => {
  const literal = await issueOf(definition([step("a", { loop: { forEach: "a, b, c" } })]));
  assert.match(literal.message, /loop\.forEach must be a reference/);

  const itemOutsideLoop = await issueOf(definition([step("a", { promptTemplate: "{{item}}" })]));
  assert.match(itemOutsideLoop.message, /uses item, which only exists inside a forEach loop/);

  const iterationOutsideLoop = await issueOf(
    definition([step("a", { promptTemplate: "{{iteration}}" })]),
  );
  assert.match(iterationOutsideLoop.message, /uses iteration, which only exists inside an until loop/);

  // Both loop kinds at once is not a shape the schema allows.
  const both = workflowDefinitionSchema.safeParse(
    definition([
      step("a", {
        loop: {
          forEach: "$.input.items",
          until: { left: "$.input.x", op: "exists" },
          maxIterations: 2,
        } as never,
      }),
    ]),
  );
  assert.equal(both.success, false);

  const forEachSource = await issueOf(
    definition([step("a", { loop: { forEach: "$.steps.ghost.output" }, promptTemplate: "{{item}}" })]),
  );
  assert.match(forEachSource.message, /unknown step "ghost"/);
});

test("a schema keyword that cannot be enforced is refused", async () => {
  const issue = await issueOf(
    definition([step("a")], { inputSchema: { type: "object", patternProperties: {} } }),
  );
  assert.match(issue.message, /inputSchema uses "patternProperties", which is not supported/);
  assert.equal(issue.field, "inputSchema");
});

// ---------- ownership ----------

test("an agent, deployment or knowledge base from another organization is refused", async () => {
  const agent = await issueOf(definition([step("a", { agentId: FOREIGN_AGENT })]));
  assert.match(agent.message, new RegExp(`agent ${FOREIGN_AGENT} not found in this organization`));
  assert.equal(agent.field, "agentId");

  const fallback = await issueOf(
    definition([step("a", { onError: "fallback", fallbackAgentId: FOREIGN_AGENT })]),
  );
  assert.match(fallback.message, /fallback agent .* not found in this organization/);

  const deployment = await issueOf(
    definition([{ name: "m", stepType: "model", deploymentId: FOREIGN_AGENT }]),
  );
  assert.match(deployment.message, /deployment .* not found in this organization/);

  const kb = await issueOf(
    definition([{ name: "r", stepType: "retrieval", knowledgeBaseId: FOREIGN_AGENT }]),
  );
  assert.match(kb.message, /knowledge base .* not found in this organization/);
});

test("ownership is asked once, for every distinct resource in the definition", async () => {
  const asked: unknown[] = [];
  await validateWorkflowDefinition(
    definition([
      step("a", { onError: "fallback", fallbackAgentId: AGENT_B }),
      step("b"),
      { name: "m", stepType: "model", deploymentId: DEPLOYMENT },
      { name: "r", stepType: "retrieval", knowledgeBaseId: KB },
    ]),
    {
      loadOwnership: async (ids) => {
        asked.push(ids);
        return ids;
      },
    },
  );
  assert.deepEqual(asked, [
    { agentIds: [AGENT_A, AGENT_B], deploymentIds: [DEPLOYMENT], knowledgeBaseIds: [KB] },
  ]);
});

// ---------- plan preview ----------

test("a valid definition returns its plan: levels, order, concurrency", async () => {
  const result = await validateWorkflowDefinition(
    definition(
      [
        step("research"),
        step("draft", { dependsOn: ["research"], promptTemplate: "{{steps.research.output}}" }),
        step("check", { dependsOn: ["research"], promptTemplate: "{{steps.research.output}}" }),
        step("publish", {
          dependsOn: ["draft", "check"],
          promptTemplate: "{{steps.draft.output}} {{steps.check.output}}",
        }),
      ],
      { executionMode: "parallel", maxConcurrency: 3 },
    ),
    { loadOwnership },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.plan.levels, [["research"], ["draft", "check"], ["publish"]]);
  assert.deepEqual(result.plan.order, ["research", "draft", "check", "publish"]);
  assert.equal(result.plan.concurrency, 3);
  assert.deepEqual(result.plan.warnings, []);
});

test("the plan warns about a later step that would only repeat the run prompt", async () => {
  const sequential = await validateWorkflowDefinition(definition([step("a"), step("b")]), {
    loadOwnership,
  });
  assert.ok(sequential.ok);
  assert.equal(sequential.plan.warnings.length, 1);
  assert.match(sequential.plan.warnings[0]!, /step "b" has no prompt template or mapped prompt/);

  // Pipeline mode chains the previous output, so there is nothing to warn about.
  const pipeline = await validateWorkflowDefinition(
    definition([step("a"), step("b")], { executionMode: "pipeline" }),
    { loadOwnership },
  );
  assert.ok(pipeline.ok);
  assert.deepEqual(pipeline.plan.warnings, []);
});

test("the plan says so when this server cannot run model steps", async () => {
  const result = await validateWorkflowDefinition(
    definition([{ name: "m", stepType: "model", deploymentId: DEPLOYMENT }]),
    {
      loadOwnership,
      capabilities: { modelSteps: { available: false, reason: "billing service not connected" } },
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.plan.warnings, [
    "model steps cannot run on this server yet: billing service not connected",
  ]);
});

test("a fallback agent that can never be used is a warning, not a refusal", async () => {
  const result = await validateWorkflowDefinition(
    definition([step("a", { onError: "continue", fallbackAgentId: AGENT_B })]),
    { loadOwnership },
  );
  assert.ok(result.ok);
  assert.match(result.plan.warnings[0]!, /has a fallback agent that is never used/);
});
