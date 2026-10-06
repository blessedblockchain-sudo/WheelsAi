import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WheelsAIError } from "@wheelsai/sdk";

import { CliError, describeError } from "../src/errors.js";
import { agentReference, resolveAgent } from "../src/lib/agents.js";
import { channelLabel, findChannels } from "../src/lib/channels.js";
import { checkAgentGraph } from "../src/lib/graph.js";
import { findAgentDeployment } from "../src/lib/logs.js";
import { AGENT_ID, DEPLOYMENT_ID, agent, deployment, fakeApi, status } from "./helpers.js";

describe("agent references", () => {
  it("accepts the positional argument, --agent, or both when they agree", () => {
    assert.equal(agentReference("a", undefined), "a");
    assert.equal(agentReference(undefined, "b"), "b");
    assert.equal(agentReference("c", "c"), "c");
  });

  it("refuses a missing or contradictory reference", () => {
    assert.throws(() => agentReference(undefined, undefined), /Pass --agent <slug-or-id>/);
    assert.throws(() => agentReference("a", "b"), CliError);
  });

  it("resolves a slug or an id with one list request", async () => {
    const api = fakeApi({ "GET /api/agents": { agents: [agent()], total: 1 } });
    assert.equal((await resolveAgent(api.wheels, "my-support-bot")).id, AGENT_ID);
    assert.equal((await resolveAgent(api.wheels, AGENT_ID)).slug, "my-support-bot");
    assert.equal(api.calls.length, 2);
  });

  it("says which agent was not found", async () => {
    const api = fakeApi({ "GET /api/agents": { agents: [agent()], total: 1 } });
    await assert.rejects(resolveAgent(api.wheels, "other"), /No agent "other" in your organization/);
  });
});

describe("checkAgentGraph", () => {
  const graphPath = `/api/agents/${AGENT_ID}/graph`;

  it("reports no graph when the agent has no nodes, without calling the validator", async () => {
    const api = fakeApi({ [`GET ${graphPath}`]: { success: true, data: { agentId: AGENT_ID, nodes: [], edges: [], version: 0 } } });
    assert.deepEqual(await checkAgentGraph(api.wheels, AGENT_ID, "token"), { kind: "none" });
    assert.equal(api.calls.length, 1);
  });

  it("counts nodes and edges from the API's graph, and passes the issues through", async () => {
    const api = fakeApi({
      [`GET ${graphPath}`]: { success: true, data: { agentId: AGENT_ID, nodes: [{ id: "1" }, { id: "2" }], edges: [{ id: "e" }], version: 1 } },
      [`POST ${graphPath}/validate`]: { success: true, data: { valid: true, issues: [{ type: "warning", message: "w" }] } },
    });
    assert.deepEqual(await checkAgentGraph(api.wheels, AGENT_ID, "token"), {
      kind: "valid",
      nodes: 2,
      edges: 1,
      issues: [{ type: "warning", message: "w" }],
    });
  });

  it("marks a graph the validator rejects as invalid", async () => {
    const api = fakeApi({
      [`GET ${graphPath}`]: { success: true, data: { agentId: AGENT_ID, nodes: [{ id: "1" }], edges: [], version: 1 } },
      [`POST ${graphPath}/validate`]: { success: true, data: { valid: false, issues: [{ type: "error", message: "no output" }] } },
    });
    const check = await checkAgentGraph(api.wheels, AGENT_ID, "token");
    assert.equal(check.kind, "invalid");
  });

  it("skips (with the API's words) when an API key cannot read the graph; throws for a session", async () => {
    const api = fakeApi({ [`GET ${graphPath}`]: status(404, { success: false, error: "The request could not be completed." }) });
    const skipped = await checkAgentGraph(api.wheels, AGENT_ID, "apiKey");
    assert.equal(skipped.kind, "skipped");
    assert.match((skipped as { reason: string }).reason, /The request could not be completed\./);
    await assert.rejects(checkAgentGraph(api.wheels, AGENT_ID, "token"), WheelsAIError);
  });

  it("only skips for the refusal an API key gets: a broken graph route is an error with either credential", async () => {
    for (const code of [500, 502, 503]) {
      const api = fakeApi({ [`GET ${graphPath}`]: status(code, { error: "InternalError", message: "boom" }) });
      await assert.rejects(checkAgentGraph(api.wheels, AGENT_ID, "apiKey"), { status: code });
    }
    for (const code of [401, 403, 404]) {
      const api = fakeApi({ [`GET ${graphPath}`]: status(code, { success: false, error: "no" }) });
      assert.equal((await checkAgentGraph(api.wheels, AGENT_ID, "apiKey")).kind, "skipped", String(code));
    }
  });

  it("drops control characters from the API's words before quoting them", async () => {
    const api = fakeApi({ [`GET ${graphPath}`]: status(404, { success: false, error: "nope\u001b[2K\u0007" }) });
    const skipped = await checkAgentGraph(api.wheels, AGENT_ID, "apiKey");
    assert.match((skipped as { reason: string }).reason, /the API said "nope\[2K"/);
  });
});

