// Renaming an organization: the rename over stand-in tables
// (services/organizationName.ts through the store of
// routes/organizationNameBindings.ts), and GET and PATCH
// /api/settings/organization (routes/organizationName.ts).
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { globalErrorHandler } from "../lib/errorHandler.js";
import { renameOrganization, type RenameOrganizationDeps } from "../services/organizationName.js";
import { createOrganizationNameRoutes, type OrganizationNameDeps } from "../routes/organizationName.js";
import {
  buildOrganizationNameDeps,
  makeOrganizationNameStore,
  type OrganizationNameDb,
} from "../routes/organizationNameBindings.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T09:00:00.000Z");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

interface AuditRow {
  orgId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

interface World {
  orgs: Array<{ id: string; name: string }>;
  profiles: Array<{ orgId: string; displayName: string; slug: string }>;
  listings: Array<{ id: string; publisherId: string; publisherName: string; status: string }>;
  audit: AuditRow[];
}

function newWorld(over: Partial<World> = {}): World {
  return {
    orgs: [
      { id: ORG, name: "demo" },
      { id: OTHER, name: "Acme Robotics" },
      { id: THIRD, name: "Quiet Lab" },
    ],
    profiles: [
      { orgId: ORG, displayName: "demo", slug: "demo" },
      { orgId: OTHER, displayName: "Acme Robotics", slug: "acme-robotics" },
    ],
    listings: [
      { id: "l1", publisherId: ORG, publisherName: "demo", status: "published" },
      { id: "l2", publisherId: ORG, publisherName: "demo", status: "draft" },
      { id: "l3", publisherId: ORG, publisherName: "demo", status: "archived" },
      { id: "l4", publisherId: ORG, publisherName: "demo", status: "pending_review" },
      { id: "l5", publisherId: OTHER, publisherName: "Acme Robotics", status: "published" },
    ],
    audit: [],
    ...over,
  };
}

const renameRow = (orgId: string, createdAt: Date, over: Partial<AuditRow> = {}): AuditRow => ({
  orgId,
  userId: "u1",
  action: "rename",
  resource: "organization",
  resourceId: orgId,
  details: { from: "a", to: "b" },
  ipAddress: null,
  userAgent: null,
  createdAt,
  ...over,
});

/**
 * The tables in memory, behind the slice of Prisma the store uses. Each call
 * is noted with whether a transaction was open.
 */
function standIn(world: World, clock: { now: Date } = { now: NOW }) {
  const calls: Array<{ op: string; inTx: boolean }> = [];
  const sql: string[] = [];
  const takenSql: string[] = [];
  const listingsSql: string[] = [];
  let inTx = false;
  const note = (op: string) => calls.push({ op, inTx });

  const db: OrganizationNameDb = {
    $queryRaw: (async (query: { sql: string; values: unknown[] }) => {
      const text = query.sql.replace(/\s+/g, " ").trim();
      if (/FOR NO KEY UPDATE$/.test(text)) {
        note("lock");
        sql.push(text);
        return world.orgs.filter((o) => o.id === query.values[0]).map((o) => ({ ...o }));
      }
      // The taken check, as the database runs it: lower() on both sides,
      // every other character compared as it is.
      note("taken");
      takenSql.push(text);
      assert.equal(query.values.length, 2);
      const [notOrg, wanted] = query.values as [string, string];
      const hit = world.profiles.some(
        (p) => p.orgId !== notOrg && p.displayName.toLowerCase() === wanted.toLowerCase(),
      );
      return hit ? [{ taken: 1 }] : [];
    }) as OrganizationNameDb["$queryRaw"],
    // The listings' stored name, written as SQL so their last-updated time stays.
    $executeRaw: (async (query: { sql: string; values: unknown[] }) => {
      note("listings.update");
      listingsSql.push(query.sql.replace(/\s+/g, " ").trim());
      assert.equal(query.values.length, 2);
      const [name, publisherId] = query.values as [string, string];
      const rows = world.listings.filter((l) => l.publisherId === publisherId);
      for (const row of rows) row.publisherName = name;
      return rows.length;
    }) as OrganizationNameDb["$executeRaw"],
    organization: {
      findUnique: async ({ where }) => {
        note("organization.findUnique");
        const org = world.orgs.find((o) => o.id === where.id);
        return org ? { ...org } : null;
      },
      update: async ({ where, data }) => {
        note("organization.update");
        const org = world.orgs.find((o) => o.id === where.id);
        if (!org) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        org.name = data.name;
        return org;
      },
    },
    publisherProfile: {
      findUnique: async ({ where }) => {
        note("publisherProfile.findUnique");
        return world.profiles.some((p) => p.orgId === where.orgId) ? { orgId: where.orgId } : null;
      },
      updateMany: async ({ where, data }) => {
        note("publisherProfile.updateMany");
        const rows = world.profiles.filter((p) => p.orgId === where.orgId);
        for (const row of rows) row.displayName = data.displayName;
        return { count: rows.length };
      },
    },
    auditLog: {
      findMany: async ({ where, orderBy, take }) => {
        note("auditLog.findMany");
        assert.deepEqual(orderBy, { createdAt: "desc" });
        return world.audit
          .filter(
            (row) =>
              row.orgId === where.orgId &&
              row.action === where.action &&
              row.resource === where.resource &&
              row.createdAt.getTime() > where.createdAt.gt.getTime(),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take)
          .map((row) => ({ createdAt: row.createdAt }));
      },
      create: async ({ data }) => {
        note("auditLog.create");
        world.audit.push({ ...data });
        return data;
      },
    },
  };

  const deps: RenameOrganizationDeps = {
    transaction: async (fn) => {
      assert.equal(inTx, false, "one transaction at a time");
      inTx = true;
      try {
        return await fn(makeOrganizationNameStore(db));
      } finally {
        inTx = false;
      }
    },
    now: () => clock.now,
  };
  const writes = () => calls.filter((c) => /update|create/.test(c.op)).map((c) => c.op);
  return { db, deps, calls, sql, takenSql, listingsSql, writes, clock };
}

const rename = (deps: RenameOrganizationDeps, name: string, orgId = ORG) =>
  renameOrganization(deps, { orgId, userId: "u1", name, ipAddress: "203.0.113.9", userAgent: "unit-test" });

// ============================================
// The rename
// ============================================

test("a rename writes the organization, its profile and every listing it published, and one audit row", async () => {
  const world = newWorld();
  const s = standIn(world);
  const result = await rename(s.deps, "Northwind AI Labs");

  assert.deepEqual(result, {
    outcome: "renamed",
    organization: { id: ORG, name: "Northwind AI Labs", sells: true },
    listingsUpdated: 4,
  });
  assert.equal(world.orgs.find((o) => o.id === ORG)!.name, "Northwind AI Labs");
  // The profile shows the new name and keeps its address.
  assert.deepEqual(world.profiles.find((p) => p.orgId === ORG), {
    orgId: ORG,
    displayName: "Northwind AI Labs",
    slug: "demo",
  });
  // Every listing of this organization, whatever its status; nobody else's.
  assert.deepEqual(
    world.listings.map((l) => [l.id, l.publisherName]),
    [
      ["l1", "Northwind AI Labs"],
      ["l2", "Northwind AI Labs"],
      ["l3", "Northwind AI Labs"],
      ["l4", "Northwind AI Labs"],
      ["l5", "Acme Robotics"],
    ],
  );
  assert.equal(world.orgs.find((o) => o.id === OTHER)!.name, "Acme Robotics");
  assert.equal(world.profiles.find((p) => p.orgId === OTHER)!.displayName, "Acme Robotics");

  assert.deepEqual(world.audit, [
    {
      orgId: ORG,
      userId: "u1",
      action: "rename",
      resource: "organization",
      resourceId: ORG,
      details: { from: "demo", to: "Northwind AI Labs" },
      ipAddress: "203.0.113.9",
      userAgent: "unit-test",
      createdAt: NOW,
    },
  ]);
});

test("the lock comes first and everything happens inside the one transaction", async () => {
  const s = standIn(newWorld());
  await rename(s.deps, "Northwind AI Labs");

  assert.deepEqual(
    s.calls.map((c) => c.op),
    [
      "lock",
      "auditLog.findMany",
      "taken",
      "organization.update",
      "publisherProfile.updateMany",
      "listings.update",
      "auditLog.create",
    ],
  );
  assert.ok(s.calls.every((c) => c.inTx), "no call outside the transaction");
  assert.equal(s.sql.length, 1);
  assert.match(s.sql[0]!, /^SELECT "id", "name" FROM "organizations" WHERE "id" = (\?|\$1)::uuid FOR NO KEY UPDATE$/);
  // The listings' name is set alone: their last-updated time is not touched.
  assert.equal(s.listingsSql.length, 1);
  assert.match(
    s.listingsSql[0]!,
    /^UPDATE "agent_listings" SET "publisher_name" = (\?|\$1) WHERE "publisher_id" = (\?|\$2)::uuid$/,
  );
});

test("the name it already has writes nothing and is not counted", async () => {
  const world = newWorld();
  const s = standIn(world);
  const before = structuredClone(world);

  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await rename(s.deps, "demo"), {
      outcome: "unchanged",
      organization: { id: ORG, name: "demo", sells: true },
      listingsUpdated: 0,
    });
  }
  assert.deepEqual(s.writes(), []);
  assert.deepEqual(world, before);
  // Not even the limit or the taken check is asked.
  assert.ok(!s.calls.some((c) => c.op === "auditLog.findMany" || c.op === "taken"));

