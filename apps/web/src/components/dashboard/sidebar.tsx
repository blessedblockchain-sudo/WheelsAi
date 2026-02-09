"use client";

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
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Deployments", href: "/dashboard/deployments", icon: Box },
  { name: "Agents", href: "/dashboard/agents", icon: Bot },
  { name: "Marketplace", href: "/dashboard/marketplace", icon: Store },
  { name: "Training", href: "/dashboard/training", icon: GraduationCap },
  { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "Monitoring", href: "/dashboard/monitoring", icon: Bell },
  { name: "Integrations", href: "/dashboard/integrations", icon: Plug },
  { name: "Testing", href: "/dashboard/testing", icon: FlaskConical },
  { name: "Memory", href: "/dashboard/memory", icon: Brain },
  { name: "Domains", href: "/dashboard/domains", icon: Globe },
  { name: "Scheduler", href: "/dashboard/scheduler", icon: Clock },
  { name: "Knowledge", href: "/dashboard/knowledge", icon: Database },
  { name: "Orchestration", href: "/dashboard/orchestrations", icon: GitBranch },
  { name: "Templates", href: "/dashboard/templates", icon: FileCode },
  { name: "Models", href: "/dashboard/models", icon: Cpu },
  { name: "Playground", href: "/dashboard/playground", icon: MessageSquare },
  { name: "API Keys", href: "/dashboard/keys", icon: Key },
  { name: "Billing", href: "/dashboard/billing", icon: CreditCard },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-64 flex-col border-r border-gray-200 bg-white">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-gray-200 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
          <Cpu className="h-5 w-5 text-white" />
        </div>
        <span className="text-xl font-bold">WheelsAI</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary-50 text-primary-700"
                  : "text-gray-700 hover:bg-gray-100"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-gray-200 p-4">
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">
          <LogOut className="h-5 w-5" />
          Sign out
        </button>
      </div>
    </div>
  );
}
