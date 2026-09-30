"use client";

import {
  Zap,
  Star,
  BadgeCheck,
  TrendingUp,
  ShieldCheck,
  Award,
  Badge,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ReputationBadgeProps {
  badge: string;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

const badgeConfig: Record<
  string,
  { name: string; description: string; icon: React.ElementType; color: string }
> = {
  "fast-responder": {
    name: "Fast Responder",
    description: "Average response time under 500ms",
    icon: Zap,
    color: "text-yellow-500 bg-yellow-500/10",
  },
  "top-rated": {
    name: "Top Rated",
    description: "4.5+ star rating with 10+ reviews",
    icon: Star,
    color: "text-amber-500 bg-amber-500/10",
  },
  "verified-developer": {
    name: "Verified Developer",
    description: "Identity verified by WheelsAI",
    icon: BadgeCheck,
    color: "text-blue-500 bg-blue-500/10",
  },
  "high-volume": {
    name: "High Volume",
    description: "100+ total agent installs",
    icon: TrendingUp,
    color: "text-green-500 bg-green-500/10",
  },
  "trusted-publisher": {
    name: "Trusted Publisher",
    description: "80+ reputation with 5+ payouts",
    icon: ShieldCheck,
    color: "text-purple-500 bg-purple-500/10",
  },
  "zero-disputes": {
    name: "Zero Disputes",
    description: "No disputes with 20+ installs",
    icon: Award,
    color: "text-emerald-500 bg-emerald-500/10",
  },
};

export function ReputationBadge({
  badge,
  size = "md",
  showLabel = false,
}: ReputationBadgeProps) {
  const config = badgeConfig[badge] || {
    name: badge,
    description: "",
    icon: Badge,
    color: "text-muted-foreground bg-gray-500/10",
  };
  const Icon = config.icon;

  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-5 w-5",
    lg: "h-6 w-6",
  };

  const containerClasses = {
    sm: "p-1",
    md: "p-1.5",
    lg: "p-2",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full",
        config.color,
        containerClasses[size]
      )}
      title={`${config.name}: ${config.description}`}
    >
      <Icon className={sizeClasses[size]} />
      {showLabel && (
        <span
          className={cn("font-medium", {
            "text-xs": size === "sm",
            "text-sm": size === "md",
            "text-base": size === "lg",
          })}
        >
          {config.name}
        </span>
      )}
    </div>
  );
}

export function ReputationBadgeList({
  badges,
  size = "sm",
  maxShow = 3,
}: {
  badges: string[];
  size?: "sm" | "md" | "lg";
  maxShow?: number;
}) {
  const visibleBadges = badges.slice(0, maxShow);
  const remaining = badges.length - maxShow;

  return (
    <div className="flex items-center gap-1">
      {visibleBadges.map((badge) => (
        <ReputationBadge key={badge} badge={badge} size={size} />
      ))}
      {remaining > 0 && (
        <span className="text-xs text-muted-foreground">+{remaining}</span>
      )}
    </div>
  );
}
