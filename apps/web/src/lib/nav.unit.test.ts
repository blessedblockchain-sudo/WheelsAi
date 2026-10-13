/**
 * The dashboard menu: 19 items, nothing dropped, every page has a home. Run with:
 *   cd apps/web && npx tsx --test src/lib/nav.unit.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORMER_LINKS,
  JOBS_HIRED_HREF,
  JOBS_RECEIVED_HREF,
  LEADERBOARD_PUBLIC_HREF,
  LEADERBOARD_TAB_HREF,
  LIST_AGENT_BUTTON,
  NEW_AGENT_BUTTON,
  USAGE_PAID_HREF,
  buildNav,
  hrefPath,
  locate,
  navItems,
  tabsNeedSearch,
} from "./nav";

const OFF = { tokenUi: false };
const ON = { tokenUi: true };

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/** Every route with a page.tsx, as a URL path. Route groups like (dashboard) are not in the URL. */
function routesOnDisk(dir: string = APP_DIR, segments: string[] = []): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      return routesOnDisk(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
    }
    return entry.name === "page.tsx" ? ["/" + segments.join("/")] : [];
  });
}

const ROUTES = routesOnDisk();
const DASHBOARD_ROUTES = ROUTES.filter((route) => route === "/dashboard" || route.startsWith("/dashboard/"));

/** /dashboard/agents/[id]/builder as a visitor would open it. */
const sample = (route: string) => route.replace(/\[[^\]]+\]/g, "sample-1");

/** The sidebar's links as they were before this menu (35 with the token flag on). */
const LINKS_BEFORE = [
  "/dashboard",
  "/dashboard/agents",
  "/dashboard/agents/new",
  "/dashboard/templates",
  "/dashboard/orchestrations",
  "/dashboard/scheduler",
  "/dashboard/models",
  "/dashboard/training",
  "/dashboard/training/datasets",
  "/dashboard/knowledge",
  "/dashboard/memory",
  "/dashboard/testing",
  "/dashboard/deployments",
  "/dashboard/playground",
  "/dashboard/openclaw",
  "/dashboard/monitoring",
  "/dashboard/domains",
  "/dashboard/integrations",
  "/marketplace",
  "/dashboard/marketplace",
  "/dashboard/marketplace/publish",
  "/dashboard/marketplace/offerings",
  "/dashboard/jobs",
  "/dashboard/marketplace/installs",
  "/dashboard/marketplace/revenue",
  "/dashboard/marketplace/analytics",
  "/marketplace/leaderboard",
  "/dashboard/marketplace/tokens",
  "/dashboard/billing",
  "/dashboard/keys",
  "/dashboard/analytics",
  "/dashboard/settings/team",
  "/dashboard/settings/security",
  "/dashboard/settings/branding",
  "/dashboard/settings",
];

/** "item" or "item > tab", and whether the tab bar shows. */
function where(pathname: string, search = "", opts = ON): string | null {
  const at = locate(pathname, search, opts);
  if (at === null) return null;
  return `${at.item.label}${at.tab ? ` > ${at.tab.label}` : ""}${at.showTabs ? " [tabs]" : ""}`;
}

test("the menu is 19 items in order, with the token flag off and on", () => {
  const expected = [
    ":Home",
    "Build:Agents",
    "Build:Workflows",
    "Build:Models",
    "Build:Knowledge",
    "Build:Testing",
    "Deploy:Channels",
    "Deploy:Domains",
    "Deploy:Monitoring",
    "Monetize:Listings",
    "Monetize:Earnings",
    "Marketplace:Browse",
    "Marketplace:Installed",
    "Marketplace:Hired",
    "Account:Billing",
    "Account:API keys",
    "Account:Usage",
    "Account:Team",
    "Account:Settings",
  ];
  for (const opts of [OFF, ON]) {
    const got = buildNav(opts).flatMap((g) => g.items.map((i) => `${g.label ?? ""}:${i.label}`));
    assert.deepEqual(got, expected);
    assert.equal(navItems(opts).length, 19);
    assert.equal(new Set(navItems(opts).map((i) => i.id)).size, 19);
  }
});

