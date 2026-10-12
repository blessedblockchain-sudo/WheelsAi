/**
 * Binds the organization-name routes (routes/organizationName.ts) to Prisma.
 *
 * The store is written over a slice of Prisma, so a test can stand in for
 * the tables and still run the real queries' conditions.
 */

import { Prisma } from "@wheelsai/db";
import { prisma } from "../lib/prisma.js";
import { lookupMemberRole } from "../middleware/auth.js";
import {
  RENAME_AUDIT_ACTION,
  RENAME_AUDIT_RESOURCE,
  type OrganizationNameStore,
} from "../services/organizationName.js";
import type { OrganizationNameDeps } from "./organizationName.js";

type OrgRow = { id: string; name: string };

/** The slice of Prisma (the client, or a transaction's client) the store needs. */
export interface OrganizationNameDb {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
  organization: {
    findUnique(args: { where: { id: string }; select: { id: true; name: true } }): Promise<OrgRow | null>;
    update(args: { where: { id: string }; data: { name: string } }): Promise<unknown>;
  };
  publisherProfile: {
    findUnique(args: { where: { orgId: string }; select: { orgId: true } }): Promise<{ orgId: string } | null>;
    updateMany(args: { where: { orgId: string }; data: { displayName: string } }): Promise<{ count: number }>;
  };
  auditLog: {
    findMany(args: {
      where: { orgId: string; action: string; resource: string; createdAt: { gt: Date } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { createdAt: true };
    }): Promise<Array<{ createdAt: Date }>>;
    create(args: {
      data: {
        orgId: string;
        userId: string;
        action: string;
        resource: string;
        resourceId: string;
        details: { from: string; to: string };
        ipAddress: string | null;
        userAgent: string | null;
        createdAt: Date;
      };
    }): Promise<unknown>;
  };
}

export function makeOrganizationNameStore(db: OrganizationNameDb): OrganizationNameStore {
  return {
    findOrganization: (orgId) =>
      db.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } }),

    // Two renames of one organization run one after the other: the second
    // waits here and then reads the name the first one wrote. The lock is the
    // one an update of the name takes anyway (NO KEY), so nothing that only
    // refers to the organization (a new agent, a new listing) waits for it.
    lockOrganization: async (orgId) => {
      const rows = await db.$queryRaw<OrgRow[]>(Prisma.sql`
        SELECT "id", "name" FROM "organizations"
        WHERE "id" = ${orgId}::uuid
        FOR NO KEY UPDATE`);
      return rows[0] ? { id: rows[0].id, name: rows[0].name } : null;
    },

    sells: async (orgId) =>
      (await db.publisherProfile.findUnique({ where: { orgId }, select: { orgId: true } })) !== null,

    recentRenames: async (orgId, since, take) => {
      const rows = await db.auditLog.findMany({
        where: {
          orgId,
          action: RENAME_AUDIT_ACTION,
          resource: RENAME_AUDIT_RESOURCE,
          createdAt: { gt: since },
        },
        orderBy: { createdAt: "desc" },
        take,
        select: { createdAt: true },
      });
      return rows.map((row) => row.createdAt);
    },

    // Equal ignoring capitals, and nothing else. Not Prisma's
    // `equals` with `mode: "insensitive"`: that one is sent as ILIKE with the
    // name as the pattern, so "_" and "%" in a name match other names and a
    // name that ends with "\" is an error from the database.
    takenByAnotherSeller: async (orgId, name) => {
      const rows = await db.$queryRaw<unknown[]>(Prisma.sql`
        SELECT 1 AS "taken" FROM "publisher_profiles"
        WHERE "org_id" <> ${orgId}::uuid
          AND lower("display_name") = lower(${name})
        LIMIT 1`);
      return rows.length > 0;
    },

    setOrganizationName: async (orgId, name) => {
      await db.organization.update({ where: { id: orgId }, data: { name } });
    },

    setSellerName: async (orgId, name) =>
      (await db.publisherProfile.updateMany({ where: { orgId }, data: { displayName: name } })).count > 0,

    // Written as SQL so that "updated_at" stays what it was: the listing
    // itself did not change, and buyers read that date as its last change.
    setListingsPublisherName: (orgId, name) =>
      db.$executeRaw(Prisma.sql`
        UPDATE "agent_listings" SET "publisher_name" = ${name}
        WHERE "publisher_id" = ${orgId}::uuid`),

    recordRename: async (entry) => {
      await db.auditLog.create({
        data: {
          orgId: entry.orgId,
          userId: entry.userId,
          action: RENAME_AUDIT_ACTION,
          resource: RENAME_AUDIT_RESOURCE,
          resourceId: entry.orgId,
          details: { from: entry.from, to: entry.to },
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          // The limit is counted against the same clock that wrote the row.
          createdAt: entry.at,
        },
      });
    },
  };
}

/** A client that can open a transaction: Prisma, or a stand-in in a test. */
export interface OrganizationNameClient extends OrganizationNameDb {
  $transaction<T>(fn: (tx: OrganizationNameDb) => Promise<T>): Promise<T>;
}

export function buildOrganizationNameDeps(
  client: OrganizationNameClient = prisma as unknown as OrganizationNameClient,
): OrganizationNameDeps {
  return {
    store: makeOrganizationNameStore(client),
    // The store of a rename is built over the transaction's client, never
    // over `client`: a write through `client` would not roll back.
    transaction: (fn) => client.$transaction((tx) => fn(makeOrganizationNameStore(tx))),
    getMemberRole: lookupMemberRole,
    now: () => new Date(),
  };
}
