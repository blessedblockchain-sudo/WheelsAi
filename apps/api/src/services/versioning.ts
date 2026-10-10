import { prisma, Prisma } from "@wheelsai/db";
import { DEFAULT_AGENT_KIND, isAgentKind } from "@wheelsai/shared/agent-kind";

import { cloneKindConfig } from "./agentKind.js";
import { setOwnScheduleEnabled, type OwnScheduleDb } from "./agentOwnSchedule.js";
import { findUseListing, isPaidUse, ON_SALE_FOR_USE_MESSAGES, type UseListingDb } from "./useListing.js";

// ============================================
// Types
// ============================================

/**
 * Every exported function in this module takes an AgentScope rather than a
 * bare agentId, and resolves it through assertAgentInOrg() before touching
 * AgentVersion rows.
 *
 * This used to be a bare `agentId: string` with no tenancy check anywhere in
 * the route or the service. Because AgentVersion snapshots `sourceCode`,
 * `systemPrompt`, and `env` (the agent's environment variables), any
 * authenticated user who knew or guessed an agent UUID could read another
 * org's source and secrets — and rollbackToVersion's
 * `prisma.agent.update({where:{id: agentId}})` let them overwrite that org's
 * live agent config.
 *
 * The scope is an object, not a trailing parameter, so that adding it is a
 * compile error at every call site instead of a silently-skippable argument.
 */
export interface AgentScope {
  agentId: string;
  /** The caller's organization, from `request.auth.orgId`. */
  orgId: string;
}

/**
 * Thrown when the agent does not exist OR belongs to another org. The two
 * cases are deliberately indistinguishable to the caller — distinguishing
 * them turns this API into an agent-ID existence oracle.
 */
/**
 * A rollback that would put an agent whose use is on sale into a state its
 * buyers cannot use: answering through its graph, or running on its own
 * while sold at a price per use. The route answers 409 on_sale_for_use with
 * `message`, a sentence written for the agent's owner (the ones an edit of
 * the agent is refused with). Nothing was restored.
 */
export class OnSaleForUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnSaleForUseError";
  }
}

/**
 * The check for an agent on sale could not be made, because its listing
 * could not be read. The rollback fails closed and restores nothing, and the
 * route answers 503 with this sentence, never with the database's own words.
 */
export class SaleCheckUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This rollback could not be checked right now, so nothing was restored. Try again in a moment.", options);
    this.name = "SaleCheckUnavailableError";
  }
}

export class AgentNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super("Agent not found");
    this.name = "AgentNotFoundError";
  }
}

/**
 * Resolve an AgentScope, or throw. Must be the first await in every exported
 * function that reaches AgentVersion/AgentVersionDiff/Agent rows.
 */
async function assertAgentInOrg({ agentId, orgId }: AgentScope): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, orgId },
    select: { id: true },
  });

  if (!agent) {
    throw new AgentNotFoundError();
  }
}

export type ChangeType = "major" | "minor" | "patch";

/**
 * Who is creating the version. An API key belongs to an org and has no user
 * behind it, so it is recorded as the key itself; passing a made-up user id
 * for it used to fail on the author column, after rollback had already
 * overwritten the agent.
 */
export type VersionAuthor =
  | { type: "user"; userId: string }
  | { type: "api_key"; apiKeyId: string; name?: string | null; keyPrefix?: string };

export interface CreateVersionInput {
  changeLog?: string;
  changeType?: ChangeType;
  tags?: string[];
  /**
   * Display name for an actor the platform has no account for (a GitHub
   * pusher). Server-side callers only: routes must not pass a request body
   * through, or a caller could sign versions with someone else's name.
   */
  createdByName?: string;
}

type Db = Prisma.TransactionClient;

/**
 * Lock the agent row for the rest of the transaction, or throw when it is not
 * in the caller's org. Version numbers are "latest + 1" and rollback rewrites
 * the agent before snapshotting it, so two writers on one agent must take
 * turns; the conditional write is also the tenancy check.
 */
async function lockAgentInOrg(tx: Db, { agentId, orgId }: AgentScope): Promise<void> {
  const locked = await tx.agent.updateMany({
    where: { id: agentId, orgId },
    data: { updatedAt: new Date() },
  });

  if (locked.count !== 1) {
    throw new AgentNotFoundError();
  }
}