describe("channels", () => {
  it("labels strings, platform objects and anything else", () => {
    assert.equal(channelLabel("discord"), "discord");
    assert.equal(channelLabel({ platform: "slack", enabled: true }), "slack");
    assert.equal(channelLabel({ platform: "telegram", enabled: false }), "telegram (disabled)");
    assert.equal(channelLabel({ kind: "web" }), '{"kind":"web"}');
  });

  it("prefers channels carried on the deployment itself, even an empty list", async () => {
    const api = fakeApi({});
    const report = await findChannels(api.wheels, AGENT_ID, deployment({ channels: ["web"] }));
    assert.deepEqual(report, { kind: "reported", source: "deployment", channels: ["web"] });
    assert.equal(api.calls.length, 0);
  });

  it("takes an empty list on the deployment as the answer, without asking OpenClaw", async () => {
    const api = fakeApi({ "GET /api/openclaw": { deployments: [{ id: "x", agentId: AGENT_ID, status: "RUNNING", channels: [{ platform: "discord" }] }] } });
    const report = await findChannels(api.wheels, AGENT_ID, deployment({ channels: [] }));
    assert.deepEqual(report, { kind: "reported", source: "deployment", channels: [] });
    assert.equal(api.calls.length, 0);
  });

  it("counts an OpenClaw deployment's channels only while it is running", async () => {
    const openclaw = (status: string) =>
      fakeApi({ "GET /api/openclaw": { deployments: [{ id: "x", agentId: AGENT_ID, status, channels: [{ platform: "discord" }] }] } });
    assert.deepEqual(await findChannels(openclaw("RUNNING").wheels, AGENT_ID, deployment()), {
      kind: "reported",
      source: "openclaw",
      channels: [{ platform: "discord" }],
    });
    for (const status of ["STOPPED", "FAILED", "PENDING", "DEPLOYING"]) {
      assert.deepEqual(await findChannels(openclaw(status).wheels, AGENT_ID, deployment()), { kind: "none-reported" }, status);
    }
  });

  it("reports nothing when the agent has no OpenClaw deployment or no channels", async () => {
    const none = fakeApi({ "GET /api/openclaw": { deployments: [] } });
    assert.deepEqual(await findChannels(none.wheels, AGENT_ID, deployment()), { kind: "none-reported" });
    const empty = fakeApi({ "GET /api/openclaw": { deployments: [{ id: "x", agentId: AGENT_ID, channels: [] }] } });
    assert.deepEqual(await findChannels(empty.wheels, AGENT_ID, deployment()), { kind: "none-reported" });
  });
});

describe("findAgentDeployment", () => {
  const OTHER_AGENT = "55555555-5555-4555-8555-555555555555";
  const agents = [
    agent({ id: OTHER_AGENT, slug: "other", latestDeployment: { id: "66666666-6666-4666-8666-666666666666", status: "running", endpoint: null, createdAt: "x" } }),
    agent({ latestDeployment: { id: DEPLOYMENT_ID, status: "running", endpoint: null, createdAt: "x" } }),
  ];

  it("goes straight to the agent whose latest deployment matches", async () => {
    const api = fakeApi({
      "GET /api/agents": { agents, total: 2 },
      [`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`]: { deployment: deployment() },
    });
    const found = await findAgentDeployment(api.wheels, DEPLOYMENT_ID, undefined);
    assert.equal(found?.agent.id, AGENT_ID);
    assert.equal(api.calls.length, 2);
  });

  it("falls back to asking each agent, treating 404 as 'not this one'", async () => {
    const OLD = "77777777-7777-4777-8777-777777777777";
    const api = fakeApi({
      "GET /api/agents": { agents, total: 2 },
      [`GET /api/agents/${OTHER_AGENT}/deployments/${OLD}`]: status(404, { error: "NotFound", message: "Deployment not found" }),
      [`GET /api/agents/${AGENT_ID}/deployments/${OLD}`]: { deployment: deployment({ id: OLD }) },
    });
    const found = await findAgentDeployment(api.wheels, OLD, undefined);
    assert.equal(found?.deployment.id, OLD);
    assert.equal(found?.agent.id, AGENT_ID);
  });

  it("returns null when no agent has it, and only asks the named agent with --agent", async () => {
    const api = fakeApi({
      "GET /api/agents": { agents, total: 2 },
      [`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`]: status(404, { error: "NotFound", message: "Deployment not found" }),
    });
    assert.equal(await findAgentDeployment(api.wheels, DEPLOYMENT_ID, "my-support-bot"), null);
    assert.deepEqual(
      api.calls.map((c) => c.path),
      ["/api/agents", `/api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`],
    );
  });

  it("turns a rate limit hit while searching into advice to skip the search", async () => {
    const api = fakeApi({
      "GET /api/agents": { agents, total: 2 },
      [`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`]: status(429, { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" }),
    });
    await assert.rejects(findAgentDeployment(api.wheels, DEPLOYMENT_ID, undefined), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.hint ?? "", /--agent <slug-or-id>, or --model/);
      return true;
    });
  });

  it("does not swallow errors other than 404", async () => {
    const api = fakeApi({
      "GET /api/agents": { agents, total: 2 },
      [`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`]: status(500, { error: "InternalError", message: "Internal Server Error" }),
    });
    await assert.rejects(findAgentDeployment(api.wheels, DEPLOYMENT_ID, undefined), { status: 500 });
  });
});

