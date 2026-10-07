/**
 * The scheduled-task type registry: one entry per task type the scheduler
 * can run, and the single source for three things that used to disagree.
 *
 *   validation  the payload schema and the agent / workflow rule a task
 *               is checked against when it is saved
 *   dispatch    which executor runs it (executeScheduledTask.ts)
 *   catalogue   what GET /api/scheduler/task-types tells the dashboard
 *
 * The dashboard once offered six types while the executor ran two. A type
 * is now offered only by being registered here, and a type or option
 * that cannot work on this server (no workflow worker, no email provider,
 * no deployment-restart service) is still LISTED, marked unavailable with
 * the reason, and refused when a task that needs it is saved. Nothing is
 * hidden and nothing pretends.
 *
 * Pure: what the server has configured arrives as TaskTypeCapabilities.
 */

import { z } from "zod";

import { validateSchedule, type ScheduleRefusalReason } from "./scheduleCalc.js";

export const TASK_TYPE_IDS = [
  "agent_run",
  "inference",
  "webhook",
  "data_sync",
  "health_check",
  "report",
  "cleanup",
  "custom",
  "workflow_run",
] as const;
export type TaskTypeId = (typeof TASK_TYPE_IDS)[number];

/** What this server can actually do; decided by the composition root. */
export interface TaskTypeCapabilities {
  /** A worker picks up workflow runs (WORKFLOW_RUN_CONCURRENCY > 0). */
  workflowRunnerEnabled: boolean;
  /** An email provider is configured, so reports can go to email channels. */
  emailConfigured: boolean;
  /** A service exists that restarts a model deployment with its billing rules. */
  deploymentRestartAvailable: boolean;
}

export const RESTART_UNAVAILABLE_REASON =
  "restarting a deployment from a health check is unavailable right now; record the failure instead";
export const EMAIL_UNAVAILABLE_REASON =
  "email delivery is unavailable right now, so a report cannot be sent to an email channel";
export const WORKFLOW_RUNNER_UNAVAILABLE_REASON =
  "workflow runs are temporarily unavailable";

export interface TaskFieldOption {
  value: string;
  label: string;
  available: boolean;
  reason?: string;
}

/** One input of a task type's form; `key` is a path inside the payload. */
export interface TaskField {
  key: string;
  label: string;
  kind:
    | "text"
    | "textarea"
    | "url"
    | "number"
    | "boolean"
    | "select"
    | "json"
    | "headers"
    | "sources"
    | "knowledge_base"
    | "deployment"
    | "monitor"
    | "alert_channel";
  required: boolean;
  min?: number;
  max?: number;
  help?: string;
  options?: TaskFieldOption[];
  /** Shown only while another field has one of these values. */
  showWhen?: { key: string; in: string[] };
}

export type AgentRule = "required" | "optional" | "none";

export interface TaskTypeDefinition {
  type: TaskTypeId;
  label: string;
  description: string;
  agent: AgentRule;
  /** The task runs a workflow and needs orchestrationId. */
  orchestration: boolean;
  /** Another worker finishes the execution; the scheduler only starts it. */
  deferred: boolean;
  /** Whether a failed attempt may be retried (maxRetries). */
  retryable: boolean;
  /** Set on a type kept only so older tasks and API callers keep working. */
  aliasOf?: TaskTypeId;
  payload: z.ZodTypeAny;
  fields: (caps: TaskTypeCapabilities) => TaskField[];
  availability?: (caps: TaskTypeCapabilities) => { available: boolean; reason?: string };
}

// ---------------------------------------------------------------------------
// Payload schemas. Strict: an unknown key is a mistake the owner should
// hear about when saving, not a setting that silently does nothing.
// ---------------------------------------------------------------------------

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), { message: "must be an http or https URL" });

const agentRunPayload = z.object({ prompt: z.string().trim().min(1).max(20_000) }).strict();

const webhookPayload = z
  .object({
    url: httpUrl,
    body: z.unknown().optional(),
    headers: z.record(z.string().max(4096)).optional(),
  })
  .strict();

const dataSyncPayload = z
  .object({
    knowledgeBaseId: z.string().uuid().optional(),
    sources: z
      .array(z.object({ url: httpUrl, title: z.string().trim().min(1).max(200).optional() }).strict())
      .min(1)
      .max(10),
    maxBytes: z.number().int().min(1024).max(2_000_000).optional(),
  })
  .strict();

