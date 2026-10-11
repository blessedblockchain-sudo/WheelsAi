import assert from "node:assert/strict";
import { test } from "node:test";

import "./unitEnv.js";

import { effectivePlan } from "../services/plans.js";
import {
  buildSetPlanDeps,
  describeSetPlanResult,
  setPlan,
  stripeDrives,
  type SetPlanInput,
  type SetPlanPrisma,
  type SetPlanResult,
  type SetPlanTx,
} from "../services/setPlan.js";

// ============================================
// An in-memory stand-in for the slice of Prisma set-plan uses
// ============================================

type Row = Record<string, any>;

const ACME = "11111111-1111-4111-8111-111111111111";
const BOLT = "22222222-2222-4222-8222-222222222222";
const CORE = "33333333-3333-4333-8333-333333333333";
const NOBODY = "99999999-9999-4999-8999-999999999999";

interface Store {
  users: Row[];
  organizations: Row[];
  members: Row[];
  profiles: Row[];
  subscriptions: Row[];
  /** Marketplace listings: the stored flag a plan's priority placement is. */
  listings: Row[];
  writes: string[];
  /** Runs once, just before the next write: something else changing the row. */
  beforeWrite?: () => void;
}

function store(): Store {
  return {
    users: [
      { id: "u-ada", email: "ada@acme.test" },
      { id: "u-bo", email: "bo@bolt.test" },
      { id: "u-cy", email: "cy@many.test" },
      { id: "u-dee", email: "dee@acme.test" },
    ],
    organizations: [
      { id: ACME, name: "Acme", ownerId: "u-ada", createdAt: new Date("2026-01-01") },
      { id: BOLT, name: "Bolt", ownerId: "u-bo", createdAt: new Date("2026-02-01") },
      // cy owns Core, and is a second owner of Bolt.
      { id: CORE, name: "Core", ownerId: "u-cy", createdAt: new Date("2026-03-01") },
    ],
    members: [
      { orgId: BOLT, userId: "u-cy", role: "owner" },
      // A member who is not an owner names no organization.
      { orgId: ACME, userId: "u-dee", role: "admin" },
    ],
    profiles: [{ orgId: ACME, slug: "acme-labs" }],
    subscriptions: [],
    listings: [
      { id: "l-acme-1", publisherId: ACME, priorityPlacement: false },
      { id: "l-acme-2", publisherId: ACME, priorityPlacement: false },
      { id: "l-bolt-1", publisherId: BOLT, priorityPlacement: true },
    ],
    writes: [],
  };
}