async function resolveAuthor(
  tx: Db,
  author: VersionAuthor,
): Promise<{ createdById: string | null; createdByApiKeyId: string | null; createdByName: string }> {
  if (author.type === "api_key") {
    const label = author.name || author.keyPrefix;
    return {
      createdById: null,
      createdByApiKeyId: author.apiKeyId,
      createdByName: label ? `API key (${label})` : "API key",
    };
  }

  const user = await tx.user.findUnique({
    where: { id: author.userId },
    select: { displayName: true, email: true },
  });

  return {
    createdById: author.userId,
    createdByApiKeyId: null,
    createdByName: user?.displayName || user?.email || "Unknown",
  };
}

export interface VersionSnapshot {
  name: string;
  description: string | null;
  framework: string;
  systemPrompt: string | null;
  tools: any[];
  modelConfig: Record<string, any>;
  sourceType: string;
  sourceUrl: string | null;
  sourceCode: string | null;
  env: Record<string, any>;
  graphNodes?: any[];
  graphEdges?: any[];
  entrypoint?: string | null;
  /** Null on a version taken before agents had a kind. */
  agentKind?: string | null;
  kindConfig?: Record<string, any> | null;
}

// ============================================
// Version Management
// ============================================

/**
 * Create a new version of an agent
 *
 * `author` is a VersionAuthor; a bare string is a user id.
 */
export async function createAgentVersion(
  scope: AgentScope,
  author: VersionAuthor | string,
  input: CreateVersionInput = {}
) {
  // One transaction: a failure part-way must not leave the agent with no
  // latest version, or with a version string no snapshot backs.
  return prisma.$transaction(async (tx) => {
    await lockAgentInOrg(tx, scope);
    return snapshotAgentVersion(tx, scope, author, input);
  });
}

/**
 * Snapshot the agent as it stands inside `tx`. The caller holds the agent's
 * row lock.
 */
async function snapshotAgentVersion(
  tx: Db,
  scope: AgentScope,
  author: VersionAuthor | string,
  input: CreateVersionInput
) {
  const { agentId, orgId } = scope;

  const agent = await tx.agent.findFirst({
    where: { id: agentId, orgId },
    include: {
      graph: true,
    },
  });

  if (!agent) {
    throw new AgentNotFoundError();
  }

  // Get the latest version number
  const latestVersion = await tx.agentVersion.findFirst({
    where: { agentId },
    orderBy: { versionNumber: "desc" },
  });

  const versionNumber = (latestVersion?.versionNumber || 0) + 1;

  // Calculate new version string
  const newVersion = calculateNewVersion(
    latestVersion?.version || "0.0.0",
    input.changeType || "patch"
  );

  const createdBy = await resolveAuthor(
    tx,
    typeof author === "string" ? { type: "user", userId: author } : author
  );

  // Mark all existing versions as not latest
  await tx.agentVersion.updateMany({
    where: { agentId, isLatest: true },
    data: { isLatest: false },
  });

  // Create the new version
  const version = await tx.agentVersion.create({
    data: {
      agentId,
      version: newVersion,
      versionNumber,
      name: agent.name,
      description: agent.description,
      framework: agent.framework,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools as any,
      modelConfig: agent.modelConfig as any,
      sourceType: agent.sourceType,
      sourceUrl: agent.sourceUrl,
      sourceCode: agent.sourceCode,
      env: agent.env as any,
      graphNodes: agent.graph?.nodes as any,
      graphEdges: agent.graph?.edges as any,
      // Whether the agent answers as a chat or through its graph is part of
      // what a version is: the same prompt and graph behave differently.
      entrypoint: agent.entrypoint === "graph" ? "graph" : "chat",
      // How the agent is used, and that kind's settings (the task form, the
      // suggested schedule), are part of the version too. A copy, so a later
      // edit of the agent cannot reach into this snapshot.
      agentKind: isAgentKind(agent.agentKind) ? agent.agentKind : DEFAULT_AGENT_KIND,
      kindConfig: cloneKindConfig(agent.kindConfig) ?? Prisma.DbNull,
      changeLog: input.changeLog,
      changeType: input.changeType || "patch",
      tags: input.tags || [],
      createdById: createdBy.createdById,
      createdByApiKeyId: createdBy.createdByApiKeyId,
      createdByName: input.createdByName || createdBy.createdByName,
      isLatest: true,
    },
  });

  // Update agent version field
  await tx.agent.update({
    where: { id: agentId },
    data: { version: newVersion },
  });

  // Create diff from previous version if exists
  if (latestVersion) {
    await createVersionDiff(tx, agentId, latestVersion.version, newVersion);
  }

  return version;
}

/**
 * Get all versions of an agent
 */
