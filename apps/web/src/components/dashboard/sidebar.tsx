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
  Trophy,
  Users,
  ShieldCheck,
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
  /** Sub-heading groups inside a leg (e.g. Build → Workflows). */
  sections?: Array<{ label: string; items: NavItem[] }>;
}

const overviewItem: NavItem = {
  name: "Dashboard",
  href: "/dashboard",
  icon: LayoutDashboard,
};

/**
 * The nav IS the positioning: the three verbs, Build, Deploy, Monetize,
 * in that order because BUILD leads, and inside Build the three product
 * types the platform builds: agents, workflows, and small language
 * models (including fine-tuning). Everything stays visible; groups are
 * collapsible as a user preference, not a default.
 */
const navGroups: NavGroup[] = [
  {
    label: "Build",
    items: [],
    sections: [
      {
        label: "Agents",
        items: [
          { name: "My Agents", href: "/dashboard/agents", icon: Bot },
          { name: "Create Agent", href: "/dashboard/agents/new", icon: Plus },
          { name: "Templates", href: "/dashboard/templates", icon: FileCode },
        ],
      },
      {
        label: "Workflows",
        items: [
          { name: "Workflows", href: "/dashboard/orchestrations", icon: GitBranch },
          { name: "Scheduler", href: "/dashboard/scheduler", icon: Clock },
        ],
      },
      {
        label: "Models",
        items: [
          { name: "Model Catalog", href: "/dashboard/models", icon: Cpu },
          { name: "Fine-tuning", href: "/dashboard/training", icon: GraduationCap },
          { name: "Datasets", href: "/dashboard/training/datasets", icon: Database },
        ],
      },
      {
        label: "Grounding & quality",
        items: [
          { name: "Knowledge", href: "/dashboard/knowledge", icon: Database },
          { name: "Memory", href: "/dashboard/memory", icon: Brain },
          { name: "Testing", href: "/dashboard/testing", icon: FlaskConical },
        ],
      },
    ],
  },
  {
    label: "Deploy",
    items: [
      { name: "Deployments", href: "/dashboard/deployments", icon: Box },
      { name: "GPU Playground", href: "/dashboard/playground", icon: MessageSquare },
      { name: "OpenClaw", href: "/dashboard/openclaw", icon: Sparkles },
      { name: "Monitoring", href: "/dashboard/monitoring", icon: Bell },
      { name: "Domains", href: "/dashboard/domains", icon: Globe },
      { name: "Channels & Integrations", href: "/dashboard/integrations", icon: Plug },
    ],
  },
  {
    label: "Monetize",
    items: [
      { name: "Browse Marketplace", href: "/marketplace", icon: Store },
      { name: "My Listings", href: "/dashboard/marketplace", icon: Upload },
      { name: "Publish", href: "/dashboard/marketplace/publish", icon: Upload },
      { name: "Installed Agents", href: "/dashboard/marketplace/installs", icon: Bot },
      { name: "Revenue & Payouts", href: "/dashboard/marketplace/revenue", icon: DollarSign },
      { name: "Insights", href: "/dashboard/marketplace/analytics", icon: BarChart3 },
      { name: "Leaderboard", href: "/marketplace/leaderboard", icon: Trophy },
      ...(featureFlags.tokenUi
        ? [{ name: "Tokens", href: "/dashboard/marketplace/tokens", icon: Coins } as NavItem]
        : []),
    ],
  },
  {
    label: "Account",
    items: [
      { name: "Billing & Plan", href: "/dashboard/billing", icon: CreditCard },
      { name: "API Keys", href: "/dashboard/keys", icon: Key },
      { name: "Usage Analytics", href: "/dashboard/analytics", icon: BarChart3 },
      { name: "Team", href: "/dashboard/settings/team", icon: Users },
      { name: "Security", href: "/dashboard/settings/security", icon: ShieldCheck },
      { name: "Branding", href: "/dashboard/settings/branding", icon: Sparkles },
      { name: "Settings", href: "/dashboard/settings", icon: Settings },
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

  // The most specific matching item is active, so /dashboard/training/datasets
  // highlights Datasets and not Fine-tuning as well.
  const allHrefs = navGroups.flatMap((g) => [
    ...g.items.map((i) => i.href),
    ...(g.sections ?? []).flatMap((s) => s.items.map((i) => i.href)),
  ]);
  const isItemActive = (href: string) => {
    const matches = (h: string) => pathname === h || (h !== "/dashboard" && pathname.startsWith(h + "/"));
    if (!matches(href)) return false;
    return !allHrefs.some((other) => other !== href && other.startsWith(href + "/") && matches(other));
  };

  const renderItem = (item: NavItem) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={isItemActive(item.href) ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        isItemActive(item.href) ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
      )}
    >
      <item.icon className="h-5 w-5" />
      {item.name}
    </Link>
  );

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
                  {group.items.map(renderItem)}
                  {group.sections?.map((section) => (
                    <div key={section.label} className="pt-2">
                      <p className="px-3 pb-1 text-[11px] font-medium text-muted-foreground">
                        {section.label}
                      </p>
                      {section.items.map(renderItem)}
                    </div>
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