const healthCheckPayload = z
  .object({
    target: z.enum(["agent", "deployment", "url", "monitor"]),
    deploymentId: z.string().uuid().optional(),
    url: httpUrl.optional(),
    monitorId: z.string().uuid().optional(),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    expectedBody: z.string().min(1).max(500).optional(),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
    onDown: z.enum(["none", "restart_deployment"]).default("none"),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const needs = { deployment: "deploymentId", url: "url", monitor: "monitorId" } as const;
    if (payload.target !== "agent") {
      const field = needs[payload.target];
      if (payload[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `a ${payload.target} health check needs ${field}`,
        });
      }
    }
    if (payload.onDown === "restart_deployment" && payload.target !== "deployment") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["onDown"],
        message: "restart_deployment applies only when the target is a deployment",
      });
    }
  });

const reportPayload = z
  .object({
    periodDays: z.number().int().min(1).max(90).default(7),
    scope: z.enum(["agent", "org"]).default("org"),
    summarize: z.boolean().optional(),
    deliver: z
      .object({
        webhookEvent: z.boolean().optional(),
        alertChannelId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const cleanupPayload = z
  .object({
    // The floors are product policy: a conversation is archived after at
    // least a day and deleted after at least a week, so one mistyped
    // number cannot erase live conversations.
    archiveConversationsOlderThanDays: z.number().int().min(1).max(3650).optional(),
    deleteArchivedOlderThanDays: z.number().int().min(7).max(3650).optional(),
    memoryDecay: z
      .object({
        factor: z.number().min(0.5).max(0.99),
        minImportance: z.number().min(0).max(1),
        deactivateBelow: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    pruneRunHistoryOlderThanDays: z.number().int().min(7).max(3650).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (cleanupOperations(payload).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          "choose at least one operation: archiveConversationsOlderThanDays, deleteArchivedOlderThanDays, memoryDecay or pruneRunHistoryOlderThanDays",
      });
    }
  });

const customPayload = z.object({ input: z.string().max(20_000).default("") }).strict();

const workflowRunPayload = z
  .object({
    prompt: z.string().max(20_000).optional(),
    input: z.record(z.unknown()).optional(),
  })
  .strict();

export type WebhookPayload = z.infer<typeof webhookPayload>;
export type DataSyncPayload = z.infer<typeof dataSyncPayload>;
export type HealthCheckPayload = z.infer<typeof healthCheckPayload>;
export type ReportPayload = z.infer<typeof reportPayload>;
export type CleanupPayload = z.infer<typeof cleanupPayload>;
export type CustomPayload = z.infer<typeof customPayload>;
export type WorkflowRunPayload = z.infer<typeof workflowRunPayload>;

export const CLEANUP_OPERATIONS = [
  "archiveConversationsOlderThanDays",
  "deleteArchivedOlderThanDays",
  "memoryDecay",
  "pruneRunHistoryOlderThanDays",
] as const;

export function cleanupOperations(payload: Record<string, unknown>): string[] {
  return CLEANUP_OPERATIONS.filter((key) => payload[key] !== undefined && payload[key] !== null);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const promptField: TaskField = {
  key: "prompt",
  label: "Prompt",
  kind: "textarea",
  required: true,
  max: 20_000,
  help: "Sent to the agent as the user message each time the task fires.",
};

const agentRun: TaskTypeDefinition = {
  type: "agent_run",
  label: "Agent run",
  description: "Sends a prompt to an agent and records its reply.",
  agent: "required",
  orchestration: false,
  deferred: false,
  retryable: true,
  payload: agentRunPayload,
  fields: () => [promptField],
};

const DEFINITIONS: TaskTypeDefinition[] = [
  agentRun,
  {
    ...agentRun,
    type: "inference",
    label: "Inference",
    description: "The earlier name for an agent run; behaves identically.",
    aliasOf: "agent_run",
  },
  {
    type: "workflow_run",
    label: "Workflow run",
    description:
      "Starts a run of one of your workflows. The run is queued and finishes on the workflow worker; this task's execution follows its outcome.",
    agent: "none",
    orchestration: true,
    deferred: true,
    // A workflow has its own retry policy per step; re-running the whole
    // workflow would re-bill every step that already succeeded.
    retryable: false,
    payload: workflowRunPayload,
    fields: () => [
      { key: "prompt", label: "Prompt", kind: "textarea", required: false, max: 20_000, help: "Becomes input.prompt for the run." },
      { key: "input", label: "Input (JSON)", kind: "json", required: false, help: "Merged into the run input; checked against the workflow's input schema." },
    ],
    availability: (caps) =>
      caps.workflowRunnerEnabled
        ? { available: true }
        : { available: false, reason: WORKFLOW_RUNNER_UNAVAILABLE_REASON },
  },
  {
    type: "webhook",
    label: "Webhook",
    description:
      "POSTs a JSON body to a URL. The body carries taskId, executionId and attempt so a receiver can drop duplicates.",
    agent: "none",
    orchestration: false,
    deferred: false,
    retryable: true,
    payload: webhookPayload,
    fields: () => [
      { key: "url", label: "URL", kind: "url", required: true, max: 2048, help: "Public http or https address. Redirects are not followed." },
      { key: "body", label: "Body (JSON)", kind: "json", required: false },
      { key: "headers", label: "Headers", kind: "headers", required: false },
    ],
  },
  {
    type: "data_sync",
    label: "Data sync",
    description:
      "Fetches up to ten web pages or text documents and keeps a knowledge base in step with them: new content is added, changed content replaces the old document, unchanged content is left alone.",
    agent: "optional",
    orchestration: false,
    deferred: false,
    retryable: true,
    payload: dataSyncPayload,
    fields: () => [
      { key: "knowledgeBaseId", label: "Knowledge base", kind: "knowledge_base", required: false, help: "Defaults to the selected agent's knowledge base." },
      { key: "sources", label: "Sources", kind: "sources", required: true, min: 1, max: 10, help: "Public URLs returning HTML, text or JSON." },
      { key: "maxBytes", label: "Largest document (bytes)", kind: "number", required: false, min: 1024, max: 2_000_000, help: "A larger source fails instead of being cut." },
    ],
  },
  {
    type: "health_check",
    label: "Health check",
    description:
      "Probes an agent runtime, a model deployment, a URL or an uptime monitor's target. The task fails unless the target is up.",
    agent: "optional",
    orchestration: false,
    deferred: false,
    // The probe ran and gave its answer; a retry would only log it again.
    retryable: false,
    payload: healthCheckPayload,
    fields: (caps) => [
      {
        key: "target",
        label: "Target",
        kind: "select",
        required: true,
        options: [
          { value: "agent", label: "The selected agent's runtime", available: true },
          { value: "deployment", label: "A model deployment", available: true },
          { value: "url", label: "A URL", available: true },
          { value: "monitor", label: "An uptime monitor's target", available: true },
        ],
      },
      { key: "deploymentId", label: "Deployment", kind: "deployment", required: true, showWhen: { key: "target", in: ["deployment"] } },
      { key: "url", label: "URL", kind: "url", required: true, max: 2048, showWhen: { key: "target", in: ["url"] } },
      { key: "monitorId", label: "Uptime monitor", kind: "monitor", required: false, help: "Required for a monitor target. For other targets, the result is also recorded on this monitor." },
      { key: "expectedStatus", label: "Expected status", kind: "number", required: false, min: 100, max: 599 },
      { key: "expectedBody", label: "Expected text in the response", kind: "text", required: false, max: 500 },
      { key: "timeoutSeconds", label: "Timeout (seconds)", kind: "number", required: false, min: 1, max: 60 },
      {
        key: "onDown",
        label: "When the target is down",
        kind: "select",
        required: false,
        showWhen: { key: "target", in: ["deployment"] },
        options: [
          { value: "none", label: "Only record the failure", available: true },
          {
            value: "restart_deployment",
            label: "Restart the deployment if it failed or the platform stopped it (never one you stopped; at most 5 restarts a day)",
            available: caps.deploymentRestartAvailable,
            ...(caps.deploymentRestartAvailable ? {} : { reason: RESTART_UNAVAILABLE_REASON }),
          },
        ],
      },
    ],
  },
  {
    type: "report",
    label: "Report",
    description:
      "Builds a usage report for the organization or one agent (requests, cost by model, runs, conversations, marketplace revenue) and can deliver it to your webhooks or an alert channel.",
    agent: "optional",
    orchestration: false,
    deferred: false,
    retryable: true,
    payload: reportPayload,
    fields: (caps) => [
      { key: "periodDays", label: "Period (days)", kind: "number", required: false, min: 1, max: 90 },
      {
        key: "scope",
        label: "Scope",
        kind: "select",
        required: false,
        options: [
          { value: "org", label: "The whole organization", available: true },
          { value: "agent", label: "The selected agent", available: true },
        ],
      },
      { key: "summarize", label: "Have the selected agent write a summary", kind: "boolean", required: false, help: "Makes one model call per report, billed like any agent run." },
      { key: "deliver.webhookEvent", label: "Send a report.generated event to your webhooks", kind: "boolean", required: false },
      {
        key: "deliver.alertChannelId",
        label: "Alert channel",
        kind: "alert_channel",
        required: false,
        help: caps.emailConfigured
          ? "Slack, Discord, webhook or email channels."
          : `Slack, Discord or webhook channels. ${EMAIL_UNAVAILABLE_REASON}.`,
      },
    ],
  },
  {
    type: "cleanup",
    label: "Cleanup",
    description:
      "Archives old conversations, deletes long-archived ones, decays stale memories and prunes old run history, limited to this organization and, when an agent is selected, to that agent. A dry run only counts.",
    agent: "optional",
    orchestration: false,
    deferred: false,
    retryable: true,
    payload: cleanupPayload,
    fields: () => [
      { key: "archiveConversationsOlderThanDays", label: "Archive conversations idle for (days)", kind: "number", required: false, min: 1, max: 3650 },
      { key: "deleteArchivedOlderThanDays", label: "Delete conversations archived for (days)", kind: "number", required: false, min: 7, max: 3650, help: "Permanent. Messages and memories go with the conversation." },
      { key: "memoryDecay.factor", label: "Memory decay factor", kind: "number", required: false, min: 0.5, max: 0.99, help: "Importance of memories not read for a week is multiplied by this." },
      { key: "memoryDecay.minImportance", label: "Memory importance floor", kind: "number", required: false, min: 0, max: 1 },
      { key: "memoryDecay.deactivateBelow", label: "Deactivate memories below importance", kind: "number", required: false, min: 0, max: 1 },
      { key: "pruneRunHistoryOlderThanDays", label: "Delete run history older than (days)", kind: "number", required: false, min: 7, max: 3650, help: "Finished task executions, workflow runs and graph runs. Runs that delivered a marketplace job are kept." },
      { key: "dryRun", label: "Dry run (count only, change nothing)", kind: "boolean", required: false },
    ],
  },
  {
    type: "custom",
    label: "Custom (agent graph)",
    description:
      "Runs the graph you drew for the selected agent in the visual builder, with this input. The task fails when the graph run fails.",
    agent: "required",
    orchestration: false,
    deferred: false,
    retryable: true,
    payload: customPayload,
    fields: () => [
      { key: "input", label: "Input", kind: "textarea", required: false, max: 20_000, help: "Passed to the graph's input node." },
    ],
  },
];

const BY_TYPE = new Map<string, TaskTypeDefinition>(DEFINITIONS.map((d) => [d.type, d]));

export function getTaskType(type: string): TaskTypeDefinition | undefined {
  return BY_TYPE.get(type);
}

export function listTaskTypes(): TaskTypeDefinition[] {
  return DEFINITIONS;
}

export interface TaskTypeCatalogueEntry {
  type: TaskTypeId;
  label: string;
  description: string;
  agent: AgentRule;
  orchestration: boolean;
  deferred: boolean;
  retryable: boolean;
  aliasOf?: TaskTypeId;
  available: boolean;
  reason?: string;
  fields: TaskField[];
}

/** Every registered type, available or not. */
export function taskTypeCatalogue(caps: TaskTypeCapabilities): TaskTypeCatalogueEntry[] {
  return DEFINITIONS.map((def) => {
    const availability = def.availability?.(caps) ?? { available: true };
    return {
      type: def.type,
      label: def.label,
      description: def.description,
      agent: def.agent,
      orchestration: def.orchestration,
      deferred: def.deferred,
      retryable: def.retryable,
      ...(def.aliasOf ? { aliasOf: def.aliasOf } : {}),
      available: availability.available,
      ...(availability.reason ? { reason: availability.reason } : {}),
      fields: def.fields(caps),
    };
  });
}

// ---------------------------------------------------------------------------
// Saving a task
// ---------------------------------------------------------------------------

export interface TaskCandidate {
  taskType: string;
  agentId?: string | null;
  orchestrationId?: string | null;
  payload?: unknown;
  maxRetries?: number | null;
  scheduleType: string;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  scheduledAt?: string | Date | null;
  timezone?: string | null;
}

/** What the task points at, looked up in the caller's organization only. */
export interface TaskOwnershipLoader {
  agent: (id: string) => Promise<{ knowledgeBaseId: string | null } | null>;
  orchestration: (id: string) => Promise<{ id: string } | null>;
  knowledgeBase: (id: string) => Promise<{ id: string } | null>;
  deployment: (id: string) => Promise<{ id: string } | null>;
  monitor: (id: string) => Promise<{ id: string } | null>;
  alertChannel: (id: string) => Promise<{ type: string } | null>;
}

export type TaskRefusal =
  | {
      error: "validation_failed";
      message: string;
      details: { formErrors: string[]; fieldErrors: Record<string, string[]> };
    }
  | { error: "invalid_schedule"; reason: ScheduleRefusalReason; field: string; message: string }
  | { error: "invalid_task"; field: string; message: string };

export type TaskVerdict =
  | {
      ok: true;
      /** The payload with the type's defaults applied; what is stored. */
      payload: Record<string, unknown>;
      maxRetries: number;
      /** Null when the schedule was not part of the change being checked. */
      schedule: { nextRunAt: Date; scheduledAt: Date | null; timezone: string } | null;
    }
  | { ok: false; refusal: TaskRefusal };

const DEFAULT_MAX_RETRIES = 3;

function payloadIssues(error: z.ZodError): TaskRefusal {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = ["payload", ...issue.path].join(".");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return {
    error: "validation_failed",
    message: "The task payload is not valid for this task type",
    details: { formErrors: [], fieldErrors },
  };
}

const fieldProblem = (field: string, message: string): TaskRefusal => ({
  error: "validation_failed",
  message,
  details: { formErrors: [], fieldErrors: { [field]: [message] } },
});

const notInOrg = (field: string, what: string): TaskRefusal => ({
  error: "invalid_task",
  field,
  message: `${what} not found in this organization`,
});

/**
 * Checks a whole task the way it will be stored: type, payload, the agent
 * and workflow rules, every id it points at, the schedule. Used for
 * create and for the merged result of an update, so a PATCH cannot leave
 * a task its type could not have been created as.
 */
export async function validateTask(
  candidate: TaskCandidate,
  ctx: {
    now: Date;
    capabilities: TaskTypeCapabilities;
    owns: TaskOwnershipLoader;
    /** False when only non-schedule fields changed; the schedule is then not re-read. */
    checkSchedule?: boolean;
  },
): Promise<TaskVerdict> {
  const fail = (refusal: TaskRefusal): TaskVerdict => ({ ok: false, refusal });

  const def = getTaskType(candidate.taskType);
  if (!def) {
    return fail(
      fieldProblem(
        "taskType",
        `unknown task type "${candidate.taskType}"; one of: ${TASK_TYPE_IDS.join(", ")}`,
      ),
    );
  }
  const availability = def.availability?.(ctx.capabilities) ?? { available: true };
  if (!availability.available) {
    return fail(fieldProblem("taskType", availability.reason ?? "this task type is not available"));
  }

  const parsed = def.payload.safeParse(candidate.payload ?? {});
  if (!parsed.success) return fail(payloadIssues(parsed.error));
  const payload = parsed.data as Record<string, unknown>;

  if (def.agent === "required" && !candidate.agentId) {
    return fail({
      error: "invalid_task",
      field: "agentId",
      message: `task type "${def.type}" needs an agent`,
    });
  }
  if (def.orchestration && !candidate.orchestrationId) {
    return fail({
      error: "invalid_task",
      field: "orchestrationId",
      message: `task type "${def.type}" needs a workflow (orchestrationId)`,
    });
  }
  if (!def.orchestration && candidate.orchestrationId) {
    return fail({
      error: "invalid_task",
      field: "orchestrationId",
      message: `task type "${def.type}" does not run a workflow; use workflow_run`,
    });
  }

  const maxRetries = candidate.maxRetries ?? (def.retryable ? DEFAULT_MAX_RETRIES : 0);
  if (!def.retryable && maxRetries > 0) {
    return fail(
      fieldProblem(
        "maxRetries",
        `task type "${def.type}" is not retried; maxRetries must be 0`,
      ),
    );
  }

  let agent: { knowledgeBaseId: string | null } | null = null;
  if (candidate.agentId) {
    agent = await ctx.owns.agent(candidate.agentId);
    if (!agent) return fail(notInOrg("agentId", "agent"));
  }
  if (candidate.orchestrationId) {
    if (!(await ctx.owns.orchestration(candidate.orchestrationId))) {
      return fail(notInOrg("orchestrationId", "workflow"));
    }
  }

  const typed = await checkTypeRules(def.type, payload, { agent, hasAgent: !!candidate.agentId }, ctx);
  if (typed) return fail(typed);

  // The stored schedule stands when an update did not touch it: a one-off
  // task whose time has passed can still be renamed.
  if (ctx.checkSchedule === false) return { ok: true, payload, maxRetries, schedule: null };
  const schedule = validateSchedule(candidate, ctx.now);
  if (!schedule.ok) {
    return fail({
      error: "invalid_schedule",
      reason: schedule.reason,
      field: schedule.field,
      message: schedule.message,
    });
  }
  return {
    ok: true,
    payload,
    maxRetries,
    schedule: {
      nextRunAt: schedule.nextRunAt,
      scheduledAt: schedule.scheduledAt,
      timezone: schedule.timezone,
    },
  };
}

async function checkTypeRules(
  type: TaskTypeId,
  payload: Record<string, unknown>,
  task: { agent: { knowledgeBaseId: string | null } | null; hasAgent: boolean },
  ctx: { capabilities: TaskTypeCapabilities; owns: TaskOwnershipLoader },
): Promise<TaskRefusal | null> {
  if (type === "data_sync") {
    const p = payload as DataSyncPayload;
    if (p.knowledgeBaseId) {
      if (!(await ctx.owns.knowledgeBase(p.knowledgeBaseId))) {
        return notInOrg("payload.knowledgeBaseId", "knowledge base");
      }
    } else if (!task.agent?.knowledgeBaseId) {
      return fieldProblem(
        "payload.knowledgeBaseId",
        task.hasAgent
          ? "the selected agent has no knowledge base; choose one for this task"
          : "choose a knowledge base, or an agent that has one",
      );
    }
  }

  if (type === "health_check") {
    const p = payload as HealthCheckPayload;
    if (p.target === "agent" && !task.hasAgent) {
      return { error: "invalid_task", field: "agentId", message: "an agent health check needs an agent" };
    }
    if (p.target === "deployment" && p.deploymentId) {
      if (!(await ctx.owns.deployment(p.deploymentId))) {
        return notInOrg("payload.deploymentId", "deployment");
      }
    }
    if (p.monitorId && !(await ctx.owns.monitor(p.monitorId))) {
      return notInOrg("payload.monitorId", "uptime monitor");
    }
    if (p.onDown === "restart_deployment" && !ctx.capabilities.deploymentRestartAvailable) {
      return fieldProblem("payload.onDown", RESTART_UNAVAILABLE_REASON);
    }
  }

  if (type === "report") {
    const p = payload as ReportPayload;
    if (p.scope === "agent" && !task.hasAgent) {
      return { error: "invalid_task", field: "agentId", message: "an agent-scoped report needs an agent" };
    }
    if (p.summarize && !task.hasAgent) {
      return {
        error: "invalid_task",
        field: "agentId",
        message: "summarize needs an agent: the selected agent writes the summary",
      };
    }
    const channelId = p.deliver?.alertChannelId;
    if (channelId) {
      const channel = await ctx.owns.alertChannel(channelId);
      if (!channel) return notInOrg("payload.deliver.alertChannelId", "alert channel");
      if (channel.type === "email" && !ctx.capabilities.emailConfigured) {
        return fieldProblem("payload.deliver.alertChannelId", EMAIL_UNAVAILABLE_REASON);
      }
      if (channel.type === "pagerduty") {
        return fieldProblem(
          "payload.deliver.alertChannelId",
          "a PagerDuty channel opens incidents and cannot carry a report; choose a Slack, Discord, webhook or email channel",
        );
      }
    }
  }

  return null;
}
