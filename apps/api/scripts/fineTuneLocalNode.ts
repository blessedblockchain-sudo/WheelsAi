/**
 * A stand-in GPU node for the local fine-tuning proof
 * (scripts/run-fine-tune-local-proof.ts).
 *
 * It sits on top of the fake Nosana REST API of the unit tests
 * (src/tests/fakeNosanaApi.ts), which the REAL @nosana/sdk client talks to.
 * The fake only stores what it is sent; this file makes a training deployment
 * actually run: when a deployment named `wheelsai-train-*` is started, it waits
 * a moment (the queue), then launches the training container's entrypoint
 * (infra/training/train.py) as a local CPU process with the environment the
 * submitted job definition carries, and reports the job the way the service
 * expects to read it from Nosana:
 *
 *   - the deployment goes STARTING -> RUNNING -> STOPPED, and lists one job;
 *   - GET .../jobs/<job> answers state, timeStart, timeEnd (unix seconds) and,
 *     once the process has exited, jobResult.opStates[0] with the exit code
 *     and every line the process printed;
 *   - a stop request sends the process SIGTERM (the trainer's exit 30).
 *
 * What it is NOT: Nosana, a container runtime or a GPU. The job result's
 * shape, the unit of the time fields, the moment logs become readable and
 * the signal a host sends are this file's choices, taken from the SDK's types.
 * Nothing observed here says anything about the live network.
 *
 * Two things differ from the submitted definition, both on purpose and both
 * printed when they happen:
 *   - BASE_MODEL is replaced by a small model that is cached on this machine
 *     (the catalog models need a GPU);
 *   - a scenario may override or remove variables (an unreachable callback
 *     URL, a base model that does not exist) to provoke one outcome.
 */

/* eslint-disable no-console */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  startFakeNosanaApi,
  type FakeDeployment,
  type FakeNosanaApi,
} from "../src/tests/fakeNosanaApi.js";

export const TRAINING_DEPLOYMENT_PREFIX = "wheelsai-train-";

/** How the node treats the next training deployment that is started. */
export interface LocalNodeBehaviour {
  /** Milliseconds between the start request and a node taking the job. */
  takeAfterMs?: number;
  /** No node ever takes the job: it stays queued until it is stopped. */
  neverTake?: boolean;
  /** Variables set on top of the definition's; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  /** Why the overrides are there, printed with them. */
  note?: string;
}

export interface LocalNodeRun {
  deploymentId: string;
  deploymentName: string;
  jobAddress: string | null;
  phase: "queued" | "running" | "exited" | "never_taken";
  /** What the service submitted, as the stand-in API received it. */
  definition: unknown;
  /** The environment of the definition (names only are safe to print). */
  definitionEnv: Record<string, string>;
  /** Names of the variables the node changed or removed. */
  overridden: string[];
  exitCode: number | null;
  signal: string | null;
  timeStart: number | null;
  timeEnd: number | null;
  lines: Array<{ type: "stdout" | "stderr"; log: string }>;
  stopSignalledAt: number | null;
}

export interface LocalNodeOptions {
  apiKey: string;
  port: number;
  /** The interpreter of the trainer's environment. */
  python: string;
  /** infra/training/train.py */
  trainerEntrypoint: string;
  /** HF_HOME holding the cached base model. */
  hfHome: string;
  /** The model the trainer loads in place of the catalog model. */
  substituteBaseModel: string;
  defaultTakeAfterMs?: number;
  log?(message: string): void;
}

