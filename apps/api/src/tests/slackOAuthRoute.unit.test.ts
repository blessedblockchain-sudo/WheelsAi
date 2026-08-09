import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import Fastify from "fastify";

import { createSlackOAuthRoutes, type SlackOAuthDeps } from "../routes/slackOAuth.js";
import { createSlackEventsRoutes, type SlackEventsDeps } from "../routes/slackEvents.js";
import { makeMemoryNonceStore } from "../services/oauthStateStore.js";
import { signState } from "../services/signedState.js";
import {
  buildSlackAuthorizeUrl,
  isSafeReturnPath,
  parseSlackAccessResponse,
} from "../services/slackOAuth.js";

// Drives the Slack install flow (W2). The callback is necessarily
// UNAUTHENTICATED — the browser arrives from slack.com with no session
// for our origin — so every property that authorizes the install lives in
// the state token. These pin that it is both unforgeable AND unreplayable.

const STATE_SECRET = "slack-state-secret-0123456789abcdef";
const SIGNING_SECRET = "slack-signing-secret";

interface Recorded {
  upserts: unknown[];
  exchanges: string[];
}

function makeOAuthDeps(
  over: Partial<SlackOAuthDeps> = {},
): { deps: SlackOAuthDeps; rec: Recorded } {
  const rec: Recorded = { upserts: [], exchanges: [] };
  const deps: SlackOAuthDeps = {
    enabled: true,
    clientId: "client-123",
    clientSecret: "secret-123",
    signingSecret: SIGNING_SECRET,
    redirectUri: "https://api.example.com/api/integrations/slack/callback",
    webBaseUrl: "https://app.example.com",
    stateSecret: STATE_SECRET,
    nonces: makeMemoryNonceStore(),
    ownsDeployment: async () => true,
    exchangeCode: async (code) => {
      rec.exchanges.push(code);
      return {
        ok: true,
        install: {
          teamId: "T123",
          teamName: "Acme",
          botToken: "xoxb-real-token",
          botUserId: "U999",
          scopes: ["chat:write"],
        },
      };
    },
    findChannelByTeam: async () => null,
    upsertSlackChannel: async (args) => {
      rec.upserts.push(args);
    },
    ...over,
  };
  return { deps, rec };
}

async function makeApp(
  deps: SlackOAuthDeps,
  opts: { authed?: boolean; orgId?: string } = {},
) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = {
        userId: "u1",
        orgId: opts.orgId ?? "org-1",
        type: "jwt",
      };
    }
  });
  await app.register(createSlackOAuthRoutes(deps));
  return app;
}

// ============================================
// Pure helpers
// ============================================

test("the authorize URL carries client_id, redirect_uri, scopes and state", () => {
  const url = new URL(
    buildSlackAuthorizeUrl({
      clientId: "abc",
      redirectUri: "https://api.example.com/cb",
      state: "STATE",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example.com/cb");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.match(url.searchParams.get("scope")!, /chat:write/);
});

test("a Slack failure arrives as HTTP 200 with ok:false — status alone would miss it", () => {
  const failed = parseSlackAccessResponse({ ok: false, error: "invalid_code" });
  assert.equal(failed.ok, false);
  assert.equal((failed as { error: string }).error, "invalid_code");

  const missingToken = parseSlackAccessResponse({ ok: true, team: { id: "T1" } });
  assert.equal(missingToken.ok, false);

  const good = parseSlackAccessResponse({
    ok: true,
    access_token: "xoxb-1",
    bot_user_id: "U1",
    scope: "chat:write,im:history",
    team: { id: "T1", name: "Acme" },
  });
  assert.ok(good.ok);
  assert.equal(good.install.teamId, "T1");
  assert.deepEqual(good.install.scopes, ["chat:write", "im:history"]);
});

test("only same-origin paths are safe return targets", () => {
  assert.equal(isSafeReturnPath("/dashboard/integrations"), true);
  assert.equal(isSafeReturnPath("//evil.com"), false, "protocol-relative");
  assert.equal(isSafeReturnPath("https://evil.com"), false);
  assert.equal(isSafeReturnPath(42), false);
});

// ============================================
// Install
// ============================================

test("install is 501 when Slack is unconfigured — never 404", async () => {
  const { deps } = makeOAuthDeps({ enabled: false });
  const app = await makeApp(deps);
  const res = await app.inject({ method: "GET", url: "/slack/install?deploymentId=d1" });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "slack_oauth_not_configured");
});

test("install requires auth and a deployment the caller's org owns", async () => {
  const { deps } = makeOAuthDeps();
  const anon = await makeApp(deps, { authed: false });
  assert.equal(
    (await anon.inject({ method: "GET", url: "/slack/install?deploymentId=d1" })).statusCode,
    401,
  );

  const { deps: notOwned } = makeOAuthDeps({ ownsDeployment: async () => false });
  const app = await makeApp(notOwned);
  const res = await app.inject({ method: "GET", url: "/slack/install?deploymentId=d1" });
  assert.equal(res.statusCode, 404, "binding a workspace to someone else's agent is refused");
});

test("install redirects to Slack with a verifiable state", async () => {
  const { deps } = makeOAuthDeps();
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: "/slack/install?deploymentId=d1&returnTo=/dashboard/x",
  });
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.location as string);
  const state = location.searchParams.get("state")!;

  const { verifyState } = await import("../services/signedState.js");
  const verified = verifyState({
    token: state,
    secret: STATE_SECRET,
    expectedPurpose: "slack-install",
  });
  assert.ok(verified.ok);
  assert.equal(verified.payload.orgId, "org-1");
  assert.equal(verified.payload.deploymentId, "d1");
  assert.equal(verified.payload.returnTo, "/dashboard/x");
});