export async function getAgentVersions(
  scope: AgentScope,
  options: {
    limit?: number;
    offset?: number;
  } = {}
) {
  await assertAgentInOrg(scope);
  const { agentId } = scope;
  const { limit = 20, offset = 0 } = options;

  const [versions, total] = await Promise.all([
    prisma.agentVersion.findMany({
      where: { agentId },
      orderBy: { versionNumber: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        version: true,
        versionNumber: true,
        changeLog: true,
        changeType: true,
        tags: true,
        createdById: true,
        createdByName: true,
        isLatest: true,
        isPublished: true,
        createdAt: true,
      },
    }),
    prisma.agentVersion.count({ where: { agentId } }),
  ]);

  return { versions, total };
}

/**
 * Get a specific version of an agent
 */
export async function getAgentVersion(scope: AgentScope, version: string) {
  await assertAgentInOrg(scope);

  return prisma.agentVersion.findUnique({
    where: {
      agentId_version: { agentId: scope.agentId, version },
    },
  });
}

/**
 * Get the latest version of an agent
 */
export async function getLatestVersion(scope: AgentScope) {
  await assertAgentInOrg(scope);

  return prisma.agentVersion.findFirst({
    where: { agentId: scope.agentId, isLatest: true },
  });
}

/**
 * Rollback agent to a specific version
 *
 * Restoring the agent, restoring its graph and recording the rollback as a
 * new version commit together or not at all. They used to be separate writes,
 * so a failure while recording left the agent rolled back with no version to
 * show for it.
 *
 * A rollback that takes the agent's kind away from "scheduled" also turns
 * its own schedule off, in the same transaction; the version returned then
 * carries `schedulePaused: true`.
 *
 * While a published listing sells use of the agent, a rollback is held to
 * the rule an edit is (PATCH /api/agents/:id): it may not switch the agent
 * to its graph, nor, at a price per use, make it run on its own. It throws
 * OnSaleForUseError and restores nothing. The listing is read only for a
 * rollback that would make one of those two switches, inside the
 * transaction, and a read that fails fails the rollback.
 */
export async function rollbackToVersion(
  scope: AgentScope,
  version: string,
  author: VersionAuthor | string
) {
  const { agentId } = scope;

  return prisma.$transaction(async (tx) => {
    await lockAgentInOrg(tx, scope);

    const targetVersion = await tx.agentVersion.findUnique({
      where: {
        agentId_version: { agentId, version },
      },
    });

    if (!targetVersion) {
      throw new Error(`Version ${version} not found`);
    }

    // The kind the agent has now, read under its row lock: a rollback that
    // takes it away from "scheduled" turns its own schedule off, below.
    const current = await tx.agent.findFirst({
      where: { id: agentId, orgId: scope.orgId },
      select: { agentKind: true, entrypoint: true },
    });
    const wasScheduled = current?.agentKind === "scheduled";
    const restoredKind = isAgentKind(targetVersion.agentKind) ? targetVersion.agentKind : DEFAULT_AGENT_KIND;

    // An agent whose use is on sale keeps what its buyers rely on, as on an
    // edit: answers from its instructions, and, at a price per use, a kind
    // that is used by a person. Decided before anything is written.
    const switchesToGraph = targetVersion.entrypoint === "graph" && current?.entrypoint !== "graph";
    const becomesScheduled = restoredKind === "scheduled" && !wasScheduled;
    if (switchesToGraph || becomesScheduled) {
      const useListing = await findUseListing(tx as unknown as UseListingDb, agentId).catch((cause: unknown) => {
        throw new SaleCheckUnavailableError({ cause });
      });
      if (useListing && switchesToGraph) throw new OnSaleForUseError(ON_SALE_FOR_USE_MESSAGES.graph);
      if (useListing && becomesScheduled && useListing.pricingModel === "per_request" && isPaidUse(useListing)) {
        throw new OnSaleForUseError(ON_SALE_FOR_USE_MESSAGES.scheduled);
      }
    }

    // Update the agent with the snapshot from the target version
    await tx.agent.update({
      where: { id: agentId },
      data: {
        name: targetVersion.name,
        description: targetVersion.description,
        framework: targetVersion.framework,
        systemPrompt: targetVersion.systemPrompt,
        tools: targetVersion.tools as any,
        modelConfig: targetVersion.modelConfig as any,
        sourceType: targetVersion.sourceType,
        sourceUrl: targetVersion.sourceUrl,
        sourceCode: targetVersion.sourceCode,
        env: targetVersion.env as any,
        version: targetVersion.version,
        // Null on a version taken before the entrypoint was recorded: the
        // agent keeps the one it has rather than being guessed back to chat.
        ...(targetVersion.entrypoint === "chat" || targetVersion.entrypoint === "graph"
          ? { entrypoint: targetVersion.entrypoint }
          : {}),
        // A version taken before agents had a kind was a conversation: that
        // was the only way to use an agent then. It recorded no settings, so
        // the agent keeps the ones it has; a version that did record its kind
        // restores its settings exactly, an empty set included.
        ...(isAgentKind(targetVersion.agentKind)
          ? {
              agentKind: targetVersion.agentKind,
              kindConfig: cloneKindConfig(targetVersion.kindConfig) ?? Prisma.DbNull,
            }
          : { agentKind: DEFAULT_AGENT_KIND }),
      },
    });

    // Update graph if it exists
    if (targetVersion.graphNodes || targetVersion.graphEdges) {
      await tx.agentGraph.upsert({
        where: { agentId },
        create: {
          agentId,
          nodes: targetVersion.graphNodes as any,
          edges: targetVersion.graphEdges as any,
        },
        update: {
          nodes: targetVersion.graphNodes as any,
          edges: targetVersion.graphEdges as any,
          version: { increment: 1 },
        },
      });
    }

    // The same rule a change of kind follows (PATCH /api/agents/:id): an
    // agent that stops being "scheduled" stops running on its own. Its own
    // schedule is turned off here, in the transaction of the rollback; the
    // task and its history stay, and rolling forward again turns nothing on.
    // No schedule, or one already off, is not an error.
    const schedulePaused =
      wasScheduled && restoredKind !== "scheduled"
        ? (
            await setOwnScheduleEnabled(tx as unknown as Pick<OwnScheduleDb, "scheduledTask">, {
              orgId: scope.orgId,
              agentId,
              enabled: false,
            })
          ).changed
        : false;

    // Create a new version to record the rollback
    const recorded = await snapshotAgentVersion(tx, scope, author, {
      changeLog: `Rolled back to version ${version}`,
      changeType: "patch",
      tags: ["rollback"],
    });
    // Said the way the PATCH says it: only when this rollback turned it off.
    return schedulePaused ? { ...recorded, schedulePaused: true as const } : recorded;
  });
}

