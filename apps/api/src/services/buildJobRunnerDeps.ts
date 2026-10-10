/**
 * Composition root for the job runner (services/jobRunner.ts).
 *
 * A job runs the publisher's ORIGINAL product in the PUBLISHER's
 * organization: every lookup below is scoped to job.publisherId, never the
 * buyer's. So the publisher's keys, files and knowledge stay where they
 * are, and nothing is billed to the buyer beyond the job's price.
 *
 *   agent     buildProductionExecutorDeps().runAgentChat - the one chat
 *             core the playground, /v1, the scheduler and workflow steps
 *             use - in tool mode `hired`, with the offering's private
 *             instructions as a system turn and its tool allowlist.
 *   workflow  startWorkflowRun (the entry point every trigger uses: the
 *             workflow's input schema and enabled flag are checked there),
 *             triggered by 'job', then runWorkflowExecutionJob in this
 *             worker with every step bound to `hired`. It is run here
 *             rather than handed to the workflow queue because that
 *             queue's worker binds steps as the owner's own batch run.
 *   model     chatWithDeployment, under the deployment's own billing.
 *
 * Money moves through prisma.$transaction and the escrow core only.
 */

import { env } from "../config/env.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { chatWithDeployment as defaultChatWithDeployment } from "./buildDeploymentChatDeps.js";
import { buildJobNotifier } from "./buildJobNotifier.js";
import {
  buildOrchestrationExecutorDeps,
  modelStepCapability,
} from "./buildOrchestrationExecutorDeps.js";
import {
  buildStartWorkflowRunDeps,
  buildWorkflowExecutionJobDeps,
  type WorkflowRunPrismaSurface,
} from "./buildWorkflowRunDeps.js";
import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import type { EscrowTx, JobTerms } from "./jobEscrow.js";
import type { JobEvent } from "./jobNotifications.js";
import type { JobForRun, JobRunnerDeps, ProductRun, TokenUsage } from "./jobRunner.js";
import { runWorkflowExecutionJob } from "./runWorkflowExecutionJob.js";
import { buildProductionExecutorDeps } from "./scheduledTaskExecutorProduction.js";
import { withSchemaOrder } from "./schemaOrder.js";
import { startWorkflowRun } from "./startWorkflowRun.js";
import { triggerWebhook } from "./webhooks.js";
import { workflowAnswerText } from "./workflowChat.js";

const logger = createLogger("job-runner");

type Executor = Pick<ExecuteScheduledTaskDeps, "loadAgent" | "runAgentChat">;

export const JOB_FOR_RUN_SELECT = {
  id: true,
  buyerId: true,
  publisherId: true,
  status: true,
  input: true,
  deadlineAt: true,
  leaseExpiresAt: true,
  attempts: true,
  terms: true,
  offering: {
    select: {
      id: true,
      title: true,
      productKind: true,
      agentId: true,
      orchestrationId: true,
      deploymentId: true,
      inputSchema: true,
      // The order of the form's questions: the brief lists the answers in it.
      inputOrder: true,
      instructions: true,
      allowedTools: true,
      maxAttempts: true,
    },
  },
} as const;

