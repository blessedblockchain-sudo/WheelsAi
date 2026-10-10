import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// Contributor invitations against an in-memory database. What these pin:
// inviting by email reads the same for an address with an account and one
// without (the response, a repeat, the share check and the list), an
// invitation is bound to an account only when its verified owner accepts,
// and a contributor's payout profile and owed shares are settled outside
// the money transaction.

type Row = Record<string, any>;

const AGENT = "agent_1";
const KNOWN = "alice@example.com"; // has an account
const UNKNOWN = "nobody@example.com"; // does not

function makeWorld() {
  const state = {
    users: [
      { id: "u_alice", email: "Alice@Example.com", emailVerified: true, displayName: "Alice A." },
      { id: "u_mallory", email: "mallory@example.com", emailVerified: true, displayName: "Mallory" },
      { id: "u_squatter", email: "bob@example.com", emailVerified: false, displayName: "Not Bob" },
    ] as Row[],
    orgs: [{ id: "org_alice", name: "Alice Labs", ownerId: "u_alice", createdAt: new Date(1) }] as Row[],
    contributors: [] as Row[],
    profiles: [] as Row[],
    earnings: [] as Row[],
    /** The recipients' ledger: one row for every change to what they are owed. */
    ledger: [] as Row[],
    userReads: 0,
    profileCreateFailures: [] as string[], // unique targets to fail the next creates with
  };
  let seq = 0;

  const whereMatches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, cond]) => {
      if (k === "OR") return (cond as Row[]).some((w) => whereMatches(row, w));
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond) return cond.in.includes(row[k]);
        if ("not" in cond) return row[k] !== cond.not;
      }
      return (row[k] ?? null) === cond;
    });

  const withUser = (c: Row) => {
    const u = state.users.find((x) => x.id === c.userId);
    return { ...c, user: u ? { id: u.id, email: u.email, displayName: u.displayName } : null };
  };

  const models: Row = {
    user: {
      findUnique: async ({ where }: Row) => {
        state.userReads++;
        return state.users.find((u) => u.id === where.id) ?? null;
      },
      findFirst: async () => {
        state.userReads++;
        throw new Error("an invite must never look an account up by email");
      },
    },
    organization: {
      findFirst: async ({ where }: Row) => state.orgs.find((o) => o.ownerId === where.ownerId) ?? null,
    },
    agentContributor: {
      findFirst: async ({ where }: Row) => state.contributors.find((c) => whereMatches(c, where)) ?? null,
      findUnique: async ({ where }: Row) => state.contributors.find((c) => c.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: Row) => state.contributors.find((c) => c.id === where.id)!,
      findMany: async ({ where, include }: Row) =>
        state.contributors
          .filter((c) => whereMatches(c, where))
          .map((c) => (include?.user ? withUser(c) : include?.agent ? { ...c, agent: { id: AGENT, name: "Agent", slug: "agent" } } : { ...c })),
      create: async ({ data }: Row) => {
        const clash = state.contributors.some(
          (c) =>
            c.agentId === data.agentId &&
            ((data.userId && c.userId === data.userId) || (data.invitedEmail && c.invitedEmail === data.invitedEmail)),
        );
        if (clash) throw Object.assign(new Error("Unique constraint failed on the fields: (`agent_id`,`invited_email`)"), { code: "P2002" });
        const row = {
          id: `c_${++seq}`,
          userId: null,
          invitedEmail: null,
          acceptedAt: null,
          createdAt: new Date(seq),
          updatedAt: new Date(seq),
          ...data,
        };
        state.contributors.push(row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.contributors.filter((c) => whereMatches(c, where));
        for (const c of hit) {
          const clash =
            data.userId &&
            state.contributors.some((o) => o !== c && o.agentId === c.agentId && o.userId === data.userId);
          if (clash) throw Object.assign(new Error("Unique constraint failed on the fields: (`agent_id`,`user_id`)"), { code: "P2002" });
          Object.assign(c, data);
        }
        return { count: hit.length };
      },
      deleteMany: async ({ where }: Row) => {
        const before = state.contributors.length;
        state.contributors = state.contributors.filter((c) => !whereMatches(c, where));
        return { count: before - state.contributors.length };
      },
    },
    contributorEarning: {
      groupBy: async ({ where }: Row) => {
        const sums = new Map<string, bigint>();
        for (const e of state.earnings) {
          if (where.contributorId.in.includes(e.contributorId)) {
            sums.set(e.contributorId, (sums.get(e.contributorId) ?? 0n) + e.amountCents);
          }
        }
        return [...sums].map(([contributorId, amountCents]) => ({ contributorId, _sum: { amountCents } }));
      },
      findMany: async ({ where }: Row) =>
        state.earnings.filter((e) => e.userId === where.userId && e.accruedAt === null).map((e) => ({ ...e })),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.earnings.filter((e) => e.id === where.id && e.accruedAt === null);
        for (const e of hit) Object.assign(e, data);
        return { count: hit.length };
      },
    },
    publisherProfile: {
      findUnique: async ({ where }: Row) =>
        state.profiles.find((p) => (where.orgId ? p.orgId === where.orgId : p.slug === where.slug)) ?? null,
      create: async ({ data }: Row) => {
        const forced = state.profileCreateFailures.shift();
        if (forced) {
          // What the request that won the race left behind.
          if (forced === "org_id") state.profiles.push({ ...data, slug: "winner", pendingPayoutCents: 0n });
          else state.profiles.push({ orgId: "org_other", slug: data.slug, pendingPayoutCents: 0n });
          throw Object.assign(
            new Error(`\nInvalid \`prisma.publisherProfile.create()\` invocation in\n/srv/app/services/marketplace.ts:730:33\n\nUnique constraint failed on the fields: (\`${forced}\`)`),
            { code: "P2002" },
          );
        }
        if (state.profiles.some((p) => p.orgId === data.orgId || p.slug === data.slug)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { pendingPayoutCents: 0n, ...data };
        state.profiles.push(row);
        return row;
      },
      // What moveEarnings issues: the credit, then (above) the read of the
      // balance it left.
      updateMany: async ({ where, data }: Row) => {
        const row = state.profiles.find((p) => p.orgId === where.orgId);
        if (!row) return { count: 0 };
        row.pendingPayoutCents += data.pendingPayoutCents.increment;
        row.totalRevenueCents = (row.totalRevenueCents ?? 0n) + (data.totalRevenueCents?.increment ?? 0n);
        return { count: 1 };
      },
    },
    earningsTransaction: {
      create: async ({ data }: Row) => {
        state.ledger.push({ ...data });
        return data;
      },
    },
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(models),
  };
  return { state, models };
}