test("each item's tabs are the ones named, and Tokens is a tab only when the flag is on", () => {
  const tabs = (opts: typeof ON) =>
    Object.fromEntries(navItems(opts).filter((i) => i.tabs.length > 0).map((i) => [i.label, i.tabs.map((t) => t.label)]));
  const shared = {
    Agents: ["Agents", "Templates"],
    Workflows: ["Workflows", "Scheduler"],
    Models: ["Catalog", "Deployments", "Fine-tuning", "Datasets", "Try"],
    Knowledge: ["Knowledge", "Memory"],
    Channels: ["Website chat", "Chat apps", "Webhooks & integrations"],
    Usage: ["Analytics", "What you pay for"],
    Settings: ["Account", "Security", "Branding"],
  };
  const listings = ["Listings", "Offerings", "Orders", "Insights", "Leaderboard"];
  assert.deepEqual(tabs(OFF), { ...shared, Listings: listings });
  assert.deepEqual(tabs(ON), { ...shared, Listings: [...listings, "Tokens"] });
  assert.ok(!navItems(ON).some((i) => i.label === "Tokens"));
});

test("an item with tabs opens one of its own tabs, and no two places share an address", () => {
  const places: string[] = [];
  for (const item of navItems(ON)) {
    if (item.tabs.length === 0) {
      places.push(item.href);
      continue;
    }
    assert.ok(item.tabs.some((t) => t.href === item.href), `${item.label} opens ${item.href}, which is not one of its tabs`);
    places.push(...item.tabs.map((t) => t.href));
  }
  assert.equal(new Set(places).size, places.length);
  assert.equal(navItems(ON).find((i) => i.id === "channels")!.href, "/dashboard/integrations?tab=channels");
});

test("every one of the old sidebar links is an item, a tab or a named button", () => {
  assert.equal(LINKS_BEFORE.length, 35);
  assert.deepEqual(FORMER_LINKS.map((l) => l.href), LINKS_BEFORE);

  const items = navItems(ON);
  for (const link of FORMER_LINKS) {
    assert.ok(link.to.length > 0, `${link.name} went nowhere`);
    for (const dest of link.to) {
      const item = items.find((i) => i.id === dest.item);
      assert.ok(item, `${link.name}: no item ${dest.item}`);
      if (dest.tab !== undefined) {
        const tab = item.tabs.find((t) => t.label === dest.tab);
        assert.ok(tab, `${link.name}: ${item.label} has no tab ${dest.tab}`);
        assert.equal(hrefPath(tab.href), link.now ?? link.href);
        assert.ok(ROUTES.includes(link.href), `${link.name}: the old address ${link.href} has no page.tsx`);
      } else if (dest.button !== undefined) {
        assert.ok(dest.button.length > 0);
        assert.equal(locate(link.href, "", ON)?.item.id, item.id, `${link.name}: the button is not on ${item.label}`);
      } else {
        assert.equal(item.href, link.href);
      }
    }
  }

  const buttons = FORMER_LINKS.filter((l) => l.to.some((d) => d.button !== undefined));
  assert.deepEqual(
    buttons.map((l) => [l.href, l.to[0]!.item, l.to[0]!.button]),
    [
      [NEW_AGENT_BUTTON.href, "agents", "New agent"],
      [LIST_AGENT_BUTTON.href, "listings", "List an agent"],
    ],
  );
});

test("every address in the menu has a page", () => {
  for (const opts of [OFF, ON]) {
    for (const item of navItems(opts)) {
      for (const href of [item.href, ...item.tabs.map((t) => t.href)]) {
        assert.ok(ROUTES.includes(hrefPath(href)), `${href} has no page.tsx`);
      }
    }
  }
  for (const button of [NEW_AGENT_BUTTON, LIST_AGENT_BUTTON]) {
    assert.ok(ROUTES.includes(button.href), `${button.href} has no page.tsx`);
  }
});

