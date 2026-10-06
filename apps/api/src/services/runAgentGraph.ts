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
import { resolveToolMode } from "./skills/runMode.js";
import type { ToolMode } from "./skills/types.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "./marketplaceMetering.js";
import { beginMarketplaceMetering } from "./marketplaceMeteringProduction.js";
import { createInFlightRuns, ServerShuttingDownError } from "./inFlightRuns.js";
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

const SHUTDOWN_ERROR = "run cancelled: the server restarted mid-run; this run was not charged";

/** Every graph run in this process, so shutdown can end them (see below). */
const inFlightGraphRuns = createInFlightRuns();

/**
 * Called first on SIGTERM. Cancels every in-flight graph run and waits for
 * each to refund its marketplace charge and close its execution row, instead
 * of the process being killed with the charge stranded `pending`. Runs that
 * arrive afterwards are refused with ServerShuttingDownError, uncharged.
 */
export function cancelInFlightGraphRuns(timeoutMs: number) {
  return inFlightGraphRuns.cancelAll(timeoutMs);
}

export interface RunAgentGraphOptions {
  signal?: AbortSignal;
  /**
   * Where the run comes from ("graph" = the builder, the default). A caller
   * with nobody watching - the scheduler, a workflow step, a test run - names
   * its own mode, so the graph's tools are gated exactly as that caller's
   * chats are. A marketplace buyer's copy still runs `trial` whatever is
   * passed (resolveToolMode).
   */
  mode?: ToolMode;
}

export async function runAgentGraph(
  agentId: string,
  orgId: string,
  input: string,
  options: RunAgentGraphOptions = {},
): Promise<GraphRunRecord> {
  // Taken BEFORE the charge: from here to `done()` shutdown waits for us.
  const slot = inFlightGraphRuns.begin();
  if (!slot) throw new ServerShuttingDownError();
  try {
    return await runTrackedGraph(agentId, orgId, input, {
      signal: options.signal ? AbortSignal.any([options.signal, slot.signal]) : slot.signal,
      shuttingDown: () => slot.signal.aborted,
      mode: options.mode ?? "graph",
    });
  } finally {
    slot.done();
  }
}

async function runTrackedGraph(
  agentId: string,
  orgId: string,
  input: string,
  options: { signal: AbortSignal; shuttingDown: () => boolean; mode: ToolMode },
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
      ? new MarketplaceLicenceRevokedError(metering.listingTitle, metering.revocation, metering.token)
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
    // `signal` is the client going away or the process shutting down; the
    // interpreter adds its own wall-clock budget on top. Either way the run
    // ENDS, comes back `failed`, and the marketplace charge below is refunded
    // rather than left pending.
    const toolMode = await resolveToolMode({ agentId, orgId, base: options.mode });
    result = await runGraph(
      nodes,
      edges,
      input,
      buildGraphInterpreterDeps(agent, { signal: options.signal, toolMode }),
    );
  } catch (err) {
    // An interpreter-level throw (not a node failure) still gets recorded
    // rather than leaving a row stuck "running".
    const message = err instanceof Error ? err.message : String(err);
    result = { status: "failed", output: null, error: message, trace: [] };
  }

  // "run cancelled" would read as the user's own doing; say whose it was.
  if (result.status === "failed" && options.shuttingDown()) {
    result = { ...result, error: SHUTDOWN_ERROR };
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
