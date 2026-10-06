import assert from "node:assert/strict";
import test from "node:test";

import {
  agentApiEndpoints,
  agentEndpoint,
  agentOpenAiBaseUrl,
  agentOpenAiModel,
  apiBase,
  deploymentEndpoint,
  openAiBaseUrl,
  serializeAgentDeployment,
  workflowEndpoint,
} from "../services/publicEndpoints.js";

// services/publicEndpoints.ts: every URL a customer is shown is built from
// PUBLIC_API_URL here. Pure, so the rule "our API host or nothing" is tested
// without touching the environment.

test("agentEndpoint joins PUBLIC_API_URL and the slug with no double slash", () => {
  for (const base of ["https://api.example.test", "https://api.example.test/", "https://api.example.test///"]) {
    assert.equal(
      agentEndpoint("support-bot", base),
      "https://api.example.test/v1/agents/support-bot/chat/completions",
    );
    assert.equal(agentOpenAiBaseUrl("support-bot", base), "https://api.example.test/v1/agents/support-bot");
    assert.equal(openAiBaseUrl(base), "https://api.example.test/v1");
    assert.equal(
      workflowEndpoint("nightly", base),
      "https://api.example.test/v1/workflows/nightly/chat/completions",
    );
  }
  // A base that carries a path keeps it.
  assert.equal(
    agentEndpoint("a", "https://example.test/api/"),
    "https://example.test/api/v1/agents/a/chat/completions",
  );
  assert.equal(agentOpenAiModel("support-bot"), "agent/support-bot");
});

test("a slug is URL-encoded, so it can never add a path segment", () => {
  assert.equal(
    agentEndpoint("a/b c", "https://api.example.test"),
    "https://api.example.test/v1/agents/a%2Fb%20c/chat/completions",
  );
});

test("unset PUBLIC_API_URL gives no agent endpoint, never a fabricated host", () => {
  for (const unset of [undefined, null, "", "   "]) {
    assert.equal(apiBase(unset), null);
    assert.equal(agentEndpoint("support-bot", unset), null);
    assert.equal(agentOpenAiBaseUrl("support-bot", unset), null);
    assert.equal(openAiBaseUrl(unset), null);
    assert.equal(workflowEndpoint("nightly", unset), null);
    assert.deepEqual(agentApiEndpoints("support-bot", unset), {
      apiEndpoint: null,
      openaiBaseUrl: null,
      // The model id needs no host: it is still true.
      openaiModel: "agent/support-bot",
    });
  }
});

test("deploymentEndpoint keeps the pinned shape", () => {
  assert.equal(
    deploymentEndpoint("alpha", "https://api.example.test/"),
    "https://api.example.test/v1/alpha/chat/completions",
  );
  // Host-relative when unset: what the deployment routes have always returned.
  assert.equal(deploymentEndpoint("alpha", undefined), "/v1/alpha/chat/completions");
});

test("a running agent deployment shows the /v1 agent endpoint; any other status shows null", () => {
  const base = "https://api.example.test";
  const row = (status: string) => ({
    id: "d1",
    status,
    // What old rows hold. It must never come back out.
    endpoint: "https://agents.wheelsai.io/support-bot",
    gpuTier: "rtx-3060",
  });

  assert.deepEqual(serializeAgentDeployment(row("running"), "support-bot", base), {
    id: "d1",
    status: "running",
    endpoint: "https://api.example.test/v1/agents/support-bot/chat/completions",
    gpuTier: "rtx-3060",
  });
  for (const status of ["pending", "building", "deploying", "stopped", "failed"]) {
    assert.equal(serializeAgentDeployment(row(status), "support-bot", base).endpoint, null, status);
  }
  // Running, but the platform has no public URL: no endpoint, not a guess.
  assert.equal(serializeAgentDeployment(row("running"), "support-bot", undefined).endpoint, null);
});
