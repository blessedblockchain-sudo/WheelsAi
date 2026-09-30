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
import { resolveModelForPlayground, runChat } from "./mastra-runtime.js";

export interface GraphAgentContext {
  agentId: string;
  orgId: string;
  agentName: string;
  systemPrompt: string | null;
  modelConfig: Record<string, unknown>;
  env: Record<string, string>;
}

export function buildGraphInterpreterDeps(
  agent: GraphAgentContext,
): GraphInterpreterDeps {
  return {
    runLlm: async ({ prompt, systemPrompt, model, temperature, maxTokens }) => {
      const configuredModel =
        typeof agent.modelConfig.externalModel === "string"
          ? agent.modelConfig.externalModel
          : typeof agent.modelConfig.model === "string"
            ? (agent.modelConfig.model as string)
            : undefined;
      const modelId = model ?? configuredModel ?? getAvailableFreeModels()[0]?.id;
      if (!modelId) {
        throw new Error(
          "no model available: the node names none, the agent configures none, and no free-model provider key is set",
        );
      }

      const resolved = resolveModelForPlayground(modelId, agent.env);
      const result = await runChat(
        resolved,
        {
          name: agent.agentName,
          // A node's own system prompt overrides the agent's for that
          // step — that is the point of putting one on the node.
          systemPrompt: systemPrompt ?? agent.systemPrompt ?? undefined,
          tools: [],
          modelConfig: {
            externalModel: modelId,
            temperature: temperature ?? 0.7,
            maxTokens: maxTokens ?? 1024,
          },
        },
        [{ role: "user", content: prompt }],
        false,
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
  };
}
