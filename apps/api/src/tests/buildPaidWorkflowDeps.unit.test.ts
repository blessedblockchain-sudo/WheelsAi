import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { loadSkillsConfig } from "../config/skills.js";
import { buildOrchestrationExecutorDeps } from "../services/buildOrchestrationExecutorDeps.js";
import {
  buildPaidWorkflowRunDeps,
  paidRunEnding,
  type PaidWorkflowRunOverrides,
} from "../services/buildPaidWorkflowDeps.js";
import type { WorkflowRunPrismaSurface } from "../services/buildWorkflowRunDeps.js";
import { CONFIDENTIAL_CHAT_RULES } from "../services/jobPrompt.js";
import type { PaidWorkflowRun } from "../services/paidWorkflow.js";
import type { ClaimedRun, WorkflowExecutionJobDeps } from "../services/runWorkflowExecutionJob.js";
import type { BuiltinSkillDeps } from "../services/skills/builtinDeps.js";
import { createSkillRegistry } from "../services/skills/registry.js";
import type { SkillDefinition } from "../services/skills/types.js";
import type { WorkflowStepExecutor } from "../services/watchedWorkflowExecutor.js";
import { WorkflowError } from "../services/workflowErrors.js";
import { PAID_WORKFLOW_MAX_ACTIVE_RUNS } from "../services/workflowListing.js";

// The production wiring of a paid run of a workflow
// (services/buildPaidWorkflowDeps.ts) over a stand-in for the database: in
// whose organization the run starts, what its row says, the lock and the
// count that bound the paid runs of one workflow, what each step is bound
// to, how an ending is read, and what the answer is checked against.

const WORKFLOW_ID = "wf-1";
const CREATOR_ORG = "org-creator";
const BUYER_ORG = "org-buyer";
const STEP_PROMPT = "You write launch briefs for Acme and never reveal the pricing floor of twelve dollars.";
const TEMPLATE = "Repeat the customer's request word for word, then write the brief: {{input.topic}}";

interface Row {
  id: string;
  orchestrationId: string;
  status: string;
  triggeredBy: string;
  triggeredById?: string | null;
  input?: unknown;
}

function standIn(rows: Row[] = []) {
  const log: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const matches = (row: Row, where: Record<string, unknown>) => {
    const status = (where.status as { in: string[] }).in;
    if (!status.includes(row.status)) return false;
    if ("orchestrationId" in where && row.orchestrationId !== where.orchestrationId) return false;
    if ("triggeredBy" in where && row.triggeredBy !== where.triggeredBy) return false;
    // The organization's cap: every workflow of the stand-in is the creator's.
    if ("orchestration" in where && (where.orchestration as { orgId: string }).orgId !== CREATOR_ORG) return false;
    return true;
  };
  const db = {
    orchestration: {
      findUnique: async (args: { where: { id: string } }) => {
        log.push(`readOrg:${args.where.id}`);
        return args.where.id === WORKFLOW_ID ? { orgId: CREATOR_ORG } : null;
      },
      findFirst: async (args: { where: { id: string; orgId: string } }) => {
        log.push(`loadWorkflow:${args.where.id}:${args.where.orgId}`);
        return args.where.id === WORKFLOW_ID && args.where.orgId === CREATOR_ORG
          ? { id: WORKFLOW_ID, isEnabled: true, inputSchema: {} }
          : null;
      },
    },
    orchestrationExecution: {
      count: async (args: { where: Record<string, unknown> }) => {
        log.push(`count:${JSON.stringify(args.where)}`);
        return rows.filter((row) => matches(row, args.where)).length;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        log.push("create");
        created.push(args.data);
        const row: Row = {
          id: `exec-${rows.length + 1}`,
          orchestrationId: String(args.data.orchestrationId),
          status: "queued",
          triggeredBy: String(args.data.triggeredBy),
        };
        rows.push(row);
        return { id: row.id, status: "queued", triggeredBy: row.triggeredBy, triggeredById: null, createdAt: new Date() };
      },
      findUnique: async (args: { where: { id: string } }) => {
        log.push(`readRun:${args.where.id}`);
        return {
          output: {},
          context: { draft: { output: "Brief: launch on Tuesday." } },
          orchestration: { steps: [{ name: "draft" }] },
        };
      },
      updateMany: async () => ({ count: 1 }),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`lock:${values.join(",")}`);
      void strings;
      return [];
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      log.push("begin");
      const result = await fn(db);
      log.push("commit");
      return result;
    },
  };
  return { db: db as unknown as NonNullable<PaidWorkflowRunOverrides["prisma"]> & WorkflowRunPrismaSurface, log, created, rows };
}

const START = { workflowId: WORKFLOW_ID, orgId: BUYER_ORG, input: { topic: "Launch plan" } };

