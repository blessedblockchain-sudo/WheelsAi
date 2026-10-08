/**
 * The one way an agent is created: POST /api/agents and "use this template"
 * both come through here, so a name is all either needs, both count toward
 * the plan, both get a unique slug, and both answer in the same shape.
 *
 * In order: the schedule (when one is sent: its times, its time zone and
 * what it is told, checked before anything is read), the template (when one
 * is named), the input (plain-word refusals, services/agentCreateInput.ts),
 * the knowledge base's owner, the plan's agent limit, then one transaction
 * that writes the agent, its public handle when it is created public, its
 * graph when the template has one, the template's use count and the agent's
 * own schedule (services/agentOwnSchedule.ts). If the schedule cannot be
 * written the agent is not kept: there is no half-made agent. A template
 * never makes a schedule by itself: it carries only the suggestion.
 * `alsoInTransaction` is the seam for a caller that has to write more beside
 * the agent or not at all: it runs inside that transaction, after the agent
 * row exists.
 *
 * The database, the secrets key and the model catalog are behind
 * CreateAgentDeps (services/buildCreateAgentDeps.ts binds them).
 */

import type { AgentKind, KindConfig } from "@wheelsai/shared/agent-kind";
import { z } from "zod";

import {
  fieldPath,
  plainIssue,
  validationFailureFromFields,
  type ValidationFailureBody,
} from "../lib/validationFailure.js";
import {
  readTemplateId,
  resolveAgentCreate,
  type AgentCreateData,
  type AgentCreateDefaults,
} from "./agentCreateInput.js";
import {
  checkOwnSchedule,
  OWN_SCHEDULE_MESSAGES,
  OwnScheduleError,
  type CreateOwnScheduleArgs,
  type OwnSchedule,
} from "./agentOwnSchedule.js";
import { uniqueAgentSlug } from "./agentSlug.js";
import { agentApiEndpoints, type AgentApiEndpoints } from "./publicEndpoints.js";

/** A published template as stored. `env` is as stored: sealed, or legacy plaintext. */
export interface AgentTemplateSource extends Omit<AgentCreateDefaults, "env"> {
  id: string;
  env?: unknown;
  graphNodes?: unknown;
  graphEdges?: unknown;
}

/** The row to write. `env` is sealed. */
export interface NewAgentRow extends Omit<AgentCreateData, "slugFrom" | "env"> {
  orgId: string;
  slug: string;
  env: unknown;
}

/** What the create path knows of the agent it wrote. */
export interface CreatedAgent {
  id: string;
  name: string;
  slug: string;
  framework: string;
  agentKind: AgentKind;
  kindConfig: KindConfig | null;
}

/** The agent's own schedule as the create answers it. Never what it is told or where results go. */
export interface CreatedSchedule {
  /** The scheduled task's id. */
  id: string;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  nextRunAt: Date | null;
}

/** What the create path hands the schedule write. Whether email can be sent is the binding's to say. */
export type NewAgentSchedule = Omit<CreateOwnScheduleArgs, "emailConfigured">;

export interface CreateAgentDeps<TTx = unknown> {
  /** A published template by id, or null. */
  findTemplate(templateId: string): Promise<AgentTemplateSource | null>;
  /** Ids of free models whose provider key is configured, in catalog order. */
  availableFreeModelIds(): readonly string[];
  openEnv(stored: unknown): Record<string, string>;
  sealEnv(env: Record<string, string>): unknown;
  knowledgeBaseOwned(knowledgeBaseId: string, orgId: string): Promise<boolean>;
  /** Throws PlanLimitError when one more agent would exceed the plan. */
  assertCanCreateAgent(orgId: string): Promise<void>;
  slugTaken(orgId: string, slug: string): Promise<boolean>;
  transaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
  insertAgent(tx: TTx, row: NewAgentRow): Promise<{ id: string }>;
  insertGraph(tx: TTx, agentId: string, nodes: unknown, edges: unknown): Promise<void>;
  countTemplateUse(tx: TTx, templateId: string): Promise<void>;
  /**
   * Gives an agent created public its address, /a/<handle>: the first free
   * handle made from its slug (services/agentPublicLink.ts). Never a page
   * key: an agent made public here is view-only.
   */
  assignHandle(tx: TTx, agent: { id: string; slug: string }): Promise<string>;
  /**
   * Writes the agent's own schedule beside the agent
   * (createOwnSchedule). Throws OwnScheduleError when the place its results
   * go is not one the organization can use; whatever it throws undoes the
   * agent too.
   */
  insertSchedule(tx: TTx, schedule: NewAgentSchedule): Promise<OwnSchedule>;
  /** Whether a failed insert lost a race for the slug. */
  isSlugConflict(err: unknown): boolean;
  /** Whether the transaction lost a race for the handle. */
  isHandleConflict(err: unknown): boolean;
  /** Whether the transaction lost a race for the schedule's name. */
  isScheduleNameConflict(err: unknown): boolean;
  /** The log line and the `agent.created` webhook. Must not throw. */
  announce(orgId: string, agent: CreatedAgent): void;
  now?(): Date;
}