  // Five of those later the organization still has all three changes.
  for (const name of ["One Co", "Two Co", "Three Co"]) {
    assert.equal((await rename(s.deps, name)).outcome, "renamed");
  }
  assert.equal(world.audit.length, 3);
});

test("the same name is compared exactly: other capitals are a change", async () => {
  const world = newWorld();
  const s = standIn(world);
  const result = await rename(s.deps, "Demo");
  assert.equal(result.outcome, "renamed");
  assert.equal(world.orgs.find((o) => o.id === ORG)!.name, "Demo");
  assert.equal(world.profiles.find((p) => p.orgId === ORG)!.displayName, "Demo");
  assert.deepEqual(world.audit[0]?.details, { from: "demo", to: "Demo" });
});

test("an organization that does not sell gets no profile and no listing written", async () => {
  const world = newWorld();
  const s = standIn(world);
  const result = await rename(s.deps, "Quieter Lab", THIRD);
  assert.deepEqual(result, {
    outcome: "renamed",
    organization: { id: THIRD, name: "Quieter Lab", sells: false },
    listingsUpdated: 0,
  });
  assert.equal(world.profiles.length, 2);
  assert.deepEqual(world.profiles.map((p) => p.displayName), ["demo", "Acme Robotics"]);
  assert.deepEqual(world.listings.map((l) => l.publisherName), ["demo", "demo", "demo", "demo", "Acme Robotics"]);
  assert.deepEqual(world.audit.map((a) => [a.orgId, a.resourceId, a.details]), [
    [THIRD, THIRD, { from: "Quiet Lab", to: "Quieter Lab" }],
  ]);
});

