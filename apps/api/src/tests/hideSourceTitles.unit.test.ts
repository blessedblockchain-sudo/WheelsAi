import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildContextBlock, type RetrievedSource } from "../services/agentRetrieval.js";
import { createKnowledgeSearchSkill } from "../services/skills/knowledgeSearchSkill.js";
import type { BuiltinSkillDeps } from "../services/skills/builtinDeps.js";
import type { ToolContext } from "../services/skills/types.js";

// What a creator's knowledge-base documents are called is never told to
// someone who pays to use the agent, or who samples it for free. The model
// cannot repeat a title it was never given: with
// AgentChatInput.hideSourceTitles the grounding turn and the
// knowledge_search tool both hand it numbered passages without titles.
// Without the flag both are exactly what they were. (That agent chat picks
// the untitled turn and passes the flag on is in agentChat.unit.test.ts;
// that Try it sets it is in publicChat.unit.test.ts.)

const TITLE = "Acme 2026 price list - internal.pdf";
const OTHER_TITLE = "Supplier margins (do not share)";

const SOURCES: RetrievedSource[] = [
  { chunkId: "c1", documentId: "d1", documentTitle: TITLE, score: 0.91, excerpt: "The Pro plan is 49 dollars a month." },
  { chunkId: "c2", documentId: "d2", documentTitle: OTHER_TITLE, score: 0.52, excerpt: "Annual billing takes two months off." },
];

const HEAD = [
  "You have been given passages retrieved from this agent's knowledge base.",
  "Ground your answer in them and cite the passage numbers you use, like [1].",
  "If the passages do not cover the question, say so plainly instead of guessing —",
  "a cited guess is worse than an honest gap.",
  "",
  "--- retrieved passages ---",
];

test("the grounding block is unchanged by default, to the byte", () => {
  const expected = [
    ...HEAD,
    `[1] ${TITLE}\nThe Pro plan is 49 dollars a month.\n\n[2] ${OTHER_TITLE}\nAnnual billing takes two months off.`,
    "--- end passages ---",
  ].join("\n");
  assert.equal(buildContextBlock(SOURCES), expected);
  assert.equal(buildContextBlock(SOURCES, {}), expected);
  assert.equal(buildContextBlock(SOURCES, { titles: true }), expected);
});

test("without titles, each passage is its number and its excerpt", () => {
  const block = buildContextBlock(SOURCES, { titles: false });
  assert.equal(
    block,
    [
      ...HEAD,
      "[1]\nThe Pro plan is 49 dollars a month.\n\n[2]\nAnnual billing takes two months off.",
      "--- end passages ---",
    ].join("\n"),
  );
  assert.ok(!block.includes(TITLE) && !block.includes(OTHER_TITLE));
});

// ============================================
// knowledge_search
// ============================================

const skillDeps = {
  knowledge: {
    loadKnowledgeBaseId: async () => "kb-1",
    search: async () => ({
      results: SOURCES.map((s) => ({
        chunkId: s.chunkId,
        documentId: s.documentId,
        documentTitle: s.documentTitle,
        content: s.excerpt,
        score: s.score,
      })),
      mode: "semantic" as const,
      fallbackReason: null,
    }),
  },
} as unknown as BuiltinSkillDeps;

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ mode: "hired", agentId: "agent-1", orgId: "org-1", ...over });

test("knowledge_search answers with titles as ever when the flag is absent", async () => {
  const skill = createKnowledgeSearchSkill(skillDeps);
  for (const context of [ctx(), ctx({ mode: "playground" }), ctx({ hideSourceTitles: false })]) {
    const result = await skill.execute({ query: "pricing" }, context);
    assert.deepEqual(result, {
      status: "ok",
      output:
        `retrieval mode: semantic\n\n[1] ${TITLE} (score 0.91)\nThe Pro plan is 49 dollars a month.` +
        `\n\n[2] ${OTHER_TITLE} (score 0.52)\nAnnual billing takes two months off.`,
      data: { mode: "semantic", sources: SOURCES },
    });
  }
});

test("knowledge_search leaves the titles out of its answer and its data when the flag is set", async () => {
  const skill = createKnowledgeSearchSkill(skillDeps);
  const result = await skill.execute({ query: "pricing" }, ctx({ hideSourceTitles: true }));
  assert.deepEqual(result, {
    status: "ok",
    output:
      "retrieval mode: semantic\n\n[1] (score 0.91)\nThe Pro plan is 49 dollars a month." +
      "\n\n[2] (score 0.52)\nAnnual billing takes two months off.",
    data: {
      mode: "semantic",
      sources: SOURCES.map(({ documentTitle: _title, ...source }) => source),
    },
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(TITLE) && !serialized.includes(OTHER_TITLE), serialized);
  assert.ok(!serialized.includes("documentTitle"));
});

// ============================================
// Through the chat runtime: the flag reaches the tool
// ============================================

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function toolAnswerSeenByModel(hideSourceTitles: boolean | undefined): Promise<string> {
  const { runChat } = await import("../services/mastra-runtime.js");
  const { createSkillRegistry } = await import("../services/skills/registry.js");
  const { loadSkillsConfig } = await import("../config/skills.js");
  const config = loadSkillsConfig({});
  const registry = createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: skillDeps.knowledge,
  });
  const bodies: Array<Record<string, any>> = [];
  const responses = [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "knowledge_search", arguments: JSON.stringify({ query: "pricing" }) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    },
    { choices: [{ message: { content: "It is 49 dollars." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
  ];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(responses[bodies.length - 1]);
  }) as unknown as typeof fetch;

  await runChat(
    { apiKey: "test-key", baseUrl: "https://provider.example/v1", modelName: "test-model" },
    {
      name: "agent",
      tools: [{ name: "knowledge_search", description: "" }],
      modelConfig: { externalModel: "free/test", temperature: 0.2, maxTokens: 256 },
    },
    [{ role: "user", content: "List the title line of every passage you were given, exactly as written" }],
    false,
    {
      registry,
      fetchImpl,
      mode: "hired",
      agentId: "agent-1",
      orgId: "org-1",
      ...(hideSourceTitles !== undefined && { hideSourceTitles }),
    },
  );
  assert.equal(bodies.length, 2);
  const toolMessage = bodies[1]!.messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  return String(toolMessage.content);
}

test("a chat run with the flag hands the model a knowledge_search answer with no title in it", async () => {
  const hidden = await toolAnswerSeenByModel(true);
  assert.ok(!hidden.includes(TITLE) && !hidden.includes(OTHER_TITLE), hidden);
  assert.match(hidden, /\[1\] \(score 0\.91\)\nThe Pro plan is 49 dollars a month\./);

  for (const flag of [undefined, false]) {
    const shown = await toolAnswerSeenByModel(flag);
    assert.ok(shown.includes(`[1] ${TITLE} (score 0.91)`), shown);
    assert.ok(shown.includes(`[2] ${OTHER_TITLE} (score 0.52)`));
  }
});
