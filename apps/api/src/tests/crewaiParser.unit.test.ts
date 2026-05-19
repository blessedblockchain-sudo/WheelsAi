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

// Drives apps/api/src/services/frameworks/crewai.ts — pure parser for the
// `agents.yaml` file CrewAI projects use to define the crew. Returns the
// same deployment-relevant shape as the ElizaOS parser:
//
//   name             — slug derived from input or top-level meta
//   agents           — [{role, goal, llm, tools}]
//   modelProviders   — set of unique modelProviders across agents
//   tools            — deduped tool list across agents
//   requiredEnvVars  — derived from modelProviders + tools
//   channelBindings  — always empty (CrewAI is API-only; no inbound chat)
//   warnings         — unsupported tool names, etc.

const minimalYaml = `
researcher:
  role: "Senior Research Analyst"
  goal: "Uncover cutting-edge developments"
  backstory: "Veteran of many dataset crunches"
  llm: "openai/gpt-4"
`.trim();

const multiAgentYaml = `
researcher:
  role: "Senior Research Analyst"
  goal: "Uncover cutting-edge developments"
  backstory: "Veteran of many dataset crunches"
  llm: "openai/gpt-4"
  tools:
    - SerperDevTool
    - WebsiteSearchTool

writer:
  role: "Content Writer"
  goal: "Produce engaging articles"
  backstory: "Long-form storyteller"
  llm: "anthropic/claude-3-opus"
  tools:
    - WebsiteSearchTool
    - FileWriteTool
`.trim();

// ============================================
// Minimal happy path
// ============================================

test("parseCrewAi returns a single-agent crew with derived model provider", async () => {
  setupEnv();
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const result = parseCrewAi(minimalYaml, { name: "research-crew" });

  assert.equal(result.name, "research-crew");
  assert.equal(result.slug, "research-crew");
  assert.equal(result.agents.length, 1);
  const a = result.agents[0]!;
  assert.equal(a.role, "Senior Research Analyst");
  assert.equal(a.llm, "openai/gpt-4");
  assert.equal(a.modelProvider, "openai");
  assert.deepEqual(a.tools, []);

  assert.deepEqual(result.modelProviders, ["openai"]);
  // CrewAI agents are API-only — no inbound chat plumbing.
  assert.deepEqual(result.channelBindings, []);
  assert.deepEqual(result.warnings, []);
});

test("parseCrewAi accepts a pre-parsed object as a convenience", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const obj = {
    researcher: {
      role: "Analyst",
      goal: "Research",
      backstory: "x",
      llm: "openai/gpt-4o",
    },
  };
  const result = parseCrewAi(obj, { name: "x" });
  assert.equal(result.agents.length, 1);
});

// ============================================
// Multi-agent
// ============================================

test("parseCrewAi merges model providers + dedupes tools across the crew", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const result = parseCrewAi(multiAgentYaml, { name: "research-crew" });

  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.modelProviders.sort(), ["anthropic", "openai"]);

  const tools = result.tools.sort();
  assert.deepEqual(tools, ["FileWriteTool", "SerperDevTool", "WebsiteSearchTool"]);
});

// ============================================
// Required env var derivation
// ============================================

test("parseCrewAi requires the right LLM env keys for each provider in use", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const result = parseCrewAi(multiAgentYaml, { name: "x" });

  assert.ok(result.requiredEnvVars.includes("OPENAI_API_KEY"));
  assert.ok(result.requiredEnvVars.includes("ANTHROPIC_API_KEY"));
});

test("parseCrewAi maps known tools to their API key envs", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const yaml = `
ag:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "openai/gpt-4"
  tools:
    - SerperDevTool
    - BraveSearchTool
`.trim();
  const result = parseCrewAi(yaml, { name: "x" });
  assert.ok(result.requiredEnvVars.includes("SERPER_API_KEY"));
  assert.ok(result.requiredEnvVars.includes("BRAVE_API_KEY"));
});

test("parseCrewAi flags unknown tools as warnings rather than failing", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const yaml = `
ag:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "openai/gpt-4"
  tools:
    - SomeRandomTool
`.trim();
  const result = parseCrewAi(yaml, { name: "x" });
  assert.deepEqual(result.warnings, ["unknown_tool:SomeRandomTool"]);
});

test("parseCrewAi dedupes envs from overlapping providers/tools", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  // Two agents, both openai → one OPENAI_API_KEY env var
  const yaml = `
a:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "openai/gpt-4"
b:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "openai/gpt-4o"
`.trim();
  const result = parseCrewAi(yaml, { name: "x" });
  const count = result.requiredEnvVars.filter((e) => e === "OPENAI_API_KEY").length;
  assert.equal(count, 1);
});

// ============================================
// Validation
// ============================================

test("parseCrewAi throws on empty input", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  assert.throws(() => parseCrewAi("", { name: "x" }), /empty|invalid/i);
});

test("parseCrewAi throws when an agent is missing a required field", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const missingGoal = `
researcher:
  role: "Analyst"
  backstory: "x"
  llm: "openai/gpt-4"
`.trim();
  assert.throws(() => parseCrewAi(missingGoal, { name: "x" }), /goal/i);
});

test("parseCrewAi throws on an unsupported model provider prefix", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const yaml = `
ag:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "rogue/local-model-7b"
`.trim();
  assert.throws(() => parseCrewAi(yaml, { name: "x" }), /modelProvider|provider/i);
});

test("parseCrewAi throws on malformed YAML", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  assert.throws(() => parseCrewAi("::\n  not yaml: [", { name: "x" }));
});

// ============================================
// Slugification
// ============================================

test("parseCrewAi slugifies the crew name", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const result = parseCrewAi(minimalYaml, { name: "Research Crew 2026!" });
  assert.equal(result.slug, "research-crew-2026");
});