test("the fourth change in 30 days is refused, with the time the earliest of the three turns 30 days old", async () => {
  const first = new Date("2026-09-20T10:15:00.000Z");
  const world = newWorld({
    audit: [
      renameRow(ORG, new Date("2026-10-01T00:00:00.000Z")),
      renameRow(ORG, first),
      renameRow(ORG, new Date("2026-10-11T23:00:00.000Z")),
    ],
  });
  const s = standIn(world);
  const before = structuredClone(world);

  const result = await rename(s.deps, "Northwind AI Labs");
  assert.deepEqual(result, { outcome: "limit", retryAt: new Date("2026-10-20T10:15:00.000Z") });
  assert.equal((result as { retryAt: Date }).retryAt.getTime(), first.getTime() + 30 * DAY);
  assert.deepEqual(s.writes(), []);
  assert.deepEqual(world, before);
});

test("the limit lifts at retryAt, not a millisecond before", async () => {
  const first = new Date("2026-09-20T10:15:00.000Z");
  const audit = () => [
    renameRow(ORG, first),
    renameRow(ORG, new Date("2026-10-01T00:00:00.000Z")),
    renameRow(ORG, new Date("2026-10-11T23:00:00.000Z")),
  ];
  const retryAt = first.getTime() + 30 * DAY;

  const early = standIn(newWorld({ audit: audit() }), { now: new Date(retryAt - 1) });
  assert.equal((await rename(early.deps, "Northwind AI Labs")).outcome, "limit");

  const onTime = standIn(newWorld({ audit: audit() }), { now: new Date(retryAt) });
  assert.equal((await rename(onTime.deps, "Northwind AI Labs")).outcome, "renamed");
});

test("only this organization's renames of the last 30 days count", async () => {
  const world = newWorld({
    audit: [
      // Older than 30 days.
      renameRow(ORG, new Date(NOW.getTime() - 31 * DAY)),
      renameRow(ORG, new Date(NOW.getTime() - 200 * DAY)),
      // Another organization's.
      renameRow(OTHER, new Date(NOW.getTime() - DAY)),
      renameRow(OTHER, new Date(NOW.getTime() - 2 * DAY)),
      renameRow(OTHER, new Date(NOW.getTime() - 3 * DAY)),
      // Other things this organization did.
      renameRow(ORG, new Date(NOW.getTime() - DAY), { action: "update" }),
      renameRow(ORG, new Date(NOW.getTime() - DAY), { resource: "agent" }),
      // Two real ones.
      renameRow(ORG, new Date(NOW.getTime() - 5 * DAY)),
      renameRow(ORG, new Date(NOW.getTime() - 6 * DAY)),
    ],
  });
  const s = standIn(world);
  assert.equal((await rename(s.deps, "Third Name")).outcome, "renamed");
  // That was the third: the next is refused, counted from the oldest of the three.
  const next = await rename(s.deps, "Fourth Name");
  assert.deepEqual(next, { outcome: "limit", retryAt: new Date(NOW.getTime() - 6 * DAY + 30 * DAY) });
});

