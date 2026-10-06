/**
 * Composition root for the task types that need more than a model call
 * or a fetch: binds each pure executor in this folder to Prisma and the
 * existing services.
 *
 * The rule for every query here: it carries the organization (and the
 * agent, when the task has one) in its own WHERE clause. No executor is
 * trusted to have checked first.
 *
 * A health check's "restart the deployment" is the deployments route's own
 * restart (services/modelDeploymentLifecycle.ts): the same run-generation
 * claim, vault check, hold refund and fresh reservation, so a task cannot
 * restart a deployment on easier terms than its owner can by hand. Its terms
 * are harder: asked for as `automatic`, it refuses a deployment the owner
 * stopped, and the health check limits how often it is asked at all.
 */

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { resolveEmbeddingConfig } from "../../config/embeddings.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import type { UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { buildUptimeProberTickDeps } from "../buildUptimeProberTickDeps.js";
import { isEmailConfigured, sendEmail } from "../email/emailService.js";
import type {
  ExecuteScheduledTaskDeps,
  ScheduledTaskTypeDeps,
} from "../executeScheduledTask.js";
import { addDocument, deleteDocument } from "../knowledge.js";
import { OWNER_STOP_REASON, restartDeploymentForOrg } from "../modelDeploymentLifecycle.js";
import { recordUptimeEvent } from "../monitoring.js";
import { runAgentGraph } from "../runAgentGraph.js";
import type { TaskTypeCapabilities } from "../scheduledTaskTypes.js";
import { triggerWebhook } from "../webhooks.js";
import type { CleanupScope } from "./cleanup.js";
import type { HealthCheckDeps, ProbeSpec } from "./healthCheck.js";
import type { ReportWindow } from "./report.js";
import { buildReportDelivery } from "./reportDelivery.js";

/** Org-scoped; a refusal (no credits, quota, a lost race) throws with its reason. */
const DEPLOYMENT_RESTART: HealthCheckDeps["restartDeployment"] = restartDeploymentForOrg;

/** What this server can do, for the catalogue and for saving a task. */
export function productionTaskTypeCapabilities(): TaskTypeCapabilities {
  return {
    workflowRunnerEnabled: env.WORKFLOW_RUN_CONCURRENCY > 0,
    emailConfigured: isEmailConfigured(),
    deploymentRestartAvailable: DEPLOYMENT_RESTART !== null,
  };
}

const FINISHED_TASK_STATUSES = ["success", "failed", "cancelled", "timeout"];
const FINISHED_RUN_STATUSES = ["completed", "failed", "cancelled"];
const FINISHED_GRAPH_STATUSES = ["completed", "failed"];

function conversationScope(scope: CleanupScope): Prisma.ConversationWhereInput {
  return { orgId: scope.orgId, ...(scope.agentId ? { agentId: scope.agentId } : {}) };
}

/** The model deployments an agent's usage is recorded against. */
async function agentDeploymentIds(agentId: string, orgId: string): Promise<string[]> {
  const rows = await prisma.agentDeployment.findMany({
    where: { agentId, agent: { orgId } },
    select: { modelDeploymentId: true },
  });
  return Array.from(
    new Set(rows.map((r) => r.modelDeploymentId).filter((id): id is string => !!id)),
  );
}

async function usageWhere(window: ReportWindow): Promise<Prisma.UsageRecordWhereInput | null> {
  const where: Prisma.UsageRecordWhereInput = {
    orgId: window.orgId,
    periodStart: { gte: window.since, lte: window.until },
  };
  if (!window.agentId) return where;
  const deploymentIds = await agentDeploymentIds(window.agentId, window.orgId);
  // An agent on an external or free model has no deployment to meter.
  return deploymentIds.length === 0 ? null : { ...where, deploymentId: { in: deploymentIds } };
}

export interface BuildScheduledTaskTypeDepsInput {
  /** The shared executor's agent loader and chat, for report summaries. */
  executor: Pick<ExecuteScheduledTaskDeps, "loadAgent" | "runAgentChat">;
  fetchFn?: typeof fetch;
  guardDeps?: UrlGuardDeps;
}

