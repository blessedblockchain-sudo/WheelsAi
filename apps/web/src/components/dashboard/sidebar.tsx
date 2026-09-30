"use client";

import { useState } from "react";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Cpu,
  LayoutDashboard,
  Box,
  Bot,
  Store,
  GraduationCap,
  Key,
  CreditCard,
  Settings,
  MessageSquare,
  LogOut,
  BarChart3,
  Bell,
  Plug,
  FlaskConical,
  Brain,
  Globe,
  Clock,
  Database,
  GitBranch,
  FileCode,
  ChevronDown,
  Sparkles,
  Coins,
  Moon,
  Sun,
  Plus,
  Upload,
  DollarSign,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { featureFlags } from "@/lib/feature-flags";
import { authApi } from "@/lib/api";
import { WalletButton } from "@/components/dashboard/wallet-button";
import { useTheme } from "@/components/providers/theme-provider";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const overviewItem: NavItem = {
  name: "Dashboard",
  href: "/dashboard",
  icon: LayoutDashboard,
};

/**
 * The nav IS the positioning (B1 / INT-X1): three groups matching the
 * three verbs — Build, Deploy, Monetize — in that order, because BUILD
 * leads. Everything stays VISIBLE (the match-up directive supersedes
 * the old plan to flag-gate the breadth behind a default-off
 * "Advanced" group: surfaces tell the truth about their state instead
 * of hiding). Groups are still collapsible — that's a user preference,
 * not a default.
 *
 * Three nav lies fixed here:
 *   - "Browse Agents" opened the publisher's OWN listings manager →
 *     renamed "My Listings", with a real "Browse Marketplace" pointing
 *     at the public marketplace.
 *   - "Playground" pointed at the deployment chat, which is a GPU/model
 *     surface, not the agent one → "GPU Playground" under Deploy (it
 *     proxies to a real healthy node since W0-3); the per-agent
 *     playground lives on each agent under Build.
 *   - The entire Deploy leg was buried in a collapsed group.
 */
const navGroups: NavGroup[] = [
  {
    label: "Build",
    items: [
      { name: "My Agents", href: "/dashboard/agents", icon: Bot },
      { name: "Create Agent", href: "/dashboard/agents/new", icon: Plus },
      { name: "Templates", href: "/dashboard/templates", icon: FileCode },
      { name: "Knowledge", href: "/dashboard/knowledge", icon: Database },
      { name: "Memory", href: "/dashboard/memory", icon: Brain },
      { name: "Training", href: "/dashboard/training", icon: GraduationCap },
      { name: "Testing", href: "/dashboard/testing", icon: FlaskConical },
      { name: "Orchestration", href: "/dashboard/orchestrations", icon: GitBranch },
      { name: "Scheduler", href: "/dashboard/scheduler", icon: Clock },
    ],
  },
  {
    label: "Deploy",
    items: [
      { name: "Deployments", href: "/dashboard/deployments", icon: Box },
      { name: "Models", href: "/dashboard/models", icon: Cpu },
      { name: "GPU Playground", href: "/dashboard/playground", icon: MessageSquare },
      { name: "OpenClaw", href: "/dashboard/openclaw", icon: Sparkles },
      { name: "Monitoring", href: "/dashboard/monitoring", icon: Bell },
      { name: "Domains", href: "/dashboard/domains", icon: Globe },
      { name: "Integrations", href: "/dashboard/integrations", icon: Plug },
    ],
  },
  {
    label: "Monetize",
    items: [
      { name: "Browse Marketplace", href: "/marketplace", icon: Store },
      { name: "My Listings", href: "/dashboard/marketplace", icon: Upload },
      { name: "Installed Agents", href: "/dashboard/marketplace/installs", icon: Bot },
      { name: "Publish", href: "/dashboard/marketplace/publish", icon: Upload },
      { name: "Revenue", href: "/dashboard/marketplace/revenue", icon: DollarSign },
      { name: "Insights", href: "/dashboard/marketplace/analytics", icon: BarChart3 },
      ...(featureFlags.tokenUi
        ? [{ name: "Tokens", href: "/dashboard/marketplace/tokens", icon: Coins } as NavItem]
        : []),
      { name: "Billing", href: "/dashboard/billing", icon: CreditCard },
    ],
  },
  {
    label: "Account",
    items: [
      { name: "API Keys", href: "/dashboard/keys", icon: Key },
      { name: "Usage Analytics", href: "/dashboard/analytics", icon: BarChart3 },
      { name: "Settings", href: "/dashboard/settings", icon: Settings },
      { name: "Branding", href: "/dashboard/settings/branding", icon: Sparkles },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  // Every group starts EXPANDED: the three verbs are the product, and
  // a collapsed leg is an invisible leg.
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

  const isItemActive = (href: string) =>
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(href + "/"));

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
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {/* Dashboard - always visible, no group header */}
        <Link
          href={overviewItem.href}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            isItemActive(overviewItem.href)
              ? "bg-primary/10 text-primary"
              : "text-foreground hover:bg-muted"
          )}
        >
          <overviewItem.icon className="h-5 w-5" />
          {overviewItem.name}
        </Link>

        {/* Grouped sections */}
        {navGroups.map((group) => {
          const isCollapsed = collapsed[group.label] ?? false;

          return (
            <div key={group.label} className="mt-4">
              <button
                onClick={() => toggleGroup(group.label)}
                className="flex w-full items-center justify-between px-3 py-1"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 text-muted-foreground transition-transform",
                    isCollapsed && "-rotate-90"
                  )}
                />
              </button>
              {!isCollapsed && (
                <div className="mt-1 space-y-0.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isItemActive(item.href)
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-muted"
                      )}
                    >
                      <item.icon className="h-5 w-5" />
                      {item.name}
                    </Link>
                  ))}
                </div>
              )}
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
