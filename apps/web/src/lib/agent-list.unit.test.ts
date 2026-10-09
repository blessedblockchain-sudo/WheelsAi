/**
 * Filters and counts behind the agent and template lists. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-list.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIND_CHOICES,
  KIND_FILTERS,
  NO_AGENT_FILTERS,
  countByKind,
  filterAgents,
  filterTemplatesByKind,
  frameworkCounts,
  frameworkLabel,
  hasActiveFilters,
  isKindFilter,
  kindOf,
  newAgentHref,
  quickStartTemplates,
  showsFrameworkChip,
} from "./agent-list";

const agents = [
  { id: "a", agentKind: "conversation", framework: "custom" },
  { id: "b", agentKind: "task", framework: "custom" },
  { id: "c", agentKind: "scheduled", framework: "mastra" },
  { id: "d", agentKind: "conversation", framework: "mastra" },
  { id: "e", agentKind: undefined, framework: "langchain" },
  { id: "f", agentKind: "something-new", framework: "custom" },
];

test("a missing or unknown kind reads as a conversation", () => {
  assert.equal(kindOf(undefined), "conversation");
  assert.equal(kindOf(null), "conversation");
  assert.equal(kindOf("something-new"), "conversation");
  assert.equal(kindOf("task"), "task");
});

test("the kind filters are All plus the three badge labels", () => {
  assert.deepEqual(
    KIND_FILTERS.map((f) => f.label),
    ["All", "Chat", "Task", "Runs on its own"],
  );
  assert.equal(isKindFilter("all"), true);
  assert.equal(isKindFilter("scheduled"), true);
  assert.equal(isKindFilter("nope"), false);
  assert.deepEqual(
    KIND_CHOICES.map((c) => c.kind),
    ["conversation", "task", "scheduled"],
  );
});

test("filtering by kind counts unknown kinds as chats", () => {
  const ids = (kind: "all" | "conversation" | "task" | "scheduled") =>
    filterAgents(agents, { kind, framework: "" }).map((a) => a.id);
  assert.deepEqual(ids("all"), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(ids("conversation"), ["a", "d", "e", "f"]);
  assert.deepEqual(ids("task"), ["b"]);
  assert.deepEqual(ids("scheduled"), ["c"]);
});

test("kind and framework filters combine", () => {
  const result = filterAgents(agents, { kind: "conversation", framework: "mastra" });
  assert.deepEqual(result.map((a) => a.id), ["d"]);
  assert.deepEqual(filterAgents(agents, { kind: "task", framework: "mastra" }), []);
  assert.equal(filterAgents(agents, NO_AGENT_FILTERS).length, agents.length);
});

test("counts add up to the list", () => {
  const counts = countByKind(agents);
  assert.deepEqual(counts, { all: 6, conversation: 4, task: 1, scheduled: 1 });
  assert.equal(counts.conversation + counts.task + counts.scheduled, counts.all);
});

test("framework counts list only frameworks that have agents, most used first", () => {
  assert.deepEqual(frameworkCounts(agents), [
    { framework: "custom", count: 3 },
    { framework: "mastra", count: 2 },
    { framework: "langchain", count: 1 },
  ]);
  assert.deepEqual(frameworkCounts([]), []);
  assert.equal(frameworkLabel("elizaos"), "ElizaOS");
  assert.equal(frameworkLabel("some-new_one"), "Some New One");
});

test("the framework chip shows only for agents that carry code", () => {
  assert.equal(showsFrameworkChip({ framework: "custom" }), false);
  assert.equal(showsFrameworkChip({ framework: "mastra" }), true);
});

test("active filters are noticed", () => {
  assert.equal(hasActiveFilters(NO_AGENT_FILTERS), false);
  assert.equal(hasActiveFilters({ kind: "task", framework: "" }), true);
  assert.equal(hasActiveFilters({ kind: "all", framework: "mastra" }), true);
});

test("template lists filter by kind the same way", () => {
  const templates = [
    { id: "1", agentKind: "task" },
    { id: "2", agentKind: "conversation" },
    { id: "3", agentKind: null },
  ];
  assert.deepEqual(filterTemplatesByKind(templates, "all").map((t) => t.id), ["1", "2", "3"]);
  assert.deepEqual(filterTemplatesByKind(templates, "conversation").map((t) => t.id), ["2", "3"]);
  assert.deepEqual(filterTemplatesByKind(templates, "scheduled"), []);
});

test("quick start picks featured templates first, then the most used, and does not change the input", () => {
  const templates = [
    { id: "a", usageCount: 5 },
    { id: "b", usageCount: 50 },
    { id: "c", usageCount: 1, isFeatured: true },
    { id: "d", usageCount: 9 },
  ];
  assert.deepEqual(quickStartTemplates(templates).map((t) => t.id), ["c", "b", "d"]);
  assert.deepEqual(quickStartTemplates(templates, 1).map((t) => t.id), ["c"]);
  assert.deepEqual(templates.map((t) => t.id), ["a", "b", "c", "d"]);
  assert.deepEqual(quickStartTemplates([]), []);
});

test("links to the create screen carry the kind or the template", () => {
  assert.equal(newAgentHref({}), "/dashboard/agents/new");
  assert.equal(newAgentHref({ kind: "task" }), "/dashboard/agents/new?kind=task");
  assert.equal(newAgentHref({ template: "abc-123" }), "/dashboard/agents/new?template=abc-123");
});
