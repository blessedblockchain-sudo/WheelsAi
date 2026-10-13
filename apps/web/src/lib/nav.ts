/**
 * The dashboard menu: one list of 19 items for everyone. Sibling pages are
 * tabs inside an item, shown in a tab bar at the top of the page, so nothing
 * is hidden and no route moves. This module is pure (no React, no icons): the
 * sidebar and the section tab bar both render from it.
 */

/** The sidebar maps each key to an icon component. */
export type NavIcon =
  | "home"
  | "agents"
  | "workflows"
  | "models"
  | "knowledge"
  | "testing"
  | "channels"
  | "domains"
  | "monitoring"
  | "listings"
  | "earnings"
  | "browse"
  | "installed"
  | "hired"
  | "billing"
  | "keys"
  | "usage"
  | "team"
  | "settings";

export interface NavTab {
  label: string;
  /** An existing route. May carry a query string when tabs share a page. */
  href: string;
}

export interface NavItem {
  id: NavIcon;
  label: string;
  /** Where the item opens. For an item with tabs this is one of its tabs. */
  href: string;
  icon: NavIcon;
  /** Empty when the item is a single page. */
  tabs: NavTab[];
}

export interface NavGroup {
  /** null for Home, which sits above the groups without a heading. */
  label: string | null;
  items: NavItem[];
}

export interface NavOptions {
  /** featureFlags.tokenUi: the Tokens tab exists only when this is on. */
  tokenUi: boolean;
}

export interface NavLocation {
  group: NavGroup;
  item: NavItem;
  /** The tab this page is, or sits under. null when the item has no tabs. */
  tab: NavTab | null;
  /** True on a tab's own page; false on detail and "new" pages below it. */
  showTabs: boolean;
}

/** A query string, or anything with URLSearchParams' get(). */
export type NavSearch = string | { get(name: string): string | null } | null | undefined;

/** The jobs page shows what you bought unless ?tab= says otherwise. */
export const JOBS_TAB_PARAM = "tab";
export const JOBS_TAB_HIRED = "hired";
export const JOBS_TAB_RECEIVED = "received";
export const JOBS_HIRED_HREF = "/dashboard/jobs";
export const JOBS_RECEIVED_HREF = `/dashboard/jobs?${JOBS_TAB_PARAM}=${JOBS_TAB_RECEIVED}`;

/** The integrations page opens on webhooks unless ?tab=channels. */
export const CHANNELS_WEBSITE_CHAT_HREF = "/dashboard/integrations?tab=channels";

/**
 * The leaderboard has two addresses with the same content: the public page,
 * and this one inside the dashboard so the Listings tab keeps the menu and
 * the tab bar around it.
 */
export const LEADERBOARD_PUBLIC_HREF = "/marketplace/leaderboard";
export const LEADERBOARD_TAB_HREF = "/dashboard/marketplace/leaderboard";

/** What the organization used and spent on the agents it pays for. The plan emails link here. */
export const USAGE_PAID_HREF = "/dashboard/usage";

function item(id: NavIcon, label: string, href: string, tabs: NavTab[] = []): NavItem {
  return { id, label, href, icon: id, tabs };
}