export interface LocalNode {
  fake: FakeNosanaApi;
  /** Applies to the next training deployment started, then resets. */
  planNext(behaviour: LocalNodeBehaviour): void;
  runs(): LocalNodeRun[];
  runFor(deploymentName: string): LocalNodeRun | undefined;
  close(): Promise<void>;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A made-up address in the shape of a Solana account (44 base58 characters). */
function fakeAddress(): string {
  return Array.from(randomBytes(44), (byte) => BASE58[byte % BASE58.length]).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The environment of the definition's one container op; {} when it has none. */
export function definitionEnvironment(definition: unknown): Record<string, string> {
  const ops = isRecord(definition) && Array.isArray(definition.ops) ? definition.ops : [];
  const op = ops.find(isRecord);
  const args = op && isRecord(op.args) ? op.args : null;
  const env = args && isRecord(args.env) ? args.env : {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

export async function startLocalNode(options: LocalNodeOptions): Promise<LocalNode> {
  const log = options.log ?? ((message: string) => console.log(message));
  const fake = await startFakeNosanaApi({ apiKey: options.apiKey, port: options.port });
  const runs = new Map<string, LocalNodeRun>();
  const processes = new Map<string, ChildProcess>();
  const workDirs: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let next: LocalNodeBehaviour | null = null;
  let closed = false;

  const submitted = (deployment: FakeDeployment): unknown => {
    const request = [...fake.requests]
      .reverse()
      .find(
        (entry) =>
          entry.method === "POST" &&
          entry.path === "/api/deployments/create" &&
          isRecord(entry.body) &&
          entry.body.name === deployment.name,
      );
    return isRecord(request?.body) ? request.body.job_definition : undefined;
  };

  const publishJob = (run: LocalNodeRun, state: "RUNNING" | "COMPLETED" | "STOPPED") => {
    if (!run.jobAddress) return;
    fake.setJob(run.deploymentId, run.jobAddress, {
      state,
      node: "LocaLCpuNode1111111111111111111111111111111",
      timeStart: run.timeStart ?? 0,
      timeEnd: run.timeEnd ?? 0,
      // The result exists once the process has exited, not before.
      jobResult:
        run.phase === "exited"
          ? {
              status: run.exitCode === 0 ? "success" : "failed",
              opStates: [
                {
                  operationId: "train",
                  status: run.exitCode === 0 ? "success" : "failed",
                  exitCode: run.exitCode,
                  logs: run.lines,
                },
              ],
            }
          : null,
    });
  };

  const take = (deployment: FakeDeployment, run: LocalNodeRun, behaviour: LocalNodeBehaviour) => {
    if (closed || deployment.status !== "STARTING") return;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? tmpdir(),
      HF_HOME: options.hfHome,
      // The Hub is off: the node loads the cached model or fails.
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      ...run.definitionEnv,
      BASE_MODEL: options.substituteBaseModel,
    };
    run.overridden = ["BASE_MODEL"];
    for (const [name, value] of Object.entries(behaviour.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
      if (!run.overridden.includes(name)) run.overridden.push(name);
    }

    const workDir = mkdtempSync(path.join(tmpdir(), "wheelsai-ft-proof-"));
    workDirs.push(workDir);
    run.jobAddress = fakeAddress();
    run.phase = "running";
    run.timeStart = Math.floor(Date.now() / 1000);
    deployment.status = "RUNNING";
    deployment.jobs.push({
      job: run.jobAddress,
      status: "RUNNING",
      tx: fakeAddress(),
      deployment: deployment.id,
      revision: 1,
      created_at: new Date().toISOString(),
    });
    deployment.updated_at = new Date().toISOString();
    publishJob(run, "RUNNING");
    log(
      `[node] ${deployment.name}: a node took the job; trainer started ` +
        `(replaced or removed: ${run.overridden.join(", ")}${behaviour.note ? `; ${behaviour.note}` : ""})`,
    );

    const child = spawn(
      options.python,
      [options.trainerEntrypoint, "--device", "cpu", "--work-dir", workDir],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    processes.set(deployment.id, child);
    const collect = (type: "stdout" | "stderr") => {
      let rest = "";
      return (chunk: Buffer) => {
        const parts = (rest + chunk.toString("utf8")).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) run.lines.push({ type, log: line });
      };
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    child.on("exit", (code, signal) => {
      processes.delete(deployment.id);
      run.phase = "exited";
      // A process killed by a signal has no code; a shell would report 128 + n.
      run.exitCode = code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : null);
      run.signal = signal;
      run.timeEnd = Math.max(Math.floor(Date.now() / 1000), run.timeStart ?? 0);
      const stopped = run.stopSignalledAt !== null;
      const job = deployment.jobs.find((entry) => entry.job === run.jobAddress);
      if (job) job.status = stopped ? "STOPPED" : "COMPLETED";
      publishJob(run, stopped ? "STOPPED" : "COMPLETED");
      // A SIMPLE deployment is over when its one job is.
      deployment.status = "STOPPED";
      deployment.updated_at = new Date().toISOString();
      log(`[node] ${deployment.name}: trainer exited with code ${run.exitCode}${signal ? ` (${signal})` : ""}`);
    });
  };

  const tick = () => {
    for (const deployment of fake.deployments.values()) {
      if (!deployment.name.startsWith(TRAINING_DEPLOYMENT_PREFIX)) {
        // Anything else (a model deployment) has no node here: a stop settles at once.
        if (deployment.status === "STOPPING") deployment.status = "STOPPED";
        continue;
      }
      let run = runs.get(deployment.id);
      if (!run && deployment.status === "STARTING") {
        const behaviour = next ?? {};
        next = null;
        const definition = submitted(deployment);
        run = {
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          jobAddress: null,
          phase: behaviour.neverTake ? "never_taken" : "queued",
          definition,
          definitionEnv: definitionEnvironment(definition),
          overridden: [],
          exitCode: null,
          signal: null,
          timeStart: null,
          timeEnd: null,
          lines: [],
          stopSignalledAt: null,
        };
        runs.set(deployment.id, run);
        if (behaviour.neverTake) {
          log(`[node] ${deployment.name}: queued; no node will take it`);
        } else {
          const started = run;
          const timer = setTimeout(() => {
            timers.delete(timer);
            take(deployment, started, behaviour);
          }, behaviour.takeAfterMs ?? options.defaultTakeAfterMs ?? 4_000);
          timers.add(timer);
        }
        continue;
      }
      if (deployment.status === "STOPPING") {
        const child = processes.get(deployment.id);
        if (child && run && run.stopSignalledAt === null) {
          run.stopSignalledAt = Date.now();
          child.kill("SIGTERM");
          log(`[node] ${deployment.name}: stop requested; SIGTERM sent to the trainer`);
        } else if (child && run && Date.now() - (run.stopSignalledAt ?? 0) > 20_000) {
          child.kill("SIGKILL");
        } else if (!child) {
          deployment.status = "STOPPED";
          deployment.updated_at = new Date().toISOString();
        }
      }
    }
  };
  const interval = setInterval(tick, 200);

  return {
    fake,
    planNext: (behaviour) => {
      next = behaviour;
    },
    runs: () => [...runs.values()],
    runFor: (deploymentName) => [...runs.values()].find((run) => run.deploymentName === deploymentName),
    close: async () => {
      closed = true;
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      const exits = [...processes.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          }),
      );
      await Promise.all(exits);
      for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
      await fake.close();
    },
  };
}
