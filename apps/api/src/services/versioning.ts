import { prisma } from "@wheelsai/db";

// ============================================
// Types
// ============================================

export type ChangeType = "major" | "minor" | "patch";

export interface CreateVersionInput {
  changeLog?: string;
  changeType?: ChangeType;
  tags?: string[];
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
}

// ============================================
// Version Management
// ============================================

/**
 * Create a new version of an agent
 */
export async function createAgentVersion(
  agentId: string,
  userId: string,
  input: CreateVersionInput = {}
) {
  // Get the agent
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      graph: true,
    },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  // Get the latest version number
  const latestVersion = await prisma.agentVersion.findFirst({
    where: { agentId },
    orderBy: { versionNumber: "desc" },
  });

  const versionNumber = (latestVersion?.versionNumber || 0) + 1;

  // Calculate new version string
  const newVersion = calculateNewVersion(
    latestVersion?.version || "0.0.0",
    input.changeType || "patch"
  );

  // Get user info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, email: true },
  });

  // Mark all existing versions as not latest
  await prisma.agentVersion.updateMany({
    where: { agentId, isLatest: true },
    data: { isLatest: false },
  });

  // Create the new version
  const version = await prisma.agentVersion.create({
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
      changeLog: input.changeLog,
      changeType: input.changeType || "patch",
      tags: input.tags || [],
      createdById: userId,
      createdByName: user?.displayName || user?.email || "Unknown",
      isLatest: true,
    },
  });

  // Update agent version field
  await prisma.agent.update({
    where: { id: agentId },
    data: { version: newVersion },
  });

  // Create diff from previous version if exists
  if (latestVersion) {
    await createVersionDiff(agentId, latestVersion.version, newVersion);
  }

  return version;
}

/**
 * Get all versions of an agent
 */
export async function getAgentVersions(
  agentId: string,
  options: {
    limit?: number;
    offset?: number;
  } = {}
) {
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
export async function getAgentVersion(agentId: string, version: string) {
  return prisma.agentVersion.findUnique({
    where: {
      agentId_version: { agentId, version },
    },
  });
}

/**
 * Get the latest version of an agent
 */
export async function getLatestVersion(agentId: string) {
  return prisma.agentVersion.findFirst({
    where: { agentId, isLatest: true },
  });
}

/**
 * Rollback agent to a specific version
 */
export async function rollbackToVersion(
  agentId: string,
  version: string,
  userId: string
) {
  const targetVersion = await prisma.agentVersion.findUnique({
    where: {
      agentId_version: { agentId, version },
    },
  });

  if (!targetVersion) {
    throw new Error(`Version ${version} not found`);
  }

  // Update the agent with the snapshot from the target version
  await prisma.agent.update({
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
    },
  });

  // Update graph if it exists
  if (targetVersion.graphNodes || targetVersion.graphEdges) {
    await prisma.agentGraph.upsert({
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

  // Create a new version to record the rollback
  const newVersion = await createAgentVersion(agentId, userId, {
    changeLog: `Rolled back to version ${version}`,
    changeType: "patch",
    tags: ["rollback"],
  });

  return newVersion;
}

/**
 * Compare two versions
 */
export async function compareVersions(
  agentId: string,
  fromVersion: string,
  toVersion: string
) {
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
  return createVersionDiff(agentId, fromVersion, toVersion);
}

/**
 * Delete a version (only if not latest and not published)
 */
export async function deleteVersion(agentId: string, version: string) {
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
  agentId: string,
  fromVersion: string,
  toVersion: string
) {
  const [from, to] = await Promise.all([
    prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId, version: fromVersion } },
    }),
    prisma.agentVersion.findUnique({
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
  const jsonFields = ["tools", "modelConfig", "env"];
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

  return prisma.agentVersionDiff.create({
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
export async function getVersionHistory(agentId: string, limit: number = 10) {
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
  agentId: string,
  version: string,
  tags: string[]
) {
  return prisma.agentVersion.update({
    where: {
      agentId_version: { agentId, version },
    },
    data: {
      tags: { push: tags },
    },
  });
}

/**
 * Mark a version as published
 */
export async function publishVersion(agentId: string, version: string) {
  return prisma.agentVersion.update({
    where: {
      agentId_version: { agentId, version },
    },
    data: {
      isPublished: true,
      publishedAt: new Date(),
    },
  });
}
