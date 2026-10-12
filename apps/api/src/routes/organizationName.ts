/**
 * The organization's name: GET and PATCH /api/settings/organization.
 *
 * Reading is for any member and for an API key. Renaming is for an owner or
 * an admin in a signed-in session: the role is read from the membership as
 * it is now, never from the token. The rule and the rename itself are in
 * services/organizationName.ts.
 *
 * Every sentence a person reads is written there or here, chosen by a code.
 * Text from Prisma or a thrown error goes to the log only.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createRequireRole,
  requireAuth,
  requireJwtAuth,
  type MemberRoleLookup,
} from "../middleware/auth.js";
import {
  NAME_SENTENCES,
  checkOrganizationName,
  nameChangeLimitSentence,
  renameOrganization,
  type OrganizationNameStore,
  type RenameOrganizationDeps,
} from "../services/organizationName.js";

/** The roles that may rename the organization. */
export const RENAME_ROLES = ["owner", "admin"] as const;

export const ORGANIZATION_NOT_FOUND_MESSAGE = "This organization could not be found.";

export interface OrganizationNameDeps extends RenameOrganizationDeps {
  /** Reads outside a transaction, for GET. */
  store: Pick<OrganizationNameStore, "findOrganization" | "sells">;
  /** The member's current role in the organization, or null (middleware/auth.ts). */
  getMemberRole: MemberRoleLookup;
}

const renameBodySchema = z.object({ name: z.string() }).strict();

// Ten a minute per caller, as linking a wallet allows.
const RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute" } };

const USER_AGENT_MAX = 512;

export function createOrganizationNameRoutes(deps: OrganizationNameDeps): FastifyPluginAsync {
  const requireRole = createRequireRole({ getMemberRole: deps.getMemberRole });

  return async (fastify) => {
    fastify.get("/organization", { preHandler: [requireAuth] }, async (request, reply) => {
      const { orgId, userId, type } = request.auth!;
      const organization = await deps.store.findOrganization(orgId);
      if (!organization) {
        return reply.status(404).send({ error: "organization_not_found", message: ORGANIZATION_NOT_FOUND_MESSAGE });
      }

      // An API key has no person behind it and cannot rename.
      let canRename = false;
      if (type === "jwt" && userId) {
        try {
          const role = await deps.getMemberRole(orgId, userId);
          canRename = role !== null && (RENAME_ROLES as readonly string[]).includes(role);
        } catch (err) {
          request.log.error({ err, orgId }, "organization name: the role could not be read");
        }
      }

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          canRename,
          sells: await deps.store.sells(orgId),
        },
      };
    });

    fastify.patch(
      "/organization",
      // No requireAuth here: the settings plugin's hook already ran it, and a
      // second run would count an API key's refused call twice.
      { preHandler: [requireJwtAuth, requireRole(...RENAME_ROLES)], config: RATE_LIMIT },
      async (request, reply) => {
        const { orgId, userId } = request.auth!;
        const body = renameBodySchema.parse(request.body);

        const checked = checkOrganizationName(body.name);
        if (!checked.ok) {
          return reply.status(400).send({ error: checked.code, message: checked.message });
        }

        const userAgent = request.headers["user-agent"];
        const result = await renameOrganization(deps, {
          orgId,
          // requireJwtAuth and requireRole leave only a member's session here.
          userId: userId!,
          name: checked.name,
          ipAddress: request.ip ?? null,
          userAgent: typeof userAgent === "string" ? userAgent.slice(0, USER_AGENT_MAX) : null,
        });

        if (result.outcome === "missing") {
          return reply.status(404).send({ error: "organization_not_found", message: ORGANIZATION_NOT_FOUND_MESSAGE });
        }
        if (result.outcome === "limit") {
          return reply.status(429).send({
            error: "name_change_limit",
            message: nameChangeLimitSentence(result.retryAt),
            retryAt: result.retryAt.toISOString(),
          });
        }
        if (result.outcome === "taken") {
          return reply.status(409).send({ error: "name_taken", message: NAME_SENTENCES.taken });
        }

        const changed = result.outcome === "renamed";
        if (changed) {
          request.log.info({ orgId, userId, listingsUpdated: result.listingsUpdated }, "Organization renamed");
        }
        return {
          organization: { ...result.organization, canRename: true },
          changed,
          listingsUpdated: result.listingsUpdated,
        };
      },
    );
  };
}
