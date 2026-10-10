import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  createAgentVersion,
  getAgentVersions,
  getAgentVersion,
  getLatestVersion,
  rollbackToVersion,
  compareVersions,
  deleteVersion,
  getVersionHistory,
  tagVersion,
  publishVersion,
  AgentNotFoundError,
  OnSaleForUseError,
  SaleCheckUnavailableError,
  type ChangeType,
  type VersionAuthor,
} from "../services/versioning.js";

// ============================================
// Versioning Routes
// ============================================

/**
 * Every handler passes `{agentId, orgId}` into the service layer, which
 * refuses to touch an agent outside the caller's org. Before this, the
 * agentId went straight from the URL to an unscoped Prisma query — see the
 * AgentScope docblock in services/versioning.ts for what that exposed.
 */

/**
 * Not-found and cross-org access are both 404 with the same body: telling
 * them apart would let a caller enumerate agent IDs belonging to other orgs.
 * Everything else stays 400, matching this file's prior behavior.
 */
function replyForError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentNotFoundError) {
    return reply.status(404).send({ error: "agent_not_found" });
  }
  // A rollback an agent on sale cannot take, said the way an edit of the
  // agent says it (PATCH /api/agents/:id).
  if (error instanceof OnSaleForUseError) {
    return reply.status(409).send({ error: "on_sale_for_use", message: error.message });
  }
  // That check could not be made. Said in our words, not the database's.
  if (error instanceof SaleCheckUnavailableError) {
    return reply.status(503).send({ error: "sale_check_unavailable", message: error.message });
  }

  const message = error instanceof Error ? error.message : "Request failed";
  return reply.status(400).send({ error: message });
}

/**
 * Who is acting: the signed-in user, or the API key itself. A key has no user
 * behind it (F4), so it is never passed off as one. Null when the principal
 * carries neither identity, which the handlers refuse.
 */
function authorOf(auth: NonNullable<FastifyRequest["auth"]>): VersionAuthor | null {
  if (auth.type === "api_key") {
    if (!auth.apiKeyId) return null;
    return {
      type: "api_key",
      apiKeyId: auth.apiKeyId,
      name: auth.apiKeyName,
      keyPrefix: auth.apiKeyPrefix,
    };
  }
  return auth.userId ? { type: "user", userId: auth.userId } : null;
}

function replyNoAuthor(reply: FastifyReply) {
  return reply.status(401).send({
    error: "Unauthorized",
    message: "Could not identify who is making this change",
  });
}

const CHANGE_TYPES: readonly ChangeType[] = ["major", "minor", "patch"];

export async function versioningRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes
  app.addHook("preHandler", requireAuth);

  // ============================================
  // Version Management
  // ============================================

  /**
   * Create a new version of an agent
   */
  app.post<{
    Params: { agentId: string };
    Body: {
      changeLog?: string;
      changeType?: "major" | "minor" | "patch";
      tags?: string[];
    };
  }>("/agents/:agentId/versions", async (request, reply) => {
    try {
      const { agentId } = request.params;
      const { orgId } = request.auth!;
      const author = authorOf(request.auth!);
      if (!author) return replyNoAuthor(reply);

      // Only the documented fields: the service also accepts an author
      // display name, which a caller must not be able to set.
      const { changeLog, changeType, tags } = request.body ?? {};
      if (changeType !== undefined && !CHANGE_TYPES.includes(changeType)) {
        return reply
          .status(400)
          .send({ error: "changeType must be major, minor or patch" });
      }

      const version = await createAgentVersion(
        { agentId, orgId },
        author,
        { changeLog, changeType, tags },
      );

      return reply.status(201).send(version);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Get all versions of an agent
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/agents/:agentId/versions", async (request, reply) => {
    try {
      const { agentId } = request.params;
      const { orgId } = request.auth!;
      const limit = request.query.limit ? parseInt(request.query.limit) : 20;
      const offset = request.query.offset ? parseInt(request.query.offset) : 0;

      const result = await getAgentVersions({ agentId, orgId }, { limit, offset });

      return reply.send(result);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Get version history with diffs
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string };
  }>("/agents/:agentId/history", async (request, reply) => {
    try {
      const { agentId } = request.params;
      const { orgId } = request.auth!;
      const limit = request.query.limit ? parseInt(request.query.limit) : 10;

      const history = await getVersionHistory({ agentId, orgId }, limit);

      return reply.send(history);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Get the latest version
   *
   * Registered before /versions/:version so "latest" isn't swallowed as a
   * version string by the parametric route.
   */
  app.get<{
    Params: { agentId: string };
  }>("/agents/:agentId/versions/latest", async (request, reply) => {
    try {
      const { agentId } = request.params;
      const { orgId } = request.auth!;

      const versionData = await getLatestVersion({ agentId, orgId });

      if (!versionData) {
        return reply.status(404).send({ error: "No versions found" });
      }

      return reply.send(versionData);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Get a specific version
   */
  app.get<{
    Params: { agentId: string; version: string };
  }>("/agents/:agentId/versions/:version", async (request, reply) => {
    try {
      const { agentId, version } = request.params;
      const { orgId } = request.auth!;

      const versionData = await getAgentVersion({ agentId, orgId }, version);

      if (!versionData) {
        return reply.status(404).send({ error: "Version not found" });
      }

      return reply.send(versionData);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Compare two versions
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { from: string; to: string };
  }>("/agents/:agentId/compare", async (request, reply) => {
    try {
      const { agentId } = request.params;
      const { orgId } = request.auth!;
      const { from, to } = request.query;

      if (!from || !to) {
        return reply
          .status(400)
          .send({ error: "Both 'from' and 'to' versions are required" });
      }

      const diff = await compareVersions({ agentId, orgId }, from, to);

      return reply.send(diff);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Rollback to a specific version
   */
  app.post<{
    Params: { agentId: string; version: string };
  }>("/agents/:agentId/versions/:version/rollback", async (request, reply) => {
    try {
      const { agentId, version } = request.params;
      const { orgId } = request.auth!;
      const author = authorOf(request.auth!);
      if (!author) return replyNoAuthor(reply);

      const newVersion = await rollbackToVersion(
        { agentId, orgId },
        version,
        author,
      );

      return reply.send(newVersion);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Tag a version
   */
  app.post<{
    Params: { agentId: string; version: string };
    Body: { tags: string[] };
  }>("/agents/:agentId/versions/:version/tag", async (request, reply) => {
    try {
      const { agentId, version } = request.params;
      const { orgId } = request.auth!;
      const { tags } = request.body;

      if (!tags || !Array.isArray(tags)) {
        return reply.status(400).send({ error: "Tags array is required" });
      }

      const versionData = await tagVersion({ agentId, orgId }, version, tags);

      return reply.send(versionData);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Publish a version
   */
  app.post<{
    Params: { agentId: string; version: string };
  }>("/agents/:agentId/versions/:version/publish", async (request, reply) => {
    try {
      const { agentId, version } = request.params;
      const { orgId } = request.auth!;

      const versionData = await publishVersion({ agentId, orgId }, version);

      return reply.send(versionData);
    } catch (error) {
      return replyForError(reply, error);
    }
  });

  /**
   * Delete a version
   */
  app.delete<{
    Params: { agentId: string; version: string };
  }>("/agents/:agentId/versions/:version", async (request, reply) => {
    try {
      const { agentId, version } = request.params;
      const { orgId } = request.auth!;

      await deleteVersion({ agentId, orgId }, version);

      return reply.status(204).send();
    } catch (error) {
      return replyForError(reply, error);
    }
  });
}
