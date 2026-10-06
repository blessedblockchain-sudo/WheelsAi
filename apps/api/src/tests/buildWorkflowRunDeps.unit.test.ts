import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLoadOwnership,
  buildStartWorkflowRunDeps,
  buildWorkflowExecutionJobDeps,
  type WorkflowRunPrismaStub,
} from "../services/buildWorkflowRunDeps.js";
import { buildWorkflowReaperTickDeps } from "../services/buildWorkflowReaperTickDeps.js";
import { finishScheduledExecution } from "../services/finishScheduledExecution.js";

// Binding tests: the run lifecycle is only as safe as the `where` clauses
// its compare-and-sets are written with. These pin them exactly.

interface Call {
  model: string;
  method: string;
  args: any;
}

function fakePrisma(
  over: {
    updateManyCount?: number;
    activeRuns?: number;
    run?: unknown;
    taskExecution?: { taskId: string; triggeredBy: string; task: { scheduleType: string } } | null;
    taskExecutionUpdateCount?: number;
  } = {},
): { prisma: WorkflowRunPrismaStub; calls: Call[] } {
  const calls: Call[] = [];
  const log = (model: string, method: string, args: unknown) => {
    calls.push({ model, method, args });
  };
  const prisma: WorkflowRunPrismaStub = {
    orchestration: {
      findFirst: async (args) => {
        log("orchestration", "findFirst", args);
        return { id: args.where.id, isEnabled: true, inputSchema: {} };
      },
    },
    orchestrationExecution: {
      updateMany: async (args) => {
        log("orchestrationExecution", "updateMany", args);
        return { count: over.updateManyCount ?? 1 };
      },
      findUnique: async (args) => {
        log("orchestrationExecution", "findUnique", args);
        return over.run ?? null;
      },
      count: async (args) => {
        log("orchestrationExecution", "count", args);
        return over.activeRuns ?? 0;
      },
      create: async (args) => {
        log("orchestrationExecution", "create", args);
        return {
          id: "exec-1",
          status: "queued",
          triggeredBy: String(args.data.triggeredBy),
          triggeredById: (args.data.triggeredById as string | null) ?? null,
          createdAt: new Date(0),
        };
      },
    },
    agent: {
      findMany: async (args) => {
        log("agent", "findMany", args);
        return args.where.id.in.filter((id) => id !== "foreign").map((id) => ({ id }));
      },
    },
    deployment: {
      findMany: async (args) => {
        log("deployment", "findMany", args);
        return [];
      },
    },
    knowledgeBase: {
      findMany: async (args) => {
        log("knowledgeBase", "findMany", args);
        return args.where.id.in.map((id) => ({ id }));
      },
    },
    taskExecution: {
      findUnique: async (args) => {
        log("taskExecution", "findUnique", args);
        return over.taskExecution === undefined
          ? { taskId: "task-1", triggeredBy: "schedule", task: { scheduleType: "cron" } }
          : over.taskExecution;
      },
      updateMany: async (args) => {
        log("taskExecution", "updateMany", args);
        return { count: over.taskExecutionUpdateCount ?? 1 };
      },
    },
    scheduledTask: {
      update: async (args) => {
        log("scheduledTask", "update", args);
        return {};
      },
    },
    $transaction: async (fn) => {
      log("$", "transaction:begin", null);
      const result = await fn(prisma);
      log("$", "transaction:end", null);
      return result;
    },
    $queryRaw: async (query, ...values) => {
      log("$", "queryRaw", { sql: query.join("?"), values });
      return [];
    },
    $executeRaw: async (query, ...values) => {
      log("$", "executeRaw", { sql: query.join("?"), values });
      return 1;
    },
  };
  return { prisma, calls };
}

const noopBindings = () => ({
  invokeAgent: async () => ({ content: "" }),
  recordStepResult: async () => {},
});

function jobDeps(prisma: WorkflowRunPrismaStub) {
  return buildWorkflowExecutionJobDeps({
    prisma,
    engineBindings: noopBindings,
    emitEvent: async () => {},
  });
}