async function withWorld<T>(
  world: ReturnType<typeof makeWorld>,
  body: (
    collab: typeof import("../services/collaboration.js"),
    market: typeof import("../services/marketplace.js"),
  ) => Promise<T>,
): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const collab = await import("../services/collaboration.js");
  const market = await import("../services/marketplace.js");
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    return await body(collab, market);
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

/** Everything an inviter can observe about one invited address. */
async function observe(email: string) {
  const world = makeWorld();
  return withWorld(world, async ({ addContributor, listContributors }) => {
    // 60% is already allocated on the agent.
    await addContributor(AGENT, { email: "first@example.com" }, "contributor", 0.6, "u_owner");

    const first = await addContributor(AGENT, { email }, "contributor", 0.1, "u_owner");
    const again = await addContributor(AGENT, { email: `  ${email.toUpperCase()} ` }, "contributor", 0.1, "u_owner");
    const tooMuch = await addContributor(AGENT, { email: `other-${email}` }, "contributor", 0.5, "u_owner").then(
      () => "accepted",
      (err: Error) => `${err.name}: ${err.message}`,
    );
    const listed = (await listContributors(AGENT)).map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => ({
      ...rest,
      invitedEmail: rest.invitedEmail === email ? "<the address>" : rest.invitedEmail,
    }));
    return { first, again, tooMuch, listed, userReads: world.state.userReads };
  });
}

