/**
 * W2 graph proof: a saved visual graph executed through the PRODUCTION
 * interpreter against the dev database with LIVE inference.
 *
 * Nothing is stubbed. `runAgentGraph` is the same function the
 * POST /agents/:agentId/graph/run route calls, so the llm node performs
 * real inference through the shared playground-parity path and the
 * execution row is persisted exactly as a real run would be.
 *
 * The graph exercises the parts that were previously undefined behavior:
 *   input -> transform (templating) -> llm (real call)
 *         -> condition (data-driven branch) -> transform -> output
 *
 * A second run then proves a `code` node REFUSES rather than executing
 * user JavaScript in the API process.
 *
 * Usage: npx tsx scripts/run-graph-demo.ts [orgId]
 * Env:   DATABASE_URL + a free-model provider key
 */

import { prisma } from "../src/lib/prisma.js";
import { getAvailableFreeModels } from "../src/config/free-models.js";
import { runAgentGraph } from "../src/services/runAgentGraph.js";

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , orgArg] = process.argv;

  const free = getAvailableFreeModels();
  if (free.length === 0) fail("no free model provider key configured");
  const modelId = free[0]!.id;
  console.log(`using model: ${modelId}`);

  const org = orgArg
    ? await prisma.organization.findUnique({ where: { id: orgArg } })
    : await prisma.organization.findFirst();
  if (!org) fail("no organization found");

  const stamp = Date.now();
  const agent = await prisma.agent.create({
    data: {
      orgId: org.id,
      name: `Graph demo agent ${stamp}`,
      slug: `graph-demo-${stamp}`,
      framework: "custom",
      systemPrompt: "You answer with one short sentence.",
      tools: [],
      modelConfig: { externalModel: modelId, temperature: 0, maxTokens: 64 },
      sourceType: "inline",
      env: {},
    },
  });

  const nodes = [
    { id: "in", type: "input", position: { x: 0, y: 0 }, data: { label: "User Input", config: {} } },
    {
      id: "frame",
      type: "transform",
      position: { x: 200, y: 0 },
      data: {
        label: "Frame the question",
        config: { template: "Answer in one sentence: {{value}}" },
      },
    },
    {
      id: "ask",
      type: "llm",
      position: { x: 400, y: 0 },
      data: { label: "Ask the model", config: { temperature: 0 } },
    },
    {
      id: "check",
      type: "condition",
      position: { x: 600, y: 0 },
      data: {
        label: "Mentions Solana?",
        config: { op: "contains", value: "Solana" },
      },
    },
    {
      id: "tagged",
      type: "transform",
      position: { x: 800, y: -80 },
      data: { label: "Tag on-topic", config: { template: "[ON-TOPIC] {{value}}" } },
    },
    {
      id: "untagged",
      type: "transform",
      position: { x: 800, y: 80 },
      data: { label: "Tag off-topic", config: { template: "[OFF-TOPIC] {{value}}" } },
    },
    { id: "out", type: "output", position: { x: 1000, y: 0 }, data: { label: "Result", config: {} } },
  ];
  const edges = [
    { id: "e1", source: "in", target: "frame" },
    { id: "e2", source: "frame", target: "ask" },
    { id: "e3", source: "ask", target: "check" },
    { id: "e4", source: "check", target: "tagged", sourceHandle: "true" },
    { id: "e5", source: "check", target: "untagged", sourceHandle: "false" },
    { id: "e6", source: "tagged", target: "out" },
    { id: "e7", source: "untagged", target: "out" },
  ];

  await prisma.agentGraph.create({
    data: { agentId: agent.id, nodes: nodes as never, edges: edges as never, isValid: true },
  });
  console.log(`graph saved for agent ${agent.id} (${nodes.length} nodes)\n`);

  console.log("run 1 — the real path:");
  const run = await runAgentGraph(
    agent.id,
    org.id,
    "Which blockchain is known for sub-second finality and very low fees?",
  );
  for (const t of run.trace) {
    console.log(
      `  ${t.label.padEnd(20)} ${t.nodeType.padEnd(10)} ${t.status.padEnd(8)} ${String(t.durationMs).padStart(5)}ms  ${(t.output ?? t.error ?? "").slice(0, 70)}`,
    );
  }
  console.log(`  => ${run.status}: ${run.output}`);

  if (run.status !== "completed") fail(`run failed: ${run.error}`);
  const llmStep = run.trace.find((t) => t.nodeType === "llm");
  if (!llmStep || llmStep.status !== "success") fail("llm node did not run");
  if (!llmStep.durationMs || llmStep.durationMs <= 0) {
    fail("llm duration not measured — timings must be observed");
  }
  // The transform must have actually reframed the prompt before the model
  // saw it: that is the data flowing through the graph.
  if (!llmStep.input?.startsWith("Answer in one sentence:")) {
    fail(`transform did not feed the llm node: ${llmStep.input}`);
  }
  // Exactly one branch of the condition may appear in the trace.
  const branches = run.trace.filter(
    (t) => t.nodeId === "tagged" || t.nodeId === "untagged",
  );
  if (branches.length !== 1) {
    fail(`expected exactly one branch to run, got ${branches.length}`);
  }
  console.log(`  branch taken: ${branches[0]!.label}`);

  // Persistence: the run must be inspectable afterwards.
  const persisted = await prisma.agentGraphExecution.findUnique({
    where: { id: run.executionId },
  });
  if (!persisted || persisted.status !== "completed") {
    fail("execution row was not persisted");
  }
  const persistedTrace = persisted.trace as unknown as unknown[];
  if (persistedTrace.length !== run.trace.length) {
    fail("persisted trace does not match the returned trace");
  }
  console.log(`  persisted execution ${persisted.id} with ${persistedTrace.length} trace entries`);

  // --- run 2: a code node must refuse ---
  console.log("\nrun 2 — a `code` node must REFUSE, not execute:");
  await prisma.agentGraph.update({
    where: { agentId: agent.id },
    data: {
      nodes: [
        nodes[0],
        {
          id: "evil",
          type: "code",
          position: { x: 200, y: 0 },
          data: { label: "Custom code", config: { code: "process.exit(1)" } },
        },
        nodes[6],
      ] as never,
      edges: [
        { id: "x1", source: "in", target: "evil" },
        { id: "x2", source: "evil", target: "out" },
      ] as never,
    },
  });
  const refused = await runAgentGraph(agent.id, org.id, "anything");
  const refusedStep = refused.trace.find((t) => t.nodeType === "code");
  console.log(`  status: ${refused.status}`);
  console.log(`  ${refusedStep?.status}: ${refusedStep?.error?.slice(0, 100)}`);
  if (refused.status !== "failed" || refusedStep?.status !== "refused") {
    fail("a code node must be refused — the process is still running, which means it did not execute, but the status must say so");
  }

  console.log("\ncleaning up…");
  await prisma.agent.delete({ where: { id: agent.id } });

  console.log("\n✅ graph interpreter proven end-to-end:");
  console.log("   real inference, real templating, real conditional branch,");
  console.log("   persisted trace, and an honest refusal for un-runnable nodes.");

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