test("every dashboard page belongs to exactly one item", () => {
  // 54 when this was written. A page added later without a home fails below.
  assert.ok(DASHBOARD_ROUTES.length >= 54, `found only ${DASHBOARD_ROUTES.length} dashboard pages`);

  for (const opts of [OFF, ON]) {
    const items = navItems(opts);
    for (const route of DASHBOARD_ROUTES) {
      const at = locate(sample(route), "", opts);
      assert.ok(at, `${route} is not in the menu`);
      assert.equal(items.filter((i) => i === at.item || i.id === at.item.id).length, 1, route);
      assert.ok(at.group.items.includes(at.item));
      if (at.tab) assert.ok(at.item.tabs.includes(at.tab));
      // A page with [id] or "new" in it is never where the tab bar shows.
      if (route.includes("[") || route.endsWith("/new") || route.endsWith("/create")) {
        assert.equal(at.showTabs, false, `${route} shows the tab bar`);
      }
    }
  }
});

test("the most specific page wins", () => {
  assert.equal(where("/dashboard"), "Home");
  assert.equal(where("/dashboard/training"), "Models > Fine-tuning [tabs]");
  assert.equal(where("/dashboard/training/datasets"), "Models > Datasets [tabs]");
  assert.equal(where("/dashboard/marketplace"), "Listings > Listings [tabs]");
  assert.equal(where("/dashboard/marketplace/revenue"), "Earnings");
  assert.equal(where("/dashboard/marketplace/installs"), "Installed");
  assert.equal(where("/dashboard/marketplace/offerings"), "Listings > Offerings [tabs]");
  assert.equal(where("/dashboard/settings"), "Settings > Account [tabs]");
  assert.equal(where("/dashboard/settings/team"), "Team");
  assert.equal(where("/dashboard/settings/security"), "Settings > Security [tabs]");
  assert.equal(where("/dashboard/playground"), "Models > Try [tabs]");
  assert.equal(where("/dashboard/openclaw"), "Channels > Chat apps [tabs]");
  assert.equal(where("/dashboard/analytics"), "Usage > Analytics [tabs]");
  assert.equal(where("/dashboard/usage"), "Usage > What you pay for [tabs]");
  assert.equal(where("/dashboard/marketplace/analytics"), "Listings > Insights [tabs]");
  assert.equal(where("/marketplace"), "Browse");
  assert.equal(where("/dashboard/marketplace/leaderboard"), "Listings > Leaderboard [tabs]");
  assert.equal(where("/dashboard/agents/"), "Agents > Agents [tabs]");
});

test("the query string picks between tabs on the same page", () => {
  assert.equal(where("/dashboard/integrations"), "Channels > Webhooks & integrations [tabs]");
  assert.equal(where("/dashboard/integrations", "?tab=channels"), "Channels > Website chat [tabs]");
  assert.equal(where("/dashboard/integrations", "tab=webhooks"), "Channels > Webhooks & integrations [tabs]");

  assert.equal(where("/dashboard/jobs"), "Hired");
  assert.equal(where("/dashboard/jobs", "?tab=hired"), "Hired");
  assert.equal(where("/dashboard/jobs", "?tab=received"), "Listings > Orders [tabs]");
  assert.equal(where("/dashboard/jobs", new URLSearchParams("page=2&tab=received").toString()), "Listings > Orders [tabs]");
  assert.equal(locate("/dashboard/jobs", new URLSearchParams("tab=received"), OFF)?.tab?.label, "Orders");
  assert.equal(locate("/dashboard/jobs", null, OFF)?.item.id, "hired");

  assert.equal(JOBS_HIRED_HREF, "/dashboard/jobs");
  assert.equal(JOBS_RECEIVED_HREF, "/dashboard/jobs?tab=received");
});