/**
 * Compare two versions
 */
export async function compareVersions(
  scope: AgentScope,
  fromVersion: string,
  toVersion: string
) {
  await assertAgentInOrg(scope);
  const { agentId } = scope;

  // Check if diff already exists
  const existingDiff = await prisma.agentVersionDiff.findUnique({
    where: {
      agentId_fromVersion_toVersion: { agentId, fromVersion, toVersion },
    },
  });

  if (existingDiff) {
    return existingDiff;
  }

  // Create diff on demand
  return createVersionDiff(prisma, agentId, fromVersion, toVersion);
}

/**
 * Delete a version (only if not latest and not published)
 */
export async function deleteVersion(scope: AgentScope, version: string) {
  await assertAgentInOrg(scope);
  const { agentId } = scope;

  const targetVersion = await prisma.agentVersion.findUnique({
    where: {
      agentId_version: { agentId, version },
    },
  });

  if (!targetVersion) {
    throw new Error(`Version ${version} not found`);
  }

  if (targetVersion.isLatest) {
    throw new Error("Cannot delete the latest version");
  }

  if (targetVersion.isPublished) {
    throw new Error("Cannot delete a published version");
  }

  // Delete related diffs
  await prisma.agentVersionDiff.deleteMany({
    where: {
      agentId,
      OR: [{ fromVersion: version }, { toVersion: version }],
    },
  });

  // Delete the version
  return prisma.agentVersion.delete({
    where: {
      agentId_version: { agentId, version },
    },
  });
}

// ============================================
// Helper Functions
// ============================================