export interface CreateAgentArgs<TTx = unknown> {
  orgId: string;
  /** The request body, as sent. */
  body: unknown;
  /** The template named by the route. It wins over a `templateId` in the body. */
  templateId?: string;
  /** More to write in the agent's transaction. A throw undoes the agent too. */
  alsoInTransaction?: (tx: TTx, agent: CreatedAgent) => Promise<void>;
}

export type CreateAgentResult =
  /** `schedule` is null (or absent) when the agent was created without one. */
  | { ok: true; agent: CreatedAgent; schedule?: CreatedSchedule | null }
  | { ok: false; reason: "validation_failed"; failure: ValidationFailureBody }
  | { ok: false; reason: "template_not_found" }
  | { ok: false; reason: "knowledge_base_not_found" };

/**
 * Two creates of the same name at once can pick the same slug, two public
 * ones the same handle, and two with a schedule the same schedule name; the
 * loser picks again.
 */
const SLUG_ATTEMPTS = 3;

export const TEMPLATE_NOT_FOUND_MESSAGE = "This template is no longer available. Choose another one.";

/**
 * A schedule sent with the create of an agent that is not of kind
 * "scheduled". An agent of any kind can be given one afterwards
 * (PUT /api/agents/:id/schedule), and the sentence says so.
 */
export const SCHEDULE_NEEDS_SCHEDULED_KIND_MESSAGE =
  "To create an agent with a schedule, set agentKind to scheduled. For another kind, create the agent first and add its schedule afterwards.";

// ============================================
// The schedule a create may carry
// ============================================

/**
 * `schedule` of POST /api/agents. Only these fields: the time limit and the
 * number of tries keep their defaults at create and are changed on the
 * agent's schedule (PUT /api/agents/:id/schedule).
 */