interface JobRunnerPrisma {
  job: {
    findUnique(args: { where: { id: string }; select: typeof JOB_FOR_RUN_SELECT }): Promise<unknown>;
    updateMany(args: {
      where: { id: string; status: "running" };
      data: { orchestrationExecutionId: string };
    }): Promise<unknown>;
  };
  orchestrationExecution: {
    findUnique(args: {
      where: { id: string };
      select: {
        output: true;
        context: true;
        orchestration: { select: { steps: { orderBy: { stepOrder: "asc" }; select: { name: true } } } };
      };
    }): Promise<{
      output: unknown;
      context: unknown;
      orchestration: { steps: Array<{ name: string }> };
    } | null>;
  };
  $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

export interface JobRunnerOverrides {
  prisma?: JobRunnerPrisma;
  executor?: Executor;
  chatWithDeployment?: typeof defaultChatWithDeployment;
  /** Runs a workflow for a job; the default is the engine described above. */
  runWorkflow?: JobRunnerDeps["runWorkflow"];
  notify?: (event: JobEvent, jobId: string) => Promise<void>;
  maxRunMs?: number;
  platformModelRates?: JobRunnerDeps["platformModelRates"];
}

function readUsage(usage: unknown): TokenUsage | null {
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
  return typeof u?.inputTokens === "number" && typeof u?.outputTokens === "number"
    ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
    : null;
}

/**
 * What a call on the platform's keys used. A provider that reports no count
 * is estimated at four characters a token, the estimate the inference path
 * already uses for prompts: usage that was not reported was still used.
 */
export function platformUsageOf(
  result: { usage?: unknown; platformModel?: boolean; content: string },
  promptChars: number,
): TokenUsage | null {
  if (!result.platformModel) return null;
  return (
    readUsage(result.usage) ?? {
      inputTokens: Math.max(1, Math.ceil(promptChars / 4)),
      outputTokens: Math.max(1, Math.ceil(result.content.length / 4)),
    }
  );
}

export function buildJobRunnerDeps(overrides: JobRunnerOverrides = {}): JobRunnerDeps {
  const prisma = overrides.prisma ?? (defaultPrisma as unknown as JobRunnerPrisma);
  const executor = overrides.executor ?? buildProductionExecutorDeps();
  const chatWithDeployment = overrides.chatWithDeployment ?? defaultChatWithDeployment;
  const notify = overrides.notify ?? buildJobNotifier();

  const runWorkflow: JobRunnerDeps["runWorkflow"] = async (args) => {
    const { job } = args;
    const orgId = job.publisherId;
    const surface = prisma as unknown as WorkflowRunPrismaSurface;

    // Every agent step goes through the shared executor; this wrapper only
    // watches: which system prompts took part (the deliverable must not
    // repeat them) and what ran on the platform's keys.
    const confidential: Array<string | null> = [];
    const used: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let usedPlatform = false;
    const watched: Executor = {
      loadAgent: async (agentId, agentOrgId) => {
        const agent = await executor.loadAgent(agentId, agentOrgId);
        if (agent) confidential.push(agent.systemPrompt);
        return agent;
      },
      runAgentChat: async (chat) => {
        const result = await executor.runAgentChat(chat);
        const usage = platformUsageOf(result, chat.prompt.length + (chat.systemAddendum?.length ?? 0));
        if (usage) {
          usedPlatform = true;
          used.inputTokens += usage.inputTokens;
          used.outputTokens += usage.outputTokens;
        }
        return result;
      },
    };

    const run = await startWorkflowRun(
      {
        orchestrationId: args.orchestrationId,
        orgId,
        input: args.input,
        ...(args.prompt !== undefined && { prompt: args.prompt }),
        // A publisher's test run has no job row to point at.
        ...(job.testRun
          ? { triggeredBy: "manual" as const }
          : { triggeredBy: "job" as const, triggeredById: job.id, jobId: job.id }),
      },
      buildStartWorkflowRunDeps({
        prisma: surface,
        // Run below, in this worker, not by the workflow queue.
        enqueue: async () => {},
        runnerEnabled: true,
        // The offering's own capacity bounds a publisher's jobs; the cap on
        // an organization's interactive runs is not a reason to fail a job.
        maxActiveRunsPerOrg: Number.MAX_SAFE_INTEGER,
      }),
    );
    if (!job.testRun) {
      await prisma.job
        .updateMany({ where: { id: job.id, status: "running" }, data: { orchestrationExecutionId: run.id } })
        .catch((err: unknown) =>
          logger.error({ err, jobId: job.id }, "Could not link the workflow run to its job"),
        );
    }

    const outcome = await runWorkflowExecutionJob(
      { executionId: run.id, shutdownSignal: args.signal },
      buildWorkflowExecutionJobDeps({
        prisma: surface,
        engineBindings: (claimed) =>
          buildOrchestrationExecutorDeps(
            claimed.id,
            { executor: watched, chatWithDeployment },
            {
              mode: "hired",
              instructions: args.systemAddendum,
              ...(args.toolAllowlist.length > 0 && { toolAllowlist: args.toolAllowlist }),
            },
          ),
        emitEvent: async (eventOrgId, type, data) => {
          await triggerWebhook(eventOrgId, type, data, "orchestration", String(data.orchestrationId));
        },
        capabilities: { modelSteps: modelStepCapability() },
        onSideEffectError: (what, err) => logger.error({ err, what }, "Workflow run bookkeeping failed"),
      }),
    );
    if (outcome.status !== "completed") {
      throw new Error(
        outcome.status === "skipped" || outcome.status === "superseded"
          ? "the workflow run was taken over or removed before it finished"
          : (outcome.error ?? `the workflow run ${outcome.status}`),
      );
    }

    const row = await prisma.orchestrationExecution.findUnique({
      where: { id: run.id },
      select: {
        output: true,
        context: true,
        orchestration: { select: { steps: { orderBy: { stepOrder: "asc" }, select: { name: true } } } },
      },
    });
    const content = row
      ? workflowAnswerText({
          output: row.output,
          context: row.context,
          stepOrder: row.orchestration.steps.map((step) => step.name),
        })
      : null;
    return {
      content: content ?? "",
      platformUsage: usedPlatform ? used : null,
      confidential,
      orchestrationExecutionId: run.id,
    };
  };

  return {
    loadJob: async (jobId) => {
      const row = (await prisma.job.findUnique({ where: { id: jobId }, select: JOB_FOR_RUN_SELECT })) as
        | (Omit<JobForRun, "terms" | "offering"> & {
            terms: unknown;
            offering: JobForRun["offering"] & { inputOrder?: string[] | null };
          })
        | null;
      if (!row) return null;
      const terms = typeof row.terms === "object" && row.terms !== null ? (row.terms as Partial<JobTerms>) : {};
      // JSONB does not keep the order of the form's questions; the brief is
      // rendered in the schema's order, so it is put back here.
      const { inputOrder, ...offering } = row.offering;
      return {
        ...row,
        terms,
        offering: { ...offering, inputSchema: withSchemaOrder(offering.inputSchema, inputOrder ?? []) },
      };
    },

    inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as EscrowTx)),

