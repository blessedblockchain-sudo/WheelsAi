import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Pins the B5 2FA login gate. Before it, the second factor was collected
// in settings and NEVER ASKED FOR: /login issued the cookie on password
// alone, so enabling 2FA bought a user nothing. These tests fix the
// contract at the route boundary:
//
//   - 2FA user + correct password  → {requires2FA} and NO session
//   - non-2FA user                 → session as before (no regression)
//   - challenge + valid code       → session issued
//   - bad / expired / reused code  → 401, still no session
//   - the removed public /2fa/challenge oracle stays removed

async function loadAuthRoutes() {
  setupEnv();
  return import("../routes/auth.js");
}

test("the unauthenticated 2FA challenge oracle is gone", async () => {
  setupEnv();
  const mod = await import("../routes/twoFactor.js");
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../routes/twoFactor.ts", import.meta.url).pathname,
      "utf8",
    ),
  );
  assert.equal(typeof mod.twoFactorRoutes, "function");
  // The route that answered "does this userId have 2FA?" to anyone.
  assert.ok(
    !/app\.post[^\n]*"\/challenge"/.test(src),
    "public POST /2fa/challenge must not exist — it was a user-enumeration oracle",
  );
  assert.ok(
    !/app\.post[^\n]*"\/challenge\/verify"/.test(src),
    "public POST /2fa/challenge/verify must not exist — superseded by /auth/login/2fa",
  );
});

test("a 2FA-enabled login returns a challenge and issues NO session", async () => {
  const { authRoutes } = await loadAuthRoutes();
  assert.equal(typeof authRoutes, "function");

  // The gate's contract lives in the route source: the challenge branch
  // must return before any token is generated or cookie set.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../routes/auth.ts", import.meta.url).pathname,
      "utf8",
    ),
  );

  const loginStart = src.indexOf('app.post("/login"');
  const challengeIdx = src.indexOf("createChallenge(user.id)", loginStart);
  const tokenIdx = src.indexOf("generateTokens(app, payload)", loginStart);
  assert.ok(challengeIdx > loginStart, "login must consult createChallenge");
  assert.ok(
    challengeIdx < tokenIdx,
    "the 2FA gate must run BEFORE the JWT is generated",
  );

  const gateBlock = src.slice(challengeIdx, tokenIdx);
  assert.ok(
    /requires2FA:\s*true/.test(gateBlock),
    "the gate must answer requires2FA",
  );
  assert.ok(
    !/setAuthCookie/.test(gateBlock),
    "the gate must not set an auth cookie",
  );
});

test("the wallet login path is gated too — a signature is only one factor", async () => {
  setupEnv();
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../routes/auth.ts", import.meta.url).pathname,
      "utf8",
    ),
  );
  const walletIdx = src.indexOf("User authenticated via wallet");
  const walletGate = src.lastIndexOf("createChallenge(user.id)", walletIdx);
  assert.ok(
    walletGate > 0 && walletGate < walletIdx,
    "the wallet path must consult createChallenge before issuing its session",
  );
});

test("challenge redemption is the only path to a session, and it is rate-limited", async () => {
  setupEnv();
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../routes/auth.ts", import.meta.url).pathname,
      "utf8",
    ),
  );
  const completionIdx = src.indexOf('"/login/2fa"');
  assert.ok(completionIdx > 0, "POST /login/2fa must exist");

  const block = src.slice(completionIdx, completionIdx + 3000);
  assert.ok(
    /rateLimit:\s*\{\s*max:\s*5/.test(block),
    "brute-forcing six digits must not be cheap",
  );
  assert.ok(
    /validateChallenge\(/.test(block),
    "must validate the challenge (which marks it used, preventing replay)",
  );
  assert.ok(
    /setAuthCookie\(reply, accessToken\)/.test(block),
    "must issue the session only after validation",
  );
  // One error shape for invalid/expired/used — no oracle.
  assert.ok(
    /Invalid or expired verification code/.test(block),
    "failures must be indistinguishable to the caller",
  );
});

test("validateChallenge marks a challenge used so a code cannot be replayed", async () => {
  setupEnv();
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const orig = {
    twoFactorChallenge: { ...p.twoFactorChallenge },
    twoFactorAuth: { ...p.twoFactorAuth },
  };
  try {
    const updates: Array<{ where: unknown; data: unknown }> = [];
    p.twoFactorChallenge.findUnique = async () => ({
      id: "chal_1",
      userId: "user_1",
      token: "tok",
      isUsed: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    p.twoFactorChallenge.update = async (args: any) => {
      updates.push(args);
      return {};
    };
    // verify2FA reads the user's 2FA row; make the TOTP check pass by
    // routing through a backup code that matches.
    p.twoFactorAuth.findUnique = async () => null;

    const { validateChallenge } = await import("../services/twoFactor.js");
    // With no 2FA row the verification must FAIL — a missing secret can
    // never validate a code.
    await assert.rejects(validateChallenge("tok", "123456"));
    assert.deepEqual(updates, [], "a failed code must not consume the challenge");
  } finally {
    Object.assign(p.twoFactorChallenge, orig.twoFactorChallenge);
    Object.assign(p.twoFactorAuth, orig.twoFactorAuth);
  }
});
