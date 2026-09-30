/**
 * One-shot backfill: seal agent environment variables written before
 * services/agentSecrets.ts existed. Rows already sealed are skipped, so
 * the script is safe to re-run. Covers live agents and version snapshots.
 *
 * Usage (from apps/api, with the API's env loaded):
 *   tsx scripts/seal-agent-env.ts            # dry run: counts only
 *   tsx scripts/seal-agent-env.ts --apply    # write sealed values
 *
 * Needs the same ENCRYPTION_KEY the API runs with; rows sealed under one
 * key cannot be opened under another.
 */
import { prisma } from "../src/lib/prisma.js";
import { isSealedAgentEnv, openAgentEnv, sealAgentEnv } from "../src/services/agentSecrets.js";

const apply = process.argv.includes("--apply");

async function sealTable(
  label: string,
  rows: { id: string; env: unknown }[],
  write: (id: string, env: ReturnType<typeof sealAgentEnv>) => Promise<unknown>,
): Promise<void> {
  let sealed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isSealedAgentEnv(row.env)) {
      skipped++;
      continue;
    }
    const next = sealAgentEnv(openAgentEnv(row.env));
    if (apply) await write(row.id, next);
    sealed++;
  }
  console.log(`${label}: ${sealed} ${apply ? "sealed" : "would be sealed"}, ${skipped} already sealed`);
}

async function main(): Promise<void> {
  const agents = await prisma.agent.findMany({ select: { id: true, env: true } });
  await sealTable("agents", agents, (id, env) =>
    prisma.agent.update({ where: { id }, data: { env } }),
  );
  const versions = await prisma.agentVersion.findMany({ select: { id: true, env: true } });
  await sealTable("agent_versions", versions, (id, env) =>
    prisma.agentVersion.update({ where: { id }, data: { env } }),
  );
  if (!apply) console.log("Dry run. Re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