function calculateNewVersion(currentVersion: string, changeType: ChangeType): string {
  const [major = 1, minor = 0, patch = 0] = currentVersion.split(".").map(Number);

  switch (changeType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function createVersionDiff(
  db: Db,
  agentId: string,
  fromVersion: string,
  toVersion: string
) {
  const [from, to] = await Promise.all([
    db.agentVersion.findUnique({
      where: { agentId_version: { agentId, version: fromVersion } },
    }),
    db.agentVersion.findUnique({
      where: { agentId_version: { agentId, version: toVersion } },
    }),
  ]);

  if (!from || !to) {
    throw new Error("One or both versions not found");
  }

  const changes: Record<string, { from: any; to: any }> = {};
  const addedFields: string[] = [];
  const removedFields: string[] = [];
  const modifiedFields: string[] = [];

  // Fields to compare
  const fieldsToCompare = [
    "name",
    "description",
    "framework",
    "systemPrompt",
    "sourceType",
    "sourceUrl",
    "sourceCode",
    "entrypoint",
    "agentKind",
  ];

  for (const field of fieldsToCompare) {
    const fromVal = (from as any)[field];
    const toVal = (to as any)[field];

    if (fromVal !== toVal) {
      changes[field] = { from: fromVal, to: toVal };

      if (fromVal === null && toVal !== null) {
        addedFields.push(field);
      } else if (fromVal !== null && toVal === null) {
        removedFields.push(field);
      } else {
        modifiedFields.push(field);
      }
    }
  }

  // Compare JSON fields
  const jsonFields = ["tools", "modelConfig", "env", "kindConfig"];
  for (const field of jsonFields) {
    const fromVal = JSON.stringify((from as any)[field]);
    const toVal = JSON.stringify((to as any)[field]);

    if (fromVal !== toVal) {
      changes[field] = {
        from: (from as any)[field],
        to: (to as any)[field],
      };
      modifiedFields.push(field);
    }
  }

  // Compare graph
  if (
    JSON.stringify(from.graphNodes) !== JSON.stringify(to.graphNodes) ||
    JSON.stringify(from.graphEdges) !== JSON.stringify(to.graphEdges)
  ) {
    changes["graph"] = {
      from: { nodes: from.graphNodes, edges: from.graphEdges },
      to: { nodes: to.graphNodes, edges: to.graphEdges },
    };
    modifiedFields.push("graph");
  }

  // Calculate lines changed for source code
  let linesAdded = 0;
  let linesRemoved = 0;

  if (from.sourceCode !== to.sourceCode) {
    const fromLines = (from.sourceCode || "").split("\n");
    const toLines = (to.sourceCode || "").split("\n");

    // Simple diff calculation
    linesAdded = Math.max(0, toLines.length - fromLines.length);
    linesRemoved = Math.max(0, fromLines.length - toLines.length);

    if (linesAdded === 0 && linesRemoved === 0 && fromLines.length > 0) {
      // Lines were modified but total count stayed same
      let changed = 0;
      for (let i = 0; i < Math.min(fromLines.length, toLines.length); i++) {
        if (fromLines[i] !== toLines[i]) changed++;
      }
      linesAdded = changed;
      linesRemoved = changed;
    }
  }

  return db.agentVersionDiff.create({
    data: {
      agentId,
      fromVersion,
      toVersion,
      changes: changes as any,
      addedFields,
      removedFields,
      modifiedFields,
      linesAdded,
      linesRemoved,
    },
  });
}

/**
 * Get version history with diffs
 */
export async function getVersionHistory(scope: AgentScope, limit: number = 10) {
  await assertAgentInOrg(scope);
  const { agentId } = scope;

  const versions = await prisma.agentVersion.findMany({
    where: { agentId },
    orderBy: { versionNumber: "desc" },
    take: limit,
    select: {
      id: true,
      version: true,
      versionNumber: true,
      changeLog: true,
      changeType: true,
      createdByName: true,
      isLatest: true,
      createdAt: true,
    },
  });

  // Get diffs between consecutive versions
  const history = [];
  for (let i = 0; i < versions.length; i++) {
    const current = versions[i];
    const previous = versions[i + 1];
    if (!current) continue;

    let diff = null;
    if (previous) {
      diff = await prisma.agentVersionDiff.findUnique({
        where: {
          agentId_fromVersion_toVersion: {
            agentId,
            fromVersion: previous.version,
            toVersion: current.version,
          },
        },
        select: {
          addedFields: true,
          removedFields: true,
          modifiedFields: true,
          linesAdded: true,
          linesRemoved: true,
        },
      });
    }

    history.push({
      ...current,
      diff,
    });
  }

  return history;
}

/**
 * Tag a version for release
 */
export async function tagVersion(
  scope: AgentScope,
  version: string,
  tags: string[]
) {
  await assertAgentInOrg(scope);

  return prisma.agentVersion.update({
    where: {
      agentId_version: { agentId: scope.agentId, version },
    },
    data: {
      tags: { push: tags },
    },
  });
}

/**
 * Mark a version as published
 */
export async function publishVersion(scope: AgentScope, version: string) {
  await assertAgentInOrg(scope);

  return prisma.agentVersion.update({
    where: {
      agentId_version: { agentId: scope.agentId, version },
    },
    data: {
      isPublished: true,
      publishedAt: new Date(),
    },
  });
}