test("inviting an address reads exactly the same whether or not it has an account", async () => {
  const known = await observe(KNOWN);
  const unknown = await observe(UNKNOWN);
  assert.deepEqual(known, unknown);

  // And what that identical observation is:
  assert.deepEqual(known.first, { created: true });
  assert.deepEqual(known.again, { created: false }); // a repeat is not an error
  assert.match(known.tooMuch, /^ContributorInviteError: Total revenue share would exceed 100%/);
  assert.equal(known.userReads, 0); // no account was looked up at all
  const row = known.listed.find((c) => c.invitedEmail === "<the address>")!;
  assert.deepEqual(row, {
    agentId: AGENT,
    role: "contributor",
    revenueShare: 0.1,
    revenueShareBps: 1_000,
    status: "pending",
    invitedEmail: "<the address>",
    acceptedAt: null,
    earnedCents: 0,
    user: null,
  });
});

test("a pending row never names an account, even one invited by user id", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addContributor, listContributors }) => {
    await addContributor(AGENT, { userId: "u_alice" }, "reviewer", 0, "u_owner");
    const [row] = await listContributors(AGENT);
    assert.equal(row!.status, "pending");
    assert.equal(row!.user, null);
    assert.equal(JSON.stringify(row).includes("u_alice"), false);
    assert.equal(JSON.stringify(row).includes("Alice"), false);
  });
});

test("a concurrent identical invite that loses the unique constraint is the same quiet repeat", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addContributor }) => {
    // Both pass the duplicate read before either inserts.
    const results = await Promise.all([
      addContributor(AGENT, { email: KNOWN }, "contributor", 0.1, "u_owner"),
      addContributor(AGENT, { email: KNOWN }, "contributor", 0.1, "u_owner"),
    ]);
    assert.deepEqual(results.map((r) => r.created).sort(), [false, true]);
    assert.equal(world.state.contributors.length, 1);
  });
});

test("the verified owner of the address accepts, and only then does the list name them", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addContributor, listMyContributions, acceptInvitation, listContributors }) => {
    await addContributor(AGENT, { email: KNOWN }, "contributor", 0.2, "u_owner");
    const [mine] = await listMyContributions("u_alice"); // matched case-insensitively
    assert.equal(mine!.acceptedAt, null);
    assert.deepEqual(await listMyContributions("u_mallory"), []);

    await assert.rejects(acceptInvitation(mine!.id, "u_mallory"), /Not your invitation/);
    const accepted = await acceptInvitation(mine!.id, "u_alice");
    assert.equal(accepted.userId, "u_alice");
    assert.ok(accepted.acceptedAt);
    await assert.rejects(acceptInvitation(mine!.id, "u_alice"), /Already accepted/);

    const [row] = await listContributors(AGENT);
    assert.equal(row!.status, "accepted");
    assert.deepEqual(row!.user, { id: "u_alice", email: "Alice@Example.com", displayName: "Alice A." });
    // Accepting created the payout profile, outside any money transaction.
    assert.equal(world.state.profiles.some((p) => p.orgId === "org_alice"), true);
  });
});

test("an unverified account cannot claim an invitation sent to its address", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addContributor, listMyContributions, acceptInvitation, declineInvitation }) => {
    await addContributor(AGENT, { email: "bob@example.com" }, "contributor", 0.5, "u_owner");
    const id = world.state.contributors[0]!.id;
    assert.deepEqual(await listMyContributions("u_squatter"), []);
    await assert.rejects(acceptInvitation(id, "u_squatter"), /Verify your email/);
    await assert.rejects(declineInvitation(id, "u_squatter"), /No pending invitation/);
    assert.equal(world.state.contributors[0]!.acceptedAt, null);
    assert.equal(world.state.contributors[0]!.userId, null);
  });
});

test("accepting a second invitation on the same agent answers cleanly, not with the database error", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addContributor, acceptInvitation }) => {
    await addContributor(AGENT, { userId: "u_alice" }, "contributor", 0.1, "u_owner");
    await addContributor(AGENT, { email: KNOWN }, "contributor", 0.1, "u_owner");
    const [byId, byEmail] = world.state.contributors;
    await acceptInvitation(byId!.id, "u_alice");
    await assert.rejects(acceptInvitation(byEmail!.id, "u_alice"), (err: Error) => {
      assert.equal(err.message, "You are already a contributor to this agent");
      return true;
    });
  });
});