const scheduleSchema = z
  .object({
    cronExpression: z
      .string({
        required_error: OWN_SCHEDULE_MESSAGES.invalidCron,
        invalid_type_error: OWN_SCHEDULE_MESSAGES.invalidCron,
      })
      .trim()
      .min(1, OWN_SCHEDULE_MESSAGES.invalidCron)
      .max(200, OWN_SCHEDULE_MESSAGES.invalidCron),
    timezone: z
      .string({ invalid_type_error: OWN_SCHEDULE_MESSAGES.invalidTimezone })
      .max(100, OWN_SCHEDULE_MESSAGES.invalidTimezone)
      .nullable()
      .optional(),
    prompt: z.string({ invalid_type_error: OWN_SCHEDULE_MESSAGES.prompt }).nullable().optional(),
    // Where results go: one of the organization's saved places. null or
    // absent means they are only saved on the agent's page.
    deliver: z
      .object({
        channelId: z.string({
          required_error: OWN_SCHEDULE_MESSAGES.placeNotFound,
          invalid_type_error: OWN_SCHEDULE_MESSAGES.placeNotFound,
        }),
      })
      .strict()
      .nullable()
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** The schedule a create asked for, checked as far as it can be without a database. */
interface WantedSchedule {
  cronExpression: string;
  timezone: string;
  prompt: string | null;
  deliver: { alertChannelId: string } | null;
  enabled: boolean;
}

/** A field of the own schedule, as the request names it. */
const sentScheduleField = (field: string | undefined): string =>
  !field ? "schedule" : `schedule.${field === "deliver.alertChannelId" ? "deliver.channelId" : field}`;

/** A refusal of the schedule as the 400 every other refusal of a create is. */
function scheduleFailure(error: OwnScheduleError): ValidationFailureBody {
  return validationFailureFromFields({ [sentScheduleField(error.extra.field)]: error.message });
}

type ScheduleReading =
  | { ok: true; schedule: WantedSchedule | null }
  | { ok: false; failure: ValidationFailureBody };

/**
 * Reads `schedule` from the body and checks it (checkOwnSchedule). Pure: no
 * plan is read and nothing is opened, so a schedule that cannot be used
 * leaves no agent. null and absent both mean "no schedule".
 */
export function readSchedule(body: unknown, now: Date): ScheduleReading {
  const sent =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).schedule : undefined;
  if (sent === undefined || sent === null) return { ok: true, schedule: null };

  const parsed = scheduleSchema.safeParse(sent);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      // Under "schedule", so a problem with the whole of it names it.
      const path = ["schedule", ...issue.path];
      const field = fieldPath(path);
      if (!(field in fields)) fields[field] = plainIssue({ ...issue, path });
    }
    return { ok: false, failure: validationFailureFromFields(fields) };
  }

  const deliver = parsed.data.deliver ? { alertChannelId: parsed.data.deliver.channelId } : null;
  const checked = checkOwnSchedule(
    {
      cronExpression: parsed.data.cronExpression,
      timezone: parsed.data.timezone,
      prompt: parsed.data.prompt,
      deliver,
    },
    now,
  );
  if (!checked.ok) return { ok: false, failure: scheduleFailure(checked.error) };
  return {
    ok: true,
    schedule: {
      cronExpression: checked.cronExpression,
      timezone: checked.timezone,
      prompt: parsed.data.prompt ?? null,
      deliver,
      enabled: parsed.data.enabled ?? true,
    },
  };
}

export async function createAgent<TTx>(
  deps: CreateAgentDeps<TTx>,
  args: CreateAgentArgs<TTx>,
): Promise<CreateAgentResult> {
  const { orgId, body } = args;

  // The schedule first, before the template, the plan or a transaction: it
  // is the part most likely to be wrong, and a wrong one must cost nothing.
  const now = deps.now?.() ?? new Date();
  const wanted = readSchedule(body, now);
  if (!wanted.ok) return { ok: false, reason: "validation_failed", failure: wanted.failure };

  let templateId = args.templateId ?? null;
  if (templateId === null) {
    const named = readTemplateId(body);
    if (!named.ok) return { ok: false, reason: "validation_failed", failure: named.failure };
    templateId = named.templateId;
  }
  let template: AgentTemplateSource | null = null;
  if (templateId !== null) {
    template = await deps.findTemplate(templateId);
    if (!template) return { ok: false, reason: "template_not_found" };
  }

  const resolved = resolveAgentCreate(body, {
    availableFreeModelIds: deps.availableFreeModelIds(),
    template: template && { ...template, env: deps.openEnv(template.env) },
    now: deps.now?.(),
  });
  if (!resolved.ok) return { ok: false, reason: "validation_failed", failure: resolved.failure };
  const { slugFrom, env, ...data } = resolved.data;

  // Only a self-running agent has a schedule of its own. Its kind may come
  // from the template, so this is known only once the input is resolved.
  if (wanted.schedule && data.agentKind !== "scheduled") {
    return {
      ok: false,
      reason: "validation_failed",
      failure: validationFailureFromFields({ schedule: SCHEDULE_NEEDS_SCHEDULED_KIND_MESSAGE }),
    };
  }

  if (data.knowledgeBaseId && !(await deps.knowledgeBaseOwned(data.knowledgeBaseId, orgId))) {
    return { ok: false, reason: "knowledge_base_not_found" };
  }

  // Starter includes up to 3 agents (marketplace installs don't count).
  // Templates create agents too, so they count toward the plan.
  await deps.assertCanCreateAgent(orgId);

  const sealedEnv = deps.sealEnv(env);
  const hasGraph = Boolean(template?.graphNodes && template.graphEdges);

  for (let attempt = 1; ; attempt++) {
    const slug = await uniqueAgentSlug({ from: slugFrom, taken: (candidate) => deps.slugTaken(orgId, candidate) });
    try {
      const { agent, schedule } = await deps.transaction(async (tx) => {
        const row = await deps.insertAgent(tx, { ...data, orgId, slug, env: sealedEnv });
        const created: CreatedAgent = {
          id: row.id,
          name: data.name,
          slug,
          framework: data.framework,
          agentKind: data.agentKind,
          kindConfig: data.kindConfig,
        };
        if (data.isPublic) await deps.assignHandle(tx, { id: row.id, slug });
        if (template && hasGraph) {
          await deps.insertGraph(tx, created.id, template.graphNodes, template.graphEdges);
        }
        if (template) await deps.countTemplateUse(tx, template.id);
        // The agent's own schedule, or no agent: what this throws undoes
        // every write above.
        const own = wanted.schedule
          ? await deps.insertSchedule(tx, {
              orgId,
              agentId: created.id,
              agentName: created.name,
              cronExpression: wanted.schedule.cronExpression,
              timezone: wanted.schedule.timezone,
              prompt: wanted.schedule.prompt,
              deliver: wanted.schedule.deliver,
              enabled: wanted.schedule.enabled,
              now,
            })
          : null;
        if (args.alsoInTransaction) await args.alsoInTransaction(tx, created);
        return { agent: created, schedule: own && createdScheduleOf(own) };
      });
      deps.announce(orgId, agent);
      return { ok: true, agent, schedule };
    } catch (err) {
      // The place its results go was not one this organization can use
      // (known only inside the transaction). The agent was not kept.
      if (err instanceof OwnScheduleError) {
        return { ok: false, reason: "validation_failed", failure: scheduleFailure(err) };
      }
      if (
        attempt < SLUG_ATTEMPTS &&
        (deps.isSlugConflict(err) || deps.isHandleConflict(err) || deps.isScheduleNameConflict(err))
      ) {
        continue;
      }
      throw err;
    }
  }
}