function fakePrisma(s: Store): SetPlanPrisma & SetPlanTx {
  // As Postgres answers a match without case: a pattern match, where "_" is
  // any one character and "%" any run of them.
  const emailIs = (userId: string, cond: Row) => {
    const user = s.users.find((u) => u.id === userId);
    const wanted = cond.email;
    assert.equal(wanted.mode, "insensitive");
    const pattern = String(wanted.equals)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/_/g, ".")
      .replace(/%/g, ".*");
    return !!user && new RegExp(`^${pattern}$`, "i").test(user.email);
  };
  const emailOf = (userId: string) => s.users.find((u) => u.id === userId)?.email;
  const pick = (o: Row) => ({ id: o.id, name: o.name });
  const interfere = () => {
    const run = s.beforeWrite;
    s.beforeWrite = undefined;
    run?.();
  };
  const db: SetPlanPrisma & SetPlanTx = {
    organization: {
      async findUnique(args: Row) {
        const found = s.organizations.find((o) => o.id === args.where.id);
        return found ? pick(found) : null;
      },
      async findMany(args: Row) {
        const [byOwner, byMember] = args.where.OR;
        assert.equal(byMember.members.some.role, "owner");
        return s.organizations
          .filter(
            (o) =>
              emailIs(o.ownerId, byOwner.owner) ||
              s.members.some(
                (m) => m.orgId === o.id && m.role === "owner" && emailIs(m.userId, byMember.members.some.user),
              ),
          )
          .map((o) => ({
            ...pick(o),
            owner: { email: emailOf(o.ownerId) },
            members: s.members
              .filter((m) => m.orgId === o.id && m.role === args.select.members.where.role)
              .map((m) => ({ user: { email: emailOf(m.userId) } })),
          }));
      },
    },
    publisherProfile: {
      async findUnique(args: Row) {
        const profile = s.profiles.find((p) => p.slug === args.where.slug);
        if (!profile) return null;
        return { org: pick(s.organizations.find((o) => o.id === profile.orgId)!) };
      },
    },
    orgSubscription: {
      async findUnique(args: Row) {
        const row = s.subscriptions.find((r) => r.orgId === args.where.orgId);
        return row ? { ...row } : null;
      },
      async updateMany(args: Row) {
        interfere();
        const rows = s.subscriptions.filter((r) =>
          Object.entries(args.where).every(([k, v]) => r[k] === v),
        );
        for (const row of rows) Object.assign(row, args.data);
        if (rows.length > 0) s.writes.push(`update ${args.where.orgId} ${args.data.plan}/${args.data.status}`);
        return { count: rows.length };
      },
      async create(args: Row) {
        interfere();
        if (s.subscriptions.some((r) => r.orgId === args.data.orgId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        s.subscriptions.push({ stripeSubscriptionId: null, stripeCustomerId: null, ...args.data });
        s.writes.push(`create ${args.data.orgId} ${args.data.plan}/${args.data.status}`);
        return args.data;
      },
    },
    agentListing: {
      async updateMany(args: Row) {
        const rows = s.listings.filter((l) => l.publisherId === args.where.publisherId);
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
    },
    // All or nothing: a throw puts back what the transaction had written.
    async $transaction<T>(run: (tx: SetPlanTx) => Promise<T>): Promise<T> {
      // Something else's change lands before this transaction's first write
      // and is not this transaction's to roll back.
      interfere();
      const before = {
        subscriptions: s.subscriptions.map((r) => ({ ...r })),
        listings: s.listings.map((r) => ({ ...r })),
        writes: [...s.writes],
      };
      try {
        return await run(db);
      } catch (err) {
        s.subscriptions.splice(0, s.subscriptions.length, ...before.subscriptions);
        s.listings.splice(0, s.listings.length, ...before.listings);
        s.writes.splice(0, s.writes.length, ...before.writes);
        throw err;
      }
    },
  };
  return db;
}

function placements(s: Store): Record<string, boolean> {
  return Object.fromEntries(s.listings.map((l) => [l.id, l.priorityPlacement]));
}

const PLACEMENTS_AT_START = { "l-acme-1": false, "l-acme-2": false, "l-bolt-1": true };

function sub(orgId: string, plan: string, status: string, stripeSubscriptionId: string | null = null): Row {
  return { orgId, plan, status, stripeSubscriptionId, stripeCustomerId: stripeSubscriptionId ? "cus_1" : null };
}

async function run(s: Store, input: SetPlanInput): Promise<SetPlanResult> {
  return setPlan(buildSetPlanDeps(fakePrisma(s)), input);
}

function rowOf(s: Store, orgId: string): Row | undefined {
  return s.subscriptions.find((r) => r.orgId === orgId);
}

// ============================================
// Naming the organization
// ============================================

test("by id: the plan is set, and effectivePlan of the written row answers it", async () => {
  for (const plan of ["pro", "enterprise"] as const) {
    const s = store();
    const result = await run(s, { organization: ACME, plan });
    assert.equal(result.outcome, "set");
    assert.ok(result.outcome === "set");
    assert.deepEqual(result.organization, { id: ACME, name: "Acme" });
    assert.equal(result.before.effective, "starter");
    assert.equal(result.before.row, null);
    assert.equal(result.after.effective, plan);
    assert.equal(effectivePlan(rowOf(s, ACME) as { plan: string; status: string }), plan);
    assert.deepEqual(s.writes, [`create ${ACME} ${plan}/manual`]);
    // Nobody else's row was made.
    assert.equal(s.subscriptions.length, 1);
  }
});

test("by id in capitals, by slug, and by an owner's email in any case", async () => {
  for (const organization of [ACME.toUpperCase(), "acme-labs", "ada@acme.test", "  ADA@Acme.Test "]) {
    const s = store();
    const result = await run(s, { organization, plan: "enterprise" });
    assert.equal(result.outcome, "set", organization);
    assert.equal(effectivePlan(rowOf(s, ACME) as { plan: string; status: string }), "enterprise");
  }

  // A second owner by membership names the organization too.
  const s = store();
  s.users.push({ id: "u-eve", email: "eve@bolt.test" });
  s.members.push({ orgId: BOLT, userId: "u-eve", role: "owner" });
  const result = await run(s, { organization: "eve@bolt.test", plan: "pro" });
  assert.ok(result.outcome === "set");
  assert.equal(result.organization.id, BOLT);
});

test("a name that matches no organization changes nothing and says so", async () => {
  for (const organization of [NOBODY, "no-such-slug", "nobody@nowhere.test", "dee@acme.test", "Acme", "", "  "]) {
    const s = store();
    const input = { organization, plan: "enterprise" };
    const result = await run(s, input);
    assert.equal(result.outcome, "not_found", organization);
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.subscriptions, []);
    const said = describeSetPlanResult(result, input);
    assert.equal(said.exitCode, 1);
    assert.match(said.lines.join("\n"), /No organization matches/);
    assert.match(said.lines.join("\n"), /Nothing was changed/);
  }
});

test("a name that matches two organizations changes nothing and lists them", async () => {
  const s = store();
  const input = { organization: "cy@many.test", plan: "enterprise" };
  const result = await run(s, input);
  assert.ok(result.outcome === "ambiguous");
  assert.deepEqual(result.matches.map((m) => m.id).sort(), [BOLT, CORE]);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.subscriptions, []);
  const said = describeSetPlanResult(result, input);
  assert.equal(said.exitCode, 1);
  const text = said.lines.join("\n");
  assert.match(text, /matches 2 organizations/);
  assert.match(text, /Nothing was changed/);
  assert.ok(text.includes(BOLT) && text.includes(CORE));
});

