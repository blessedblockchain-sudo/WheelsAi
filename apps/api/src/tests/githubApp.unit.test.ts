import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import Fastify from "fastify";

import { createGitHubAppRoutes, type GitHubAppRouteDeps } from "../routes/githubApp.js";
import {
  handleGitHubPush,
  repoMatchesSourceUrl,
  type PushHandlerDeps,
} from "../services/githubPushHandler.js";
import { makeMemoryNonceStore } from "../services/oauthStateStore.js";
import { signState } from "../services/signedState.js";
import { parseGitHubUrl } from "../services/github-import.js";

// Drives the GitHub App (W2). The webhook is a public POST whose body an
// attacker controls once the secret is known, so the properties under
// test are: signature verified over RAW bytes, SHA-1 refused outright,
// deliveries deduped, and tenancy taken from the STORED installation row
// rather than the payload.

const STATE_SECRET = "github-state-secret-0123456789abc";
const WEBHOOK_SECRET = "webhook-secret-0123456789abcdef";

// ============================================
// URL parsing
// ============================================

test("the repo URL parser is anchored to github.com", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo"), {
    owner: "owner",
    repo: "repo",
    branch: undefined,
  });
  assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/tree/dev"), {
    owner: "owner",
    repo: "repo",
    branch: "dev",
  });
  assert.deepEqual(parseGitHubUrl("github.com/o/r.git"), {
    owner: "o",
    repo: "r",
    branch: undefined,
  });
  // Unanchored, this matched — a parser that accepts a hostile host is a
  // bad place to start building request URLs from.
  assert.throws(() => parseGitHubUrl("https://evil.example/github.com/o/r"), /Invalid GitHub URL/);
  assert.throws(() => parseGitHubUrl("https://gitlab.com/o/r"), /Invalid GitHub URL/);
});

// ============================================
// Push handling
// ============================================

test("repo matching normalizes URL shape, not just string equality", () => {
  for (const url of [
    "https://github.com/Acme/Bot",
    "https://github.com/acme/bot.git",
    "github.com/acme/bot/",
  ]) {
    assert.equal(repoMatchesSourceUrl(url, "acme/bot"), true, url);
  }
  assert.equal(repoMatchesSourceUrl("https://github.com/acme/other", "acme/bot"), false);
  assert.equal(repoMatchesSourceUrl(null, "acme/bot"), false);
});

function pushDeps(
  over: Partial<PushHandlerDeps> = {},
): { deps: PushHandlerDeps; rec: { versions: unknown[]; redeploys: unknown[]; refused: unknown[] } } {
  const rec = { versions: [] as unknown[], redeploys: [] as unknown[], refused: [] as unknown[] };
  const deps: PushHandlerDeps = {
    resolveOrgByInstallation: async (id) => (id === "999" ? "org-1" : null),
    findAgentsForRepo: async () => [
      {
        id: "agent-1",
        orgId: "org-1",
        sourceUrl: "https://github.com/acme/bot",
        autoRedeploy: false,
        runningDeploymentId: "dep-1",
      },
    ],
    recordVersion: async (v) => {
      rec.versions.push(v);
    },
    redeploy: async (r) => {
      rec.redeploys.push(r);
      return { attempted: true, ok: true, deploymentId: "dep-1" };
    },
    emitRefused: async (r) => {
      rec.refused.push(r);
    },
    ...over,
  };
  return { deps, rec };
}

function pushPayload(over: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: "abc123def4567890",
    repository: { full_name: "acme/bot", default_branch: "main" },
    pusher: { name: "octocat" },
    installation: { id: 999 },
    ...over,
  };
}

test("a push records a version and does NOT redeploy by default", async () => {
  const { deps, rec } = pushDeps();
  const result = await handleGitHubPush(pushPayload(), deps);
  assert.equal(result.handled, true);
  assert.equal(result.versionsRecorded, 1);
  assert.equal(result.redeploysAttempted, 0, "opt-in, default off");
  assert.equal((rec.versions[0] as { commitSha: string }).commitSha, "abc123def4567890");
});

