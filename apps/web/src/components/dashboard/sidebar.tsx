"use client";

import { useState } from "react";
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
} from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
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

const navGroups: NavGroup[] = [
  {
    label: "Build",
    items: [
      { name: "Agents", href: "/dashboard/agents", icon: Bot },
      { name: "OpenClaw", href: "/dashboard/openclaw", icon: Sparkles },
      { name: "Deployments", href: "/dashboard/deployments", icon: Box },
      { name: "Templates", href: "/dashboard/templates", icon: FileCode },
      { name: "Models", href: "/dashboard/models", icon: Cpu },
      { name: "Playground", href: "/dashboard/playground", icon: MessageSquare },
    ],
  },
  {
    label: "Marketplace",
    items: [
      { name: "Marketplace", href: "/dashboard/marketplace", icon: Store },
      { name: "Tokens", href: "/dashboard/marketplace/tokens", icon: Coins },
    ],
  },
  {
    label: "Train & Test",
    items: [
      { name: "Training", href: "/dashboard/training", icon: GraduationCap },
      { name: "Testing", href: "/dashboard/testing", icon: FlaskConical },
      { name: "Knowledge", href: "/dashboard/knowledge", icon: Database },
      { name: "Memory", href: "/dashboard/memory", icon: Brain },
    ],
  },
  {
    label: "Operate",
    items: [
      { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
      { name: "Monitoring", href: "/dashboard/monitoring", icon: Bell },
      { name: "Orchestration", href: "/dashboard/orchestrations", icon: GitBranch },
      { name: "Scheduler", href: "/dashboard/scheduler", icon: Clock },
      { name: "Domains", href: "/dashboard/domains", icon: Globe },
      { name: "Integrations", href: "/dashboard/integrations", icon: Plug },
    ],
  },
  {
    label: "Account",
    items: [
      { name: "API Keys", href: "/dashboard/keys", icon: Key },
      { name: "Billing", href: "/dashboard/billing", icon: CreditCard },
      { name: "Settings", href: "/dashboard/settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    "Train & Test": true,
    "Operate": true,
  });
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
    (href !== "/dashboard" && pathname.startsWith(href));

  return (
    <div className="flex h-full w-64 flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
          <Cpu className="h-5 w-5 text-white" />
        </div>
        <span className="text-xl font-bold text-gray-900 dark:text-gray-100">WheelsAI</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {/* Dashboard - always visible, no group header */}
        <Link
          href={overviewItem.href}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            isItemActive(overviewItem.href)
              ? "bg-primary-50 text-primary-700 dark:bg-blue-900/30 dark:text-blue-400"
              : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
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
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {group.label}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 text-gray-400 dark:text-gray-500 transition-transform",
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
                          ? "bg-primary-50 text-primary-700 dark:bg-blue-900/30 dark:text-blue-400"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
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
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-1">
        <WalletButton />
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
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
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <LogOut className="h-5 w-5" />
          Sign out
        </button>
      </div>
    </div>
  );
}