test("a plan that is not one of the three changes nothing", async () => {
  for (const plan of ["team", "Enterprise", "", "free"]) {
    const s = store();
    const input = { organization: ACME, plan };
    const result = await run(s, input);
    assert.equal(result.outcome, "invalid_plan");
    assert.deepEqual(s.writes, []);
    assert.equal(describeSetPlanResult(result, input).exitCode, 1);
  }
});

// ============================================
// Stripe
// ============================================

test("a row Stripe drives is one with a subscription id and a status Stripe keeps alive", () => {
  for (const status of ["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]) {
    assert.equal(stripeDrives({ plan: "pro", status, stripeSubscriptionId: "sub_1" }), true, status);
    // The same status with no subscription id is nothing Stripe will write to.
    assert.equal(stripeDrives({ plan: "pro", status, stripeSubscriptionId: null }), false, status);
  }
  for (const status of ["canceled", "incomplete_expired", "none", "manual"]) {
    assert.equal(stripeDrives({ plan: "pro", status, stripeSubscriptionId: "sub_1" }), false, status);
  }
  assert.equal(stripeDrives(null), false);
});

test("a row Stripe drives is refused without --force, whatever plan is asked for", async () => {
  for (const plan of ["starter", "pro", "enterprise"]) {
    const s = store();
    s.subscriptions.push(sub(ACME, "pro", "active", "sub_1"));
    const input = { organization: ACME, plan };
    const result = await run(s, input);
    assert.ok(result.outcome === "stripe_managed", plan);
    assert.equal(result.before.effective, "pro");
    assert.deepEqual(s.writes, []);
    assert.deepEqual(rowOf(s, ACME), sub(ACME, "pro", "active", "sub_1"));
    const said = describeSetPlanResult(result, input);
    assert.equal(said.exitCode, 1);
    assert.match(said.lines.join("\n"), /Stripe subscription drives this plan/);
    assert.match(said.lines.join("\n"), /--force/);
  }
});

test("--force writes over a row Stripe drives, keeps its Stripe ids, and warns", async () => {
  const s = store();
  s.subscriptions.push(sub(ACME, "pro", "active", "sub_1"));
  const input = { organization: ACME, plan: "enterprise", force: true };
  const result = await run(s, input);
  assert.ok(result.outcome === "set");
  assert.equal(result.overStripe, true);
  assert.equal(result.before.effective, "pro");
  assert.equal(result.after.effective, "enterprise");
  assert.deepEqual(rowOf(s, ACME), {
    orgId: ACME,
    plan: "enterprise",
    status: "manual",
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
  });
  const said = describeSetPlanResult(result, input);
  assert.equal(said.exitCode, 0);
  assert.match(said.lines.join("\n"), /Stripe subscription still exists/);
});

test("a subscription Stripe has ended is not refused", async () => {
  const s = store();
  s.subscriptions.push(sub(ACME, "pro", "canceled", "sub_1"));
  const result = await run(s, { organization: ACME, plan: "enterprise" });
  assert.ok(result.outcome === "set");
  assert.equal(result.overStripe, false);
  assert.equal(result.before.effective, "starter");
  assert.equal(effectivePlan(rowOf(s, ACME) as { plan: string; status: string }), "enterprise");
});

// ============================================
// Dry run
// ============================================

test("--dry-run writes nothing and says what it would write", async () => {
  const s = store();
  const input = { organization: "acme-labs", plan: "enterprise", dryRun: true };
  const result = await run(s, input);
  assert.ok(result.outcome === "dry_run");
  assert.deepEqual(result.wouldWrite, { plan: "enterprise", status: "manual" });
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.subscriptions, []);
  const said = describeSetPlanResult(result, input);
  assert.equal(said.exitCode, 0);
  assert.match(said.lines.join("\n"), /Dry run/);
  assert.match(said.lines.join("\n"), /Nothing was changed/);

  // With --force over Stripe: still nothing written.
  const forced = store();
  forced.subscriptions.push(sub(ACME, "pro", "trialing", "sub_1"));
  const over = await run(forced, { organization: ACME, plan: "starter", force: true, dryRun: true });
  assert.ok(over.outcome === "dry_run");
  assert.equal(over.overStripe, true);
  assert.deepEqual(over.wouldWrite, { plan: "starter", status: "none" });
  assert.deepEqual(forced.writes, []);
  assert.deepEqual(rowOf(forced, ACME), sub(ACME, "pro", "trialing", "sub_1"));

  // Without --force a dry run is refused the way a real run is.
  const refused = store();
  refused.subscriptions.push(sub(ACME, "pro", "active", "sub_1"));
  assert.equal((await run(refused, { organization: ACME, plan: "starter", dryRun: true })).outcome, "stripe_managed");
});