test("three changes pass and each is counted by its own audit row", async () => {
  const world = newWorld();
  const s = standIn(world);
  const times = ["2026-10-12T09:00:00.000Z", "2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z"];
  for (const [i, at] of times.entries()) {
    s.clock.now = new Date(at);
    assert.equal((await rename(s.deps, `Name ${i}`)).outcome, "renamed");
  }
  s.clock.now = new Date("2026-10-15T09:00:00.000Z");
  assert.deepEqual(await rename(s.deps, "Name 3"), {
    outcome: "limit",
    retryAt: new Date("2026-11-11T09:00:00.000Z"),
  });
  assert.equal(world.orgs.find((o) => o.id === ORG)!.name, "Name 2");
  assert.equal(world.audit.length, 3);
});

test("the limit is answered before the taken check", async () => {
  const world = newWorld({
    audit: [1, 2, 3].map((d) => renameRow(ORG, new Date(NOW.getTime() - d * DAY))),
  });
  const s = standIn(world);
  assert.equal((await rename(s.deps, "Acme Robotics")).outcome, "limit");
  assert.ok(!s.calls.some((c) => c.op === "taken"));
});

test("a name another seller shows is taken, ignoring capitals, and nothing is written", async () => {
  for (const name of ["Acme Robotics", "acme robotics", "ACME ROBOTICS", "aCmE rObOtIcS"]) {
    const world = newWorld();
    const s = standIn(world);
    const before = structuredClone(world);
    assert.deepEqual(await rename(s.deps, name), { outcome: "taken" }, name);
    assert.deepEqual(s.writes(), []);
    assert.deepEqual(world, before);
  }
});

test("taken is exact apart from capitals", async () => {
  for (const name of ["Acme Robotics.", "Acme-Robotics", "Acme  Robotics Inc", "Acme Robotic"]) {
    const s = standIn(newWorld());
    assert.equal((await rename(s.deps, name)).outcome, "renamed", name);
  }
});

test("an organization that does not sell does not make a name taken", async () => {
  // "Quiet Lab" is an organization's name, but it has no profile.
  assert.equal((await rename(standIn(newWorld()).deps, "Quiet Lab")).outcome, "renamed");
  assert.equal((await rename(standIn(newWorld()).deps, "QUIET LAB", OTHER)).outcome, "renamed");
});

test("the name a seller shows counts, not the name its organization has", async () => {
  // A profile whose shown name differs from its organization's name.
  const world = newWorld();
  world.profiles.find((p) => p.orgId === OTHER)!.displayName = "Acme Storefront";
  const s = standIn(world);
  assert.equal((await rename(s.deps, "acme storefront")).outcome, "taken");
  assert.equal((await rename(s.deps, "Acme Robotics")).outcome, "renamed");
});

test("a seller that does not sell yet is refused a name another seller shows", async () => {
  const s = standIn(newWorld());
  assert.equal((await rename(s.deps, "acme robotics", THIRD)).outcome, "taken");
});

test("the taken check is equality ignoring capitals: a name is never a pattern", async () => {
  const s = standIn(newWorld());
  await rename(s.deps, "Northwind AI Labs");
  assert.equal(s.takenSql.length, 1);
  assert.match(
    s.takenSql[0]!,
    /^SELECT 1 AS "taken" FROM "publisher_profiles" WHERE "org_id" <> (\?|\$1)::uuid AND lower\("display_name"\) = lower\((\?|\$2)\) LIMIT 1$/,
  );
  assert.doesNotMatch(s.takenSql[0]!, /LIKE/i);

  // What a pattern would match is not taken; the name itself is.
  for (const name of ["Acme_Robotics", "Acme%", "%", "A%s", "Acme Robotic_", "Acme Robotics\\"]) {
    const outcome = (await rename(standIn(newWorld()).deps, name)).outcome;
    assert.equal(outcome, "renamed", name);
  }
  const world = newWorld();
  world.profiles.find((p) => p.orgId === OTHER)!.displayName = "100%_Robots\\";
  assert.equal((await rename(standIn(world).deps, "100%_robots\\")).outcome, "taken");
});