// ============================================
// Payout profile
// ============================================

test("losing the profile race returns the winner's profile, or the next slug, never the raw database error", async () => {
  // Same org, two requests: the loser's insert hits the org_id key.
  const sameOrg = makeWorld();
  sameOrg.state.profileCreateFailures.push("org_id");
  await withWorld(sameOrg, async (_collab, { ensurePublisherProfile }) => {
    const profile = await ensurePublisherProfile("org_alice", "Alice Labs");
    assert.equal(profile.orgId, "org_alice");
    assert.equal(sameOrg.state.profiles.length, 1);
  });

  // Two orgs whose names give the same slug: the loser takes the next one.
  const sameSlug = makeWorld();
  sameSlug.state.profileCreateFailures.push("slug");
  await withWorld(sameSlug, async (_collab, { ensurePublisherProfile }) => {
    const profile = await ensurePublisherProfile("org_alice", "Alice Labs");
    assert.equal(profile.orgId, "org_alice");
    assert.equal(profile.slug, "alice-labs-1");
  });

  // Whatever happens, the message carries no query text or server path.
  const stuck = makeWorld();
  stuck.state.profileCreateFailures.push("slug", "slug", "slug", "slug", "slug", "slug");
  await withWorld(stuck, async (_collab, { ensurePublisherProfile }) => {
    await assert.rejects(ensurePublisherProfile("org_alice", "Alice Labs"), (err: Error) => {
      assert.equal(err.message, "Could not create the publisher profile. Please try again.");
      return true;
    });
  });
});

test("a contributor accepted before profiles were created gets one, and their owed shares, when they open their contributions", async () => {
  const world = makeWorld();
  // Accepted under the old code: no publisher profile for org_alice.
  world.state.contributors.push({
    id: "c_legacy",
    agentId: AGENT,
    userId: "u_alice",
    invitedEmail: null,
    role: "contributor",
    revenueShare: 0.2,
    revenueShareBps: 2_000,
    acceptedAt: new Date(1),
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  // Settlements since then recorded her share as owed.
  world.state.earnings.push(
    { id: "e1", contributorId: "c_legacy", userId: "u_alice", amountCents: 180n, accruedAt: null, recipientOrgId: "org_alice" },
    { id: "e2", contributorId: "c_legacy", userId: "u_alice", amountCents: 90n, accruedAt: null, recipientOrgId: null },
  );

  await withWorld(world, async ({ listMyContributions }) => {
    const [mine] = await listMyContributions("u_alice");
    assert.equal(mine!.earnedCents, 270);
    const profile = world.state.profiles.find((p) => p.orgId === "org_alice")!;
    assert.equal(profile.pendingPayoutCents, 270n);
    assert.equal(profile.totalRevenueCents, 270n);
    assert.ok(world.state.earnings.every((e) => e.accruedAt !== null && e.recipientOrgId === "org_alice"));
    // Each share credited has its ledger row, against the earning it pays,
    // with the balance it left.
    assert.deepEqual(world.state.ledger, [
      {
        orgId: "org_alice",
        amountCents: 180n,
        type: "contributor_share",
        referenceId: "e1",
        description: "Contributor share owed from an earlier sale",
        balanceAfter: 180n,
      },
      {
        orgId: "org_alice",
        amountCents: 90n,
        type: "contributor_share",
        referenceId: "e2",
        description: "Contributor share owed from an earlier sale",
        balanceAfter: 270n,
      },
    ]);

    // Opening the page again credits nothing more.
    await listMyContributions("u_alice");
    assert.equal(profile.pendingPayoutCents, 270n);
    assert.equal(world.state.ledger.length, 2);
  });
});

// ============================================
// Route wiring
// ============================================

test("the invite route never resolves an email to an account", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(path.join(here, "..", "routes", "collaboration.ts"), "utf8");
  assert.equal(route.includes("findUserIdByEmail"), false);
  // The only user read is the caller's own row, for the self-invite check.
  assert.deepEqual(route.match(/prisma\.user\.\w+\([^)]*\)/g), [
    "prisma.user.findUnique({ where: { id: currentUserId }, select: { email: true } })",
  ]);
});