// ============================================
// Starter, and nothing to do
// ============================================

test("starter removes a grant", async () => {
  const s = store();
  s.subscriptions.push(sub(ACME, "enterprise", "manual"));
  const input = { organization: ACME, plan: "starter" };
  const result = await run(s, input);
  assert.ok(result.outcome === "set");
  assert.equal(result.before.effective, "enterprise");
  assert.equal(result.after.effective, "starter");
  assert.deepEqual(rowOf(s, ACME), sub(ACME, "starter", "none"));
  assert.deepEqual(s.writes, [`update ${ACME} starter/none`]);

  const said = describeSetPlanResult(result, input).lines.join("\n");
  assert.match(said, /Plan before: Enterprise/);
  assert.match(said, /Plan after: {2}Starter/);
});

test("starter with no row, and a plan that is already set, change nothing", async () => {
  const none = store();
  const input = { organization: ACME, plan: "starter" };
  const result = await run(none, input);
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(none.subscriptions, []);
  assert.equal(describeSetPlanResult(result, input).exitCode, 0);

  const granted = store();
  granted.subscriptions.push(sub(ACME, "enterprise", "manual"));
  assert.equal((await run(granted, { organization: ACME, plan: "enterprise" })).outcome, "unchanged");
  assert.deepEqual(granted.writes, []);

  // A row that names the plan but is not in force is not "already set".
  const lapsed = store();
  lapsed.subscriptions.push(sub(ACME, "enterprise", "none"));
  const fixed = await run(lapsed, { organization: ACME, plan: "enterprise" });
  assert.ok(fixed.outcome === "set");
  assert.equal(fixed.before.effective, "starter");
  assert.equal(effectivePlan(rowOf(lapsed, ACME) as { plan: string; status: string }), "enterprise");
});