// ---------- start ----------

test("loadWorkflow is scoped to the caller's organization", async () => {
  const { prisma, calls } = fakePrisma();
  const deps = buildStartWorkflowRunDeps({
    prisma,
    enqueue: async () => {},
    runnerEnabled: true,
    maxActiveRunsPerOrg: 5,
  });
  await deps.loadWorkflow("orch-1", "org-1");
  assert.deepEqual(calls[0]!.args.where, { id: "orch-1", orgId: "org-1" });
});

test("the run cap is counted and the row inserted under one org lock, in one transaction", async () => {
  const { prisma, calls } = fakePrisma({ activeRuns: 2 });
  const deps = buildStartWorkflowRunDeps({
    prisma,
    enqueue: async () => {},
    runnerEnabled: true,
    maxActiveRunsPerOrg: 5,
  });
  const run = await deps.createQueuedRun(
    {
      orchestrationId: "orch-1",
      orgId: "org-1",
      input: { prompt: "go" },
      triggeredBy: "schedule",
      triggeredById: null,
      scheduledTaskId: "task-1",
      taskExecutionId: "texec-1",
      jobId: null,
    },
    5,
  );
  assert.equal(run!.id, "exec-1");

  assert.deepEqual(
    calls.map((c) => `${c.model}.${c.method}`),
    [
      "$.transaction:begin",
      "$.queryRaw",
      "orchestrationExecution.count",
      "orchestrationExecution.create",
      "$.transaction:end",
    ],
  );
  assert.match(calls[1]!.args.sql, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);
  assert.deepEqual(calls[1]!.args.values, ["workflow-runs:org-1"]);
  assert.deepEqual(calls[2]!.args.where, {
    status: { in: ["queued", "running"] },
    orchestration: { orgId: "org-1" },
  });
  const data = calls[3]!.args.data;
  assert.equal(data.status, "queued");
  assert.equal(data.triggeredBy, "schedule");
  assert.equal(data.scheduledTaskId, "task-1");
  assert.equal(data.taskExecutionId, "texec-1");
});

test("at the cap no row is inserted", async () => {
  const { prisma, calls } = fakePrisma({ activeRuns: 5 });
  const deps = buildStartWorkflowRunDeps({
    prisma,
    enqueue: async () => {},
    runnerEnabled: true,
    maxActiveRunsPerOrg: 5,
  });
  const run = await deps.createQueuedRun(
    {
      orchestrationId: "orch-1",
      orgId: "org-1",
      input: {},
      triggeredBy: "manual",
      triggeredById: null,
      scheduledTaskId: null,
      taskExecutionId: null,
      jobId: null,
    },
    5,
  );
  assert.equal(run, null);
  assert.equal(calls.some((c) => c.method === "create"), false);
});

test("failQueuedRun only matches a row that is still queued", async () => {
  const { prisma, calls } = fakePrisma();
  const deps = buildStartWorkflowRunDeps({
    prisma,
    enqueue: async () => {},
    runnerEnabled: true,
    maxActiveRunsPerOrg: 5,
  });
  await deps.failQueuedRun("exec-1", "could not be queued");
  assert.deepEqual(calls[0]!.args.where, { id: "exec-1", status: "queued" });
  assert.equal(calls[0]!.args.data.status, "failed");
});

// ---------- claim / finish ----------

test("claim is a compare-and-set on {id, status: 'queued'}", async () => {
  const won = fakePrisma({ updateManyCount: 1 });
  assert.equal(await jobDeps(won.prisma).claimRun("exec-1", new Date(5)), true);
  assert.deepEqual(won.calls[0]!.args.where, { id: "exec-1", status: "queued" });
  assert.equal(won.calls[0]!.args.data.status, "running");
  assert.deepEqual(won.calls[0]!.args.data.startedAt, new Date(5));

  const lost = fakePrisma({ updateManyCount: 0 });
  assert.equal(await jobDeps(lost.prisma).claimRun("exec-1", new Date(5)), false);
});

