/**
 * D10 usage seeder: give the dogfood agent a model deployment and a
 * metered UsageRecord so the reputation-attestation worker has a
 * non-zero aggregate to attest on-chain.
 *
 * On devnet there is no payable Nosana host serving real inference, so
 * the usage row is seeded directly — the same documented substitution
 * the payment leg makes for recipient resolution (docs/D10-RUN.md).
 * Everything downstream of this row (aggregation, scoring, signing,
 * submission, on-chain mirror) is the production worker code.
 *
 * Idempotent: re-running creates only a new UsageRecord for the last
 * hour; the deployment chain is reused.
 *
 * Usage:
 *   tsx scripts/seed-d10-usage.ts <agentSlug> <computeSeconds> <requestCount>
 */

import { prisma } from "../src/lib/prisma.js";

const DEPLOYMENT_SLUG_SUFFIX = "-d10";

async function main() {
  const [, , slugArg, secondsArg, requestsArg] = process.argv;
  if (!slugArg || !secondsArg || !requestsArg) {
    console.error(
      "usage: tsx scripts/seed-d10-usage.ts <agentSlug> <computeSeconds> <requestCount>",
    );
    process.exit(2);
  }
  const computeSeconds = BigInt(secondsArg);
  const requestCount = Number(requestsArg);

  const agent = await prisma.agent.findFirst({
    where: { slug: slugArg },
    select: { id: true, orgId: true, name: true },
  });
  if (!agent) {
    console.error(`Agent with slug "${slugArg}" not found`);
    process.exit(1);
  }

  const model = await prisma.model.findFirst({ select: { id: true } });
  if (!model) {
    console.error("No models in catalog; run the DB seed first");
    process.exit(1);
  }

  const deploymentSlug = `${slugArg}${DEPLOYMENT_SLUG_SUFFIX}`;
  let deployment = await prisma.deployment.findFirst({
    where: { orgId: agent.orgId, slug: deploymentSlug },
  });
  if (!deployment) {
    deployment = await prisma.deployment.create({
      data: {
        orgId: agent.orgId,
        name: `${agent.name} (D10 usage)`,
        slug: deploymentSlug,
        modelId: model.id,
        engine: "vllm",
        gpuTier: "4090",
        config: { seededBy: "seed-d10-usage" },
        status: "running",
        nosanaJobIds: [],
      },
    });
  }

  const agentDeployment = await prisma.agentDeployment.findFirst({
    where: { agentId: agent.id, modelDeploymentId: deployment.id },
  });
  if (!agentDeployment) {
    await prisma.agentDeployment.create({
      data: {
        agentId: agent.id,
        gpuTier: "4090",
        modelDeploymentId: deployment.id,
        status: "running",
      },
    });
  }

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);
  const usage = await prisma.usageRecord.create({
    data: {
      orgId: agent.orgId,
      deploymentId: deployment.id,
      periodStart,
      periodEnd,
      requestCount,
      errorCount: 0,
      computeSeconds,
      inputTokens: BigInt(requestCount) * 200n,
      outputTokens: BigInt(requestCount) * 400n,
      totalLatencyMs: BigInt(requestCount) * 900n,
    },
  });

  console.log(
    JSON.stringify(
      {
        agentId: agent.id,
        deploymentId: deployment.id,
        usageRecordId: usage.id,
        periodStart,
        periodEnd,
        computeSeconds: computeSeconds.toString(),
        requestCount,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