test("a profile made while the rename runs gets the new name too", async () => {
  // The organization did not sell when the rename began; its first publish
  // lands before the rename writes.
  const world = newWorld();
  const s = standIn(world);
  const update = s.db.organization.update;
  s.db.organization.update = async (args) => {
    world.profiles.push({ orgId: THIRD, displayName: "Quiet Lab", slug: "quiet-lab" });
    return update(args);
  };
  const result = await rename(s.deps, "Quieter Lab", THIRD);
  assert.deepEqual(result, {
    outcome: "renamed",
    organization: { id: THIRD, name: "Quieter Lab", sells: true },
    listingsUpdated: 0,
  });
  assert.deepEqual(world.profiles.find((p) => p.orgId === THIRD), {
    orgId: THIRD,
    displayName: "Quieter Lab",
    slug: "quiet-lab",
  });
});

test("a failure part of the way leaves the rename to the transaction: the error is passed on, no audit row", async () => {
  const world = newWorld();
  const s = standIn(world);
  s.db.$executeRaw = (async () => {
    throw new Error("deadlock detected");
  }) as OrganizationNameDb["$executeRaw"];
  await assert.rejects(rename(s.deps, "Northwind AI Labs"), /deadlock detected/);
  // Nothing is caught and carried on with: the audit row, which the limit
  // counts, is never written for a rename that did not finish.
  assert.deepEqual(world.audit, []);
  assert.ok(!s.calls.some((c) => c.op === "auditLog.create"));
});

test("the real binding runs the whole rename on the transaction's client, never on the outer one", async () => {
  const world = newWorld();
  const inside = standIn(world);
  const outside = standIn(world);
  let opened = 0;
  const deps = buildOrganizationNameDeps({
    ...outside.db,
    $transaction: async (fn) => {
      opened++;
      return fn(inside.db);
    },
  });
  const result = await renameOrganization(
    { transaction: deps.transaction, now: () => NOW },
    { orgId: ORG, userId: "u1", name: "Northwind AI Labs" },
  );
  assert.equal(result.outcome, "renamed");
  assert.equal(opened, 1);
  assert.equal(outside.calls.length, 0, "nothing went around the transaction");
  assert.deepEqual(
    inside.calls.map((c) => c.op),
    [
      "lock",
      "auditLog.findMany",
      "taken",
      "organization.update",
      "publisherProfile.updateMany",
      "listings.update",
      "auditLog.create",
    ],
  );
  // Reading for GET is outside any transaction.
  assert.deepEqual(await deps.store.findOrganization(ORG), { id: ORG, name: "Northwind AI Labs" });
  assert.deepEqual(outside.calls.map((c) => c.op), ["organization.findUnique"]);

  // An error inside is passed on as it is, so Prisma rolls the transaction back.
  inside.db.auditLog.create = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(
    renameOrganization(
      { transaction: deps.transaction, now: () => NOW },
      { orgId: ORG, userId: "u1", name: "Another Name" },
    ),
    /connection lost/,
  );
});

test("an organization's own profile never makes its new name taken", async () => {
  const world = newWorld();
  world.profiles.find((p) => p.orgId === ORG)!.displayName = "DEMO SHOP";
  const s = standIn(world);
  assert.equal((await rename(s.deps, "Demo Shop")).outcome, "renamed");
});

test("an organization that is gone is answered as missing and nothing is written", async () => {
  const s = standIn(newWorld());
  assert.deepEqual(await rename(s.deps, "Anything", "99999999-9999-4999-8999-999999999999"), {
    outcome: "missing",
  });
  assert.deepEqual(s.calls.map((c) => c.op), ["lock"]);
});

test("a second rename to the same name, run after the first, finds nothing to change", async () => {
  const world = newWorld();
  const s = standIn(world);
  assert.equal((await rename(s.deps, "Northwind AI Labs")).outcome, "renamed");
  assert.equal((await rename(s.deps, "Northwind AI Labs")).outcome, "unchanged");
  assert.equal(world.audit.length, 1);
});

// ============================================
// The routes
// ============================================

const session = (role: string | undefined, over: Record<string, unknown> = {}) => ({
  userId: "u1",
  orgId: ORG,
  email: "ada@example.com",
  role,
  type: "jwt" as const,
  ...over,
});
const API_KEY = { userId: null, orgId: ORG, type: "api_key" as const, scopes: ["*"], apiKeyId: "k1" };