test("moving between paid plans by hand", async () => {
  const s = store();
  s.subscriptions.push(sub(ACME, "pro", "manual"));
  const input = { organization: ACME, plan: "enterprise" };
  const result = await run(s, input);
  assert.ok(result.outcome === "set");
  const said = describeSetPlanResult(result, input).lines.join("\n");
  assert.match(said, /Plan before: Pro \(stored plan "pro", status "manual"\)/);
  assert.match(said, /Plan after: {2}Enterprise \(stored plan "enterprise", status "manual"\)/);
  assert.match(said, /Done\./);
});

// ============================================
// The write is a compare-and-set
// ============================================

test("a row that changed between the read and the write is not written over", async () => {
  // A Stripe event lands in between.
  const s = store();
  s.subscriptions.push(sub(ACME, "pro", "canceled", "sub_1"));
  s.beforeWrite = () => {
    Object.assign(rowOf(s, ACME)!, { status: "active" });
  };
  const input = { organization: ACME, plan: "enterprise" };
  const result = await run(s, input);
  assert.equal(result.outcome, "changed_meanwhile");
  assert.deepEqual(rowOf(s, ACME), sub(ACME, "pro", "active", "sub_1"));
  assert.deepEqual(s.writes, []);
  assert.equal(describeSetPlanResult(result, input).exitCode, 1);

  // A row is created in between, where none was read.
  const fresh = store();
  fresh.beforeWrite = () => {
    fresh.subscriptions.push(sub(ACME, "pro", "trialing", "sub_9"));
  };
  const second = await run(fresh, { organization: ACME, plan: "enterprise" });
  assert.equal(second.outcome, "changed_meanwhile");
  assert.deepEqual(rowOf(fresh, ACME), sub(ACME, "pro", "trialing", "sub_9"));
  assert.deepEqual(fresh.writes, []);
});

test("a write that did not put the plan in force is reported, not called done", async () => {
  const s = store();
  const deps = buildSetPlanDeps(fakePrisma(s));
  const input = { organization: ACME, plan: "enterprise" };
  const result = await setPlan(
    {
      ...deps,
      // Something rewrites the row straight after the write.
      writePlan: async (w) => {
        const written = await deps.writePlan(w);
        Object.assign(rowOf(s, ACME)!, { plan: "pro", status: "canceled" });
        return written;
      },
    },
    input,
  );
  assert.ok(result.outcome === "did_not_apply");
  assert.equal(result.after.effective, "starter");
  const said = describeSetPlanResult(result, input);
  assert.equal(said.exitCode, 1);
  assert.doesNotMatch(said.lines.join("\n"), /Done\./);
});