test("detail and new pages belong to their list page's item, without the tab bar", () => {
  assert.equal(where("/dashboard/agents/abc"), "Agents > Agents");
  assert.equal(where("/dashboard/agents/abc/builder"), "Agents > Agents");
  assert.equal(where("/dashboard/agents/new"), "Agents > Agents");
  assert.equal(where("/dashboard/deployments/abc"), "Models > Deployments");
  assert.equal(where("/dashboard/deployments/new"), "Models > Deployments");
  assert.equal(where("/dashboard/training/abc"), "Models > Fine-tuning");
  assert.equal(where("/dashboard/training/new"), "Models > Fine-tuning");
  assert.equal(where("/dashboard/training/models/abc"), "Models > Fine-tuning");
  assert.equal(where("/dashboard/memory/abc"), "Knowledge > Memory");
  assert.equal(where("/dashboard/openclaw/new"), "Channels > Chat apps");
  assert.equal(where("/dashboard/orchestrations/abc"), "Workflows > Workflows");
  assert.equal(where("/dashboard/domains/abc"), "Domains");
  assert.equal(where("/dashboard/marketplace/publish"), "Listings > Listings");
  assert.equal(where("/dashboard/marketplace/offerings/new"), "Listings > Offerings");
  // A job opens under Hired unless the link says it came from Orders.
  assert.equal(where("/dashboard/jobs/abc"), "Hired");
  assert.equal(where("/dashboard/jobs/abc", "?tab=received"), "Listings > Orders");
});

test("the Leaderboard tab stays inside the dashboard, and the public page keeps its address", () => {
  const tab = navItems(OFF).find((i) => i.id === "listings")!.tabs.find((t) => t.label === "Leaderboard")!;
  assert.equal(tab.href, LEADERBOARD_TAB_HREF);
  assert.ok(tab.href.startsWith("/dashboard/"), "the tab would leave the dashboard frame");
  assert.ok(ROUTES.includes(LEADERBOARD_TAB_HREF));
  assert.ok(ROUTES.includes(LEADERBOARD_PUBLIC_HREF));
  // The public page is outside the dashboard, so the menu does not claim it.
  assert.equal(where(LEADERBOARD_PUBLIC_HREF), null);
  // Every tab of every item opens inside the dashboard.
  for (const item of navItems(ON)) {
    for (const t of item.tabs) assert.ok(t.href.startsWith("/dashboard/"), `${item.label} > ${t.label} opens ${t.href}`);
  }
});

test("what the organization pays for is a tab of Usage, at the address the plan emails link to", () => {
  const usage = navItems(OFF).find((i) => i.id === "usage")!;
  // The item still opens where it always did, and the new page is beside it.
  assert.equal(usage.href, "/dashboard/analytics");
  assert.deepEqual(usage.tabs, [
    { label: "Analytics", href: "/dashboard/analytics" },
    { label: "What you pay for", href: "/dashboard/usage" },
  ]);
  assert.equal(USAGE_PAID_HREF, "/dashboard/usage");
  assert.ok(ROUTES.includes(USAGE_PAID_HREF));
});

test("only jobs and integrations need the query string to draw their tabs", () => {
  assert.equal(tabsNeedSearch("/dashboard/jobs"), true);
  assert.equal(tabsNeedSearch("/dashboard/integrations"), true);
  assert.equal(tabsNeedSearch("/dashboard/integrations/"), true);
  assert.equal(tabsNeedSearch("/dashboard/models"), false);
  assert.equal(tabsNeedSearch("/dashboard/jobs/abc"), false);
  assert.equal(tabsNeedSearch("/dashboard"), false);
});

test("token pages belong to Listings whether or not the Tokens tab exists", () => {
  assert.equal(where("/dashboard/marketplace/tokens", "", ON), "Listings > Tokens [tabs]");
  assert.equal(where("/dashboard/marketplace/tokens/abc", "", ON), "Listings > Tokens");
  assert.equal(where("/dashboard/marketplace/tokens/create", "", ON), "Listings > Tokens");
  assert.equal(where("/dashboard/marketplace/tokens", "", OFF), "Listings");
  assert.equal(where("/dashboard/marketplace/tokens/abc", "", OFF), "Listings");
});

test("a path the menu does not know is not guessed at", () => {
  assert.equal(where("/dashboard/nope"), null);
  assert.equal(where("/dashboard-old"), null);
  assert.equal(where("/"), null);
  assert.equal(where("/login"), null);
  assert.equal(where("/marketplace/some-agent"), null);
  assert.equal(where("/marketplace/leaderboard/2025"), null);
  assert.equal(where("/dashboard/marketplace/leaderboard/2025"), "Listings > Leaderboard");
  assert.equal(where("/dashboard/agentsx"), null);
});