async function harness(
  opts: {
    world?: World;
    principal?: unknown;
    /** The membership's role as it is now; null when the user is no longer a member. */
    memberRole?: string | null;
    deps?: Partial<OrganizationNameDeps>;
    now?: Date;
  } = {},
) {
  const world = opts.world ?? newWorld();
  const s = standIn(world, { now: opts.now ?? NOW });
  const roleLookups: Array<[string, string]> = [];
  const deps: OrganizationNameDeps = {
    ...s.deps,
    store: makeOrganizationNameStore(s.db),
    getMemberRole: async (orgId, userId) => {
      roleLookups.push([orgId, userId]);
      return "memberRole" in opts ? (opts.memberRole ?? null) : "owner";
    },
    ...opts.deps,
  };

  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.decorateRequest("auth", null);
  const principal = "principal" in opts ? opts.principal : session("owner");
  app.addHook("onRequest", async (request) => {
    // A copy each time: requireRole writes the current role onto it.
    (request as any).auth = principal ? { ...(principal as object) } : null;
  });
  await app.register(createOrganizationNameRoutes(deps), { prefix: "/api/settings" });

  const get = () => app.inject({ method: "GET", url: "/api/settings/organization" });
  const patch = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "PATCH",
      url: "/api/settings/organization",
      payload: payload as any,
      headers,
      remoteAddress: "203.0.113.9",
    });
  return { app, world, get, patch, roleLookups, writes: s.writes, calls: s.calls };
}

test("GET answers the organization for an owner, with canRename and sells", async () => {
  const h = await harness({ memberRole: "owner" });
  const res = await h.get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { organization: { id: ORG, name: "demo", canRename: true, sells: true } });
  assert.deepEqual(h.roleLookups, [[ORG, "u1"]]);
  assert.deepEqual(h.writes(), []);
  await h.app.close();
});

test("GET for an admin can rename; for a member it cannot", async () => {
  const admin = await harness({ principal: session("admin"), memberRole: "admin" });
  assert.equal((await admin.get()).json().organization.canRename, true);
  await admin.app.close();

  const member = await harness({ principal: session("member"), memberRole: "member" });
  const res = await member.get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { organization: { id: ORG, name: "demo", canRename: false, sells: true } });
  await member.app.close();
});

test("GET reads the membership as it is now, not the role inside the token", async () => {
  // The token still says owner; the membership says member, or is gone.
  for (const memberRole of ["member", null]) {
    const h = await harness({ principal: session("owner"), memberRole });
    const res = await h.get();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().organization.canRename, false);
    await h.app.close();
  }
  // The token says member; the membership was raised to admin since.
  const raised = await harness({ principal: session("member"), memberRole: "admin" });
  assert.equal((await raised.get()).json().organization.canRename, true);
  await raised.app.close();
});

test("GET for an API key answers the organization and cannot rename", async () => {
  const h = await harness({ principal: API_KEY, world: newWorld(), memberRole: "owner" });
  const res = await h.get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { organization: { id: ORG, name: "demo", canRename: false, sells: true } });
  assert.deepEqual(h.roleLookups, [], "a key has no membership to read");
  await h.app.close();
});

test("GET says whether the organization sells", async () => {
  const h = await harness({ principal: session("owner", { orgId: THIRD }) });
  assert.deepEqual((await h.get()).json(), {
    organization: { id: THIRD, name: "Quiet Lab", canRename: true, sells: false },
  });
  await h.app.close();
});

test("GET still answers when the role cannot be read, without the right to rename", async () => {
  const h = await harness({
    deps: {
      getMemberRole: async () => {
        throw new Error("ECONNREFUSED postgres://10.0.0.7 password=hunter2");
      },
    },
  });
  const res = await h.get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().organization.canRename, false);
  assert.ok(!res.body.includes("hunter2"));
  await h.app.close();
});

test("GET without a principal is 401, and for an organization that is gone 404", async () => {
  const anonymous = await harness({ principal: null });
  assert.equal((await anonymous.get()).statusCode, 401);
  await anonymous.app.close();

  const gone = await harness({ principal: session("owner", { orgId: "99999999-9999-4999-8999-999999999999" }) });
  const res = await gone.get();
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), {
    error: "organization_not_found",
    message: "This organization could not be found.",
  });
  await gone.app.close();
});

test("PATCH renames for an owner and for an admin, and answers the contract's shape", async () => {
  for (const role of ["owner", "admin"]) {
    const h = await harness({ principal: session("member"), memberRole: role });
    const res = await h.patch({ name: "Northwind AI Labs" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      organization: { id: ORG, name: "Northwind AI Labs", canRename: true, sells: true },
      changed: true,
      listingsUpdated: 4,
    });
    assert.equal(h.world.orgs.find((o) => o.id === ORG)!.name, "Northwind AI Labs");
    assert.ok(h.world.listings.filter((l) => l.publisherId === ORG).every((l) => l.publisherName === "Northwind AI Labs"));
    await h.app.close();
  }
});