test("finish is a compare-and-set on {id, status: 'running'}: it never matches a cancelled row", async () => {
  const outcome = {
    status: "completed" as const,
    output: { a: 1 },
    context: {},
    error: null,
    failedStepId: null,
    completedAt: new Date(9),
    durationMs: 4,
  };
  const won = fakePrisma({ updateManyCount: 1 });
  assert.equal(await jobDeps(won.prisma).finishRun("exec-1", outcome), true);
  assert.deepEqual(won.calls[0]!.args.where, { id: "exec-1", status: "running" });
  assert.equal(won.calls[0]!.args.data.status, "completed");
  assert.equal(won.calls[0]!.args.data.progress, 100);

  // A row already 'cancelled' (or reaped) is not 'running': count 0.
  const lost = fakePrisma({ updateManyCount: 0 });
  assert.equal(await jobDeps(lost.prisma).finishRun("exec-1", outcome), false);
});

test("a cancel is requested when the flag is set, the row stopped running, or the row is gone", async () => {
  const ask = async (run: unknown) => jobDeps(fakePrisma({ run }).prisma).isCancelRequested("exec-1");
  assert.equal(await ask({ status: "running", cancelRequestedAt: null }), false);
  assert.equal(await ask({ status: "running", cancelRequestedAt: new Date() }), true);
  assert.equal(await ask({ status: "failed", cancelRequestedAt: null }), true);
  assert.equal(await ask(null), true);
});

test("stats are one atomic UPDATE that computes the mean in SQL and leaves updated_at alone", async () => {
  const { prisma, calls } = fakePrisma();
  await jobDeps(prisma).recordRunStats("orch-1", { success: true, durationMs: 1200, at: new Date(7) });

  assert.deepEqual(calls.map((c) => `${c.model}.${c.method}`), ["$.executeRaw"]);
  const { sql, values } = calls[0]!.args;
  assert.match(sql, /"total_runs" = "total_runs" \+ 1/);
  assert.match(sql, /COALESCE\("avg_duration_ms", 0\)::numeric \* "total_runs" \+ \?\)\s*\/ \("total_runs" \+ 1\)/);
  assert.doesNotMatch(sql, /updated_at/);
  assert.deepEqual(values, [1200, 1, 0, new Date(7), "orch-1"]);

  const failed = fakePrisma();
  await jobDeps(failed.prisma).recordRunStats("orch-1", { success: false, durationMs: 5, at: new Date(7) });
  assert.deepEqual(failed.calls[0]!.args.values.slice(1, 3), [0, 1]);
});

test("loadRun maps the stored workflow, steps in order, into what the engine runs", async () => {
  const { prisma, calls } = fakePrisma({
    run: {
      id: "exec-1",
      input: { prompt: "go" },
      triggeredBy: "api",
      scheduledTaskId: null,
      taskExecutionId: "texec-1",
      jobId: null,
      orchestration: {
        id: "orch-1",
        orgId: "org-1",
        name: "Flow",
        executionMode: "parallel",
        maxConcurrency: 3,
        timeout: 30_000,
        retryPolicy: { maxRetries: 1 },
        inputSchema: {},
        outputSchema: { type: "object" },
        steps: [
          {
            id: "s1",
            name: "search",
            stepOrder: 0,
            stepType: "retrieval",
            agentId: null,
            deploymentId: null,
            modelId: null,
            knowledgeBaseId: "kb-1",
            promptTemplate: "{{input.prompt}}",
            inputMapping: {},
            outputMapping: {},
            outputFormat: "text",
            condition: null,
            loop: null,
            onError: "fail",
            fallbackAgentId: null,
            maxRetries: 0,
            timeoutMs: null,
            dependsOn: [],
          },
        ],
      },
    },
  });
  const run = await jobDeps(prisma).loadRun("exec-1");
  assert.deepEqual(calls[0]!.args.include, {
    orchestration: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
  });
  assert.equal(run!.taskExecutionId, "texec-1");
  assert.equal(run!.workflow.orgId, "org-1");
  assert.equal(run!.workflow.timeout, 30_000);
  assert.deepEqual(run!.workflow.outputSchema, { type: "object" });
  assert.equal(run!.workflow.steps[0]!.stepType, "retrieval");
  assert.equal(run!.workflow.steps[0]!.knowledgeBaseId, "kb-1");
});

