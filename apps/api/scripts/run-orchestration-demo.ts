/**
 * W2 orchestration proof: a real multi-agent workflow through the
 * PRODUCTION engine, against the dev database with LIVE inference.
 *
 * Nothing is stubbed. `executeOrchestration` is the same function the
 * POST /:orchId/execute route calls; the steps invoke real agents through
 * the shared playground-parity path (buildProductionExecutorDeps →
 * resolveModelForPlayground → runChat), so every duration and status
 * recorded is observed rather than simulated.
 *
 * The workflow exercises the parts that were previously fiction:
 *   classify  — a real model call
 *   summarize — depends on classify, reads its OUTPUT via inputMapping
 *   skipme    — a condition that evaluates false ⇒ recorded as skipped
 *
 * Usage: npx tsx scripts/run-orchestration-demo.ts [orgId]
 * Env:   DATABASE_URL + a free-model provider key (GROQ_API_KEY etc.)
 */

import { prisma } from "../src/lib/prisma.js";
import { getAvailableFreeModels } from "../src/config/free-models.js";
import {
  createOrchestration,
  executeOrchestration,
} from "../src/services/orchestration.js";

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , orgArg] = process.argv;

  const free = getAvailableFreeModels();
  if (free.length === 0) {
    fail(
      "no free model provider key configured (GROQ_API_KEY / GOOGLE_GEMINI_API_KEY / TOGETHER_API_KEY) — the engine needs real inference to prove",
    );
  }
  const modelId = free[0]!.id;
  console.log(`using model: ${modelId} (${free[0]!.displayName})`);

  const org = orgArg
    ? await prisma.organization.findUnique({ where: { id: orgArg } })
    : await prisma.organization.findFirst();
  if (!org) fail("no organization found");
  console.log(`org: ${org.id}`);

  // Two throwaway agents that differ only in system prompt.
  const stamp = Date.now();
  const classifier = await prisma.agent.create({
    data: {
      orgId: org.id,
      name: `Classifier (orch demo ${stamp})`,
      slug: `orch-classifier-${stamp}`,
      framework: "custom",
      systemPrompt:
        "You classify text. Reply with exactly ONE word naming the topic. No punctuation, no explanation.",
      tools: [],
      modelConfig: { externalModel: modelId, temperature: 0, maxTokens: 16 },
      sourceType: "inline",
      env: {},
    },
  });
  const summarizer = await prisma.agent.create({
    data: {
      orgId: org.id,
      name: `Summarizer (orch demo ${stamp})`,
      slug: `orch-summarizer-${stamp}`,
      framework: "custom",
      systemPrompt:
        "You write a single short sentence. Be concise and concrete.",
      tools: [],
      modelConfig: { externalModel: modelId, temperature: 0, maxTokens: 64 },
      sourceType: "inline",
      env: {},
    },
  });
  console.log(`agents: classifier=${classifier.id} summarizer=${summarizer.id}`);

  const orch = await createOrchestration(org.id, {
    name: `Demo workflow ${stamp}`,
    description: "W2 orchestration engine proof",
    executionMode: "sequential",
    steps: [
      {
        name: "classify",
        agentId: classifier.id,
        inputMapping: { prompt: "$.input.text" },
      },
      {
        name: "summarize",
        agentId: summarizer.id,
        dependsOn: ["classify"],
        // Reads the PREVIOUS step's real output — the wiring that the
        // fabricated engine never actually did.
        inputMapping: {
          prompt: "$.steps.classify.output",
        },
        outputMapping: { summary: "$.steps.summarize.output" },
      },
      {
        name: "skipme",
        agentId: summarizer.id,
        dependsOn: ["classify"],
        // Deliberately false: classify's output will not contain this.
        condition: {
          left: "$.steps.classify.output",
          op: "contains",
          right: "zzzz-never-matches",
        },
      },
    ],
  });
  console.log(`orchestration: ${orch.id} (${orch.steps.length} steps)\n`);

  console.log("executing…");
  const started = Date.now();
  const execution = (await executeOrchestration(orch.id, org.id, {
    input: {
      text: "The Solana validator finalized the block in 400 milliseconds.",
    },
    triggeredBy: "manual",
  })) as {
    id: string;
    status: string;
    output: unknown;
    error: string | null;
    durationMs: number | null;
  };
  const wall = Date.now() - started;

  const stepResults = await prisma.orchestrationStepResult.findMany({
    where: { executionId: execution.id },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nexecution ${execution.id}: ${execution.status} (${execution.durationMs}ms recorded, ${wall}ms wall)`);
  for (const r of stepResults) {
    const out =
      r.output && typeof r.output === "object" && "content" in r.output
        ? String((r.output as { content: unknown }).content).slice(0, 90)
        : "—";
    console.log(
      `  ${r.stepName.padEnd(10)} ${r.status.padEnd(8)} ${String(r.durationMs ?? 0).padStart(6)}ms  ${
        r.status === "skipped" ? `(${r.error})` : out
      }`,
    );
  }
  console.log(`\noutput: ${JSON.stringify(execution.output)}`);

  // --- assertions ---
  if (execution.status !== "completed") {
    fail(`execution failed: ${execution.error}`);
  }
  const byName = new Map(stepResults.map((r) => [r.stepName, r]));
  const classify = byName.get("classify");
  const summarize = byName.get("summarize");
  const skipme = byName.get("skipme");

  if (classify?.status !== "success") fail("classify did not succeed");
  if (summarize?.status !== "success") fail("summarize did not succeed");
  if (skipme?.status !== "skipped") fail("skipme should have been skipped");
  if (!classify.durationMs || classify.durationMs <= 0) {
    fail("classify has no measured duration — durations must be observed");
  }

  // The chaining proof: summarize's INPUT must equal classify's OUTPUT.
  const classifyOut = (classify.output as { content?: string })?.content;
  const summarizeIn = (summarize.input as { prompt?: string })?.prompt;
  if (!classifyOut || summarizeIn !== classifyOut) {
    fail(
      `chaining broken: summarize received ${JSON.stringify(summarizeIn)} but classify produced ${JSON.stringify(classifyOut)}`,
    );
  }
  console.log(`\n  chaining verified: summarize.input.prompt === classify.output === ${JSON.stringify(classifyOut)}`);

  const stats = await prisma.orchestration.findUnique({
    where: { id: orch.id },
    select: { totalRuns: true, successfulRuns: true, failedRuns: true, avgDurationMs: true },
  });
  console.log(`  stats: ${JSON.stringify(stats)}`);
  if (stats?.totalRuns !== 1 || stats.successfulRuns !== 1) {
    fail("run stats were not recorded");
  }

  console.log("\ncleaning up throwaway rows…");
  await prisma.orchestration.delete({ where: { id: orch.id } });
  await prisma.agent.deleteMany({
    where: { id: { in: [classifier.id, summarizer.id] } },
  });

  console.log("\n✅ orchestration engine proven end-to-end:");
  console.log("   real multi-agent inference, real step chaining, real skip,");
  console.log("   observed durations, recorded run stats.");

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