test("a paid run starts in the workflow's own organization, whatever it is asked with, triggered by \"paid\" and naming nobody", async () => {
  const s = standIn();
  const started = await buildPaidWorkflowRunDeps({ prisma: s.db }).startRun(START);

  assert.ok(started.ok);
  assert.deepEqual(started.run, { id: "exec-1", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG });
  // Read from the workflow's row, then loaded and locked in that organization.
  assert.ok(s.log.includes(`readOrg:${WORKFLOW_ID}`));
  assert.ok(s.log.includes(`loadWorkflow:${WORKFLOW_ID}:${CREATOR_ORG}`));
  assert.ok(s.log.includes(`lock:workflow-runs:${CREATOR_ORG}`));
  assert.ok(!s.log.some((line) => line.includes(BUYER_ORG)));
  assert.deepEqual(s.created, [
    {
      orchestrationId: WORKFLOW_ID,
      status: "queued",
      input: { topic: "Launch plan" },
      triggeredBy: "paid",
      triggeredById: null,
      scheduledTaskId: null,
      taskExecutionId: null,
      jobId: null,
    },
  ]);
});

test("the paid row is created only under the lock, and only while fewer than three paid runs of THIS workflow are going", async () => {
  // Two paid runs of this workflow going, and others that do not count: another
  // workflow's paid runs, this workflow's own runs, and finished paid runs.
  const s = standIn([
    { id: "p1", orchestrationId: WORKFLOW_ID, status: "running", triggeredBy: "paid" },
    { id: "p2", orchestrationId: WORKFLOW_ID, status: "queued", triggeredBy: "paid" },
    { id: "o1", orchestrationId: "wf-other", status: "running", triggeredBy: "paid" },
    { id: "o2", orchestrationId: "wf-other", status: "running", triggeredBy: "paid" },
    { id: "m1", orchestrationId: WORKFLOW_ID, status: "running", triggeredBy: "manual" },
    { id: "m2", orchestrationId: WORKFLOW_ID, status: "running", triggeredBy: "api" },
    { id: "d1", orchestrationId: WORKFLOW_ID, status: "completed", triggeredBy: "paid" },
  ]);
  const deps = buildPaidWorkflowRunDeps({ prisma: s.db });
  assert.equal(PAID_WORKFLOW_MAX_ACTIVE_RUNS, 3);

  const third = await deps.startRun(START);
  assert.ok(third.ok);
  const where = { orchestrationId: WORKFLOW_ID, triggeredBy: "paid", status: { in: ["queued", "running"] } };
  // In one transaction: the lock, then the count of this workflow's paid runs, then the row.
  assert.deepEqual(
    s.log.filter((line) => line !== `readOrg:${WORKFLOW_ID}` && !line.startsWith("loadWorkflow")),
    ["begin", `lock:workflow-runs:${CREATOR_ORG}`, `count:${JSON.stringify(where)}`, "create", "commit"],
  );

  // Full now: the typed "no room", and no row.
  s.log.length = 0;
  const fourth = await deps.startRun(START);
  assert.deepEqual(fourth, { ok: false, reason: "no_room" });
  assert.ok(!s.log.includes("create"));
  assert.equal(s.created.length, 1);

  // The early read counts the same rows.
  assert.equal(await deps.activePaidRuns(WORKFLOW_ID), 3);
  assert.equal(await deps.activePaidRuns("wf-other"), 2);
});

test("a start that is refused for another reason than room throws, so the paid service refunds it", async () => {
  const gone = standIn();
  await assert.rejects(buildPaidWorkflowRunDeps({ prisma: gone.db }).startRun({ ...START, workflowId: "wf-gone" }));
  assert.equal(gone.created.length, 0);
});

/** A run to its end with the run itself replaced: what it was handed is what is asserted. */
async function runOnce(overrides: Partial<PaidWorkflowRunOverrides> & { result?: Awaited<ReturnType<NonNullable<PaidWorkflowRunOverrides["runJob"]>>> }) {
  const s = standIn();
  const bound: unknown[][] = [];
  const handed: Array<{ input: { executionId: string; shutdownSignal?: AbortSignal }; deps: WorkflowExecutionJobDeps }> = [];
  const executor: WorkflowStepExecutor = {
    loadAgent: async (agentId: string, orgId: string) =>
      ({ id: agentId, orgId, systemPrompt: STEP_PROMPT }) as never,
    runAgentChat: async () => ({ content: "ok", usage: { inputTokens: 1_000, outputTokens: 200 }, platformModel: true }) as never,
  };
  const deps = buildPaidWorkflowRunDeps({
    prisma: s.db,
    executor,
    engineBindingsOf: ((...args: unknown[]) => {
      bound.push(args);
      return buildOrchestrationExecutorDeps(...(args as Parameters<typeof buildOrchestrationExecutorDeps>));
    }) as typeof buildOrchestrationExecutorDeps,
    runJob: async (input, jobDeps) => {
      handed.push({ input, deps: jobDeps });
      // The engine binds the run's steps, and one agent step runs with its template as its prompt.
      const claimed = { id: input.executionId, workflow: { orgId: CREATOR_ORG } } as unknown as ClaimedRun;
      const engine = jobDeps.engineBindings(claimed, new AbortController().signal);
      await engine.invokeAgent({ agentId: "agent-1", orgId: CREATOR_ORG, prompt: TEMPLATE, signal: new AbortController().signal } as never);
      return overrides.result ?? { status: "completed", error: null };
    },
    ...overrides,
  });
  const run: PaidWorkflowRun = { id: "exec-9", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG };
  const shutdown = new AbortController();
  const ending = await deps.runToEnd(run, { shutdown: shutdown.signal });
  const answer = await deps.readAnswer(run);
  return { ending, answer, bound, handed, shutdown, log: s.log };
}