describe("describeError", () => {
  it("passes CliError text and hint through", () => {
    assert.deepEqual(describeError(new CliError("nope", { hint: "try this" })), { message: "nope", hint: "try this" });
  });

  it("keeps the API's message and adds status and code as detail", () => {
    const described = describeError(new WheelsAIError(402, "Add credits and retry.", {}, "insufficient_credits"), { webUrl: "https://w.test" });
    assert.equal(described.message, "Add credits and retry.");
    assert.equal(described.detail, "HTTP 402 insufficient_credits");
    assert.equal(described.hint, "Add credits at https://w.test/dashboard/billing");
  });

  it("tells a 401 to log in, and an unreachable API to check the URL", () => {
    assert.match(describeError(new WheelsAIError(401, "Authentication required")).hint ?? "", /wheelsai login/);
    const unreachable = describeError(new WheelsAIError(0, "Could not reach http://x: ECONNREFUSED"));
    assert.equal(unreachable.detail, undefined);
    assert.match(unreachable.hint ?? "", /config show/);
  });

  it("points a 401 at the environment when the credential came from there", () => {
    const described = describeError(new WheelsAIError(401, "Authentication required"), { credentialSource: "env" });
    assert.match(described.hint ?? "", /WHEELSAI_API_KEY \/ WHEELSAI_TOKEN/);
    assert.doesNotMatch(described.hint ?? "", /Run `wheelsai login`/);
  });

  it("tells the three kinds of 429 apart", () => {
    const quota = describeError(
      new WheelsAIError(429, "Monthly API call limit reached.", { upgradeUrl: "/dashboard/billing?upgrade=pro" }, "plan_limit_reached"),
      { webUrl: "https://w.test" },
    );
    assert.equal(quota.detail, "HTTP 429 plan_limit_reached");
    assert.match(quota.hint ?? "", /retrying will not help until it resets\. Upgrade at https:\/\/w\.test\/dashboard\/billing\?upgrade=pro$/);
    assert.match(describeError(new WheelsAIError(429, "Too many", {}, "deployment_quota_exceeded")).hint ?? "", /limit of active deployments/);
    assert.match(describeError(new WheelsAIError(429, "Rate limit exceeded", {}, "Too Many Requests")).hint ?? "", /rate limiting/);
    // An upgrade link is only built from a path on the configured web app, never from a URL the server names.
    const elsewhere = describeError(new WheelsAIError(429, "x", { upgradeUrl: "https://evil.test/pay" }, "plan_limit_reached"), { webUrl: "https://w.test" });
    assert.doesNotMatch(elsewhere.hint ?? "", /evil/);
  });

  it("keeps a CliError's detail, and strips control characters from API text", () => {
    assert.deepEqual(describeError(new CliError("nope", { detail: "HTTP 400 validation_failed", hint: "h" })), {
      message: "nope",
      detail: "HTTP 400 validation_failed",
      hint: "h",
    });
    const hostile = describeError(new WheelsAIError(500, "bad\u001b]52;c;ZXZpbA==\u0007 thing\u009b2K", {}, "Internal\u001b[1A"));
    assert.equal(hostile.message, "bad]52;c;ZXZpbA== thing2K");
    assert.equal(hostile.detail, "HTTP 500 Internal[1A");
  });

  it("describes plain errors and non-errors", () => {
    assert.equal(describeError(new Error("boom")).message, "boom");
    assert.equal(describeError("odd").message, "odd");
  });
});
