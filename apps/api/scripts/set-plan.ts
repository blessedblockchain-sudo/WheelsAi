/**
 * Put an organization on a plan by hand.
 *
 *   cd apps/api && npx tsx scripts/set-plan.ts <organization> <starter|pro|enterprise> [--force] [--dry-run]
 *
 * <organization> is its id, its publisher slug, or the email of one of its
 * owners. A name that matches no organization, or more than one, changes
 * nothing and says so.
 *
 * pro and enterprise are written as an operator grant (status "manual").
 * starter removes the grant. The plan before and after is printed.
 *
 * An organization whose plan a Stripe subscription drives is refused: the
 * next Stripe event would undo the change. --force writes it anyway.
 * --dry-run reads, says what it would write, and writes nothing.
 *
 * It reads and writes the database DATABASE_URL names. It reads no chain.
 *
 * Exit code: 0 the plan is set (or was already, or a dry run), 1 refused or
 * failed, 2 bad arguments.
 */

import "dotenv/config";

import { prisma } from "../src/lib/prisma.js";
import {
  buildSetPlanDeps,
  describeSetPlanResult,
  isSettablePlan,
  setPlan,
  type SetPlanInput,
  type SetPlanPrisma,
} from "../src/services/setPlan.js";

const USAGE =
  "Usage: npx tsx scripts/set-plan.ts <organization> <starter|pro|enterprise> [--force] [--dry-run]\n" +
  "  <organization>  its id, its publisher slug, or an owner's email\n";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv: string[]): SetPlanInput | null {
  const words: string[] = [];
  let force = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) return null;
    else words.push(arg);
  }
  if (words.length !== 2) return null;
  const [organization, plan] = words;
  if (!isSettablePlan(plan)) return null;
  return { organization, plan, force, dryRun };
}

async function main(): Promise<number> {
  const input = parseArgs(process.argv.slice(2));
  if (!input) {
    process.stderr.write(USAGE);
    return 2;
  }
  const result = await setPlan(buildSetPlanDeps(prisma as unknown as SetPlanPrisma), input);
  const { lines, exitCode } = describeSetPlanResult(result, input);
  for (const line of lines) out(line);
  return exitCode;
}

main()
  .catch((err) => {
    process.stderr.write(`set-plan failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(code);
  });