test("an off-origin returnTo never enters the signed state", async () => {
  const { deps } = makeOAuthDeps();
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: "/slack/install?deploymentId=d1&returnTo=https://evil.com/steal",
  });
  const state = new URL(res.headers.location as string).searchParams.get("state")!;
  const { verifyState } = await import("../services/signedState.js");
  const verified = verifyState({
    token: state,
    secret: STATE_SECRET,
    expectedPurpose: "slack-install",
  });
  assert.ok(verified.ok);
  assert.equal(verified.payload.returnTo, "/dashboard/integrations", "sanitized at mint");
});

// ============================================
// Callback
// ============================================

async function installAndGetState(deps: SlackOAuthDeps): Promise<string> {
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: "/slack/install?deploymentId=d1",
  });
  return new URL(res.headers.location as string).searchParams.get("state")!;
}

test("the happy path writes credentials where the channel stack reads them", async () => {
  const { deps, rec } = makeOAuthDeps();
  const state = await installAndGetState(deps);
  const app = await makeApp(deps);

  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=CODE&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /^https:\/\/app\.example\.com\/dashboard\/integrations\?slack=connected$/);

  assert.deepEqual(rec.exchanges, ["CODE"]);
  const written = rec.upserts[0] as Record<string, unknown>;
  assert.equal(written.deploymentId, "d1");
  assert.equal(written.teamId, "T123");
  // These two keys are exactly what resolveChannelConfig/channelDispatch
  // read — writing anything else would leave the install inert.
  assert.equal(written.botToken, "xoxb-real-token");
  assert.equal(written.signingSecret, SIGNING_SECRET);
});

