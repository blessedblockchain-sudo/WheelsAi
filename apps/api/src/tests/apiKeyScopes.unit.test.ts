import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { checkKeyGrant, grantsScope, isSpendScope, SPEND_SCOPES } from "../config/apiKeyScopes.js";
import { createRequireSpend, requireScope } from "../middleware/auth.js";
import { principalHasScope } from "../middleware/openaiAuth.js";

// API-key scopes. What these pin: a spend scope is held only by a key that
// was granted it by name; everything else keeps the access unscoped keys
// have always had; and a signed-in member spends only as an owner or admin.

interface Sent {
  status: number;
  body: { error?: string } | null;
}

function fakeReply() {
  const sent: Sent = { status: 200, body: null };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: Sent["body"]) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as never, sent };
}

const key = (scopes: string[]) => ({ auth: { type: "api_key", orgId: "org_1", userId: null, scopes } }) as never;
const session = (userId = "user_1") => ({ auth: { type: "jwt", orgId: "org_1", userId } }) as never;

test("a spend scope is granted only by name: neither * nor an unscoped key carries it", () => {
  for (const scope of SPEND_SCOPES) {
    assert.equal(isSpendScope(scope), true);
    assert.equal(grantsScope([], scope), false, `[] must not grant ${scope}`);
    assert.equal(grantsScope(undefined, scope), false);
    assert.equal(grantsScope(["*"], scope), false, `* must not grant ${scope}`);
    assert.equal(grantsScope(["agents:invoke"], scope), false);
    assert.equal(grantsScope([scope], scope), true);
    assert.equal(grantsScope(["*", scope], scope), true);
  }
});

test("an ordinary scope is held by the listed scope, by *, and by a key created before scopes", () => {
  for (const scope of ["jobs:read", "offerings:write", "agents:invoke", "workflows:invoke"]) {
    assert.equal(isSpendScope(scope), false);
    assert.equal(grantsScope([], scope), true);
    assert.equal(grantsScope(["*"], scope), true);
    assert.equal(grantsScope([scope], scope), true);
    // A key that WAS scoped is held to its scopes.
    assert.equal(grantsScope(["jobs:hire"], scope), false);
  }
  // The /v1 guard reads the same rule.
  assert.equal(principalHasScope({ type: "api_key", scopes: [] }, "agents:invoke"), true);
  assert.equal(principalHasScope({ type: "api_key", scopes: ["workflows:invoke"] }, "agents:invoke"), false);
  assert.equal(principalHasScope({ type: "api_key", scopes: ["*"] }, "jobs:hire"), false);
  assert.equal(principalHasScope({ type: "jwt" }, "jobs:hire"), true);
});

test("requireScope: a session passes, a key needs the scope, nobody is a 401", async () => {
  const guard = requireScope("jobs:hire");

  const anonymous = fakeReply();
  await guard({ auth: null } as never, anonymous.reply);
  assert.equal(anonymous.sent.status, 401);

  const member = fakeReply();
  await guard(session(), member.reply);
  assert.equal(member.sent.body, null);

  for (const scopes of [[], ["*"], ["jobs:read"]]) {
    const refused = fakeReply();
    await guard(key(scopes), refused.reply);
    assert.equal(refused.sent.status, 403, JSON.stringify(scopes));
    assert.equal(refused.sent.body?.error, "missing_scope");
  }
  const granted = fakeReply();
  await guard(key(["jobs:hire"]), granted.reply);
  assert.equal(granted.sent.body, null);

  // A read scope still admits the keys that predate scopes.
  const legacy = fakeReply();
  await requireScope("jobs:read")(key([]), legacy.reply);
  assert.equal(legacy.sent.body, null);
});

test("requireSpend: only an owner or admin spends from a session; a key spends only with the scope", async () => {
  const roles: Record<string, string | null> = { owner_1: "owner", admin_1: "admin", member_1: "member", gone_1: null };
  const guard = createRequireSpend({ getMemberRole: async (_orgId, userId) => roles[userId] ?? null })("jobs:hire");

  for (const userId of ["owner_1", "admin_1"]) {
    const ok = fakeReply();
    await guard(session(userId), ok.reply);
    assert.equal(ok.sent.body, null, userId);
  }
  const member = fakeReply();
  await guard(session("member_1"), member.reply);
  assert.equal(member.sent.status, 403);
  assert.equal(member.sent.body?.error, "insufficient_role");

  // The role is the membership's as it is now, not the token's claim.
  const removed = fakeReply();
  await guard(session("gone_1"), removed.reply);
  assert.equal(removed.sent.body?.error, "not_a_member");

  const unscoped = fakeReply();
  await guard(key([]), unscoped.reply);
  assert.equal(unscoped.sent.body?.error, "missing_scope");
  const star = fakeReply();
  await guard(key(["*"]), star.reply);
  assert.equal(star.sent.body?.error, "missing_scope");
  const granted = fakeReply();
  await guard(key(["jobs:hire"]), granted.reply);
  assert.equal(granted.sent.body, null);

  const anonymous = fakeReply();
  await guard({ auth: null } as never, anonymous.reply);
  assert.equal(anonymous.sent.status, 401);
});

test("a role lookup that fails refuses the spend instead of letting it through", async () => {
  const guard = createRequireSpend({
    getMemberRole: async () => {
      throw new Error("db down");
    },
  })("jobs:hire");
  const refused = fakeReply();
  await guard(session(), refused.reply);
  assert.equal(refused.sent.status, 503);
});

test("creating a key: unknown scopes are refused, and jobs:hire needs both caps", () => {
  assert.equal(checkKeyGrant({ scopes: [] }), null);
  assert.equal(checkKeyGrant({ scopes: ["jobs:read", "offerings:write"] }), null);
  assert.equal(checkKeyGrant({ scopes: ["jobs:review", "marketplace:install"] }), null);

  const unknown = checkKeyGrant({ scopes: ["jobs:read", "admin", "billing:write"] });
  assert.equal(unknown?.code, "invalid_scope");
  assert.deepEqual(unknown?.code === "invalid_scope" ? unknown.scopes : [], ["admin", "billing:write"]);

  assert.equal(checkKeyGrant({ scopes: ["jobs:hire"] })?.code, "spend_caps_required");
  assert.equal(checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 500 })?.code, "spend_caps_required");
  assert.equal(checkKeyGrant({ scopes: ["jobs:hire"], dailySpendCapCents: 500 })?.code, "spend_caps_required");
  assert.equal(checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 500, dailySpendCapCents: 2_000 }), null);

  // Caps are whole cents within bounds, the per-job one no larger than the day's.
  assert.equal(
    checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 0, dailySpendCapCents: 2_000 })?.code,
    "invalid_spend_cap",
  );
  assert.equal(
    checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 12.5, dailySpendCapCents: 2_000 })?.code,
    "invalid_spend_cap",
  );
  assert.equal(
    checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 5_000, dailySpendCapCents: 2_000 })?.code,
    "invalid_spend_cap",
  );
  assert.equal(
    checkKeyGrant({ scopes: ["jobs:hire"], maxJobPriceCents: 100_001, dailySpendCapCents: 200_000 })?.code,
    "invalid_spend_cap",
  );
  // Caps on a key that cannot hire would be a promise nothing keeps.
  assert.equal(checkKeyGrant({ scopes: ["jobs:read"], maxJobPriceCents: 500 })?.code, "invalid_spend_cap");
});