test("PATCH stores and answers the cleaned name", async () => {
  const h = await harness();
  const res = await h.patch({ name: "  \uFF2E\uFF4F\uFF52\uFF54\uFF48\uFF57\uFF49\uFF4E\uFF44   AI\tLabs  " });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().organization.name, "Northwind AI Labs");
  assert.equal(h.world.orgs.find((o) => o.id === ORG)!.name, "Northwind AI Labs");
  assert.deepEqual(h.world.audit[0]?.details, { from: "demo", to: "Northwind AI Labs" });
  await h.app.close();
});

test("PATCH records who renamed, from where and with what", async () => {
  const h = await harness();
  await h.patch({ name: "Northwind AI Labs" }, { "user-agent": "Mozilla/5.0 (unit test)" });
  assert.deepEqual(h.world.audit, [
    {
      orgId: ORG,
      userId: "u1",
      action: "rename",
      resource: "organization",
      resourceId: ORG,
      details: { from: "demo", to: "Northwind AI Labs" },
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (unit test)",
      createdAt: NOW,
    },
  ]);
  await h.app.close();
});

test("PATCH with the name it already has is 200 with changed false, after cleaning", async () => {
  const h = await harness();
  for (const name of ["demo", "  demo  ", "\uFF44\uFF45\uFF4D\uFF4F"]) {
    const res = await h.patch({ name });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      organization: { id: ORG, name: "demo", canRename: true, sells: true },
      changed: false,
      listingsUpdated: 0,
    });
  }
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.world.audit, []);
  await h.app.close();
});

test("PATCH is refused for a member with what requireRole answers", async () => {
  // The token says owner; the membership says member.
  const h = await harness({ principal: session("owner"), memberRole: "member" });
  const res = await h.patch({ name: "Northwind AI Labs" });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "insufficient_role", message: "Requires role: owner or admin" });
  assert.deepEqual(h.calls, [], "nothing was read or written");
  assert.equal(h.world.orgs.find((o) => o.id === ORG)!.name, "demo");
  await h.app.close();
});

test("PATCH is refused for someone who is no longer a member, and when the role cannot be read", async () => {
  const removed = await harness({ principal: session("owner"), memberRole: null });
  const res = await removed.patch({ name: "Northwind AI Labs" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "not_a_member");
  assert.deepEqual(removed.calls, []);
  await removed.app.close();

  const down = await harness({
    deps: {
      getMemberRole: async () => {
        throw new Error("ECONNREFUSED password=hunter2");
      },
    },
  });
  const unavailable = await down.patch({ name: "Northwind AI Labs" });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error, "role_check_unavailable");
  assert.ok(!unavailable.body.includes("hunter2"));
  assert.deepEqual(down.calls, []);
  await down.app.close();
});

test("PATCH is refused for an API key with what requireJwtAuth answers, and without a principal", async () => {
  for (const principal of [API_KEY, null]) {
    const h = await harness({ principal, memberRole: "owner" });
    const res = await h.patch({ name: "Northwind AI Labs" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "Unauthorized", message: "Session authentication required" });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.roleLookups, []);
    assert.equal(h.world.orgs.find((o) => o.id === ORG)!.name, "demo");
    await h.app.close();
  }
});

test("PATCH answers each refusal of the name rule with its status, code and sentence", async () => {
  const h = await harness();
  const cases: Array<[string, string, string]> = [
    ["<b>Northwind</b>", "invalid_name", "A name cannot contain line breaks, < or >."],
    ["North\u0085wind", "invalid_name", "A name cannot contain line breaks, < or >."],
    ["North\u200Bwind", "invalid_name", "A name cannot contain invisible characters."],
    ["a", "invalid_name", "Give your organization a name of 2 to 60 characters."],
    ["", "invalid_name", "Give your organization a name of 2 to 60 characters."],
    ["a".repeat(61), "invalid_name", "Give your organization a name of 2 to 60 characters."],
    ["---", "invalid_name", "A name needs at least one letter or number."],
    ["Wheels AI Labs", "name_reserved", "That name is reserved. Choose another."],
  ];
  for (const [name, error, message] of cases) {
    const res = await h.patch({ name });
    assert.equal(res.statusCode, 400, JSON.stringify(name));
    assert.deepEqual(res.json(), { error, message }, JSON.stringify(name));
  }
  // The rule is checked before the database is asked anything.
  assert.deepEqual(h.calls, []);
  await h.app.close();
});

