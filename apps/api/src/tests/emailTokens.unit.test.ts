import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmEmailVerification,
  hashEmailToken,
  InvalidEmailTokenError,
  issueEmailToken,
  resetPasswordWithToken,
  SIGNUP_BONUS_CENTS,
  type EmailTokenDb,
} from "../services/emailTokens.js";

function fakeDb() {
  const state = {
    tokens: [] as any[],
    users: new Map<string, { id: string; email: string | null; emailVerified: boolean; passwordHash?: string }>(),
    orgs: [] as { id: string; ownerId: string; createdAt: Date; signupBonusGrantedAt: Date | null }[],
    balances: new Map<string, bigint>(),
    ledger: [] as any[],
  };
  const db: EmailTokenDb = {
    emailToken: {
      create: async ({ data }) => {
        state.tokens.push({ id: `t${state.tokens.length + 1}`, usedAt: null, ...data });
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const t of state.tokens) {
          if (where.id && t.id !== where.id) continue;
          if (where.userId && t.userId !== where.userId) continue;
          if (where.purpose && t.purpose !== where.purpose) continue;
          if (t.usedAt !== null) continue;
          t.usedAt = data.usedAt;
          count++;
        }
        return { count };
      },
      findUnique: async ({ where }) => state.tokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
    },
    user: {
      findUnique: async ({ where }) => state.users.get(where.id) ?? null,
      update: async ({ where, data }) => {
        Object.assign(state.users.get(where.id)!, data);
      },
    },
    organization: {
      findFirst: async ({ where }) =>
        state.orgs.filter((o) => o.ownerId === where.ownerId).sort((a, b) => +a.createdAt - +b.createdAt)[0] ?? null,
      updateMany: async ({ where, data }) => {
        const o = state.orgs.find((x) => x.id === where.id && x.signupBonusGrantedAt === null);
        if (!o) return { count: 0 };
        o.signupBonusGrantedAt = data.signupBonusGrantedAt;
        return { count: 1 };
      },
    },
    creditBalance: {
      upsert: async ({ where, update }) => {
        const next = (state.balances.get(where.orgId) ?? 0n) + update.balanceCents.increment;
        state.balances.set(where.orgId, next);
        return { balanceCents: next };
      },
    },
    creditTransaction: {
      create: async ({ data }) => {
        state.ledger.push(data);
      },
    },
  };
  state.users.set("u1", { id: "u1", email: "a@example.com", emailVerified: false });
  state.orgs.push({ id: "o1", ownerId: "u1", createdAt: new Date(0), signupBonusGrantedAt: null });
  return { db, state };
}

test("only the token's hash is stored", async () => {
  const { db, state } = fakeDb();
  const token = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email" });
  assert.equal(state.tokens[0].tokenHash, hashEmailToken(token));
  assert.ok(!JSON.stringify(state.tokens).includes(token));
});

test("verification grants the signup bonus exactly once per org", async () => {
  const { db, state } = fakeDb();
  const t1 = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email" });
  const r1 = await confirmEmailVerification(db, { token: t1 });
  assert.equal(r1.bonusGrantedCents, SIGNUP_BONUS_CENTS);
  assert.equal(state.users.get("u1")!.emailVerified, true);
  assert.equal(state.balances.get("o1"), 500n);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].referenceId, "signup-bonus:o1");

  // Verifying again (e.g. after an email change) never pays twice.
  const t2 = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email" });
  const r2 = await confirmEmailVerification(db, { token: t2 });
  assert.equal(r2.bonusGrantedCents, 0n);
  assert.equal(state.balances.get("o1"), 500n);
});

test("a token works once", async () => {
  const { db } = fakeDb();
  const t = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email" });
  await confirmEmailVerification(db, { token: t });
  await assert.rejects(confirmEmailVerification(db, { token: t }), InvalidEmailTokenError);
});

test("expired, wrong-purpose and superseded tokens are refused", async () => {
  const { db } = fakeDb();
  const now = new Date("2026-10-01T00:00:00Z");
  const verify = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email", now });
  await assert.rejects(
    confirmEmailVerification(db, { token: verify, now: new Date(now.getTime() + 25 * 3600_000) }),
    InvalidEmailTokenError,
  );
  const reset = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "reset_password", now });
  await assert.rejects(confirmEmailVerification(db, { token: reset, now }), InvalidEmailTokenError);
  const older = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "reset_password", now });
  await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "reset_password", now });
  await assert.rejects(resetPasswordWithToken(db, { token: older, passwordHash: "h", now }), InvalidEmailTokenError);
});

test("a verification link dies when the account's email changes", async () => {
  const { db, state } = fakeDb();
  const t = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "verify_email" });
  state.users.get("u1")!.email = "new@example.com";
  await assert.rejects(confirmEmailVerification(db, { token: t }), InvalidEmailTokenError);
  assert.equal(state.balances.get("o1"), undefined);
});

test("password reset sets the hash and retires other reset links", async () => {
  const { db, state } = fakeDb();
  const a = await issueEmailToken(db, { userId: "u1", email: "a@example.com", purpose: "reset_password" });
  const res = await resetPasswordWithToken(db, { token: a, passwordHash: "argon2-hash" });
  assert.deepEqual(res, { userId: "u1", email: "a@example.com" });
  assert.equal(state.users.get("u1")!.passwordHash, "argon2-hash");
  assert.ok(state.tokens.every((t) => t.usedAt !== null));
});
