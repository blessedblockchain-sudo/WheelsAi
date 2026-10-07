/**
 * Read-only look at what Nosana reports for one training deployment. Spends nothing.
 *
 *   cd apps/api && npx tsx scripts/nosana-training-job-check.ts <nosana deployment id>
 *
 * The deployment id is `training_jobs.nosana_job_id` (also in the API log line
 * "Training job submitted to Nosana"). The script reads the same environment
 * the API reads and uses the API's own Nosana client, so it sees exactly what
 * the training poller sees. It calls two reads and nothing else:
 * getDeploymentStatus and getDeploymentJob.
 *
 * It exists for the first paid fine-tuning run (docs/FINE-TUNE-RUN.md, part 2),
 * to settle what the poller's code assumes from the SDK's types:
 *   - whether a deployment of strategy SIMPLE lists exactly one job;
 *   - the raw `state`, `timeStart` and `timeEnd` of that job, and how this
 *     code reads them (their unit is not documented);
 *   - whether a finished (confidential) job's result is readable at all, and
 *     its shape: opStates, the exit code, the log entries;
 *   - whether the trainer's WHEELSAI_EVENT lines can be recovered from it.
 *
 * It prints shapes and counts, never log text: a training log can quote rows
 * of the customer's dataset. Event lines are reported by type only.
 *
 * Exit code: 0 read, 1 could not be read, 2 wrong arguments.
 */

/* eslint-disable no-console */

import "dotenv/config";

import { getNosanaClient } from "../src/services/nosana.js";
import { readTrainerJobResult } from "../src/services/trainingJobs.js";
import { isTerminalTrainerEvent, parseTrainerEventsFromLog } from "../src/services/trainingStateMachine.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const iso = (value: Date | null) => (value ? value.toISOString() : "not set");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^[A-Za-z0-9_-]{4,128}$/.test(args[0]!)) {
    console.error("Usage: npx tsx scripts/nosana-training-job-check.ts <nosana deployment id>   (one argument; read-only)");
    return 2;
  }
  const deploymentId = args[0]!;
  const nosana = await getNosanaClient();
  console.log("Nosana training job check - read-only (two reads, nothing is created, started or stopped)");
  console.log(`time: ${new Date().toISOString()}`);
  console.log(`access mode: ${nosana.getAccessMode()} | network: ${nosana.getNetwork()}`);
  if (nosana.getAccessMode() === "none") {
    console.error("No Nosana credential is configured: nothing can be read.");
    return 1;
  }

  const deployment = await nosana.getDeploymentStatus(deploymentId);
  console.log(`\ndeployment ${deploymentId}`);
  console.log(`  status (as this code reads it): ${deployment.status}`);
  console.log(`  jobs listed: ${deployment.jobs.length}${deployment.jobs.length === 1 ? "" : "   <- the poller follows the FIRST one"}`);
  for (const job of deployment.jobs) {
    const entry = job as unknown as Record<string, unknown>;
    console.log(`    job ${String(entry.job).slice(0, 8)}...  fields: ${Object.keys(entry).sort().join(", ")}`);
  }
  const first = deployment.jobs[0]?.job;
  if (!first) {
    console.log("  no job yet: no node has taken it (or the deployment never listed one)");
    return 0;
  }

  const job = await nosana.getDeploymentJob(deploymentId, first);
  console.log(`\njob ${first.slice(0, 8)}...`);
  console.log(`  state: raw ${JSON.stringify(job.rawState)} -> read as "${job.state}"`);
  console.log(`  host node: ${job.node ?? "not set"} | market: ${job.market ?? "not set"}`);
  console.log(`  timeStart: raw ${JSON.stringify(job.raw.timeStart ?? null)} -> read as ${iso(job.timeStart)}`);
  console.log(`  timeEnd:   raw ${JSON.stringify(job.raw.timeEnd ?? null)} -> read as ${iso(job.timeEnd)}`);
  console.log(`  listedAt:  raw ${JSON.stringify(job.raw.listedAt ?? null)} -> read as ${iso(job.listedAt)}`);
  if (job.timeStart && job.timeEnd) {
    console.log(`  timeEnd - timeStart as read: ${((job.timeEnd.getTime() - job.timeStart.getTime()) / 1000).toFixed(0)} s`);
  }
  console.log("  A raw value near 1.8e9 is unix seconds, near 1.8e12 milliseconds. Compare the times as read with the");
  console.log("  trainer's own `started` and `completed` event timestamps on the job's page.");

  const result = job.jobResult;
  console.log(`\njob result: ${result === null || result === undefined ? "NOT PRESENT" : `present, ${isRecord(result) ? `fields: ${Object.keys(result).sort().join(", ")}` : `a ${typeof result}`}`}`);
  const ops = isRecord(result) && Array.isArray(result.opStates) ? result.opStates : [];
  console.log(`  opStates: ${ops.length}`);
  for (const op of ops) {
    if (!isRecord(op)) continue;
    const logs = Array.isArray(op.logs) ? op.logs : [];
    const firstLog = logs.find(isRecord);
    const types = [...new Set(logs.filter(isRecord).map((entry) => String(entry.type)))];
    console.log(`    op "${String(op.operationId)}": fields ${Object.keys(op).sort().join(", ")}`);
    console.log(`      exitCode ${JSON.stringify(op.exitCode ?? null)} | status ${JSON.stringify(op.status ?? null)} | log entries ${logs.length}`);
    console.log(`      a log entry's fields: ${firstLog ? Object.keys(firstLog).sort().join(", ") : "-"} | entry types seen: ${types.join(", ") || "-"}`);
    const multiline = logs.filter(isRecord).filter((entry) => typeof entry.log === "string" && entry.log.trimEnd().includes("\n")).length;
    console.log(`      entries holding more than one line: ${multiline}`);
  }

  const read = readTrainerJobResult(result);
  const events = read.logText ? parseTrainerEventsFromLog(read.logText) : [];
  const terminal = [...events].reverse().find(isTerminalTrainerEvent);
  console.log("\nas the poller reads it");
  console.log(`  exit code: ${read.exitCode === null ? "none" : read.exitCode}`);
  console.log(`  log text: ${read.logText === null ? "none" : `${read.logText.length} characters, ${read.logText.split("\n").length} lines`}`);
  console.log(`  trainer events recovered: ${events.length}${events.length > 0 ? ` (seq ${events[0]!.seq}..${events[events.length - 1]!.seq}: ${events.map((event) => event.type).join(" ")})` : ""}`);
  console.log(`  final event: ${terminal ? terminal.type : "none"}`);
  if (read.logText !== null && events.length === 0) {
    console.log("  The log is readable but no line BEGINS with 'WHEELSAI_EVENT ': Nosana prefixes or wraps the lines in a way");
    console.log("  readTrainerJobResult does not strip. Record the first 40 characters of one such line by hand.");
  }
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    const e = err as { code?: unknown; message?: unknown };
    console.error(`Could not be read: ${typeof e.code === "string" ? `${e.code}: ` : ""}${String(e.message ?? err).slice(0, 300)}`);
    process.exit(1);
  },
);