// ---------- ownership ----------

test("ownership lookups are scoped to the organization and skip empty lists", async () => {
  const { prisma, calls } = fakePrisma();
  const owned = await buildLoadOwnership(prisma, "org-1")({
    agentIds: ["a1", "foreign"],
    deploymentIds: [],
    knowledgeBaseIds: ["kb-1"],
  });
  assert.deepEqual(owned, { agentIds: ["a1"], deploymentIds: [], knowledgeBaseIds: ["kb-1"] });
  assert.deepEqual(calls.map((c) => c.model).sort(), ["agent", "knowledgeBase"]);
  for (const call of calls) assert.equal(call.args.where.orgId, "org-1");
});

// ---------- reaper ----------

test("the reaper fails a run with a compare-and-set on the status it saw", async () => {
  const { prisma, calls } = fakePrisma({ updateManyCount: 0 });
  const deps = buildWorkflowReaperTickDeps({ prisma, emitEvent: async () => {} });
  const now = new Date(50);

  assert.equal(
    await deps.failRun({ executionId: "e1", from: "queued", error: "never started", now, durationMs: null }),
    false,
  );
  assert.deepEqual(calls[0]!.args.where, { id: "e1", status: "queued" });
  assert.equal("durationMs" in calls[0]!.args.data, false);

  await deps.failRun({ executionId: "e2", from: "running", error: "run lost", now, durationMs: 99 });
  assert.deepEqual(calls[1]!.args.where, { id: "e2", status: "running" });
  assert.deepEqual(calls[1]!.args.data, {
    status: "failed",
    error: "run lost",
    completedAt: now,
    durationMs: 99,
  });
});

// ---------- linked scheduled-task execution ----------

test("a scheduled execution is finished by compare-and-set on 'running', then the task's stats", async () => {
  const { prisma, calls } = fakePrisma({
    taskExecution: { taskId: "task-1", triggeredBy: "schedule", task: { scheduleType: "once" } },
  });
  const now = new Date(123);
  const finished = await finishScheduledExecution(
    prisma,
    "texec-1",
    { status: "success", durationMs: 40, output: { ok: true } },
    now,
  );
  assert.equal(finished, true);
  assert.deepEqual(calls[1]!.args.where, { id: "texec-1", status: "running" });
  assert.deepEqual(calls[1]!.args.data, {
    status: "success",
    completedAt: now,
    durationMs: 40,
    output: { ok: true },
  });
  const task = calls[2]!.args;
  assert.deepEqual(task.where, { id: "task-1" });
  assert.deepEqual(task.data.totalRuns, { increment: 1 });
  assert.deepEqual(task.data.successfulRuns, { increment: 1 });
  assert.equal(task.data.lastRunStatus, "success");
  // A 'once' schedule that has run is complete.
  assert.equal(task.data.status, "completed");
});

test("an execution that already finished is not finished twice: no stats are written", async () => {
  const { prisma, calls } = fakePrisma({ taskExecutionUpdateCount: 0 });
  const finished = await finishScheduledExecution(prisma, "texec-1", {
    status: "failed",
    durationMs: 1,
    error: "late",
  });
  assert.equal(finished, false);
  assert.equal(calls.some((c) => c.model === "scheduledTask"), false);
});

test("a cancelled execution counts as neither a success nor a failure", async () => {
  const { prisma, calls } = fakePrisma();
  await finishScheduledExecution(prisma, "texec-1", { status: "cancelled", durationMs: 0 });
  const data = calls.find((c) => c.model === "scheduledTask")!.args.data;
  assert.equal(data.lastRunStatus, "cancelled");
  assert.equal("totalRuns" in data, false);
  assert.equal("failedRuns" in data, false);
  assert.equal("status" in data, false);
});
