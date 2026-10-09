/**
 * The tab model of the agent page. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-tabs.unit.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_ADVANCED_STORAGE_KEY,
  FORMER_TAB_IDS,
  advancedStartsOn,
  agentCarriesCode,
  agentMoreLinks,
  buildAgentTabs,
  firstTabOf,
  initialAdvanced,
  resolveTab,
  storedAdvanced,
} from "./agent-tabs";

const KINDS = ["conversation", "task", "scheduled"] as const;

const ids = (tabs: Array<{ id: string }>) => tabs.map((tab) => tab.id);
const labels = (tabs: Array<{ label: string }>) => tabs.map((tab) => tab.label);

test("each kind opens on its own tab", () => {
  assert.equal(firstTabOf("conversation"), "chat");
  assert.equal(firstTabOf("task"), "run");
  assert.equal(firstTabOf("scheduled"), "runs");
  // An agent from before kinds existed is a chat.
  assert.equal(firstTabOf(null), "chat");
  assert.equal(firstTabOf(undefined), "chat");
});

test("with the switch off: the first tab, Share, Sell, Settings", () => {
  assert.deepEqual(labels(buildAgentTabs({ agentKind: "conversation", hasCode: false, advanced: false })), [
    "Chat",
    "Share",
    "Sell",
    "Settings",
  ]);
  assert.deepEqual(labels(buildAgentTabs({ agentKind: "task", hasCode: false, advanced: false })), ["Run", "Share", "Sell", "Settings"]);
  assert.deepEqual(labels(buildAgentTabs({ agentKind: "scheduled", hasCode: false, advanced: false })), [
    "Runs",
    "Share",
    "Sell",
    "Settings",
  ]);
  for (const agentKind of KINDS) {
    assert.ok(buildAgentTabs({ agentKind, hasCode: true, advanced: false }).every((tab) => !tab.advanced));
  }
});

test("with the switch on: the technical tabs, then the doors the kind does not open on", () => {
  assert.deepEqual(labels(buildAgentTabs({ agentKind: "conversation", hasCode: false, advanced: true })), [
    "Chat",
    "Share",
    "Sell",
    "Settings",
    "API",
    "Versions",
    "Code",
    "Logs",
    "GPU",
    "Overview",
    "Schedule",
  ]);
  assert.deepEqual(ids(buildAgentTabs({ agentKind: "task", hasCode: false, advanced: true })), [
    "run",
    "share",
    "sell",
    "settings",
    "api",
    "versions",
    "code",
    "logs",
    "gpu",
    "overview",
    "chat",
    "schedule",
  ]);
  assert.deepEqual(ids(buildAgentTabs({ agentKind: "scheduled", hasCode: false, advanced: true })), [
    "runs",
    "share",
    "sell",
    "settings",
    "api",
    "versions",
    "code",
    "logs",
    "gpu",
    "overview",
    "chat",
  ]);
});

test("basic tabs are marked basic and the rest advanced; no id shows twice", () => {
  for (const agentKind of KINDS) {
    const tabs = buildAgentTabs({ agentKind, hasCode: false, advanced: true });
    assert.deepEqual(ids(tabs.filter((tab) => !tab.advanced)), [firstTabOf(agentKind), "share", "sell", "settings"]);
    assert.equal(new Set(ids(tabs)).size, tabs.length);
    // Every kind can reach a chat and a schedule one way or another.
    assert.ok(ids(tabs).includes("chat"));
    assert.ok(ids(tabs).includes("schedule") || ids(tabs).includes("runs"));
    // Turning the switch off only ever removes advanced tabs.
    assert.deepEqual(ids(buildAgentTabs({ agentKind, hasCode: false, advanced: false })), ids(tabs.filter((tab) => !tab.advanced)));
  }
});

test("every old tab id still resolves, for every kind", () => {
  // The ids of the page before this model, in its order.
  const old: Record<string, string> = {
    overview: "overview",
    api: "api",
    deployments: "gpu",
    versions: "versions",
    code: "code",
    logs: "logs",
    settings: "settings",
  };
  for (const agentKind of KINDS) {
    for (const [was, now] of Object.entries(old)) {
      const resolved = resolveTab(was, { agentKind, hasCode: false, advanced: true });
      assert.equal(resolved.tab, now, `${agentKind} ${was}`);
      assert.ok(ids(buildAgentTabs({ agentKind, hasCode: false, advanced: true })).includes(resolved.tab));
    }
  }
  assert.equal(FORMER_TAB_IDS.deployments, "gpu");
  assert.equal(resolveTab("playground", { agentKind: "task", hasCode: false, advanced: false }).tab, "chat");
  assert.equal(resolveTab("LOGS", { agentKind: "task", hasCode: false, advanced: true }).tab, "logs");
});

test("an unknown tab, or none, falls to the first tab and leaves the switch alone", () => {
  for (const agentKind of KINDS) {
    for (const requested of ["nope", "", null, undefined, "constructor", "__proto__", "toString"]) {
      for (const advanced of [false, true]) {
        assert.deepEqual(
          resolveTab(requested, { agentKind, hasCode: false, advanced }),
          { tab: firstTabOf(agentKind), turnOnAdvanced: false, advanced },
          `${agentKind} ${String(requested)}`,
        );
      }
    }
  }
  // A front door of another kind is not a tab of this one.
  assert.equal(resolveTab("run", { agentKind: "conversation", hasCode: false, advanced: true }).tab, "chat");
  assert.equal(resolveTab("run", { agentKind: "scheduled", hasCode: false, advanced: true }).tab, "runs");
});

test("a link to an advanced tab opens it and turns the switch on", () => {
  assert.deepEqual(resolveTab("logs", { agentKind: "conversation", hasCode: false, advanced: false }), {
    tab: "logs",
    turnOnAdvanced: true,
    advanced: true,
  });
  assert.deepEqual(resolveTab("deployments", { agentKind: "task", hasCode: false, advanced: false }), {
    tab: "gpu",
    turnOnAdvanced: true,
    advanced: true,
  });
  // Already on: nothing to turn.
  assert.deepEqual(resolveTab("logs", { agentKind: "conversation", hasCode: false, advanced: true }), {
    tab: "logs",
    turnOnAdvanced: false,
    advanced: true,
  });
  // A basic tab never touches the switch.
  for (const advanced of [false, true]) {
    assert.deepEqual(resolveTab("share", { agentKind: "task", hasCode: false, advanced }), {
      tab: "share",
      turnOnAdvanced: false,
      advanced,
    });
  }
  // Chat is basic for a chat agent and advanced for the others.
  assert.equal(resolveTab("chat", { agentKind: "conversation", hasCode: false, advanced: false }).turnOnAdvanced, false);
  assert.equal(resolveTab("chat", { agentKind: "task", hasCode: false, advanced: false }).turnOnAdvanced, true);
  assert.equal(resolveTab("chat", { agentKind: "scheduled", hasCode: false, advanced: false }).turnOnAdvanced, true);
});

test("a link to the schedule finds it under either name", () => {
  assert.deepEqual(resolveTab("schedule", { agentKind: "scheduled", hasCode: false, advanced: false }), {
    tab: "runs",
    turnOnAdvanced: false,
    advanced: false,
  });
  assert.deepEqual(resolveTab("runs", { agentKind: "task", hasCode: false, advanced: false }), {
    tab: "schedule",
    turnOnAdvanced: true,
    advanced: true,
  });
  assert.equal(resolveTab("schedule", { agentKind: "conversation", hasCode: false, advanced: true }).tab, "schedule");
});

test("the switch is remembered under one key and starts on for agents that carry code", () => {
  assert.equal(AGENT_ADVANCED_STORAGE_KEY, "wheelsai:agent-advanced");
  assert.equal(advancedStartsOn(true), true);
  assert.equal(advancedStartsOn(false), false);
  // Nothing remembered: the code rule decides.
  assert.equal(initialAdvanced(null, true), true);
  assert.equal(initialAdvanced(null, false), false);
  assert.equal(initialAdvanced(undefined, true), true);
  assert.equal(initialAdvanced("garbage", false), false);
  assert.equal(initialAdvanced("garbage", true), true);
  // A remembered choice is kept either way.
  assert.equal(initialAdvanced(storedAdvanced(true), false), true);
  assert.equal(initialAdvanced(storedAdvanced(false), true), false);
  // With the switch left out, the tabs follow the code rule too.
  assert.ok(ids(buildAgentTabs({ agentKind: "conversation", hasCode: true })).includes("code"));
  assert.ok(!ids(buildAgentTabs({ agentKind: "conversation", hasCode: false })).includes("code"));
  assert.equal(resolveTab("logs", { agentKind: "conversation", hasCode: true }).turnOnAdvanced, false);
  assert.equal(resolveTab("logs", { agentKind: "conversation", hasCode: false }).turnOnAdvanced, true);
});

test("an agent carries code when it has source of its own", () => {
  assert.equal(agentCarriesCode({ sourceCode: "export default agent;", sourceUrl: null }), true);
  assert.equal(agentCarriesCode({ sourceCode: null, sourceUrl: "https://github.com/acme/agent" }), true);
  assert.equal(agentCarriesCode({ sourceCode: null, sourceUrl: null }), false);
  assert.equal(agentCarriesCode({ sourceCode: "  \n", sourceUrl: "" }), false);
  assert.equal(agentCarriesCode({}), false);
});

test("the More menu: Visual Builder, Analytics, Contributors, each a page that exists", () => {
  const links = agentMoreLinks("abc-123");
  assert.deepEqual(links, [
    { id: "builder", label: "Visual Builder", href: "/dashboard/agents/abc-123/builder" },
    { id: "analytics", label: "Analytics", href: "/dashboard/agents/abc-123/analytics" },
    { id: "contributors", label: "Contributors", href: "/dashboard/agents/abc-123/contributors" },
  ]);
  const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(dashboard)", "dashboard", "agents", "[id]");
  for (const link of links) {
    assert.ok(existsSync(join(agentDir, link.id, "page.tsx")), link.id);
  }
});

test("a link to an advanced tab turns the switch on, and once remembered it stays on for the basic tabs", () => {
  const model = { agentKind: "conversation" as const, hasCode: false };
  // Nothing remembered, or "off": the link opens the tab and asks for the switch.
  const opened = resolveTab("api", { ...model, advanced: initialAdvanced("off", false) });
  assert.equal(opened.tab, "api");
  assert.equal(opened.turnOnAdvanced, true);
  assert.equal(opened.advanced, true);
  // The page then remembers the switch as on (storedAdvanced(true)); moving to Share keeps it on.
  const remembered = storedAdvanced(true);
  const moved = resolveTab("share", { ...model, advanced: initialAdvanced(remembered, false) });
  assert.equal(moved.tab, "share");
  assert.equal(moved.advanced, true);
  assert.equal(moved.turnOnAdvanced, false);
  assert.ok(buildAgentTabs({ ...model, advanced: moved.advanced }).some((tab) => tab.id === "api"));
});