test("PATCH to a name another seller shows is 409 name_taken", async () => {
  const h = await harness();
  const res = await h.patch({ name: "ACME robotics" });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    error: "name_taken",
    message: "Another seller already uses that name. Choose another.",
  });
  assert.deepEqual(h.writes(), []);
  await h.app.close();
});

test("PATCH past the limit is 429 name_change_limit with retryAt and the moment it lifts in the sentence", async () => {
  const world = newWorld({
    audit: [
      renameRow(ORG, new Date("2026-10-15T08:30:00.000Z")),
      renameRow(ORG, new Date("2026-10-20T00:00:00.000Z")),
      renameRow(ORG, new Date("2026-11-01T00:00:00.000Z")),
    ],
  });
  const h = await harness({ world, now: new Date("2026-11-02T12:00:00.000Z") });
  const res = await h.patch({ name: "Northwind AI Labs" });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), {
    error: "name_change_limit",
    message:
      "An organization's name can be changed 3 times in 30 days. It can be changed again after 08:30 UTC on 14 November 2026.",
    retryAt: "2026-11-14T08:30:00.000Z",
  });
  assert.deepEqual(h.writes(), []);
  assert.equal(world.orgs.find((o) => o.id === ORG)!.name, "demo");
  await h.app.close();
});

test("PATCH is limited to ten calls a minute; GET is not", async () => {
  const seen: Array<[string, unknown]> = [];
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    seen.push([String(route.method), (route.config as { rateLimit?: unknown } | undefined)?.rateLimit]);
  });
  const s = standIn(newWorld());
  await app.register(
    createOrganizationNameRoutes({ ...s.deps, store: makeOrganizationNameStore(s.db), getMemberRole: async () => "owner" }),
    { prefix: "/api/settings" },
  );
  await app.ready();
  assert.deepEqual(seen.find(([method]) => method === "PATCH")?.[1], { max: 10, timeWindow: "1 minute" });
  assert.equal(seen.find(([method]) => method === "GET")?.[1], undefined);
  await app.close();
});

test("PATCH with a body that is not exactly a name is the ordinary validation error", async () => {
  const h = await harness();
  for (const payload of [{}, { name: 42 }, { name: null }, { name: ["x"] }, { name: "Northwind", slug: "northwind" }, { title: "x" }]) {
    const res = await h.patch(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, "validation_failed", JSON.stringify(payload));
    assert.equal(typeof res.json().message, "string");
  }
  assert.deepEqual(h.calls, []);
  await h.app.close();
});

test("PATCH for an organization that is gone is 404", async () => {
  const h = await harness({ principal: session("owner", { orgId: "99999999-9999-4999-8999-999999999999" }) });
  const res = await h.patch({ name: "Northwind AI Labs" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "organization_not_found");
  assert.deepEqual(h.writes(), []);
  await h.app.close();
});

test("text from a failing database never reaches the answer", async () => {
  const hostile = "Invalid `prisma.organization.update()` invocation: ECONNREFUSED 10.0.0.7 password=hunter2";
  const h = await harness({
    deps: {
      transaction: async () => {
        throw new Error(hostile);
      },
    },
  });
  const res = await h.patch({ name: "Northwind AI Labs" });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("hunter2") && !res.body.includes("prisma") && !res.body.includes("ECONNREFUSED"));
  await h.app.close();
});

test("no sentence a person reads has an em dash or an exclamation mark", async () => {
  const world = newWorld({
    audit: [1, 2, 3].map((d) => renameRow(THIRD, new Date(NOW.getTime() - d * DAY))),
  });
  const h = await harness({ world });
  const limited = await harness({ world, principal: session("owner", { orgId: THIRD }) });
  const answers = [
    await h.patch({ name: "<x>" }),
    await h.patch({ name: "x\u200By" }),
    await h.patch({ name: "x" }),
    await h.patch({ name: "??" }),
    await h.patch({ name: "WheelsAI" }),
    await h.patch({ name: "Acme Robotics" }),
    await limited.patch({ name: "Quieter Lab" }),
  ];
  assert.deepEqual(
    answers.map((a) => a.statusCode),
    [400, 400, 400, 400, 400, 409, 429],
  );
  for (const res of answers) {
    const { message } = res.json();
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0 && !message.includes("\u2014") && !message.includes("!"), message);
    assert.doesNotMatch(message, /invalid_name|name_reserved|name_taken|name_change_limit|Bad Request/);
  }
  await h.app.close();
  await limited.app.close();
});