export function buildNav({ tokenUi }: NavOptions): NavGroup[] {
  return [
    { label: null, items: [item("home", "Home", "/dashboard")] },
    {
      label: "Build",
      items: [
        item("agents", "Agents", "/dashboard/agents", [
          { label: "Agents", href: "/dashboard/agents" },
          { label: "Templates", href: "/dashboard/templates" },
        ]),
        item("workflows", "Workflows", "/dashboard/orchestrations", [
          { label: "Workflows", href: "/dashboard/orchestrations" },
          { label: "Scheduler", href: "/dashboard/scheduler" },
        ]),
        item("models", "Models", "/dashboard/models", [
          { label: "Catalog", href: "/dashboard/models" },
          { label: "Deployments", href: "/dashboard/deployments" },
          { label: "Fine-tuning", href: "/dashboard/training" },
          { label: "Datasets", href: "/dashboard/training/datasets" },
          { label: "Try", href: "/dashboard/playground" },
        ]),
        item("knowledge", "Knowledge", "/dashboard/knowledge", [
          { label: "Knowledge", href: "/dashboard/knowledge" },
          { label: "Memory", href: "/dashboard/memory" },
        ]),
        item("testing", "Testing", "/dashboard/testing"),
      ],
    },
    {
      label: "Deploy",
      items: [
        item("channels", "Channels", CHANNELS_WEBSITE_CHAT_HREF, [
          { label: "Website chat", href: CHANNELS_WEBSITE_CHAT_HREF },
          { label: "Chat apps", href: "/dashboard/openclaw" },
          { label: "Webhooks & integrations", href: "/dashboard/integrations" },
        ]),
        item("domains", "Domains", "/dashboard/domains"),
        item("monitoring", "Monitoring", "/dashboard/monitoring"),
      ],
    },
    {
      label: "Monetize",
      items: [
        item("listings", "Listings", "/dashboard/marketplace", [
          { label: "Listings", href: "/dashboard/marketplace" },
          { label: "Offerings", href: "/dashboard/marketplace/offerings" },
          { label: "Orders", href: JOBS_RECEIVED_HREF },
          { label: "Insights", href: "/dashboard/marketplace/analytics" },
          { label: "Leaderboard", href: LEADERBOARD_TAB_HREF },
          ...(tokenUi ? [{ label: "Tokens", href: "/dashboard/marketplace/tokens" }] : []),
        ]),
        item("earnings", "Earnings", "/dashboard/marketplace/revenue"),
      ],
    },
    {
      label: "Marketplace",
      items: [
        item("browse", "Browse", "/marketplace"),
        item("installed", "Installed", "/dashboard/marketplace/installs"),
        item("hired", "Hired", JOBS_HIRED_HREF),
      ],
    },
    {
      label: "Account",
      items: [
        item("billing", "Billing", "/dashboard/billing"),
        item("keys", "API keys", "/dashboard/keys"),
        // Two pages of usage: what the organization's own agents and models did, and what it used and
        // spent on the agents it pays for. The second address is the one the plan emails link to.
        item("usage", "Usage", "/dashboard/analytics", [
          { label: "Analytics", href: "/dashboard/analytics" },
          { label: "What you pay for", href: USAGE_PAID_HREF },
        ]),
        item("team", "Team", "/dashboard/settings/team"),
        item("settings", "Settings", "/dashboard/settings", [
          { label: "Account", href: "/dashboard/settings" },
          { label: "Security", href: "/dashboard/settings/security" },
          { label: "Branding", href: "/dashboard/settings/branding" },
        ]),
      ],
    },
  ];
}

/** The items in menu order, without their groups. */
export function navItems(opts: NavOptions): NavItem[] {
  return buildNav(opts).flatMap((group) => group.items);
}

/** The pathname of an href, without its query string. */
export function hrefPath(href: string): string {
  return href.split("?")[0] ?? href;
}

/** A page (and, under /dashboard/x, everything below it) that belongs to an item. */
interface Claim {
  path: string;
  query: [name: string, value: string] | null;
  itemId: NavIcon;
  tabHref: string | null;
}

function claimOf(href: string, itemId: NavIcon, tabHref: string | null): Claim {
  const [path = href, queryString] = href.split("?");
  const first = queryString ? [...new URLSearchParams(queryString)][0] : undefined;
  return { path, query: first ? [first[0], first[1]] : null, itemId, tabHref };
}

// Ownership is decided with every tab present, so a token page still belongs
// to Listings when the flag is off; it just has no tab to show.
const CLAIMS: Claim[] = navItems({ tokenUi: true }).flatMap((navItem) =>
  navItem.tabs.length > 0
    ? navItem.tabs.map((tab) => claimOf(tab.href, navItem.id, tab.href))
    : [claimOf(navItem.href, navItem.id, null)],
);

function reader(search: NavSearch): (name: string) => string | null {
  if (!search) return () => null;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return (name) => params.get(name);
}

/**
 * True when a path's tabs depend on the query string (jobs, integrations),
 * so the bar cannot be drawn before the query string is known.
 */
export function tabsNeedSearch(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return CLAIMS.some((claim) => claim.query !== null && claim.path === path);
}

/**
 * The one item a page belongs to, or null for a path the menu does not know.
 * The longest matching path wins, and between two tabs on the same page the
 * one whose query string matches wins.
 */
export function locate(pathname: string, search: NavSearch, opts: NavOptions): NavLocation | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const param = reader(search);

  let best: Claim | null = null;
  for (const claim of CLAIMS) {
    // Only pages under /dashboard/x own what is below them. Home and the
    // public marketplace pages match themselves alone.
    const below = claim.path.startsWith("/dashboard/") && path.startsWith(claim.path + "/");
    if (path !== claim.path && !below) continue;
    if (claim.query && param(claim.query[0]) !== claim.query[1]) continue;
    if (
      best === null ||
      claim.path.length > best.path.length ||
      (claim.path.length === best.path.length && claim.query !== null && best.query === null)
    ) {
      best = claim;
    }
  }
  if (best === null) return null;

  const owner = best;
  for (const group of buildNav(opts)) {
    const found = group.items.find((candidate) => candidate.id === owner.itemId);
    if (!found) continue;
    const tab = found.tabs.find((candidate) => candidate.href === owner.tabHref) ?? null;
    return { group, item: found, tab, showTabs: tab !== null && path === owner.path };
  }
  return null;
}

/** Where one of the old sidebar links can be found now. */
export interface NavDestination {
  item: NavIcon;
  /** The label of a tab inside the item. */
  tab?: string;
  /** The label of a button on the item's page that opens the old link. */
  button?: string;
}

