"use client";

import { cn } from "@/lib/utils";
import { ReputationBadgeList } from "./reputation-badge";

interface ReputationScoreProps {
  score: number;
  tier: string;
  badges?: string[];
  size?: "sm" | "md" | "lg";
  showTier?: boolean;
  showBadges?: boolean;
}

const tierConfig: Record<
  string,
  { label: string; color: string; bgColor: string }
> = {
  platinum: {
    label: "Platinum",
    color: "text-cyan-400",
    bgColor: "bg-gradient-to-r from-cyan-500/20 to-blue-500/20",
  },
  gold: {
    label: "Gold",
    color: "text-yellow-400",
    bgColor: "bg-gradient-to-r from-yellow-500/20 to-amber-500/20",
  },
  silver: {
    label: "Silver",
    color: "text-gray-300",
    bgColor: "bg-gradient-to-r from-gray-400/20 to-gray-500/20",
  },
  bronze: {
    label: "Bronze",
    color: "text-orange-400",
    bgColor: "bg-gradient-to-r from-orange-500/20 to-amber-600/20",
  },
  new: {
    label: "New",
    color: "text-gray-400",
    bgColor: "bg-gray-500/10",
  },
};

export function ReputationScore({
  score,
  tier,
  badges = [],
  size = "md",
  showTier = true,
  showBadges = true,
}: ReputationScoreProps) {
  const config = tierConfig[tier] ?? tierConfig.new ?? {
    label: "New",
    color: "text-gray-400",
    bgColor: "bg-gray-500/10",
  };

  const scoreSize = {
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-4xl",
  };

  const labelSize = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-lg px-3 py-2",
          config.bgColor
        )}
      >
        <span className={cn("font-bold", scoreSize[size], config.color)}>
          {Math.round(score)}
        </span>
        {showTier && (
          <span className={cn("font-medium", labelSize[size], config.color)}>
            {config.label}
          </span>
        )}
      </div>
      {showBadges && badges.length > 0 && (
        <ReputationBadgeList badges={badges} size={size} maxShow={4} />
      )}
    </div>
  );
}

export function ReputationTierBadge({
  tier,
  size = "md",
}: {
  tier: string;
  size?: "sm" | "md" | "lg";
}) {
  const config = tierConfig[tier] ?? tierConfig.new ?? {
    label: "New",
    color: "text-gray-400",
    bgColor: "bg-gray-500/10",
  };

  const sizeClasses = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-2.5 py-1 text-sm",
    lg: "px-3 py-1.5 text-base",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        sizeClasses[size],
        config.color,
        config.bgColor
      )}
    >
      {config.label}
    </span>
  );
}

export function ReputationProgressBar({
  score,
  tier,
}: {
  score: number;
  tier: string;
}) {
  const config = tierConfig[tier] || tierConfig.new;
  const fallbackTierConfig = tierConfig.new ?? {
    label: "New",
    color: "text-gray-400",
    bgColor: "bg-gray-500/10",
  };
  const resolvedConfig = config ?? fallbackTierConfig;
  const nextTier =
    tier === "new"
      ? "bronze"
      : tier === "bronze"
      ? "silver"
      : tier === "silver"
      ? "gold"
      : tier === "gold"
      ? "platinum"
      : null;

  const thresholds: Record<string, number> = {
    bronze: 25,
    silver: 50,
    gold: 75,
    platinum: 90,
  };

  const currentThreshold =
    tier === "new" ? 0 : thresholds[tier as keyof typeof thresholds] || 0;
  const nextThreshold = nextTier
    ? (thresholds[nextTier as keyof typeof thresholds] ?? 100)
    : 100;
  const progress =
    ((score - currentThreshold) / (nextThreshold - currentThreshold)) * 100;

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-muted-foreground mb-1">
        <span>{resolvedConfig.label}</span>
        {nextTier && <span>{(tierConfig[nextTier] ?? fallbackTierConfig).label}</span>}
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", {
            "bg-cyan-500": tier === "platinum",
            "bg-yellow-500": tier === "gold",
            "bg-gray-400": tier === "silver",
            "bg-orange-500": tier === "bronze",
            "bg-gray-500": tier === "new",
          })}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground mt-1">
        <span>{Math.round(score)} pts</span>
        {nextTier && <span>{nextThreshold} pts needed</span>}
      </div>
    </div>
  );
}