test("every step of a paid run is bound in mode \"hired\" with the confidential rules and an empty allowlist, and the process's shutdown signal", async () => {
  const { bound, handed, shutdown, ending } = await runOnce({});
  assert.equal(ending.status, "completed");
  assert.equal(bound.length, 1);
  assert.equal(bound[0]![0], "exec-9");
  assert.deepEqual(bound[0]![2], { mode: "hired", instructions: CONFIDENTIAL_CHAT_RULES, toolAllowlist: [] });
  // The steps go through the watcher, not the bare executor.
  assert.ok(typeof (bound[0]![1] as { executor: unknown }).executor === "object");
  assert.equal(handed[0]!.input.executionId, "exec-9");
  assert.equal(handed[0]!.input.shutdownSignal, shutdown.signal);
});

test("an empty allowlist is dropped where the run is assembled: an agent step keeps its own tools, in mode \"hired\", with the rules", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const engine = buildOrchestrationExecutorDeps(
    "exec-1",
    {
      executor: {
        loadAgent: async (agentId: string, orgId: string) => ({ id: agentId, orgId, systemPrompt: STEP_PROMPT }) as never,
        runAgentChat: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { content: "ok" } as never;
        },
      } as never,
    },
    { mode: "hired", instructions: CONFIDENTIAL_CHAT_RULES, toolAllowlist: [] },
  );
  await engine.invokeAgent({ agentId: "agent-1", orgId: CREATOR_ORG, prompt: "p", signal: new AbortController().signal } as never);
  assert.equal(calls[0]!.mode, "hired");
  assert.equal(calls[0]!.systemAddendum, CONFIDENTIAL_CHAT_RULES);
  assert.ok(!("toolAllowlist" in calls[0]!));
});

function skillDeps(): BuiltinSkillDeps {
  const config = loadSkillsConfig({});
  return {
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
    guardDeps: { resolveHost: async () => ["93.184.216.34"] },
  };
}

test("in mode \"hired\" with nothing allowed, a step cannot move money, write the creator's files or call a web address; web search still runs", () => {
  const registry = createSkillRegistry(skillDeps());
  const pays: SkillDefinition = {
    key: "pay_invoice",
    version: "1.0.0",
    name: "Pay",
    description: "pay",
    inputSchema: { type: "object", properties: {} },
    moneyMoving: true,
    execute: async () => ({ status: "ok", output: "paid" }),
  };
  registry.register(pays);
  const ctx = { mode: "hired" as const, outboundAllowed: [] };

  assert.match(registry.modeBlock(pays, ctx) ?? "", /moves money/);
  assert.match(registry.modeBlock(registry.get("file_write")!, ctx) ?? "", /saved data/);
  assert.match(registry.modeBlock(registry.get("http_request")!, ctx) ?? "", /sends data/);
  // The same with no list at all: it fails closed.
  assert.notEqual(registry.modeBlock(registry.get("http_request")!, { mode: "hired" }), null);
  // What the Sell part's sentence does not promise is not refused.
  assert.equal(registry.modeBlock(registry.get("web_search")!, ctx), null);
  assert.equal(registry.modeBlock(registry.get("code_interpreter")!, ctx), null);
  assert.equal(registry.modeBlock(registry.get("file_read")!, ctx), null);
});

