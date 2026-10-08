"use client";

import { Suspense, useState } from "react";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Cpu,
  LayoutDashboard,
  Bot,
  Store,
  Key,
  CreditCard,
  Settings,
  LogOut,
  BarChart3,
  Bell,
  Plug,
  FlaskConical,
  Globe,
  Database,
  GitBranch,
  ChevronDown,
  Moon,
  Sun,
  Upload,
  PackageCheck,
  DollarSign,
  Users,
  ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { featureFlags } from "@/lib/feature-flags";
import { buildNav, locate } from "@/lib/nav";
import { authApi } from "@/lib/api";
import { WalletButton } from "@/components/dashboard/wallet-button";
import { useTheme } from "@/components/providers/theme-provider";
import type { LucideIcon } from "lucide-react";
import type { NavIcon, NavItem, NavSearch } from "@/lib/nav";

/**
 * One menu of 19 items for everyone, from the nav model: Home, then Build,
 * Deploy, Monetize, Marketplace and Account. Sibling pages are tabs inside
 * an item, shown in the tab bar at the top of the page, so nothing is
 * hidden. Groups are collapsible as a user preference, not a default.
 */
const navOptions = { tokenUi: featureFlags.tokenUi };
const navGroups = buildNav(navOptions);

const navIcons: Record<NavIcon, LucideIcon> = {
  home: LayoutDashboard,
  agents: Bot,
  workflows: GitBranch,
  models: Cpu,
  knowledge: Database,
  testing: FlaskConical,
  channels: Plug,
  domains: Globe,
  monitoring: Bell,
  listings: Upload,
  earnings: DollarSign,
  browse: Store,
  installed: PackageCheck,
  hired: ClipboardCheck,
  billing: CreditCard,
  keys: Key,
  usage: BarChart3,
  team: Users,
  settings: Settings,
};

// useSearchParams needs a Suspense boundary on prerendered pages. Until the
// query string is known the menu renders from the path alone.
// onNavigate runs when a menu item is chosen, so the mobile drawer can close
// even when only the query string changes.
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Suspense fallback={<SidebarMenu search={null} onNavigate={onNavigate} />}>
      <SidebarWithSearch onNavigate={onNavigate} />
    </Suspense>
  );
}

function SidebarWithSearch({ onNavigate }: { onNavigate?: () => void }) {
  const search = useSearchParams();
  return <SidebarMenu search={search} onNavigate={onNavigate} />;
}

function SidebarMenu({ search, onNavigate }: { search: NavSearch; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  // Every group starts expanded: a collapsed group is an invisible one.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { resolvedTheme, setTheme } = useTheme();

  const handleSignOut = async () => {
    try {
      await authApi.logout();
    } catch {
      // Continue with redirect even if API call fails
    }
    router.push("/login");
  };

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  // The item a page belongs to, so a tab or a detail page highlights the
  // item it sits under.
  const activeId = locate(pathname, search, navOptions)?.item.id;

  const renderItem = (item: NavItem) => {
    const Icon = navIcons[item.icon];
    const isActive = item.id === activeId;
    return (
      <Link
        key={item.id}
        href={item.href}
        onClick={onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
        )}
      >
        <Icon className="h-5 w-5" />
        {item.label}
      </Link>
    );
  };

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-border px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
          <Cpu className="h-5 w-5 text-white" />
        </div>
        <span className="text-xl font-bold text-foreground">WheelsAI</span>
      </div>

      <OrgSwitcher />

      {/* Navigation */}
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
        {navGroups.map((group) => {
          // Home sits above the groups with no heading.
          if (group.label === null) {
            return <div key="home">{group.items.map(renderItem)}</div>;
          }
          const label = group.label;
          const isCollapsed = collapsed[label] ?? false;
          const listId = `nav-group-${label.toLowerCase()}`;

          return (
            <div key={label} className="mt-4">
              <button
                type="button"
                onClick={() => toggleGroup(label)}
                aria-expanded={!isCollapsed}
                aria-controls={listId}
                className="flex w-full items-center justify-between px-3 py-1"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "h-3 w-3 text-muted-foreground transition-transform",
                    isCollapsed && "-rotate-90"
                  )}
                />
              </button>
              <div id={listId} hidden={isCollapsed} className="mt-1 space-y-0.5">
                {group.items.map(renderItem)}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Wallet + User section */}
      <div className="border-t border-border p-4 space-y-1">
        <WalletButton />
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          {resolvedTheme === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
          {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
        </button>
        <button
          onClick={handleSignOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <LogOut className="h-5 w-5" />
          Sign out
        </button>
      </div>
    </div>
  );
}