function createdScheduleOf(own: OwnSchedule): CreatedSchedule {
  return {
    id: own.id,
    enabled: own.enabled,
    cronExpression: own.cronExpression,
    timezone: own.timezone,
    nextRunAt: own.nextRunAt,
  };
}

export interface CreatedAgentAnswer {
  agent: { id: string; name: string; slug: string; framework: string; agentKind: AgentKind } & AgentApiEndpoints;
  /** The agent's own schedule; null when it was created without one. */
  schedule: CreatedSchedule | null;
  message: string;
}

/** The 201 body of every route that creates an agent. No instructions, no settings, no secrets. */
export function createdAgentAnswer(
  agent: CreatedAgent,
  publicApiUrl: string | null | undefined,
  schedule: CreatedSchedule | null = null,
): CreatedAgentAnswer {
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      framework: agent.framework,
      agentKind: agent.agentKind,
      ...agentApiEndpoints(agent.slug, publicApiUrl),
    },
    // Field by field: what it is told and where its results go stay out.
    schedule: schedule && {
      id: schedule.id,
      enabled: schedule.enabled,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      nextRunAt: schedule.nextRunAt,
    },
    message: "Agent created successfully",
  };
}

/** A create's result as an HTTP answer: the status and the body to send. */
export function createAgentAnswer(
  result: CreateAgentResult,
  publicApiUrl: string | null | undefined,
): { status: number; body: unknown } {
  if (result.ok) {
    return { status: 201, body: createdAgentAnswer(result.agent, publicApiUrl, result.schedule ?? null) };
  }
  switch (result.reason) {
    case "validation_failed":
      return { status: 400, body: result.failure };
    case "template_not_found":
      return { status: 404, body: { error: "template_not_found", message: TEMPLATE_NOT_FOUND_MESSAGE } };
    case "knowledge_base_not_found":
      // The shape reply.badRequest() gave this refusal before the create path moved here.
      return { status: 400, body: { statusCode: 400, error: "Bad Request", message: "Knowledge base not found" } };
  }
}