test("an error from the database that is not a unique violation is not swallowed", async () => {
  const s = store();
  const prisma = fakePrisma(s);
  prisma.orgSubscription.create = async () => {
    throw new Error("connection refused");
  };
  await assert.rejects(
    setPlan(buildSetPlanDeps(prisma), { organization: ACME, plan: "enterprise" }),
    /connection refused/,
  );
});

// ============================================
// An email is matched letter for letter
// ============================================

test("an email with \"_\" or \"%\" in it names only the owner who has exactly that email", async () => {
  // The database reads "_" as any one character. a_b@acme.test is nobody's
  // email, and must not name the organization of aXb@acme.test.
  const s = store();
  s.users.push({ id: "u-axb", email: "aXb@acme.test" });
  s.organizations.push({ id: NOBODY, name: "Twin", ownerId: "u-axb", createdAt: new Date("2026-04-01") });
  for (const organization of ["a_b@acme.test", "%@acme.test", "a%@acme.test"]) {
    const result = await run(s, { organization, plan: "enterprise" });
    assert.equal(result.outcome, "not_found", organization);
  }
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.subscriptions, []);

  // The owner whose email really has the underscore is found, alone.
  s.users.push({ id: "u-a_b", email: "A_B@acme.test" });
  s.members.push({ orgId: CORE, userId: "u-a_b", role: "owner" });
  const result = await run(s, { organization: "a_b@acme.test", plan: "enterprise" });
  assert.ok(result.outcome === "set");
  assert.equal(result.organization.id, CORE);
  assert.equal(rowOf(s, NOBODY), undefined);
});

// ============================================
// What the plan gives is written with it
// ============================================

test("the organization's listings get the plan's priority placement, and lose it with the grant", async () => {
  const s = store();
  assert.deepEqual(placements(s), PLACEMENTS_AT_START);

  assert.equal((await run(s, { organization: ACME, plan: "enterprise" })).outcome, "set");
  // Acme's listings, and nobody else's.
  assert.deepEqual(placements(s), { "l-acme-1": true, "l-acme-2": true, "l-bolt-1": true });

  assert.equal((await run(s, { organization: ACME, plan: "pro" })).outcome, "set");
  assert.deepEqual(placements(s), { "l-acme-1": true, "l-acme-2": true, "l-bolt-1": true });

  assert.equal((await run(s, { organization: ACME, plan: "starter" })).outcome, "set");
  assert.deepEqual(placements(s), { "l-acme-1": false, "l-acme-2": false, "l-bolt-1": true });
});

test("nothing is written to listings by a dry run, a refusal or a row that changed meanwhile", async () => {
  const dry = store();
  await run(dry, { organization: ACME, plan: "enterprise", dryRun: true });
  assert.deepEqual(placements(dry), PLACEMENTS_AT_START);

  const refused = store();
  refused.subscriptions.push(sub(BOLT, "pro", "active", "sub_1"));
  assert.equal((await run(refused, { organization: BOLT, plan: "starter" })).outcome, "stripe_managed");
  assert.deepEqual(placements(refused), PLACEMENTS_AT_START);

  const changed = store();
  changed.subscriptions.push(sub(BOLT, "pro", "manual"));
  changed.beforeWrite = () => {
    Object.assign(rowOf(changed, BOLT)!, { plan: "enterprise" });
  };
  assert.equal((await run(changed, { organization: BOLT, plan: "starter" })).outcome, "changed_meanwhile");
  assert.deepEqual(placements(changed), PLACEMENTS_AT_START);
  assert.deepEqual(rowOf(changed, BOLT), sub(BOLT, "enterprise", "manual"));
});

test("the plan and the listings are written together or not at all", async () => {
  const s = store();
  const prisma = fakePrisma(s);
  prisma.agentListing.updateMany = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(
    setPlan(buildSetPlanDeps(prisma), { organization: ACME, plan: "enterprise" }),
    /connection lost/,
  );
  // The plan row did not stay behind without what it gives.
  assert.deepEqual(s.subscriptions, []);
  assert.deepEqual(placements(s), PLACEMENTS_AT_START);
});
