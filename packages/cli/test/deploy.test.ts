import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WheelsAIError } from "@wheelsai/sdk";

import { CliError } from "../src/errors.js";
import { DeployFailure, failureFor, runDeploy, type DeployContext, type DeployRequest } from "../src/lib/deploy.js";
import { Reporter } from "../src/ui.js";
import {
  AGENT_ID,
  DEPLOYMENT_ID,
  RecordingReporter,
  TIERS,
  agent,
  deployment,
  fakeApi,
  fakeClock,
  sequence,
  status,
  type Route,
} from "./helpers.js";

const AGENT_PATH = `/api/agents/${AGENT_ID}`;
const DEPLOYMENT_PATH = `${AGENT_PATH}/deployments/${DEPLOYMENT_ID}`;

const request = (overrides: Partial<DeployRequest> = {}): DeployRequest => ({
  agent: "my-support-bot",
  replicas: 1,
  timeoutMs: 600_000,
  intervalMs: 3_000,
  validate: true,
  ...overrides,
});

/** Routes for an agent whose deployment goes pending -> building -> deploying -> running. */
function happyRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /api/agents": { agents: [agent()], total: 1 },
    [`GET ${AGENT_PATH}/graph`]: { success: true, data: { agentId: AGENT_ID, nodes: [], edges: [], version: 0 } },
    "GET /api/models": { models: [], gpuTiers: TIERS },
    [`POST ${AGENT_PATH}/deploy`]: status(201, { deployment: { id: DEPLOYMENT_ID, status: "pending" }, message: "Agent deployment started" }),
    [`GET ${DEPLOYMENT_PATH}`]: sequence(
      { deployment: deployment({ status: "building" }) },
      { deployment: deployment({ status: "deploying", endpoint: "https://agents.example.test/my-support-bot" }) },
      { deployment: deployment({ status: "running", endpoint: "https://agents.example.test/my-support-bot" }) },
    ),
    "GET /api/openclaw": { deployments: [] },
    ...extra,
  };
}

