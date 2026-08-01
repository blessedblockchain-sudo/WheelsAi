/**
 * Composition root for the deployment-status poll tick (plan D8).
 *
 * Wires for runDeploymentStatusTick:
 *   loadDeployments    → AgentDeployment + model Deployment rows in
 *                        non-terminal states that have Nosana job ids;
 *                        model rows carry their DeploymentNodes for the
 *                        health probe (agents have no nodes relation)
 *   getJobState        → NosanaClient.getJobStatusStrict (THROWS on
 *                        SDK/RPC failure so rows stay untouched), with
 *                        the env-gated dev mock short-circuit
 *   persistTransition  → compare-and-set updateMany on {id, fromStatus}
 *   checkNodeHealth    → NosanaClient.checkNodeHealth (HTTP /health
 *                        probe, never throws)
 *   persistNodeHealth  → updateMany by node id (race-safe: the node may
 *                        have been cascade-deleted with its deployment
 *                        between load and write — count=0 beats P2025)
 *
 * Status vocabularies (schema comments are the source of truth):
 *   AgentDeployment: pending | building | deploying | running | stopped | failed
 *   Deployment:      pending | provisioning | running | degraded | stopped | failed
 *
 * "running" rows ARE polled: a running deployment whose job completes or
 * fails on Nosana must be observed into stopped/failed — that was the
 * other half of the setTimeout lie (the fake flip to running was never
 * followed by any real observation again).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import type { NosanaJob } from "./nosana.js";
import type {
  DeploymentStatusRow,
  DeploymentStatusTickDeps,
  NodeHealthObservation,
} from "./runDeploymentStatusTick.js";

/** Everything except stopped/failed — rows worth polling. */
export const AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES = [
  "pending",
  "building",
  "deploying",
  "running",
];
export const MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "degraded",
];

interface AgentDeploymentDelegateStub {
  findMany: (args: {
    where: {
      status: { in: string[] };
      nosanaJobIds: { isEmpty: false };
    };
    select: { id: true; status: true; nosanaJobIds: true };
  }) => Promise<
    Array<{ id: string; status: string; nosanaJobIds: string[] }>
  >;
  updateMany: (args: {
    where: { id: string; status: string };
    data: {
      status: string;
      stoppedAt?: Date;
      lastError?: string;
    };
  }) => Promise<{ count: number }>;
}

interface ModelDeploymentDelegateStub {
  findMany: (args: {
    where: {
      status: { in: string[] };
      nosanaJobIds: { isEmpty: false };
    };
    select: {
      id: true;
      status: true;
      nosanaJobIds: true;
      nodes: { select: { id: true; nodeUrl: true; healthStatus: true } };
    };
  }) => Promise<
    Array<{
      id: string;
      status: string;
      nosanaJobIds: string[];
      nodes: Array<{ id: string; nodeUrl: string; healthStatus: string }>;
    }>
  >;
  updateMany: (args: {
    where: { id: string; status: string };
    data: {
      status: string;
      stoppedAt?: Date;
    };
  }) => Promise<{ count: number }>;
}

interface DeploymentNodeDelegateStub {
  updateMany: (args: {
    where: { id: string };
    data: {
      healthStatus: string;
      lastHealthCheck: Date;
      latencyMs: number;
    };
  }) => Promise<{ count: number }>;
}

type DeploymentStatusPrismaSurface =
  | Pick<PrismaClient, "agentDeployment" | "deployment" | "deploymentNode">
  | {
      agentDeployment: AgentDeploymentDelegateStub;
      deployment: ModelDeploymentDelegateStub;
      deploymentNode: DeploymentNodeDelegateStub;
    };

// Type-level guard: the stub findMany/updateMany args must remain valid
// Prisma args for their delegates.
type _AgentArgsCheck = Parameters<
  AgentDeploymentDelegateStub["findMany"]
>[0] extends Prisma.AgentDeploymentFindManyArgs
  ? true
  : never;
type _ModelArgsCheck = Parameters<
  ModelDeploymentDelegateStub["findMany"]
>[0] extends Prisma.DeploymentFindManyArgs
  ? true
  : never;
type _NodeArgsCheck = Parameters<
  DeploymentNodeDelegateStub["updateMany"]
>[0] extends Prisma.DeploymentNodeUpdateManyArgs
  ? true
  : never;
const _argsCheck: [_AgentArgsCheck, _ModelArgsCheck, _NodeArgsCheck] = [
  true,
  true,
  true,
];
void _argsCheck;