test("A FORGED state is refused — the org binding cannot be minted by a stranger", async () => {
  const { deps, rec } = makeOAuthDeps();
  const forged = signState({
    payload: { purpose: "slack-install", orgId: "victim-org", deploymentId: "d1" },
    secret: "attacker-secret-0123456789abcdef",
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=CODE&state=${encodeURIComponent(forged)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_state");
  assert.equal(rec.upserts.length, 0);
});

test("REPLAY is refused — a captured callback URL works exactly once", async () => {
  const { deps, rec } = makeOAuthDeps();
  const state = await installAndGetState(deps);
  const app = await makeApp(deps);
  const url = `/slack/callback?code=CODE&state=${encodeURIComponent(state)}`;

  assert.equal((await app.inject({ method: "GET", url })).statusCode, 302);
  const second = await app.inject({ method: "GET", url });
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().error, "state_replayed");
  assert.equal(rec.upserts.length, 1, "no second install");
});

test("a state minted for another flow is refused", async () => {
  const { deps } = makeOAuthDeps();
  const wrongPurpose = signState({
    payload: { purpose: "github-install", orgId: "org-1", deploymentId: "d1" },
    secret: STATE_SECRET,
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=C&state=${encodeURIComponent(wrongPurpose)}`,
  });
  assert.equal(res.statusCode, 400);
});

test("a workspace already bound elsewhere is REFUSED, not silently rebound", async () => {
  const { deps, rec } = makeOAuthDeps({
    findChannelByTeam: async () => ({ deploymentId: "someone-elses-deployment" }),
  });
  const state = await installAndGetState(deps);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=C&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "slack_workspace_already_installed");
  assert.equal(rec.upserts.length, 0, "the existing install keeps its events");
});

test("a failed Slack exchange does not write credentials", async () => {
  const { deps, rec } = makeOAuthDeps({
    exchangeCode: async () => ({ ok: false, error: "invalid_code" }),
  });
  const state = await installAndGetState(deps);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=C&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "slack_oauth_exchange_failed");
  assert.equal(rec.upserts.length, 0);
});

test("ownership is re-checked at callback time, not just at mint", async () => {
  const { deps, rec } = makeOAuthDeps();
  const state = await installAndGetState(deps);
  // The deployment is deleted (or moved) between install and callback.
  const laterDeps = { ...deps, ownsDeployment: async () => false };
  const app = await makeApp(laterDeps);
  const res = await app.inject({
    method: "GET",
    url: `/slack/callback?code=C&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 404);
  assert.equal(rec.upserts.length, 0);
});

// ============================================
// Events endpoint
// ============================================

function signSlack(body: string, ts: string, secret = SIGNING_SECRET): string {
  return (
    "v0=" +
    crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")
  );
}

function makeEventsDeps(
  over: Partial<SlackEventsDeps> = {},
): { deps: SlackEventsDeps; enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  const deps: SlackEventsDeps = {
    enabled: true,
    signingSecret: SIGNING_SECRET,
    resolveDeploymentByTeam: async (teamId) => (teamId === "T123" ? "dep-1" : null),
    normalize: (payload) => {
      const p = payload as Record<string, unknown>;
      if (p?.type === "url_verification") {
        return { __special: "slack_url_verification", challenge: p.challenge };
      }
      if (p?.type === "event_callback") return { messageId: "1.1", text: "hi" };
      return null;
    },
    enqueue: async (args) => {
      enqueued.push(args);
      return {};
    },
    ...over,
  };
  return { deps, enqueued };
}

async function makeEventsApp(deps: SlackEventsDeps) {
  const app = Fastify();
  await app.register(createSlackEventsRoutes(deps));
  return app;
}

async function postEvent(
  app: Awaited<ReturnType<typeof makeEventsApp>>,
  payload: unknown,
  opts: { secret?: string; ts?: string } = {},
) {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/slack/events",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signSlack(body, ts, opts.secret),
    },
  });
}

test("the url_verification handshake succeeds BEFORE any install exists", async () => {
  // This is what makes the Request URL verifiable at app-setup time.
  const { deps } = makeEventsDeps({
    resolveDeploymentByTeam: async () => {
      throw new Error("must not hit the database for the handshake");
    },
  });
  const app = await makeEventsApp(deps);
  const res = await postEvent(app, { type: "url_verification", challenge: "abc123" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().challenge, "abc123");
});

test("a bad signature is rejected", async () => {
  const { deps, enqueued } = makeEventsDeps();
  const app = await makeEventsApp(deps);
  const res = await postEvent(
    app,
    { type: "event_callback", team_id: "T123" },
    { secret: "wrong-secret" },
  );
  assert.equal(res.statusCode, 401);
  assert.equal(enqueued.length, 0);
});

test("a stale timestamp is rejected (replay window)", async () => {
  const { deps } = makeEventsDeps();
  const app = await makeEventsApp(deps);
  const old = String(Math.floor(Date.now() / 1000) - 60 * 60);
  const res = await postEvent(app, { type: "event_callback", team_id: "T123" }, { ts: old });
  assert.equal(res.statusCode, 401);
});

test("a valid event resolves team_id to a deployment and enqueues once", async () => {
  const { deps, enqueued } = makeEventsDeps();
  const app = await makeEventsApp(deps);
  const res = await postEvent(app, { type: "event_callback", team_id: "T123" });
  assert.equal(res.statusCode, 204);
  assert.equal(enqueued.length, 1);
  assert.deepEqual((enqueued[0] as { deploymentId: string }).deploymentId, "dep-1");
});

test("an unknown workspace gets 204, not a status that reveals installs", async () => {
  const { deps, enqueued } = makeEventsDeps();
  const app = await makeEventsApp(deps);
  const res = await postEvent(app, { type: "event_callback", team_id: "T-UNKNOWN" });
  assert.equal(res.statusCode, 204);
  assert.equal(enqueued.length, 0);
});

test("events are 501 when Slack is unconfigured", async () => {
  const { deps } = makeEventsDeps({ enabled: false });
  const app = await makeEventsApp(deps);
  const res = await postEvent(app, { type: "url_verification", challenge: "x" });
  assert.equal(res.statusCode, 501);
});
