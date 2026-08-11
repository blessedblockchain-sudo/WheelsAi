/**
 * Graph run orchestration (W2): loads a saved graph, walks it through the
 * linear interpreter, and PERSISTS the run.
 *
 * The execution row exists so a run is inspectable afterwards — the
 * builder can show what each node received and produced, including nodes
 * that refused. Returning the trace only in the HTTP response would make
 * every run vanish the moment the tab closed.
 *
 * A run is recorded even when it fails, and even when it fails on the
 * FIRST node: a refusal the author needs to see is exactly the case
 * where a silent 400 would be least helpful.
 */

import { prisma } from "../lib/prisma.js";
import {
  buildGraphInterpreterDeps,
  loadGraphAgentContext,
} from "./buildGraphInterpreterDeps.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "./marketplaceMetering.js";
import { beginMarketplaceMetering } from "./marketplaceMeteringProduction.js";
import {
  runGraph,
  type GraphRunResult,
  type InterpretableEdge,
  type InterpretableNode,
} from "./graphInterpreter.js";

export interface GraphRunRecord extends GraphRunResult {
  executionId: string;
  durationMs: number;
}

export async function runAgentGraph(
  agentId: string,
  orgId: string,
  input: string,
): Promise<GraphRunRecord> {
  const agent = await loadGraphAgentContext(agentId, orgId);
  if (!agent) {
    throw new Error("Agent not found or access denied");
  }

  const graph = await prisma.agentGraph.findUnique({ where: { agentId } });
  if (!graph) {
    throw new Error("This agent has no graph — build one first");
  }

  const nodes = (graph.nodes as unknown as InterpretableNode[]) ?? [];
  const edges = (graph.edges as unknown as InterpretableEdge[]) ?? [];
  if (nodes.length === 0) {
    throw new Error("Graph is empty");
  }

  // One graph RUN is one billable request, not one per llm node — a graph
  // that fans out to five nodes is still one thing the buyer asked for,
  // and per-node billing would make the same agent cost a different
  // amount depending on internal wiring the buyer cannot see. Charging
  // BEFORE the execution row exists means an unpayable run is a clean 402
  // rather than a "failed" run in the buyer's history.
  const metering = await beginMarketplaceMetering({ agentId, orgId });
  if (metering && !metering.ok) {
    throw metering.reason === "licence_revoked"
      ? new MarketplaceLicenceRevokedError(metering.listingTitle)
      : new MarketplacePaymentRequiredError({
          requiredCents: metering.requiredCents,
          balanceCents: metering.balanceCents,
          listingTitle: metering.listingTitle,
        });
  }
  const meter = metering?.ok ? metering.handle : null;

  const startedAt = new Date();
  const execution = await prisma.agentGraphExecution.create({
    data: {
      graphId: graph.id,
      agentId,
      status: "running",
      input,
      startedAt,
    },
  });

  let result: GraphRunResult;
  try {
    result = await runGraph(nodes, edges, input, buildGraphInterpreterDeps(agent));
  } catch (err) {
    // An interpreter-level throw (not a node failure) still gets recorded
    // rather than leaving a row stuck "running".
    const message = err instanceof Error ? err.message : String(err);
    result = { status: "failed", output: null, error: message, trace: [] };
  }

  // The interpreter returns `failed` rather than throwing when a node
  // fails, so settling on "no exception" would bill the buyer for a run
  // that produced nothing. Settle on delivered output only.
  if (result.status === "failed") {
    await meter?.refund(result.error ?? "graph run failed");
  } else {
    await meter?.settle();
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  await prisma.agentGraphExecution.update({
    where: { id: execution.id },
    data: {
      status: result.status,
      output: result.output,
      error: result.error,
      trace: result.trace as never,
      completedAt,
      durationMs,
    },
  });

  return { ...result, executionId: execution.id, durationMs };
}

export async function getGraphExecutions(
  agentId: string,
  orgId: string,
  limit = 20,
) {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, orgId },
    select: { id: true },
  });
  if (!agent) throw new Error("Agent not found or access denied");

  return prisma.agentGraphExecution.findMany({
    where: { agentId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