export function buildScheduledTaskTypeDeps(
  input: BuildScheduledTaskTypeDepsInput,
): ScheduledTaskTypeDeps {
  const fetchFn = input.fetchFn ?? fetch;
  // The uptime prober's own target resolution and probe (SSRF-guarded,
  // classifying, never throwing), so a health check and an uptime monitor
  // cannot disagree about what "up" means.
  const uptime = buildUptimeProberTickDeps({ fetchFn, guardDeps: input.guardDeps });
  const resolveTarget = (targetType: string, targetId: string) =>
    uptime.resolveTargetUrl({
      id: targetId,
      targetType,
      targetId,
      targetUrl: null,
      timeoutSeconds: 10,
      httpMethod: "GET",
      expectedStatus: 200,
      expectedBody: null,
      headers: null,
    });
  const delivery = buildReportDelivery({ fetchFn, guardDeps: input.guardDeps, sendEmail });

  return {
    dataSync: {
      loadAgentKnowledgeBaseId: async (agentId, orgId) => {
        const agent = await prisma.agent.findFirst({
          where: { id: agentId, orgId },
          select: { knowledgeBaseId: true },
        });
        return agent?.knowledgeBaseId ?? null;
      },
      loadKnowledgeBase: (id, orgId) =>
        prisma.knowledgeBase.findFirst({ where: { id, orgId }, select: { id: true } }),
      findDocumentBySource: async (knowledgeBaseId, sourceUrl) => {
        const doc = await prisma.knowledgeDocument.findFirst({
          where: { knowledgeBaseId, sourceUrl },
          orderBy: { createdAt: "desc" },
          select: { id: true, metadata: true },
        });
        if (!doc) return null;
        const hash = (doc.metadata as { contentHash?: unknown } | null)?.contentHash;
        return { id: doc.id, contentHash: typeof hash === "string" ? hash : null };
      },
      addDocument: async (knowledgeBaseId, orgId, doc) => {
        const added = await addDocument(knowledgeBaseId, orgId, {
          title: doc.title,
          content: doc.content,
          sourceType: "url",
          sourceUrl: doc.sourceUrl,
          mimeType: doc.mimeType,
          metadata: doc.metadata,
        });
        return { id: added.id, chunkCount: added.chunkCount };
      },
      deleteDocument: async (documentId, knowledgeBaseId, orgId) => {
        await deleteDocument(documentId, knowledgeBaseId, orgId);
      },
      embeddingMode: () => (resolveEmbeddingConfig() ? "semantic" : "keyword"),
      hash: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
      fetchFn,
      guardDeps: input.guardDeps,
    },

    healthCheck: {
      loadDeployment: async (deploymentId, orgId) => {
        const row = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
          select: {
            id: true,
            status: true,
            statusReason: true,
            autoRestartCount: true,
            lastAutoRestartAt: true,
          },
        });
        if (!row) return null;
        return {
          id: row.id,
          status: row.status,
          stoppedByOwner: row.statusReason === OWNER_STOP_REASON,
          healthUrl: await resolveTarget("deployment", row.id),
          autoRestarts: { count: row.autoRestartCount, lastAt: row.lastAutoRestartAt },
        };
      },
      loadAgentRuntime: async (agentId, orgId) => {
        const agent = await prisma.agent.findFirst({
          where: { id: agentId, orgId },
          select: { id: true },
        });
        if (!agent) return null;
        return { healthUrl: await resolveTarget("agent", agent.id) };
      },
      loadMonitor: async (monitorId, orgId) => {
        const monitor = await prisma.uptimeMonitor.findFirst({
          where: { id: monitorId, orgId },
          select: {
            id: true,
            targetType: true,
            targetId: true,
            targetUrl: true,
            timeoutSeconds: true,
            httpMethod: true,
            expectedStatus: true,
            expectedBody: true,
            headers: true,
          },
        });
        if (!monitor) return null;
        return {
          id: monitor.id,
          url: await uptime.resolveTargetUrl(monitor),
          timeoutSeconds: monitor.timeoutSeconds,
          httpMethod: monitor.httpMethod,
          expectedStatus: monitor.expectedStatus,
          expectedBody: monitor.expectedBody,
          headers: monitor.headers,
        };
      },
      probe: (spec: ProbeSpec, url) =>
        uptime.probe(
          {
            id: "health-check",
            targetType: "custom_url",
            targetId: null,
            targetUrl: url,
            timeoutSeconds: spec.timeoutSeconds,
            httpMethod: spec.httpMethod,
            expectedStatus: spec.expectedStatus,
            expectedBody: spec.expectedBody,
            headers: spec.headers,
          },
          url,
        ),
      recordUptimeEvent: (monitorId, result) => recordUptimeEvent(monitorId, result),
      restartDeployment: DEPLOYMENT_RESTART,
      claimAutoRestart: async (deploymentId, orgId, expected, next) => {
        const claimed = await prisma.deployment.updateMany({
          where: {
            id: deploymentId,
            orgId,
            autoRestartCount: expected.count,
            lastAutoRestartAt: expected.lastAt,
          },
          data: { autoRestartCount: next.count, lastAutoRestartAt: next.lastAt },
        });
        return claimed.count === 1;
      },
    },

    report: {
      loadUsage: async (window) => {
        const where = await usageWhere(window);
        if (!where) return null;
        const usage = await prisma.usageRecord.aggregate({
          where,
          _count: { _all: true },
          _sum: {
            requestCount: true,
            inputTokens: true,
            outputTokens: true,
            costCents: true,
            errorCount: true,
            totalLatencyMs: true,
          },
        });
        if (usage._count._all === 0) return null;
        const requests = usage._sum.requestCount ?? 0;
        return {
          requests,
          inputTokens: Number(usage._sum.inputTokens ?? 0n),
          outputTokens: Number(usage._sum.outputTokens ?? 0n),
          costCents: Number(usage._sum.costCents ?? 0n),
          errors: usage._sum.errorCount ?? 0,
          avgLatencyMs:
            requests > 0 ? Math.round(Number(usage._sum.totalLatencyMs ?? 0n) / requests) : 0,
        };
      },

      loadCostByModel: async (window) => {
        const where = await usageWhere(window);
        if (!where) return null;
        const byDeployment = await prisma.usageRecord.groupBy({
          by: ["deploymentId"],
          where,
          _sum: { costCents: true, requestCount: true },
        });
        if (byDeployment.length === 0) return null;
        const deployments = await prisma.deployment.findMany({
          where: { orgId: window.orgId, id: { in: byDeployment.map((r) => r.deploymentId) } },
          select: { id: true, modelId: true },
        });
        const modelOf = new Map(deployments.map((d) => [d.id, d.modelId]));
        const byModel = new Map<string, { costCents: number; requests: number }>();
        for (const row of byDeployment) {
          const modelId = modelOf.get(row.deploymentId) ?? "unknown";
          const entry = byModel.get(modelId) ?? { costCents: 0, requests: 0 };
          entry.costCents += Number(row._sum.costCents ?? 0n);
          entry.requests += row._sum.requestCount ?? 0;
          byModel.set(modelId, entry);
        }
        return Array.from(byModel, ([modelId, totals]) => ({ modelId, ...totals })).sort(
          (a, b) => b.costCents - a.costCents,
        );
      },

      loadRuns: async (window) => {
        const created = { gte: window.since, lte: window.until };
        const agentFilter = window.agentId ? { agentId: window.agentId } : {};
        const [tasks, workflows, graphs] = await Promise.all([
          prisma.taskExecution.groupBy({
            by: ["status"],
            where: { task: { orgId: window.orgId, ...agentFilter }, createdAt: created },
            _count: { _all: true },
          }),
          window.agentId
            ? Promise.resolve(null)
            : prisma.orchestrationExecution.groupBy({
                by: ["status"],
                where: { orchestration: { orgId: window.orgId }, createdAt: created },
                _count: { _all: true },
              }),
          prisma.agentGraphExecution.groupBy({
            by: ["status"],
            where: {
              graph: { agent: { orgId: window.orgId, ...(window.agentId ? { id: window.agentId } : {}) } },
              startedAt: created,
            },
            _count: { _all: true },
          }),
        ]);
        const tally = (rows: Array<{ status: string; _count: { _all: number } }>) => {
          const of = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
          return { total: rows.reduce((sum, r) => sum + r._count._all, 0), of };
        };
        const t = tally(tasks);
        const w = workflows ? tally(workflows) : null;
        const g = tally(graphs);
        if (t.total + (w?.total ?? 0) + g.total === 0) return null;
        return {
          scheduledTasks: { total: t.total, success: t.of("success"), failed: t.of("failed") },
          workflows: w
            ? { total: w.total, completed: w.of("completed"), failed: w.of("failed") }
            : null,
          graphs: { total: g.total, completed: g.of("completed"), failed: g.of("failed") },
        };
      },

      loadConversations: async (window) => {
        const scope: Prisma.ConversationWhereInput = {
          orgId: window.orgId,
          ...(window.agentId ? { agentId: window.agentId } : {}),
        };
        const [conversations, messages] = await Promise.all([
          prisma.conversation.count({
            where: {
              ...scope,
              OR: [
                { lastMessageAt: { gte: window.since } },
                { createdAt: { gte: window.since } },
              ],
            },
          }),
          prisma.message.aggregate({
            where: { conversation: scope, createdAt: { gte: window.since, lte: window.until } },
            _count: { _all: true },
            _sum: { tokens: true },
          }),
        ]);
        if (conversations === 0 && messages._count._all === 0) return null;
        return {
          conversations,
          messages: messages._count._all,
          tokens: messages._sum.tokens ?? 0,
        };
      },

      loadRevenue: async (window) => {
        const where: Prisma.MarketplaceRevenueWhereInput = {
          publisherId: window.orgId,
          createdAt: { gte: window.since, lte: window.until },
        };
        if (window.agentId) {
          const listing = await prisma.agentListing.findFirst({
            where: { agentId: window.agentId, agent: { orgId: window.orgId } },
            select: { id: true },
          });
          if (!listing) return null;
          where.listingId = listing.id;
        }
        const rows = await prisma.marketplaceRevenue.groupBy({
          by: ["status"],
          where,
          _sum: { creatorAmountCents: true, requestCount: true },
        });
        if (rows.length === 0) return null;
        const cents = (status: string) =>
          Number(rows.find((r) => r.status === status)?._sum.creatorAmountCents ?? 0n);
        return {
          settledCents: cents("settled"),
          pendingCents: cents("pending"),
          refundedCents: cents("refunded"),
          requests: rows.reduce((sum, r) => sum + (r._sum.requestCount ?? 0), 0),
        };
      },

      summarize: async ({ agentId, orgId, prompt, signal }) => {
        const agent = await input.executor.loadAgent(agentId, orgId);
        if (!agent) throw new Error("agent not found in this organization");
        const reply = await input.executor.runAgentChat({ agent, prompt, mode: "scheduled", signal });
        return reply.content;
      },

      emitReportEvent: async (orgId, data) => {
        await triggerWebhook(orgId, "report.generated", data);
      },

      loadAlertChannel: (channelId, orgId) =>
        prisma.alertChannel.findFirst({
          where: { id: channelId, orgId },
          select: { id: true, name: true, type: true, isEnabled: true, config: true },
        }),
      emailConfigured: isEmailConfigured,
      sendToChannel: delivery.sendToChannel,
      sendEmail: delivery.sendEmail,
    },

    cleanup: {
      loadAgent: (agentId, orgId) =>
        prisma.agent.findFirst({ where: { id: agentId, orgId }, select: { id: true } }),

      archiveConversations: async ({ scope, idleBefore, dryRun }) => {
        const where: Prisma.ConversationWhereInput = {
          ...conversationScope(scope),
          status: "active",
          OR: [
            { lastMessageAt: { lt: idleBefore } },
            { lastMessageAt: null, createdAt: { lt: idleBefore } },
          ],
        };
        if (dryRun) return prisma.conversation.count({ where });
        return (await prisma.conversation.updateMany({ where, data: { status: "archived" } })).count;
      },

      deleteArchivedConversations: async ({ scope, archivedBefore, dryRun }) => {
        // Archiving is the conversation's last write, so updatedAt is
        // when it was archived.
        const where: Prisma.ConversationWhereInput = {
          ...conversationScope(scope),
          status: "archived",
          updatedAt: { lt: archivedBefore },
        };
        if (dryRun) return prisma.conversation.count({ where });
        return (await prisma.conversation.deleteMany({ where })).count;
      },

      decayMemory: async ({ scope, staleBefore, factor, minImportance, deactivateBelow, dryRun }) => {
        const stale: Prisma.MemoryContextWhereInput = {
          isActive: true,
          conversation: conversationScope(scope),
          OR: [
            { lastAccessedAt: { lt: staleBefore } },
            { lastAccessedAt: null, createdAt: { lt: staleBefore } },
          ],
        };
        // importance * factor would fall under the floor exactly when
        // importance <= floor / factor; those rows land ON the floor.
        const clampAt = minImportance / factor;
        const toFloor = { ...stale, importance: { gt: minImportance, lte: clampAt } };
        const toScale = { ...stale, importance: { gt: clampAt } };
        const below =
          deactivateBelow === null
            ? null
            : {
                isActive: true,
                conversation: conversationScope(scope),
                importance: { lt: deactivateBelow },
              };

        if (dryRun) {
          const [floored, scaled, deactivated] = await Promise.all([
            prisma.memoryContext.count({ where: toFloor }),
            prisma.memoryContext.count({ where: toScale }),
            // Counted on today's importance: a dry run does not apply the
            // decay, so memories the decay would push under the threshold
            // are not included.
            below ? prisma.memoryContext.count({ where: below }) : Promise.resolve(0),
          ]);
          return { decayed: floored + scaled, deactivated };
        }
        // Floor first: once the others are scaled, some of them would
        // match the floor range too and be counted (and clamped) twice.
        const floored = await prisma.memoryContext.updateMany({
          where: toFloor,
          data: { importance: minImportance },
        });
        const scaled = await prisma.memoryContext.updateMany({
          where: toScale,
          data: { importance: { multiply: factor } },
        });
        const deactivated = below
          ? await prisma.memoryContext.updateMany({ where: below, data: { isActive: false } })
          : { count: 0 };
        return { decayed: floored.count + scaled.count, deactivated: deactivated.count };
      },

      pruneRunHistory: async ({ scope, finishedBefore, dryRun }) => {
        const taskWhere: Prisma.TaskExecutionWhereInput = {
          task: { orgId: scope.orgId, ...(scope.agentId ? { agentId: scope.agentId } : {}) },
          status: { in: FINISHED_TASK_STATUSES },
          completedAt: { lt: finishedBefore },
        };
        // A workflow run belongs to no single agent, so an agent-scoped
        // cleanup leaves workflow runs alone. A run that delivered a
        // marketplace job is that job's record and is never pruned.
        const runWhere: Prisma.OrchestrationExecutionWhereInput | null = scope.agentId
          ? null
          : {
              orchestration: { orgId: scope.orgId },
              status: { in: FINISHED_RUN_STATUSES },
              completedAt: { lt: finishedBefore },
              jobId: null,
            };
        const graphWhere: Prisma.AgentGraphExecutionWhereInput = {
          graph: { agent: { orgId: scope.orgId, ...(scope.agentId ? { id: scope.agentId } : {}) } },
          status: { in: FINISHED_GRAPH_STATUSES },
          completedAt: { lt: finishedBefore },
        };

        if (dryRun) {
          const [taskExecutions, workflowRuns, graphRuns] = await Promise.all([
            prisma.taskExecution.count({ where: taskWhere }),
            runWhere ? prisma.orchestrationExecution.count({ where: runWhere }) : Promise.resolve(0),
            prisma.agentGraphExecution.count({ where: graphWhere }),
          ]);
          return { taskExecutions, workflowRuns, graphRuns };
        }
        const taskExecutions = await prisma.taskExecution.deleteMany({ where: taskWhere });
        const workflowRuns = runWhere
          ? await prisma.orchestrationExecution.deleteMany({ where: runWhere })
          : { count: 0 };
        const graphRuns = await prisma.agentGraphExecution.deleteMany({ where: graphWhere });
        return {
          taskExecutions: taskExecutions.count,
          workflowRuns: workflowRuns.count,
          graphRuns: graphRuns.count,
        };
      },
    },

    graphRun: {
      runGraph: (agentId, orgId, graphInput, options) =>
        runAgentGraph(agentId, orgId, graphInput, options),
    },

    workflowRun: {
      startRun: async (args) => {
        // Imported lazily: orchestration.ts reaches the shared executor,
        // which reaches this file.
        const { startOrchestrationRun } = await import("../orchestration.js");
        return startOrchestrationRun({
          orchestrationId: args.orchestrationId,
          orgId: args.orgId,
          prompt: args.prompt,
          input: args.input,
          triggeredBy: args.triggeredBy,
          scheduledTaskId: args.scheduledTaskId,
          taskExecutionId: args.taskExecutionId,
        });
      },
      linkExecution: async (taskExecutionId, orchestrationExecutionId) => {
        await prisma.taskExecution.updateMany({
          where: { id: taskExecutionId },
          data: { orchestrationExecutionId },
        });
      },
    },
  };
}