export interface FormerLink {
  name: string;
  href: string;
  /** Set when the tab opens a dashboard copy of the page; the old address still works. */
  now?: string;
  to: NavDestination[];
}

export const NEW_AGENT_BUTTON = { label: "New agent", href: "/dashboard/agents/new" } as const;
export const LIST_AGENT_BUTTON = { label: "List an agent", href: "/dashboard/marketplace/publish" } as const;

/** Every link the sidebar had before it became 19 items, and where each went. */
export const FORMER_LINKS: FormerLink[] = [
  { name: "Dashboard", href: "/dashboard", to: [{ item: "home" }] },
  { name: "My Agents", href: "/dashboard/agents", to: [{ item: "agents", tab: "Agents" }] },
  { name: "Create Agent", href: NEW_AGENT_BUTTON.href, to: [{ item: "agents", button: NEW_AGENT_BUTTON.label }] },
  { name: "Templates", href: "/dashboard/templates", to: [{ item: "agents", tab: "Templates" }] },
  { name: "Workflows", href: "/dashboard/orchestrations", to: [{ item: "workflows", tab: "Workflows" }] },
  { name: "Scheduler", href: "/dashboard/scheduler", to: [{ item: "workflows", tab: "Scheduler" }] },
  { name: "Model Catalog", href: "/dashboard/models", to: [{ item: "models", tab: "Catalog" }] },
  { name: "Fine-tuning", href: "/dashboard/training", to: [{ item: "models", tab: "Fine-tuning" }] },
  { name: "Datasets", href: "/dashboard/training/datasets", to: [{ item: "models", tab: "Datasets" }] },
  { name: "Knowledge", href: "/dashboard/knowledge", to: [{ item: "knowledge", tab: "Knowledge" }] },
  { name: "Memory", href: "/dashboard/memory", to: [{ item: "knowledge", tab: "Memory" }] },
  { name: "Testing", href: "/dashboard/testing", to: [{ item: "testing" }] },
  { name: "Deployments", href: "/dashboard/deployments", to: [{ item: "models", tab: "Deployments" }] },
  { name: "GPU Playground", href: "/dashboard/playground", to: [{ item: "models", tab: "Try" }] },
  { name: "OpenClaw", href: "/dashboard/openclaw", to: [{ item: "channels", tab: "Chat apps" }] },
  { name: "Monitoring", href: "/dashboard/monitoring", to: [{ item: "monitoring" }] },
  { name: "Domains", href: "/dashboard/domains", to: [{ item: "domains" }] },
  {
    name: "Channels & Integrations",
    href: "/dashboard/integrations",
    to: [
      { item: "channels", tab: "Webhooks & integrations" },
      { item: "channels", tab: "Website chat" },
    ],
  },
  { name: "Browse Marketplace", href: "/marketplace", to: [{ item: "browse" }] },
  { name: "My Listings", href: "/dashboard/marketplace", to: [{ item: "listings", tab: "Listings" }] },
  { name: "Publish", href: LIST_AGENT_BUTTON.href, to: [{ item: "listings", button: LIST_AGENT_BUTTON.label }] },
  { name: "Offerings", href: "/dashboard/marketplace/offerings", to: [{ item: "listings", tab: "Offerings" }] },
  { name: "Jobs", href: "/dashboard/jobs", to: [{ item: "hired" }, { item: "listings", tab: "Orders" }] },
  { name: "Installed Agents", href: "/dashboard/marketplace/installs", to: [{ item: "installed" }] },
  { name: "Revenue & Payouts", href: "/dashboard/marketplace/revenue", to: [{ item: "earnings" }] },
  { name: "Insights", href: "/dashboard/marketplace/analytics", to: [{ item: "listings", tab: "Insights" }] },
  {
    name: "Leaderboard",
    href: LEADERBOARD_PUBLIC_HREF,
    now: LEADERBOARD_TAB_HREF,
    to: [{ item: "listings", tab: "Leaderboard" }],
  },
  { name: "Tokens", href: "/dashboard/marketplace/tokens", to: [{ item: "listings", tab: "Tokens" }] },
  { name: "Billing & Plan", href: "/dashboard/billing", to: [{ item: "billing" }] },
  { name: "API Keys", href: "/dashboard/keys", to: [{ item: "keys" }] },
  { name: "Usage Analytics", href: "/dashboard/analytics", to: [{ item: "usage", tab: "Analytics" }] },
  { name: "Team", href: "/dashboard/settings/team", to: [{ item: "team" }] },
  { name: "Security", href: "/dashboard/settings/security", to: [{ item: "settings", tab: "Security" }] },
  { name: "Branding", href: "/dashboard/settings/branding", to: [{ item: "settings", tab: "Branding" }] },
  { name: "Settings", href: "/dashboard/settings", to: [{ item: "settings", tab: "Account" }] },
];
