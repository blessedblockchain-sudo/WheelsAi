import assert from "node:assert/strict";
import test from "node:test";

import {
  runWorkflowExecutionJob,
  type ClaimedRun,
  type LinkedTaskOutcome,
  type RunOutcome,
  type WorkflowExecutionJobDeps,
} from "../services/runWorkflowExecutionJob.js";
import type { OrchestrationStepDef } from "../services/runOrchestrationExecution.js";

// Drives services/runWorkflowExecutionJob.ts with the REAL engine and
// fake IO. The run row is a small state machine held in `world.status`;
// claim and finish are compare-and-set against it, exactly as the Prisma
// binding does with a `where` on status.

function step(name: string, over: Partial<OrchestrationStepDef> = {}): OrchestrationStepDef {
  return {
    id: `id-${name}`,
    name,
    stepOrder: 0,
    dependsOn: [],
    agentId: `agent-${name}`,
    inputMapping: {},
    outputMapping: {},
    condition: null,
    onError: "fail",
    fallbackAgentId: null,
    maxRetries: 0,
    timeoutMs: null,
    ...over,
  };
}

interface World {
  status: string;
  cancelRequested: boolean;
  invocations: string[];
  finished: RunOutcome[];
  stats: Array<{ orchestrationId: string; success: boolean; durationMs: number }>;
  linked: Array<{ taskExecutionId: string; outcome: LinkedTaskOutcome }>;
  events: Array<{ orgId: string; type: string; data: Record<string, unknown> }>;
  sideEffectErrors: string[];
}

function makeWorld(
  options: {
    status?: string;
    steps?: OrchestrationStepDef[];
    run?: Partial<ClaimedRun>;
    workflow?: Partial<ClaimedRun["workflow"]>;
    invoke?: (agentId: string, signal?: AbortSignal) => Promise<{ content: string }>;
    deps?: Partial<WorkflowExecutionJobDeps>;
  } = {},
): { deps: WorkflowExecutionJobDeps; world: World } {
  const world: World = {
    status: options.status ?? "queued",
    cancelRequested: false,
    invocations: [],
    finished: [],
    stats: [],
    linked: [],
    events: [],
    sideEffectErrors: [],
  };
  const steps = (options.steps ?? [step("only")]).map((s, i) => ({ ...s, stepOrder: i }));
  const run: ClaimedRun = {
    id: "exec-1",
    input: { prompt: "go" },
    triggeredBy: "manual",
    scheduledTaskId: null,
    taskExecutionId: null,
    jobId: null,
    workflow: {
      id: "orch-1",
      orgId: "org-1",
      name: "Flow",
      executionMode: "sequential",
      maxConcurrency: 5,
      timeout: 60_000,
      outputSchema: {},
      steps,
      ...options.workflow,
    },
    ...options.run,
  };

  let clock = 0;
  const deps: WorkflowExecutionJobDeps = {
    claimRun: async () => {
      if (world.status !== "queued") return false;
      world.status = "running";
      return true;
    },
    loadRun: async () => run,
    engineBindings: (_run, signal) => ({
      invokeAgent: async ({ agentId }) => {
        world.invocations.push(agentId);
        return options.invoke ? options.invoke(agentId, signal) : { content: `${agentId} done` };
      },
      recordStepResult: async () => {},
    }),
    isCancelRequested: async () => world.cancelRequested,
    finishRun: async (_id, outcome) => {
      if (world.status !== "running") return false;
      world.status = outcome.status;
      world.finished.push(outcome);
      return true;
    },
    recordRunStats: async (orchestrationId, stats) => {
      world.stats.push({ orchestrationId, success: stats.success, durationMs: stats.durationMs });
    },
    finishLinkedTaskExecution: async (taskExecutionId, outcome) => {
      world.linked.push({ taskExecutionId, outcome });
    },
    emitEvent: async (orgId, type, data) => {
      world.events.push({ orgId, type, data });
    },
    onSideEffectError: (what) => {
      world.sideEffectErrors.push(what);
    },
    now: () => new Date(1_000 + clock++ * 250),
    cancelPollMs: 5,
    ...options.deps,
  };
  return { deps, world };
}