export interface BuildDeploymentStatusTickDepsInput {
  prisma: DeploymentStatusPrismaSurface;
  /** Strict read — must THROW on SDK/RPC failure (getJobStatusStrict). */
  getJobStatus: (jobId: string) => Promise<NosanaJob>;
  /** HTTP /health probe (NosanaClient.checkNodeHealth — never throws). */
  checkNodeHealth: (
    nodeUrl: string,
  ) => Promise<{ healthy: boolean; latencyMs: number }>;
  /**
   * env.ALLOW_NOSANA_MOCK. Dev-only: mock ids are treated as running
   * instead of being polled on-chain. Production boot REJECTS the flag
   * (validateEnv), so this branch cannot run there.
   */
  allowMock: boolean;
}

function isMockNosanaId(jobId: string): boolean {
  // submitJob's fallback mints mock_job_*; createDeployment's mints
  // mock_deploy_* — agent deployments store the latter as their job id.
  return jobId.startsWith("mock_job_") || jobId.startsWith("mock_deploy_");
}

export function buildDeploymentStatusTickDeps(
  input: BuildDeploymentStatusTickDepsInput,
): DeploymentStatusTickDeps {
  const prisma = input.prisma as {
    agentDeployment: AgentDeploymentDelegateStub;
    deployment: ModelDeploymentDelegateStub;
    deploymentNode: DeploymentNodeDelegateStub;
  };

  return {
    loadDeployments: async () => {
      const [agentRows, modelRows] = await Promise.all([
        prisma.agentDeployment.findMany({
          where: {
            status: { in: AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES },
            nosanaJobIds: { isEmpty: false },
          },
          select: { id: true, status: true, nosanaJobIds: true },
        }),
        prisma.deployment.findMany({
          where: {
            status: { in: MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES },
            nosanaJobIds: { isEmpty: false },
          },
          select: {
            id: true,
            status: true,
            nosanaJobIds: true,
            nodes: { select: { id: true, nodeUrl: true, healthStatus: true } },
          },
        }),
      ]);

      const rows: DeploymentStatusRow[] = [
        ...agentRows.map((r) => ({
          kind: "agent" as const,
          id: r.id,
          status: r.status,
          nosanaJobIds: r.nosanaJobIds,
        })),
        ...modelRows.map((r) => ({
          kind: "model" as const,
          id: r.id,
          status: r.status,
          nosanaJobIds: r.nosanaJobIds,
          nodes: r.nodes,
        })),
      ];
      return rows;
    },

    getJobState: async (jobId) => {
      if (input.allowMock && isMockNosanaId(jobId)) {
        // Dev-only (env-gated): mock jobs never reach the chain, treat
        // them as running so local flows can exercise the running path.
        return "running";
      }
      const job = await input.getJobStatus(jobId);
      return job.status;
    },

    persistTransition: async (t) => {
      // Compare-and-set: WHERE includes the observed fromStatus, so a
      // concurrent writer (user stop, another replica) wins and this
      // tick's stale observation becomes a count=0 no-op.
      const terminal = t.toStatus === "stopped" || t.toStatus === "failed";
      const base = {
        status: t.toStatus,
        // Both models have stoppedAt; neither has startedAt. Record the
        // observation time when the deployment leaves service.
        ...(terminal ? { stoppedAt: t.observedAt } : {}),
      };

      if (t.kind === "agent") {
        return prisma.agentDeployment.updateMany({
          where: { id: t.id, status: t.fromStatus },
          data: {
            ...base,
            // AgentDeployment carries a lastError surface; record why.
            ...(t.toStatus === "failed"
              ? { lastError: "Nosana reported job failure" }
              : {}),
          },
        });
      }
      return prisma.deployment.updateMany({
        where: { id: t.id, status: t.fromStatus },
        data: base,
      });
    },

    checkNodeHealth: (nodeUrl) => input.checkNodeHealth(nodeUrl),

    persistNodeHealth: async (obs: NodeHealthObservation) => {
      // updateMany, not update: the node may have been cascade-deleted
      // with its deployment between load and write — count=0 beats a
      // thrown P2025 killing the row's remaining probes.
      await prisma.deploymentNode.updateMany({
        where: { id: obs.nodeId },
        data: {
          healthStatus: obs.healthStatus,
          lastHealthCheck: obs.checkedAt,
          latencyMs: obs.latencyMs,
        },
      });
    },
  };
}
