"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Flame, Clock, TrendingDown } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  treasuryApi,
  type AgentRunwayResponse,
  type RunwayAlertLevel,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const ALERT_BADGE: Record<RunwayAlertLevel, {
  variant: "success" | "warning" | "destructive" | "secondary";
  label: string;
}> = {
  ok: { variant: "success", label: "Healthy" },
  warning: { variant: "warning", label: "< 14 days" },
  critical: { variant: "destructive", label: "< 3 days" },
  shutdown: { variant: "destructive", label: "Out of runway" },
};

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

function formatSol(lamportsStr: string): string {
  try {
    const lamports = BigInt(lamportsStr);
    const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
    if (sol >= 1) return `${sol.toFixed(3)} SOL`;
    if (sol >= 0.001) return `${sol.toFixed(6)} SOL`;
    return `${sol.toExponential(2)} SOL`;
  } catch {
    return "—";
  }
}

function formatDays(runwaySeconds: number | "infinity"): string {
  if (runwaySeconds === "infinity") return "∞";
  const days = runwaySeconds / 86_400;
  if (days >= 30) return `${Math.floor(days)} days`;
  if (days >= 1) return `${days.toFixed(1)} days`;
  const hours = runwaySeconds / 3600;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  return `${Math.floor(runwaySeconds / 60)} min`;
}

function formatUsd(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(2)}K`;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

interface Props {
  slug: string;
  /** Refresh interval in ms; default 30s. Set to 0 to disable. */
  refreshIntervalMs?: number;
  className?: string;
}

export function RunwayCard({
  slug,
  refreshIntervalMs = 30_000,
  className,
}: Props) {
  const [data, setData] = useState<AgentRunwayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const res = await treasuryApi.runway(slug);
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load runway");
        }
      } finally {
        if (!cancelled && refreshIntervalMs > 0) {
          timer = setTimeout(load, refreshIntervalMs);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug, refreshIntervalMs]);

  if (error) {
    return (
      <Card className={cn("border-red-500/30", className)}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-sm text-red-500">
            <AlertTriangle className="h-4 w-4" />
            <span>Runway unavailable: {error}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className={className}>
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    );
  }

  const { runway, treasuryBalanceLamports, solPriceUsd } = data;
  const badge = ALERT_BADGE[runway.alertLevel];

  return (
    <Card className={className}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Runway</span>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>

        <div>
          <div className="text-3xl font-bold tabular-nums">
            {formatDays(runway.runwaySeconds)}
          </div>
          <div className="text-xs text-muted-foreground">
            at current burn rate
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/40">
          <div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Flame className="h-3 w-3" />
              <span>Burned (7d)</span>
            </div>
            <div className="text-sm font-medium tabular-nums">
              {formatUsd(runway.totalCostCents)}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendingDown className="h-3 w-3" />
              <span>Burn / day</span>
            </div>
            <div className="text-sm font-medium tabular-nums">
              {formatSol(runway.burnLamportsPerDay)}
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground space-y-1">
          <div className="flex justify-between">
            <span>Treasury</span>
            <span className="tabular-nums">
              {formatSol(treasuryBalanceLamports)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Replicas (current → desired)</span>
            <span className="tabular-nums">
              {/* desiredReplicas comes from runway; current isn't on this
                  shape (it's on the agent detail). Show desired only. */}
              → {runway.desiredReplicas}
            </span>
          </div>
          <div className="flex justify-between">
            <span>SOL/USD</span>
            <span className="tabular-nums">${solPriceUsd.toFixed(2)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
