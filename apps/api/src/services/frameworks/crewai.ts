/**
 * CrewAI agents.yaml parser (plan A10).
 *
 * Pure: takes the contents of a crew's `agents.yaml` (string or pre-parsed
 * object) and returns the deployment-relevant facts. Mirrors the shape
 * `frameworks/eliza.ts` returns so the launch wizard can treat the two
 * frameworks uniformly downstream.
 *
 * CrewAI is API-only — agents are invoked programmatically rather than
 * receiving messages from chat platforms — so `channelBindings` is always
 * empty. The launch wizard's "wire up Discord" step is hidden for CrewAI.
 */

import { parse as parseYaml } from "yaml";

const MODEL_PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GOOGLE_GEMINI_API_KEY",
  together: "TOGETHER_API_KEY",
};

// Tools whose API keys we know about. Unknown tools become warnings.
const TOOL_ENV_KEYS: Record<string, readonly string[]> = {
  SerperDevTool: ["SERPER_API_KEY"],
  BraveSearchTool: ["BRAVE_API_KEY"],
  // The website crawler ships with no API key requirement.
  WebsiteSearchTool: [],
  FileWriteTool: [],
  FileReadTool: [],
  TavilySearchTool: ["TAVILY_API_KEY"],
};

export interface ParsedCrewAgent {
  key: string;
  role: string;
  goal: string;
  llm: string;
  modelProvider: string;
  tools: string[];
}

export interface CrewBinding {
  platform: never;
  envKeys: readonly string[];
}

export interface ParsedCrewAi {
  name: string;
  slug: string;
  agents: ParsedCrewAgent[];
  modelProviders: string[];
  tools: string[];
  requiredEnvVars: string[];
  channelBindings: CrewBinding[];
  warnings: string[];
}

export interface ParseCrewAiOptions {
  name: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deriveModelProvider(llm: string): string {
  const slash = llm.indexOf("/");
  const provider = slash >= 0 ? llm.slice(0, slash) : llm;
  return provider.toLowerCase();
}

function parseAgent(key: string, raw: unknown): ParsedCrewAgent {
  if (!isPlainObject(raw)) {
    throw new Error(`CrewAI agent '${key}' must be an object`);
  }
  const role = raw.role;
  if (typeof role !== "string" || role.length === 0) {
    throw new Error(`CrewAI agent '${key}' is missing a role`);
  }
  const goal = raw.goal;
  if (typeof goal !== "string" || goal.length === 0) {
    throw new Error(`CrewAI agent '${key}' is missing a goal`);
  }
  const llm = raw.llm;
  if (typeof llm !== "string" || llm.length === 0) {
    throw new Error(`CrewAI agent '${key}' is missing an llm`);
  }

  const modelProvider = deriveModelProvider(llm);
  if (!MODEL_PROVIDER_ENV[modelProvider]) {
    throw new Error(
      `CrewAI agent '${key}' has unsupported modelProvider '${modelProvider}' (from llm '${llm}')`,
    );
  }

  const tools: string[] = [];
  if (Array.isArray(raw.tools)) {
    for (const t of raw.tools) if (typeof t === "string") tools.push(t);
  }

  return { key, role, goal, llm, modelProvider, tools };
}

export function parseCrewAi(
  input: unknown,
  opts: ParseCrewAiOptions,
): ParsedCrewAi {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new Error("parseCrewAi: empty input");
    }
    raw = parseYaml(input);
  }
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new Error("parseCrewAi: invalid YAML (expected a non-empty object of agents)");
  }

  const agents: ParsedCrewAgent[] = [];
  for (const [key, value] of Object.entries(raw)) {
    agents.push(parseAgent(key, value));
  }

  const modelProviders = Array.from(
    new Set(agents.map((a) => a.modelProvider)),
  ).sort();
  const tools = Array.from(new Set(agents.flatMap((a) => a.tools))).sort();

  const envSet = new Set<string>();
  for (const p of modelProviders) envSet.add(MODEL_PROVIDER_ENV[p]!);
  const warnings: string[] = [];
  for (const t of tools) {
    const envs = TOOL_ENV_KEYS[t];
    if (!envs) {
      warnings.push(`unknown_tool:${t}`);
      continue;
    }
    for (const e of envs) envSet.add(e);
  }

  return {
    name: opts.name,
    slug: slugify(opts.name),
    agents,
    modelProviders,
    tools,
    requiredEnvVars: Array.from(envSet).sort(),
    channelBindings: [],
    warnings: warnings.sort(),
  };
}