    runAgent: async ({ job, agentId, brief, systemAddendum, toolAllowlist, signal }): Promise<ProductRun> => {
      // In the publisher's organization: an agent that left it is "gone".
      const agent = await executor.loadAgent(agentId, job.publisherId);
      if (!agent) throw new Error("the offering's agent no longer exists in the publisher's organization");
      const result = await executor.runAgentChat({
        agent,
        prompt: brief,
        mode: "hired",
        signal,
        systemAddendum,
        ...(toolAllowlist.length > 0 && { toolAllowlist }),
      });
      return {
        content: result.content,
        platformUsage: platformUsageOf(result, brief.length + systemAddendum.length),
        confidential: [agent.systemPrompt],
      };
    },

    runWorkflow: overrides.runWorkflow ?? runWorkflow,

    runModel: async ({ job, deploymentId, brief, systemAddendum, signal }): Promise<ProductRun> => {
      // Org-scoped inside; billed by the deployment's own rules to its owner.
      const result = await chatWithDeployment({
        orgId: job.publisherId,
        deploymentId,
        messages: [
          { role: "system", content: systemAddendum },
          { role: "user", content: brief },
        ],
        signal,
      });
      return { content: result.content, platformUsage: null, confidential: [] };
    },

    notify: async (event, jobId) => {
      await notify(event, jobId).catch((err: unknown) =>
        logger.error({ err, event, jobId }, "Job notification failed"),
      );
    },

    maxRunMs: overrides.maxRunMs ?? env.JOB_MAX_RUN_MS,
    platformModelRates: overrides.platformModelRates ?? {
      inputCentsPerMTok: env.JOB_PLATFORM_MODEL_INPUT_CENTS_PER_MTOK,
      outputCentsPerMTok: env.JOB_PLATFORM_MODEL_OUTPUT_CENTS_PER_MTOK,
    },
  };
}