test("TENANCY: the org comes from the stored installation, never the payload", async () => {
  const { deps, rec } = pushDeps({
    // The attacker's payload claims another org's repo owner.
    findAgentsForRepo: async ({ orgId }) => {
      assert.equal(orgId, "org-1", "org must come from the installation lookup");
      return [];
    },
  });
  const result = await handleGitHubPush(
    pushPayload({ repository: { full_name: "victim/repo", default_branch: "main", owner: { login: "victim" } } }),
    deps,
  );
  assert.equal(result.handled, true);
  assert.equal(rec.versions.length, 0);
});

test("an unknown installation is ignored entirely", async () => {
  const { deps, rec } = pushDeps();
  const result = await handleGitHubPush(
    pushPayload({ installation: { id: 12345 } }),
    deps,
  );
  assert.equal(result.handled, false);
  assert.match(result.reason!, /unknown installation/);
  assert.equal(rec.versions.length, 0);
});

test("a push to a non-default branch is not a release", async () => {
  const { deps, rec } = pushDeps();
  const result = await handleGitHubPush(
    pushPayload({ ref: "refs/heads/feature-x" }),
    deps,
  );
  assert.match(result.reason!, /ignoring push/);
  assert.equal(rec.versions.length, 0);
});

test("opting in attempts a redeploy THROUGH admission", async () => {
  const { deps, rec } = pushDeps({
    findAgentsForRepo: async () => [
      {
        id: "agent-1",
        orgId: "org-1",
        sourceUrl: "https://github.com/acme/bot",
        autoRedeploy: true,
        runningDeploymentId: "dep-1",
      },
    ],
  });
  const result = await handleGitHubPush(pushPayload(), deps);
  assert.equal(result.redeploysAttempted, 1);
  assert.deepEqual(rec.redeploys[0], {
    agentId: "agent-1",
    orgId: "org-1",
    deploymentId: "dep-1",
  });
});

test("a REFUSED redeploy is surfaced, never silently swallowed", async () => {
  // "Looks deployed, isn't" is the exact failure this codebase keeps
  // removing — the author has to learn the push did not ship.
  const { deps, rec } = pushDeps({
    findAgentsForRepo: async () => [
      {
        id: "agent-1",
        orgId: "org-1",
        sourceUrl: "https://github.com/acme/bot",
        autoRedeploy: true,
        runningDeploymentId: "dep-1",
      },
    ],
    redeploy: async () => ({ attempted: false, reason: "insufficient credits" }),
  });
  const result = await handleGitHubPush(pushPayload(), deps);
  assert.equal(result.redeploysRefused, 1);
  assert.equal(result.versionsRecorded, 1, "the version is still real");
  assert.match((rec.refused[0] as { reason: string }).reason, /insufficient credits/);
});

// ============================================
// The webhook route
// ============================================

function routeDeps(
  over: Partial<GitHubAppRouteDeps> = {},
): { deps: GitHubAppRouteDeps; rec: { saved: unknown[]; removed: string[]; pushes: number } } {
  const rec = { saved: [] as unknown[], removed: [] as string[], pushes: 0 };
  const deps: GitHubAppRouteDeps = {
    enabled: true,
    appSlug: "wheelsai",
    webhookSecret: WEBHOOK_SECRET,
    webBaseUrl: "https://app.example.com",
    stateSecret: STATE_SECRET,
    nonces: makeMemoryNonceStore(),
    verifyInstallation: async () => ({ ok: true, accountLogin: "acme" }),
    saveInstallation: async (a) => {
      rec.saved.push(a);
    },
    removeInstallation: async (id) => {
      rec.removed.push(id);
    },
    claimDelivery: async () => true,
    pushDeps: pushDeps({
      recordVersion: async () => {
        rec.pushes += 1;
      },
    }).deps,
    ...over,
  };
  return { deps, rec };
}

async function makeApp(deps: GitHubAppRouteDeps, authed = true) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (authed) {
      request.auth = { userId: "u1", orgId: "org-1", type: "jwt" };
    }
  });
  await app.register(createGitHubAppRoutes(deps));
  return app;
}

function sign256(body: string, secret = WEBHOOK_SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postHook(
  app: Awaited<ReturnType<typeof makeApp>>,
  payload: unknown,
  opts: { event?: string; secret?: string; delivery?: string; sha1Only?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "push",
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
  };
  if (opts.sha1Only) {
    headers["x-hub-signature"] =
      "sha1=" + crypto.createHmac("sha1", WEBHOOK_SECRET).update(body).digest("hex");
  } else {
    headers["x-hub-signature-256"] = sign256(body, opts.secret);
  }
  return app.inject({ method: "POST", url: "/github/webhook", payload: body, headers });
}

test("a valid signature over the raw body is accepted", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const res = await postHook(app, pushPayload());
  assert.equal(res.statusCode, 200);
  assert.equal(rec.pushes, 1);
});