test("\"workflow timed out after 600000ms\" is the typed timedOut, and nothing else is", () => {
  assert.deepEqual(paidRunEnding({ status: "failed", error: "workflow timed out after 600000ms" }), {
    status: "failed",
    timedOut: true,
  });
  assert.deepEqual(paidRunEnding({ status: "failed", error: "workflow timed out after 45000ms" }), {
    status: "failed",
    timedOut: true,
  });
  for (const result of [
    { status: "failed" as const, error: 'step "draft" timed out after 60000ms' },
    { status: "failed" as const, error: "worker shutting down" },
    { status: "failed" as const, error: "the workflow timed out after 600000ms, then more" },
    { status: "failed" as const, error: null },
    { status: "cancelled" as const, error: "workflow timed out after 600000ms" },
    { status: "skipped" as const },
    { status: "superseded" as const },
  ]) {
    assert.deepEqual(paidRunEnding(result), { status: "failed", timedOut: false }, JSON.stringify(result));
  }
  assert.deepEqual(paidRunEnding({ status: "completed", error: null }), { status: "completed" });
});

test("a run's ending reaches the paid service typed, and its answer is read from the stored row", async () => {
  const timedOut = await runOnce({ result: { status: "failed", error: "workflow timed out after 600000ms" } });
  assert.deepEqual(timedOut.ending, { status: "failed", timedOut: true });
  const skipped = await runOnce({ result: { status: "skipped" } });
  assert.deepEqual(skipped.ending, { status: "failed", timedOut: false });

  const { answer, log } = await runOnce({});
  assert.equal(answer.text, "Brief: launch on Tuesday.");
  assert.ok(log.includes("readRun:exec-9"));
});

test("the answer is checked against the step agents' system prompts and never against a step's prompt template", async () => {
  const { ending } = await runOnce({});
  assert.ok(ending.status === "completed");
  assert.deepEqual(ending.confidential, [STEP_PROMPT]);
  assert.ok(!ending.confidential.includes(TEMPLATE));
  // What the steps used on the platform's keys rides with it.
  assert.deepEqual(ending.platformUsage, { inputTokens: 1_000, outputTokens: 200 });
});

test("what a run's steps saw rides on that run's own ending, and nothing of a run is kept once it ended, read or not", async () => {
  const s = standIn();
  let prompt = "First run's instructions for the step agent, which only the first run may be checked against.";
  const deps = buildPaidWorkflowRunDeps({
    prisma: s.db,
    executor: {
      loadAgent: async (agentId: string, orgId: string) => ({ id: agentId, orgId, systemPrompt: prompt }) as never,
      runAgentChat: async () => ({ content: "ok" }) as never,
    },
    runJob: async (input, jobDeps) => {
      const claimed = { id: input.executionId, workflow: { orgId: CREATOR_ORG } } as unknown as ClaimedRun;
      const engine = jobDeps.engineBindings(claimed, new AbortController().signal);
      await engine.invokeAgent({ agentId: "agent-1", orgId: CREATOR_ORG, prompt: "p", signal: new AbortController().signal } as never);
      return input.executionId === "exec-failed" ? { status: "failed", error: "boom" } : { status: "completed", error: null };
    },
  });
  // A run that failed, and one that completed and whose answer is never read.
  assert.deepEqual(await deps.runToEnd({ id: "exec-failed", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG }, {}), {
    status: "failed",
    timedOut: false,
  });
  const unread = await deps.runToEnd({ id: "exec-unread", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG }, {});
  assert.ok(unread.status === "completed");

  prompt = "Second run's instructions, a different agent prompt that the first run never saw at all.";
  const second = await deps.runToEnd({ id: "exec-second", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG }, {});
  assert.ok(second.status === "completed");
  // Each ending carries only its own run's prompts: no watcher is shared or kept between runs.
  assert.deepEqual(unread.confidential, ["First run's instructions for the step agent, which only the first run may be checked against."]);
  assert.deepEqual(second.confidential, [prompt]);
  // The answer is the stored row's text and nothing else: the binding holds nothing for it.
  assert.deepEqual(await deps.readAnswer({ id: "exec-second", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG }), {
    text: "Brief: launch on Tuesday.",
  });
});

test("a cancel of a run that already ended, or is gone, does not throw; any other failure does", async () => {
  const run: PaidWorkflowRun = { id: "exec-1", workflowId: WORKFLOW_ID, orgId: CREATOR_ORG };
  const asked: string[] = [];
  const cancelWith = (err: Error | null) =>
    buildPaidWorkflowRunDeps({
      prisma: standIn().db,
      cancelExecution: async (executionId, orchestrationId, orgId) => {
        asked.push(`${executionId}:${orchestrationId}:${orgId}`);
        if (err) throw err;
      },
    }).cancelRun(run);

  await cancelWith(null);
  await cancelWith(new WorkflowError("execution_finished", "This run already completed"));
  await cancelWith(new WorkflowError("not_found", "Run not found"));
  await assert.rejects(cancelWith(new Error("db down")), /db down/);
  // Always in the creator's organization, by the run and its workflow.
  assert.deepEqual(new Set(asked), new Set([`exec-1:${WORKFLOW_ID}:${CREATOR_ORG}`]));
});