test("a queued run is claimed, executed and finished as completed", async () => {
  const { deps, world } = makeWorld({
    steps: [step("a", { outputMapping: { answer: "$.steps.a.output" } })],
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);

  assert.deepEqual(result, { status: "completed", error: null });
  assert.equal(world.status, "completed");
  assert.deepEqual(world.invocations, ["agent-a"]);
  assert.deepEqual(world.finished[0]!.output, { answer: "agent-a done" });
  assert.ok(world.finished[0]!.durationMs > 0);
});

test("when the claim finds no queued row, nothing is invoked or written", async () => {
  // Another delivery owns the run (already 'running'), or it was
  // cancelled while queued.
  for (const status of ["running", "cancelled", "completed", "failed"]) {
    const { deps, world } = makeWorld({ status });
    const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
    assert.deepEqual(result, { status: "skipped" }, status);
    assert.equal(world.invocations.length, 0, `${status}: an agent was invoked`);
    assert.equal(world.finished.length, 0);
    assert.equal(world.stats.length, 0);
    assert.equal(world.events.length, 0);
    assert.equal(world.status, status, "the row is untouched");
  }
});

test("two deliveries of the same job run the workflow once", async () => {
  const { deps, world } = makeWorld();
  const results = await Promise.all([
    runWorkflowExecutionJob({ executionId: "exec-1" }, deps),
    runWorkflowExecutionJob({ executionId: "exec-1" }, deps),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["completed", "skipped"]);
  assert.equal(world.invocations.length, 1, "agents were invoked (and billed) once");
  assert.equal(world.stats.length, 1);
  assert.equal(world.events.length, 1);
});

test("a failed step fails the run and emits workflow.failed with the error", async () => {
  const { deps, world } = makeWorld({
    invoke: async () => {
      throw new Error("model exploded");
    },
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "failed");
  assert.equal(world.status, "failed");
  assert.equal(world.finished[0]!.failedStepId, "id-only");
  assert.deepEqual(world.stats, [{ orchestrationId: "orch-1", success: false, durationMs: world.finished[0]!.durationMs }]);
  assert.equal(world.events[0]!.type, "workflow.failed");
  assert.equal(world.events[0]!.data.error, "model exploded");
});

test("a completed run updates stats once and emits workflow.completed", async () => {
  const { deps, world } = makeWorld({
    steps: [step("a", { outputMapping: { answer: "$.steps.a.output" } })],
  });
  await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(world.stats.length, 1, "one atomic stats update");
  assert.equal(world.stats[0]!.success, true);
  assert.deepEqual(
    world.events.map((e) => [e.orgId, e.type, e.data.executionId, e.data.status]),
    [["org-1", "workflow.completed", "exec-1", "completed"]],
  );
  assert.equal(world.events[0]!.data.outputPreview, '{"answer":"agent-a done"}');
});

test("a linked scheduled-task execution is finished with the workflow's real outcome", async () => {
  const ok = makeWorld({
    run: { taskExecutionId: "texec-1", triggeredBy: "schedule" },
    steps: [step("a", { outputMapping: { answer: "$.steps.a.output" } })],
  });
  await runWorkflowExecutionJob({ executionId: "exec-1" }, ok.deps);
  assert.equal(ok.world.linked[0]!.taskExecutionId, "texec-1");
  assert.equal(ok.world.linked[0]!.outcome.status, "success");
  assert.deepEqual(ok.world.linked[0]!.outcome.output, {
    orchestrationExecutionId: "exec-1",
    status: "completed",
    output: { answer: "agent-a done" },
  });

  const bad = makeWorld({
    run: { taskExecutionId: "texec-2" },
    invoke: async () => {
      throw new Error("nope");
    },
  });
  await runWorkflowExecutionJob({ executionId: "exec-1" }, bad.deps);
  assert.equal(bad.world.linked[0]!.outcome.status, "failed");
  assert.equal(bad.world.linked[0]!.outcome.error, "nope");
});

test("a cancel requested mid-run aborts the in-flight call and ends 'cancelled'", async () => {
  let sawAbort = false;
  const { deps, world } = makeWorld({
    steps: [step("slow"), step("never")],
    run: { taskExecutionId: "texec-1" },
    invoke: (_agentId, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
        setTimeout(() => {
          world.cancelRequested = true;
        }, 5);
      }),
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);

  assert.equal(result.status, "cancelled");
  assert.equal(world.status, "cancelled");
  assert.ok(sawAbort, "the model call was aborted, not left running");
  assert.deepEqual(world.invocations, ["agent-slow"]);
  // A cancel is neither a success nor a failure of the workflow.
  assert.equal(world.stats.length, 0);
  assert.equal(world.events.length, 0);
  assert.equal(world.linked[0]!.outcome.status, "cancelled");
});

test("the workflow timeout aborts the run and fails it with a timeout message", async () => {
  let sawAbort = false;
  const { deps, world } = makeWorld({
    workflow: { timeout: 20 },
    invoke: (_agentId, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.error : null, "workflow timed out after 20ms");
  assert.ok(sawAbort);
  assert.equal(world.events[0]!.type, "workflow.failed");
});

test("the final compare-and-set never overwrites a run someone else already ended", async () => {
  // The reaper (or a delete) ended the run while the engine was working.
  const { deps, world } = makeWorld({
    invoke: async () => {
      world.status = "failed";
      return { content: "late answer" };
    },
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.deepEqual(result, { status: "superseded" });
  assert.equal(world.status, "failed", "the earlier ending stands");
  assert.equal(world.finished.length, 0);
  // The loser records nothing: no second stats update, no event.
  assert.equal(world.stats.length, 0);
  assert.equal(world.events.length, 0);
  assert.equal(world.linked.length, 0);
});

test("an output that does not match the outputSchema fails the run", async () => {
  const { deps, world } = makeWorld({
    steps: [step("a", { outputMapping: { answer: "$.steps.a.output" } })],
    workflow: {
      outputSchema: {
        type: "object",
        required: ["answer", "score"],
        properties: { answer: { type: "string" }, score: { type: "number" } },
      },
    },
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "failed");
  assert.match(world.finished[0]!.error!, /output does not match the workflow's output schema: score is required/);
  assert.equal(world.events[0]!.type, "workflow.failed");
  assert.equal(world.stats[0]!.success, false);
});

test("a definition that can no longer run fails before any step is invoked", async () => {
  const { deps, world } = makeWorld({
    deps: { validateWorkflow: async () => 'step "only": agent x not found in this organization' },
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "failed");
  assert.match(world.finished[0]!.error!, /workflow can no longer run: step "only": agent x not found/);
  assert.equal(world.invocations.length, 0, "nothing was charged");
});

test("a plan error is recorded on the run instead of leaving it running", async () => {
  const { deps, world } = makeWorld({
    steps: [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })],
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "failed");
  assert.match(world.finished[0]!.error!, /dependency cycle/);
  assert.equal(world.status, "failed");
});

test("a failed stats or event write does not change the run's outcome", async () => {
  const { deps, world } = makeWorld({
    run: { taskExecutionId: "texec-1" },
    deps: {
      recordRunStats: async () => {
        throw new Error("db blip");
      },
      emitEvent: async () => {
        throw new Error("webhook table locked");
      },
    },
  });
  const result = await runWorkflowExecutionJob({ executionId: "exec-1" }, deps);
  assert.equal(result.status, "completed");
  assert.equal(world.status, "completed");
  assert.deepEqual(world.sideEffectErrors, ["stats", "webhook event"]);
  // The step between the two failures still ran.
  assert.equal(world.linked.length, 1);
});

test("a worker shutdown aborts the run and fails it with that reason", async () => {
  const shutdown = new AbortController();
  const { deps, world } = makeWorld({
    invoke: (_agentId, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => shutdown.abort(), 5);
      }),
  });
  const result = await runWorkflowExecutionJob(
    { executionId: "exec-1", shutdownSignal: shutdown.signal },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(world.finished[0]!.error!, /workflow run interrupted: worker shutting down/);
});

test("a run that was claimed but cannot be loaded is ended, not left running", async () => {
  const { deps, world } = makeWorld({
    deps: {
      loadRun: async () => {
        throw new Error("db blip");
      },
    },
  });
  await assert.rejects(runWorkflowExecutionJob({ executionId: "exec-1" }, deps), /db blip/);
  assert.equal(world.status, "failed");
  assert.equal(world.finished[0]!.error, "the run could not be loaded");
  assert.equal(world.invocations.length, 0);
});