test("a wrong signature is rejected", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const res = await postHook(app, pushPayload(), { secret: "wrong-secret-000000000000000" });
  assert.equal(res.statusCode, 401);
  assert.equal(rec.pushes, 0);
});

test("SHA-1 alone is REFUSED — no downgrade around the strong check", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const res = await postHook(app, pushPayload(), { sha1Only: true });
  assert.equal(res.statusCode, 401);
  assert.equal(rec.pushes, 0);
});

test("a retried delivery is deduped — a push must not redeploy twice", async () => {
  let claimed = false;
  const { deps, rec } = routeDeps({
    claimDelivery: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  });
  const app = await makeApp(deps);
  const delivery = "delivery-1";
  assert.equal((await postHook(app, pushPayload(), { delivery })).statusCode, 200);
  const second = await postHook(app, pushPayload(), { delivery });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().deduped, true);
  assert.equal(rec.pushes, 1, "handled exactly once");
});

test("installation deleted/suspended marks the install removed", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const res = await postHook(
    app,
    { action: "deleted", installation: { id: 999 } },
    { event: "installation" },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(rec.removed, ["999"]);
});

test("ping is acknowledged; unknown events are 204 rather than retried", async () => {
  const { deps } = routeDeps();
  const app = await makeApp(deps);
  assert.equal((await postHook(app, {}, { event: "ping" })).statusCode, 200);
  assert.equal((await postHook(app, {}, { event: "star" })).statusCode, 204);
});

test("everything is 501 when the App is unconfigured — never 404", async () => {
  const { deps } = routeDeps({ enabled: false });
  const app = await makeApp(deps);
  assert.equal((await postHook(app, pushPayload())).statusCode, 501);
  assert.equal(
    (await app.inject({ method: "GET", url: "/github/install" })).statusCode,
    501,
  );
});

// ============================================
// Install + callback
// ============================================

test("install redirects to the App page with a verifiable state", async () => {
  const { deps } = routeDeps();
  const app = await makeApp(deps);
  const res = await app.inject({ method: "GET", url: "/github/install" });
  assert.equal(res.statusCode, 302);
  const location = res.headers.location as string;
  assert.match(location, /^https:\/\/github\.com\/apps\/wheelsai\/installations\/new\?state=/);
});

test("the callback VERIFIES the installation id before trusting it", async () => {
  // installation_id arrives in a query string, i.e. from the browser.
  const { deps, rec } = routeDeps({
    verifyInstallation: async () => ({ ok: false, error: "not reachable" }),
  });
  const app = await makeApp(deps);
  const res0 = await app.inject({ method: "GET", url: "/github/install" });
  const state = new URL(res0.headers.location as string).searchParams.get("state")!;

  const res = await app.inject({
    method: "GET",
    url: `/github/callback?installation_id=999&state=${encodeURIComponent(state)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "github_installation_unverified");
  assert.equal(rec.saved.length, 0, "nothing persisted for an unverified id");
});

test("a forged state is refused", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const forged = signState({
    payload: { purpose: "github-install", orgId: "victim-org" },
    secret: "attacker-secret-0123456789abcdef",
  });
  const res = await app.inject({
    method: "GET",
    url: `/github/callback?installation_id=999&state=${encodeURIComponent(forged)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(rec.saved.length, 0);
});

test("a replayed callback is refused and installs once", async () => {
  const { deps, rec } = routeDeps();
  const app = await makeApp(deps);
  const res0 = await app.inject({ method: "GET", url: "/github/install" });
  const state = new URL(res0.headers.location as string).searchParams.get("state")!;
  const url = `/github/callback?installation_id=999&state=${encodeURIComponent(state)}`;

  assert.equal((await app.inject({ method: "GET", url })).statusCode, 302);
  const second = await app.inject({ method: "GET", url });
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().error, "state_replayed");
  assert.equal(rec.saved.length, 1);
});
