/**
 * The one way an agent is created: POST /api/agents and "use this template"
 * both come through here, so a name is all either needs, both count toward
 * the plan, both get a unique slug, and both answer in the same shape.
 *
 * In order: the template (when one is named), the input (plain-word
 * refusals, services/agentCreateInput.ts), the knowledge base's owner, the
 * plan's agent limit, then one transaction that writes the agent, its graph
 * when the template has one, and the template's use count. `alsoInTransaction`
 * is the seam for a caller that has to write more beside the agent or not at
 * all (a schedule, in a later batch): it runs inside that transaction, after
 * the agent row exists.
 *
 * The database, the secrets key and the model catalog are behind
 * CreateAgentDeps (services/buildCreateAgentDeps.ts binds them).
 */

import type { AgentKind, KindConfig } from "@wheelsai/shared/agent-kind";

import type { ValidationFailureBody } from "../lib/validationFailure.js";
import {
  readTemplateId,
  resolveAgentCreate,
  type AgentCreateData,
  type AgentCreateDefaults,
} from "./agentCreateInput.js";
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
  /** Whether a failed insert lost a race for the slug. */
  isSlugConflict(err: unknown): boolean;
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
  | { ok: true; agent: CreatedAgent }
  | { ok: false; reason: "validation_failed"; failure: ValidationFailureBody }
  | { ok: false; reason: "template_not_found" }
  | { ok: false; reason: "knowledge_base_not_found" };

/** Two creates of the same name at once can pick the same slug; the loser picks again. */
const SLUG_ATTEMPTS = 3;

export const TEMPLATE_NOT_FOUND_MESSAGE = "This template is no longer available. Choose another one.";

export async function createAgent<TTx>(
  deps: CreateAgentDeps<TTx>,
  args: CreateAgentArgs<TTx>,
): Promise<CreateAgentResult> {
  const { orgId, body } = args;

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
      const agent = await deps.transaction(async (tx) => {
        const row = await deps.insertAgent(tx, { ...data, orgId, slug, env: sealedEnv });
        const created: CreatedAgent = {
          id: row.id,
          name: data.name,
          slug,
          framework: data.framework,
          agentKind: data.agentKind,
          kindConfig: data.kindConfig,
        };
        if (template && hasGraph) {
          await deps.insertGraph(tx, created.id, template.graphNodes, template.graphEdges);
        }
        if (template) await deps.countTemplateUse(tx, template.id);
        if (args.alsoInTransaction) await args.alsoInTransaction(tx, created);
        return created;
      });
      deps.announce(orgId, agent);
      return { ok: true, agent };
    } catch (err) {
      if (attempt < SLUG_ATTEMPTS && deps.isSlugConflict(err)) continue;
      throw err;
    }
  }
}

export interface CreatedAgentAnswer {
  agent: { id: string; name: string; slug: string; framework: string; agentKind: AgentKind } & AgentApiEndpoints;
  message: string;
}

/** The 201 body of every route that creates an agent. No instructions, no settings, no secrets. */
export function createdAgentAnswer(
  agent: CreatedAgent,
  publicApiUrl: string | null | undefined,
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
    message: "Agent created successfully",
  };
}

/** A create's result as an HTTP answer: the status and the body to send. */
export function createAgentAnswer(
  result: CreateAgentResult,
  publicApiUrl: string | null | undefined,
): { status: number; body: unknown } {
  if (result.ok) return { status: 201, body: createdAgentAnswer(result.agent, publicApiUrl) };
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
