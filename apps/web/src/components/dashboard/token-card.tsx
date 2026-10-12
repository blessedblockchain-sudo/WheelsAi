"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SparkChart } from "./token-chart";
import { cn } from "@/lib/utils";
import { NO_FIGURE, curveListLabel } from "@/lib/token-curve";
import { TrendingUp, TrendingDown } from "lucide-react";

export interface TokenCardData {
  id: string;
  name: string;
  symbol: string;
  imageUri?: string | null;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  holders: number;
  status: "BONDING" | "GRADUATED" | "FAILED";
  /** "meteora" for a token on WheelsAI's own Meteora curve. Absent from an API older than the field. */
  launchpad?: string | null;
  priceHistory?: number[];
  agentName?: string;
  createdAt: string;
}

interface TokenCardProps {
  token: TokenCardData;
  onClick?: () => void;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(8)}`;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export function TokenCard({ token, onClick }: TokenCardProps) {
  const priceChange =
    token.priceHistory && token.priceHistory.length >= 2
      ? (((token.priceHistory[token.priceHistory.length - 1] ?? 0) - (token.priceHistory[0] ?? 0)) /
          (token.priceHistory[0] || 1)) *
        100
      : 0;

  const isPositive = priceChange >= 0;
  // A token on Meteora is priced in SOL on its curve and has no dollar price
  // here: a zero would read as worthless, so the card says where it trades.
  const curveLabel = token.priceUsd > 0 ? null : curveListLabel(token);

  return (
    <Card
      className="hover:shadow-lg transition-all cursor-pointer hover:border-primary/30"
      onClick={onClick}
    >
      <CardContent className="p-4 space-y-3">
        {/* Header: Logo + Name + Status */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {token.imageUri ? (
              <img
                src={token.imageUri}
                alt={token.name}
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center font-bold text-sm">
                {token.symbol.slice(0, 2)}
              </div>
            )}
            <div>
              <div className="font-semibold text-sm">{token.name}</div>
              <div className="text-xs text-muted-foreground font-mono">${token.symbol}</div>
            </div>
          </div>
          <Badge
            variant={
              token.status === "GRADUATED"
                ? "default"
                : token.status === "FAILED"
                ? "destructive"
                : "secondary"
            }
            className="text-[10px]"
          >
            {token.status === "BONDING"
              ? "Bonding"
              : token.status === "GRADUATED"
              ? "Graduated"
              : "Failed"}
          </Badge>
        </div>

        {/* Price + Change */}
        <div className="flex items-end justify-between">
          {curveLabel ? (
            <div className="text-sm font-semibold">{curveLabel}</div>
          ) : (
          <div>
            <div className="text-lg font-bold">{formatUsd(token.priceUsd)}</div>
            <div
              className={cn(
                "flex items-center gap-1 text-xs font-medium",
                isPositive ? "text-green-500" : "text-red-500"
              )}
            >
              {isPositive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {isPositive ? "+" : ""}
              {priceChange.toFixed(2)}%
            </div>
          </div>
          )}

          {/* Spark chart */}
          {token.priceHistory && token.priceHistory.length >= 2 && (
            <SparkChart data={token.priceHistory} width={80} height={30} />
          )}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t text-xs">
          <div>
            <div className="text-muted-foreground">MCap</div>
            <div className="font-medium">
              {curveLabel && !(token.marketCapUsd > 0) ? NO_FIGURE : formatUsd(token.marketCapUsd)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Volume</div>
            <div className="font-medium">{formatUsd(token.volume24h)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Holders</div>
            <div className="font-medium">{formatCompact(token.holders)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
