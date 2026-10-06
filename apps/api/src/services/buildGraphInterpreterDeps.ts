/**
 * Composition root for the graph interpreter (W2): binds the pure
 * runGraph to real inference and real knowledge retrieval.
 *
 * `runLlm` resolves through the SAME model path the playground uses, so a
 * graph's llm node and the agent's own chat behave identically. A node
 * may name its own model; otherwise the agent's configured model wins,
 * and failing that the first available free model — the graph does not
 * get a private, quietly different model policy.
 *
 * `searchKnowledge` reuses searchKnowledgeBase, so a memory node inherits
 * the same semantic/keyword decision (and the same honest `mode`) as the
 * search API instead of growing a second retrieval policy.
 */

import { getAvailableFreeModels } from "../config/free-models.js";
import { openAgentEnv } from "./agentSecrets.js";
import { prisma } from "../lib/prisma.js";
import type { GraphInterpreterDeps } from "./graphInterpreter.js";
import { searchKnowledgeBase } from "./knowledge.js";
import { resolveAgentModelId } from "./agentModelResolution.js";
import { HOSTED_MODEL_PREFIX, resolveHostedModel } from "./hostedModel.js";
import { resolveModelForPlayground, runChat, type ResolvedModel } from "./mastra-runtime.js";
import { getDefaultRegistry, getSandboxRunner } from "./skills/production.js";
import type { ToolMode } from "./skills/types.js";

export interface GraphAgentContext {
  agentId: string;
  orgId: string;
  agentName: string;
  systemPrompt: string | null;
  modelConfig: Record<string, unknown>;
  env: Record<string, string>;
  /** The agent's enabled tools (Agent.tools); llm nodes may use them. */
  tools?: Array<{ name: string; description?: string }>;
}

export interface GraphRunOptions {
  /** Cancels the run (the client went away). */
  signal?: AbortSignal;
  /** "graph" by default; "trial" for a marketplace buyer's run. */
  toolMode?: ToolMode;
}

export interface NodeModelDeps {
  availableFreeModelIds: () => string[];
  resolveModel: (modelId: string, agentEnv: Record<string, string>) => ResolvedModel;
  resolveHostedModel: (args: {
    orgId: string;
    modelId: string;
  }) => Promise<{ ok: true; resolved: ResolvedModel } | { ok: false; message: string }>;
}

const PRODUCTION_NODE_MODEL_DEPS: NodeModelDeps = {
  availableFreeModelIds: () => getAvailableFreeModels().map((m) => m.id),
  resolveModel: resolveModelForPlayground,
  resolveHostedModel: (args) => resolveHostedModel(args),
};

/**
 * The model an llm node runs on, by the precedence every agent chat uses
 * (agentModelResolution.ts) with the node's own choice first. A
 * `wheelsai/<id>` model is the organization's own running deployment, as it
 * is for the agent's chat; it used to be refused here by name.
 */
export async function resolveNodeModel(
  args: { model?: string | null; agent: Pick<GraphAgentContext, "orgId" | "modelConfig" | "env"> },
  deps: NodeModelDeps = PRODUCTION_NODE_MODEL_DEPS,
): Promise<{ modelId: string; model: ResolvedModel }> {
  const modelId = resolveAgentModelId({
    override: args.model,
    modelConfig: args.agent.modelConfig,
    availableFreeModelIds: deps.availableFreeModelIds(),
  });
  if (!modelId) {
    throw new Error(
      "no model available: the node names none, the agent configures none, and no free-model provider key is set",
    );
  }
  if (modelId.startsWith(HOSTED_MODEL_PREFIX)) {
    const hosted = await deps.resolveHostedModel({ orgId: args.agent.orgId, modelId });
    if (!hosted.ok) throw new Error(hosted.message);
    return { modelId, model: hosted.resolved };
  }
  return { modelId, model: deps.resolveModel(modelId, args.agent.env) };
}

export function buildGraphInterpreterDeps(
  agent: GraphAgentContext,
  options: GraphRunOptions = {},
): GraphInterpreterDeps {
  const toolMode = options.toolMode ?? "graph";
  return {
    signal: options.signal,
    toolMode,
    runLlm: async ({ prompt, systemPrompt, model, temperature, maxTokens, tools, signal }) => {
      const resolved = await resolveNodeModel({ model, agent });
      const modelId = resolved.modelId;

      // An llm node gets the agent's enabled tools, and a node may only
      // NARROW that set (`tools: [...]` on the node) - it cannot enable a
      // tool the agent's owner did not.
      const agentTools = (agent.tools ?? []).filter(
        (t) => !tools || tools.includes(t.name),
      );

      const result = await runChat(
        resolved.model,
        {
          name: agent.agentName,
          // A node's own system prompt overrides the agent's for that
          // step — that is the point of putting one on the node.
          systemPrompt: systemPrompt ?? agent.systemPrompt ?? undefined,
          tools: agentTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
          })),
          modelConfig: {
            externalModel: modelId,
            temperature: temperature ?? 0.7,
            maxTokens: maxTokens ?? 1024,
          },
        },
        [{ role: "user", content: prompt }],
        false,
        { agentId: agent.agentId, orgId: agent.orgId, mode: toolMode, signal },
      );
      return { content: result.content };
    },

    searchKnowledge: async ({ knowledgeBaseId, query, limit }) => {
      const found = await searchKnowledgeBase(knowledgeBaseId, agent.orgId, {
        query,
        limit,
      });
      if (found.results.length === 0) return null;
      const text = found.results
        .map((r, i) => `[${i + 1}] ${r.documentTitle}\n${r.content}`)
        .join("\n\n");
      return { text, mode: found.mode };
    },

    // `tool` nodes run registry skills under the same availability rules as
    // chat; `code` nodes run only in the external sandbox, when configured.
    skills: getDefaultRegistry(),
    // A tool node may only use what the agent's owner enabled on the agent.
    enabledTools: (agent.tools ?? []).map((t) => t.name),
    toolContext: { agentId: agent.agentId, orgId: agent.orgId },
    sandbox: getSandboxRunner(),
  };
}

/** Loads the agent context a graph run needs, scoped to the org. */
export async function loadGraphAgentContext(
  agentId: string,
  orgId: string,
): Promise<GraphAgentContext | null> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, orgId },
    select: {
      id: true,
      name: true,
      systemPrompt: true,
      modelConfig: true,
      env: true,
      tools: true,
    },
  });
  if (!agent) return null;
  return {
    agentId: agent.id,
    orgId,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
    modelConfig: (agent.modelConfig as Record<string, unknown>) ?? {},
    env: openAgentEnv(agent.env),
    tools: Array.isArray(agent.tools)
      ? (agent.tools as Array<{ name?: unknown; description?: unknown }>)
          .filter((t) => typeof t?.name === "string")
          .map((t) => ({
            name: t.name as string,
            description: typeof t.description === "string" ? t.description : undefined,
          }))
      : [],
  };
}