function context(api: ReturnType<typeof fakeApi>, overrides: Partial<DeployContext> = {}): DeployContext {
  const clock = fakeClock();
  return {
    wheels: api.wheels,
    webUrl: "http://localhost:3000",
    credential: "apiKey",
    reporter: new Reporter(true),
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

describe("runDeploy", () => {
  it("deploys on the cheapest tier the API lists and returns exactly what the API reported", async () => {
    const api = fakeApi(happyRoutes());
    const result = await runDeploy(context(api), request());

    assert.equal(result.agent.id, AGENT_ID);
    assert.equal(result.deployment.status, "running");
    assert.equal(result.deployment.endpoint, "https://agents.example.test/my-support-bot");
    assert.deepEqual(result.channels, { kind: "none-reported" });
    assert.equal(result.listing, undefined);

    const [deployCall] = api.requested("POST", `${AGENT_PATH}/deploy`);
    assert.deepEqual(deployCall?.body, { gpuTier: "3060", replicas: 1 }, "cheapest listed tier, not a made-up default");
    assert.equal(deployCall?.authorization, "Bearer wheels_live_test");
    assert.deepEqual(api.requested("GET", "/api/models")[0]?.query, { tier: "gpu" });
    assert.equal(api.requested("GET", DEPLOYMENT_PATH).length, 3, "polled until running, no further");
  });

  it("sends a requested tier, the replica count and the model options", async () => {
    const api = fakeApi(happyRoutes());
    await runDeploy(
      context(api),
      request({
        gpuTier: "4090",
        replicas: 2,
        modelDeployment: "33333333-3333-4333-8333-333333333333",
        externalModelUrl: "https://models.example.test/v1",
      }),
    );
    assert.deepEqual(api.requested("POST", `${AGENT_PATH}/deploy`)[0]?.body, {
      gpuTier: "4090",
      replicas: 2,
      modelDeploymentId: "33333333-3333-4333-8333-333333333333",
      externalModelUrl: "https://models.example.test/v1",
    });
  });

  it("reports no endpoint when the API returns none (never invents one)", async () => {
    const api = fakeApi(
      happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "running", endpoint: null }) } }),
    );
    const result = await runDeploy(context(api), request());
    assert.equal(result.deployment.endpoint, null);
  });

  it("reports the channels the API gives for the agent's OpenClaw deployment", async () => {
    const api = fakeApi(
      happyRoutes({
        "GET /api/openclaw": {
          deployments: [
            { id: "x", agentId: "someone-else", status: "RUNNING", channels: [{ platform: "slack" }] },
            { id: "y", agentId: AGENT_ID, status: "RUNNING", channels: [{ platform: "discord", enabled: true }, { platform: "telegram", enabled: false }] },
          ],
        },
      }),
    );
    const result = await runDeploy(context(api), request());
    assert.deepEqual(result.channels, {
      kind: "reported",
      source: "openclaw",
      channels: [{ platform: "discord", enabled: true }, { platform: "telegram", enabled: false }],
    });
  });

  it("does not report the channels of an OpenClaw deployment that is not running", async () => {
    for (const openclawStatus of ["STOPPED", "FAILED", "PENDING"]) {
      const api = fakeApi(
        happyRoutes({
          "GET /api/openclaw": { deployments: [{ id: "y", agentId: AGENT_ID, status: openclawStatus, channels: [{ platform: "discord" }] }] },
        }),
      );
      const result = await runDeploy(context(api), request());
      assert.deepEqual(result.channels, { kind: "none-reported" }, openclawStatus);
    }
  });

  it("does not fail a finished deploy because the channel lookup failed", async () => {
    const api = fakeApi(happyRoutes({ "GET /api/openclaw": status(500, { error: "InternalError", message: "Internal Server Error" }) }));
    const result = await runDeploy(context(api), request());
    assert.deepEqual(result.channels, { kind: "none-reported" });
  });

  describe("validation", () => {
    it("validates a graph with the API's validator and deploys when it is valid", async () => {
      const graph = { agentId: AGENT_ID, nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ id: "e1" }, { id: "e2" }], version: 2 };
      const api = fakeApi(
        happyRoutes({
          [`GET ${AGENT_PATH}/graph`]: { success: true, data: graph },
          [`POST ${AGENT_PATH}/graph/validate`]: { success: true, data: { valid: true, issues: [{ type: "warning", message: "Node b is not connected" }] } },
        }),
      );
      const reporter = new RecordingReporter();
      await runDeploy(context(api, { reporter }), request());
      assert.deepEqual(api.requested("POST", `${AGENT_PATH}/graph/validate`)[0]?.body, { nodes: graph.nodes, edges: graph.edges });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 1);
      assert.ok(reporter.texts("succeed").includes("Graph valid: 3 nodes, 2 edges"), "the counts are the graph's own");
      assert.deepEqual(reporter.texts("warn"), ["Node b is not connected"], "the validator's warning is shown");
      assert.ok(
        reporter.texts("succeed").some((line) => /^GPU tier 3060 \(NVIDIA 3060, 12 GB, \$0\.20\/hr\) {2}cheapest available$/.test(line)),
        "says the tier was chosen as the cheapest",
      );
    });

    it("refuses to deploy an invalid graph, with the API's messages, before any GPU is requested", async () => {
      const api = fakeApi(
        happyRoutes({
          [`GET ${AGENT_PATH}/graph`]: { success: true, data: { agentId: AGENT_ID, nodes: [{ id: "a" }], edges: [], version: 1 } },
          [`POST ${AGENT_PATH}/graph/validate`]: {
            success: true,
            data: { valid: false, issues: [{ type: "error", message: "Graph must have at least one output node" }, { type: "warning", message: "ignored" }] },
          },
        }),
      );
      await assert.rejects(runDeploy(context(api), request()), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.match(err.message, /Graph must have at least one output node/);
        assert.doesNotMatch(err.message, /ignored/);
        return true;
      });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
      assert.equal(api.requested("GET", "/api/models").length, 0);
    });

    it("skips the graph check with an API key the graph routes refuse, and says so", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${AGENT_PATH}/graph`]: status(404, { success: false, error: "The request could not be completed." }) }));
      const reporter = new RecordingReporter();
      const result = await runDeploy(context(api, { credential: "apiKey", reporter }), request());
      assert.equal(result.deployment.status, "running");
      const [warning, ...others] = reporter.texts("warn");
      assert.deepEqual(others, []);
      assert.match(warning ?? "", /^Graph not checked: an API key cannot read agent graphs/);
      assert.match(warning ?? "", /--no-validate/);
    });

    it("does not wave a graph through when the graph route is broken, even with an API key", async () => {
      for (const reply of [status(500, { error: "InternalError", message: "Internal Server Error" }), status(502, "<html>bad gateway</html>")]) {
        const api = fakeApi(happyRoutes({ [`GET ${AGENT_PATH}/graph`]: reply }));
        await assert.rejects(runDeploy(context(api, { credential: "apiKey" }), request()), { status: reply.status });
        assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0, "nothing deployed unvalidated");
      }
    });

    it("fails on a graph read error when signed in with a session", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${AGENT_PATH}/graph`]: status(404, { success: false, error: "Agent not found or access denied" }) }));
      await assert.rejects(runDeploy(context(api, { credential: "token" }), request()), { status: 404, message: "Agent not found or access denied" });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });

    it("does not read the graph at all with validate: false", async () => {
      const api = fakeApi(happyRoutes());
      await runDeploy(context(api), request({ validate: false }));
      assert.equal(api.requested("GET", `${AGENT_PATH}/graph`).length, 0);
    });
  });

  describe("failures", () => {
    it("rejects an unknown agent without deploying anything", async () => {
      const api = fakeApi(happyRoutes());
      await assert.rejects(runDeploy(context(api), request({ agent: "nope" })), /No agent "nope" in your organization/);
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });

    it("rejects a tier the API does not list (rtx-4090) before deploying", async () => {
      const api = fakeApi(happyRoutes());
      await assert.rejects(runDeploy(context(api), request({ gpuTier: "rtx-4090" })), /"rtx-4090" is not a deployable GPU tier/);
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });

    it("explains an API with no deployable tiers", async () => {
      const api = fakeApi(happyRoutes({ "GET /api/models": { models: [], gpuTiers: [] } }));
      await assert.rejects(runDeploy(context(api), request()), /no deployable GPU tiers/);
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });

    it("passes the API's own refusal through (insufficient credits)", async () => {
      const api = fakeApi(
        happyRoutes({
          [`POST ${AGENT_PATH}/deploy`]: status(402, { error: "insufficient_credits", message: "Deploying requires a reservation of $0.37 in credits. Add credits and retry." }),
        }),
      );
      await assert.rejects(runDeploy(context(api), request()), (err: unknown) => {
        assert.ok(err instanceof WheelsAIError);
        assert.equal(err.status, 402);
        assert.equal(err.code, "insufficient_credits");
        assert.match(err.message, /reservation of \$0\.37/);
        return true;
      });
    });

    it("passes an unconfigured-compute refusal through (501)", async () => {
      const api = fakeApi(
        happyRoutes({
          [`POST ${AGENT_PATH}/deploy`]: status(501, { error: "nosana_not_configured", message: "Nosana deployments are not configured: NOSANA_WALLET_PRIVATE_KEY is not set" }),
        }),
      );
      await assert.rejects(runDeploy(context(api), request({ gpuTier: "3060" })), { status: 501, code: "nosana_not_configured" });
    });

    it("fails with the deployment's lastError when it ends up failed", async () => {
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: sequence(
            { deployment: deployment({ status: "building" }) },
            { deployment: deployment({ status: "failed", lastError: "Nosana deployments are not configured: NOSANA_WALLET_PRIVATE_KEY is not set" }) },
          ),
        }),
      );
      await assert.rejects(runDeploy(context(api), request()), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.message, "Deployment failed: Nosana deployments are not configured: NOSANA_WALLET_PRIVATE_KEY is not set");
        assert.equal(err.hint, `Details: wheelsai logs ${DEPLOYMENT_ID}`);
        return true;
      });
    });

    it("says when the API gave no error message for a failed deployment", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "failed", lastError: null }) } }));
      await assert.rejects(runDeploy(context(api), request()), /Deployment failed: the API gave no error message/);
    });

    it("times out with the last status seen", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "deploying" }) } }));
      await assert.rejects(runDeploy(context(api), request({ timeoutMs: 9_000, intervalMs: 3_000 })), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.match(err.message, /Still deploying after 9s/);
        assert.match(err.hint ?? "", /wheelsai logs/);
        return true;
      });
    });

    it("on a timeout, names the deployment and how to keep waiting for it, and never suggests deploying again", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "deploying" }) } }));
      await assert.rejects(runDeploy(context(api), request({ timeoutMs: 9_000, intervalMs: 3_000 })), (err: unknown) => {
        assert.ok(err instanceof DeployFailure);
        assert.equal(err.deployment.id, DEPLOYMENT_ID);
        assert.equal(err.deployment.status, "deploying");
        const hint = err.hint ?? "";
        assert.ok(hint.includes(`wheelsai logs ${DEPLOYMENT_ID}`));
        assert.ok(hint.includes(`wheelsai deploy --agent my-support-bot --resume ${DEPLOYMENT_ID}`));
        assert.match(hint, /without --resume would start a second, separately billed deployment/);
        assert.doesNotMatch(hint, /raise --timeout/);
        assert.doesNotMatch(`${err.message} ${hint}`, /deploy again|run .*deploy.* again/i);
        return true;
      });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 1);
    });

    it("failureFor never points a timeout at a flag that only exists on a fresh deploy", () => {
      const timeout = failureFor("timeout", deployment({ status: "building" }), DEPLOYMENT_ID, 600_000, "my-support-bot");
      assert.doesNotMatch(timeout.hint ?? "", /--timeout/);
      assert.match(timeout.hint ?? "", new RegExp(`--resume ${DEPLOYMENT_ID}`));
      const blind = failureFor("timeout", null, DEPLOYMENT_ID, 600_000, "my-support-bot", new Error("Service Unavailable"));
      assert.match(blind.message, /Could not read the deployment's status at the end of 600s \(Service Unavailable\)/);
    });
  });

  describe("once the deployment exists, its id is never lost", () => {
    const expectFailure = async (promise: Promise<unknown>, check: (failure: DeployFailure) => void) => {
      await assert.rejects(promise, (err: unknown) => {
        assert.ok(err instanceof DeployFailure, `expected a DeployFailure, got ${String(err)}`);
        assert.equal(err.deployment.id, DEPLOYMENT_ID);
        assert.deepEqual(err.agent, { id: AGENT_ID, slug: "my-support-bot", name: "My Support Bot" });
        check(err);
        return true;
      });
    };

    it("carries the id when a status check is refused, with the API's status and code", async () => {
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: sequence<unknown>(
            { deployment: deployment({ status: "building" }) },
            status(401, { error: "Unauthorized", message: "Authentication required" }),
          ),
        }),
      );
      await expectFailure(runDeploy(context(api), request()), (failure) => {
        assert.equal(failure.message, "Authentication required");
        assert.equal(failure.status, 401);
        assert.equal(failure.detail, "HTTP 401 Unauthorized");
        assert.equal(failure.deployment.status, "building", "the last status the API reported");
        const hint = failure.hint ?? "";
        assert.ok(hint.includes(`Deployment ${DEPLOYMENT_ID} exists and carries on`));
        assert.ok(hint.includes(`wheelsai logs ${DEPLOYMENT_ID} --agent my-support-bot`));
        assert.ok(hint.includes(`--resume ${DEPLOYMENT_ID}`));
        // What --json prints on stdout.
        assert.deepEqual(JSON.parse(JSON.stringify(failure)), {
          agent: { id: AGENT_ID, slug: "my-support-bot", name: "My Support Bot" },
          deployment: JSON.parse(JSON.stringify(deployment({ status: "building" }))),
          error: { message: "Authentication required", status: 401, code: "Unauthorized" },
        });
      });
    });

    it("carries the id (as created) when the very first status check fails", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: status(404, { error: "NotFound", message: "Deployment not found" }) }));
      await expectFailure(runDeploy(context(api), request()), (failure) => {
        assert.deepEqual(failure.deployment, { id: DEPLOYMENT_ID, status: "pending" });
      });
    });

    it("rides out a long run of 5xx and network errors instead of abandoning the deployment", async () => {
      const unavailable = status(503, { error: "ServiceUnavailable", message: "Service Unavailable" });
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: sequence<unknown>(
            ...Array.from({ length: 12 }, () => unavailable),
            { deployment: deployment({ status: "running", endpoint: "https://agents.example.test/my-support-bot" }) },
          ),
        }),
      );
      const result = await runDeploy(context(api), request());
      assert.equal(result.deployment.status, "running");
      assert.equal(api.requested("GET", DEPLOYMENT_PATH).length, 13);
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 1);
    });

    it("stops at once on the monthly-quota 429, and still names the deployment", async () => {
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: status(429, {
            error: "plan_limit_reached",
            message: "Monthly API call limit reached for the starter plan.",
            plan: "starter",
            limit: "monthlyApiCalls",
            upgradeUrl: "/dashboard/billing?upgrade=pro",
          }),
        }),
      );
      await expectFailure(runDeploy(context(api), request()), (failure) => {
        assert.equal(failure.status, 429);
        assert.equal(failure.code, "plan_limit_reached");
        assert.match(failure.hint ?? "", /monthly allowance is used up/);
      });
      assert.equal(api.requested("GET", DEPLOYMENT_PATH).length, 1, "a spent quota is not retried");
    });

    it("carries the id and the retry command when only the listing fails, without relying on progress output", async () => {
      const api = fakeApi(
        happyRoutes({
          "GET /api/marketplace/my-listings": { listings: [] },
          "POST /api/marketplace/listings": status(500, { error: "InternalError", message: "Internal Server Error" }),
        }),
      );
      const publish = { pricing: { pricingModel: "per_request" as const, pricePerRequestCents: 5 }, title: "Support Pro", description: "It's a paid support agent.", category: "coding" };
      // A silent reporter, as with --json: the advice must be on the error itself.
      await expectFailure(runDeploy(context(api, { reporter: new Reporter(true) }), request({ publish })), (failure) => {
        assert.equal(failure.status, 500);
        assert.equal(failure.deployment.status, "running");
        const hint = failure.hint ?? "";
        assert.match(hint, /The agent is running .* only the listing failed\. Do not deploy again\./);
        assert.ok(
          hint.includes(
            `wheelsai publish --agent my-support-bot --price-per-request 5 --title 'Support Pro' --description 'It'\\''s a paid support agent.' --category coding`,
          ),
          hint,
        );
      });
    });

    it("says a deploy request that got no answer may still have created the deployment", async () => {
      const api = fakeApi(happyRoutes());
      const wheels = api.wheels;
      const original = wheels.agents.deploy;
      wheels.agents.deploy = async () => {
        throw new WheelsAIError(0, "Request to https://api.example.test timed out after 30000ms");
      };
      try {
        await assert.rejects(runDeploy(context(api), request()), (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.match(err.message, /may or may not have been created/);
          assert.match(err.hint ?? "", /wheelsai agents get my-support-bot/);
          assert.match(err.hint ?? "", /--resume/);
          return true;
        });
      } finally {
        wheels.agents.deploy = original;
      }
    });
  });

  describe("--resume", () => {
    it("waits for the existing deployment and never starts another", async () => {
      const api = fakeApi(happyRoutes());
      const reporter = new RecordingReporter();
      const result = await runDeploy(context(api, { reporter }), request({ resume: DEPLOYMENT_ID }));
      assert.equal(result.deployment.status, "running");
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0, "no second deployment, no second reservation");
      assert.equal(api.requested("GET", "/api/models").length, 0);
      assert.equal(api.requested("GET", `${AGENT_PATH}/graph`).length, 0);
      assert.ok(reporter.texts("succeed").some((line) => line.includes("nothing new was started")));
    });

    it("refuses an id that is not one of the agent's deployments", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: status(404, { error: "NotFound", message: "Deployment not found" }) }));
      await assert.rejects(runDeploy(context(api), request({ resume: DEPLOYMENT_ID })), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.ok(!(err instanceof DeployFailure), "nothing is known to exist");
        assert.match(err.message, /No deployment .* on agent "my-support-bot"/);
        return true;
      });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });
  });

  describe("status polling", () => {
    it("checks soon after submitting, then backs off to the interval the API refreshes at", async () => {
      const clock = fakeClock();
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: sequence(
            ...Array.from({ length: 6 }, () => ({ deployment: deployment({ status: "deploying" }) })),
            { deployment: deployment({ status: "running" }) },
          ),
        }),
      );
      await runDeploy(context(api, { now: clock.now, sleep: clock.sleep }), request({ intervalMs: 30_000 }));
      assert.deepEqual(clock.sleeps, [5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
    });

    it("stays far below the old 200 status requests over a full default wait", async () => {
      const api = fakeApi(happyRoutes({ [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "deploying" }) } }));
      await assert.rejects(runDeploy(context(api), request({ timeoutMs: 600_000, intervalMs: 30_000 })), /Still deploying after 600s/);
      assert.ok(api.requested("GET", DEPLOYMENT_PATH).length <= 25, String(api.requested("GET", DEPLOYMENT_PATH).length));
    });
  });

  describe("a listing is checked before the GPU is paid for", () => {
    it("checks the listing before any GPU is requested: a title the API would refuse stops the deploy", async () => {
      for (const name of ["AB", "x".repeat(101)]) {
        const api = fakeApi(
          happyRoutes({
            "GET /api/agents": { agents: [agent({ name })], total: 1 },
            "GET /api/marketplace/my-listings": { listings: [] },
          }),
        );
        await assert.rejects(runDeploy(context(api), request({ publish: { pricing: null } })), (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.match(err.message, /is not 3 to 100 characters/);
          assert.match(err.hint ?? "", /--title/);
          return true;
        });
        assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0, "no deployment, no credits reserved");
        assert.equal(api.requested("GET", "/api/models").length, 0);
      }
    });

    it("checks --title and --description against the API's limits before deploying", async () => {
      for (const publish of [
        { pricing: null, title: "ab" },
        { pricing: null, description: "short" },
        { pricing: null, description: "x".repeat(281) },
        { pricing: null, category: "finance" },
      ]) {
        const api = fakeApi(happyRoutes({ "GET /api/marketplace/my-listings": { listings: [] } }));
        await assert.rejects(runDeploy(context(api), request({ publish })), CliError);
        assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0, JSON.stringify(publish));
      }
    });

    it("stops before deploying when the marketplace cannot be used at all", async () => {
      const api = fakeApi(happyRoutes({ "GET /api/marketplace/my-listings": status(403, { error: "Forbidden", message: "Marketplace access denied" }) }));
      await assert.rejects(runDeploy(context(api), request({ publish: { pricing: null } })), { status: 403 });
      assert.equal(api.requested("POST", `${AGENT_PATH}/deploy`).length, 0);
    });

    it("lets a short agent name through when the agent already has a listing", async () => {
      const api = fakeApi(
        happyRoutes({
          "GET /api/agents": { agents: [agent({ name: "AB" })], total: 1 },
          "GET /api/marketplace/my-listings": { listings: [{ id: "44444444-4444-4444-8444-444444444444", agentId: AGENT_ID, title: "Support Pro", slug: "support-pro", status: "published", category: "other", pricingModel: "free" }] },
        }),
      );
      const result = await runDeploy(context(api), request({ publish: { pricing: null } }));
      assert.equal(result.listing?.alreadyPublished, true);
    });

  });

  describe("publishing", () => {
    const listing = (overrides: Record<string, unknown> = {}) => ({
      id: "44444444-4444-4444-8444-444444444444",
      agentId: AGENT_ID,
      title: "My Support Bot",
      slug: "my-support-bot",
      status: "draft",
      category: "other",
      pricingModel: "free",
      pricePerRequestCents: null,
      monthlyPriceCents: null,
      ...overrides,
    });

    it("lists the agent after it is running and returns the URL built from the API's slug", async () => {
      const api = fakeApi(
        happyRoutes({
          "GET /api/marketplace/my-listings": { listings: [] },
          "POST /api/marketplace/listings": status(201, { listing: listing() }),
          "POST /api/marketplace/listings/44444444-4444-4444-8444-444444444444/publish": {
            listing: listing({ status: "published", slug: "my-support-bot-1" }),
            message: "Listing published successfully",
          },
        }),
      );
      const result = await runDeploy(context(api), request({ publish: { pricing: { pricingModel: "per_request", pricePerRequestCents: 5 } } }));
      assert.equal(result.listing?.url, "http://localhost:3000/marketplace/my-support-bot-1");
      assert.equal(result.listing?.created, true);

      const [created] = api.requested("POST", "/api/marketplace/listings");
      assert.deepEqual(created?.body, {
        agentId: AGENT_ID,
        title: "My Support Bot",
        shortDescription: "Answers customer support questions about orders and refunds.",
        category: "other",
        pricingModel: "per_request",
        pricePerRequestCents: 5,
      });
    });

    it("does not list anything when the deployment fails", async () => {
      const api = fakeApi(
        happyRoutes({
          [`GET ${DEPLOYMENT_PATH}`]: { deployment: deployment({ status: "failed", lastError: "boom" }) },
          "GET /api/marketplace/my-listings": { listings: [] },
        }),
      );
      await assert.rejects(runDeploy(context(api), request({ publish: { pricing: null } })), /Deployment failed: boom/);
      assert.equal(api.requested("POST", "/api/marketplace/listings").length, 0);
    });

    it("keeps the API's error when listing fails after a successful deploy", async () => {
      const api = fakeApi(
        happyRoutes({
          "GET /api/marketplace/my-listings": { listings: [] },
          "POST /api/marketplace/listings": status(400, { error: "Bad Request", message: "Monthly price is required for monthly pricing model" }),
        }),
      );
      await assert.rejects(
        runDeploy(context(api), request({ publish: { pricing: { pricingModel: "monthly", monthlyPriceCents: 900 } } })),
        { status: 400, message: "Monthly price is required for monthly pricing model" },
      );
    });
  });
});
