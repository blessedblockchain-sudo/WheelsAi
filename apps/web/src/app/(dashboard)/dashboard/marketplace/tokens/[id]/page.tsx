"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { TokenChart } from "@/components/dashboard/token-chart";
import { TokenTradePanel } from "@/components/dashboard/token-trade-panel";
import { BondingCurveProgress } from "@/components/dashboard/bonding-curve-progress";
import { TokenCurveCard, TokenCreatorFeesCard } from "@/components/dashboard/token-curve-card";
import { usePolling } from "@/lib/use-polling";
import { cn } from "@/lib/utils";
import { ArrowRightLeft, Coins, Copy } from "lucide-react";
import { getErrorMessage, tokenApi, type TokenCurve } from "@/lib/api";
import { NO_FIGURE, formatDecimal, formatPriceSol, isMeteoraToken } from "@/lib/token-curve";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface TokenDetail {
  id: string;
  name: string;
  symbol: string;
  imageUri?: string | null;
  mintAddress: string;
  pumpfunUrl?: string | null;
  /** "meteora" for a token on WheelsAI's own Meteora curve. */
  launchpad?: string | null;
  bondingCurveAddress?: string | null;
  creatorAddress: string;
  totalSupply: number;
  curveSupply: number;
  reservedSupply: number;
  status: "BONDING" | "GRADUATED" | "FAILED";
  graduatedAt?: string | null;
  raydiumPoolId?: string | null;
  marketCapUsd: number;
  priceUsd: number;
  volume24h: number;
  holders: number;
  creatorLockupEnd?: string | null;
  createdAt: string;
  agentListing?: {
    id: string;
    title: string;
    slug: string;
    avgRating: number;
    totalInstalls: number;
    totalRequests: number;
    category: string;
  };
}

interface Trade {
  id: string;
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

interface ChartPoint {
  timestamp: string;
  priceUsd: number;
}

interface TokenPageData {
  token: TokenDetail;
  trades: Trade[];
  chartData: ChartPoint[];
}

function formatUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(8)}`;
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function LiveDot() {
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
    </span>
  );
}

function useRelativeTime(date: Date | null): string {
  const [label, setLabel] = useState("just now");

  useEffect(() => {
    if (!date) return;

    const update = () => {
      const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
      if (diffSec < 5) setLabel("just now");
      else if (diffSec < 60) setLabel(`${diffSec}s ago`);
      else setLabel(`${Math.floor(diffSec / 60)}m ago`);
    };

    update();
    const id = setInterval(update, 5_000);
    return () => clearInterval(id);
  }, [date]);

  return label;
}

/** Mirrors the loaded layout: chart + trades on the left, trading on the right. */
function TokenDetailSkeleton() {
  return (
    <div className="p-8" aria-busy="true">
      <span className="sr-only">Loading token</span>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Token header */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-1 items-center gap-4">
                  <Skeleton className="h-16 w-16 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-8 w-1/3" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            </CardContent>
          </Card>

          {/* Price chart */}
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[300px] w-full" />
            </CardContent>
          </Card>

          {/* Recent trades */}
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-16" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* Trade panel */}
          <Card>
            <CardHeader className="pb-3">
              <Skeleton className="h-6 w-1/2" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-11 w-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-10 w-full" />
              </div>
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>

          {/* Bonding curve */}
          <Card>
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between gap-4">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-1/4" />
              </div>
              <Skeleton className="h-3 w-full rounded-full" />
              <Skeleton className="h-3 w-2/3" />
            </CardContent>
          </Card>

          {/* Token info */}
          <Card>
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex justify-between gap-4">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/4" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function TokenDetailPage() {
  const params = useParams();
  const router = useRouter();
  const tokenId = params.id as string;

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const updatedLabel = useRelativeTime(lastUpdated);

  const fetcher = useCallback(async (): Promise<TokenPageData> => {
    const [tokenRes, tradesRes, chartRes] = await Promise.all([
      fetch(`${API_URL}/api/tokens/${tokenId}`, { credentials: "include" }),
      fetch(`${API_URL}/api/tokens/${tokenId}/trades?limit=50`, { credentials: "include" }),
      fetch(`${API_URL}/api/tokens/${tokenId}/chart`, { credentials: "include" }),
    ]);

    if (!tokenRes.ok) {
      throw new Error("Failed to fetch token");
    }

    const [tokenData, tradesData, chartData] = await Promise.all([
      tokenRes.json(),
      tradesRes.ok ? tradesRes.json() : Promise.resolve({ trades: [] }),
      chartRes.ok ? chartRes.json() : Promise.resolve({ snapshots: [] }),
    ]);

    setLastUpdated(new Date());

    return {
      token: tokenData.token as TokenDetail,
      trades: (tradesData.trades || []) as Trade[],
      chartData: (chartData.snapshots || []) as ChartPoint[],
    };
  }, [tokenId]);

  // Must keep a stable identity: usePolling re-subscribes and fetches again
  // whenever onError changes, so an inline arrow refetched on every render
  // (and repeated the error toast in a loop) instead of every 15s.
  const handleLoadError = useCallback((err: Error) => {
    toast.error(getErrorMessage(err, "Failed to load token details"));
  }, []);

  const {
    data,
    isLoading: loading,
    error: loadError,
    refresh,
  } = usePolling<TokenPageData>({
    fetcher,
    interval: 15_000,
    onError: handleLoadError,
  });

  // A token on Meteora: the curve is read from the chain through the API,
  // every 10 seconds and after any action. Other tokens never ask for it.
  const onCurve = isMeteoraToken(data?.token);
  const curveFetcher = useCallback(() => tokenApi.getCurve(tokenId), [tokenId]);
  const {
    data: curve,
    isLoading: curveLoading,
    error: curveError,
    refresh: refreshCurve,
  } = usePolling<TokenCurve>({
    fetcher: curveFetcher,
    interval: 10_000,
    enabled: onCurve,
  });
  // A public RPC refuses a read now and then. The last curve read stays on
  // the page and the card says, with its time, that it is not fresh.
  const liveCurve = curve;
  const curveStale = curve !== null && curveError !== null;
  // After an action: the curve first, then the trades and the token's row.
  const refreshAfterAction = useCallback(() => {
    void refreshCurve();
    void refresh();
  }, [refreshCurve, refresh]);

  // "Try again" on the load error shows the skeleton until the retry settles.
  const [retrying, setRetrying] = useState(false);
  const retryLoad = async () => {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  };

  const token = data?.token ?? null;
  const trades = data?.trades ?? [];
  const chartData = data?.chartData ?? [];

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    toast.success("Address copied");
  };

  if (loading || retrying) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <TokenDetailSkeleton />
      </div>
    );
  }

  // No data and an error means the load itself failed; that is not the same
  // as a token that does not exist (the API answers that with token: null).
  if (!data && loadError) {
    return (
      <div className="flex flex-col">
        <Header title="Agent Token" />
        <div className="p-8">
          <ErrorState
            title="Couldn't load token"
            error={loadError}
            onRetry={() => void retryLoad()}
            actionLabel="Back to Marketplace"
            actionHref="/dashboard/marketplace/tokens"
          />
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex flex-col">
        <Header title="Token Not Found" />
        <div className="p-8">
          <EmptyState
            icon={Coins}
            title="Token not found"
            description="Check the link, or go back to the token marketplace."
            actionLabel="Back to Marketplace"
            actionHref="/dashboard/marketplace/tokens"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title={`${token.name} ($${token.symbol})`}
        description={token.agentListing?.title || "Agent Token"}
      />

      <div className="p-8">
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left Column: Chart + Trades */}
          <div className="lg:col-span-2 space-y-6">
            {/* Token Header Card */}
            <Card>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    {token.imageUri ? (
                      <img
                        src={token.imageUri}
                        alt={token.name}
                        className="w-16 h-16 rounded-full"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center font-bold text-xl">
                        {token.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-2xl font-bold break-all">
                          {onCurve
                            ? liveCurve
                              ? `${formatPriceSol(liveCurve.priceSol)} SOL`
                              : "Price not read yet"
                            : formatUsd(token.priceUsd)}
                        </h2>
                        <LiveDot />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm">
                        {onCurve ? (
                          liveCurve && (
                            <span className="text-muted-foreground">
                              Value of the whole supply: {formatDecimal(liveCurve.marketCapSol, 4)} SOL
                            </span>
                          )
                        ) : (
                          <>
                            <span className="text-muted-foreground">
                              MCap: {formatUsd(token.marketCapUsd)}
                            </span>
                            <span className="text-muted-foreground">
                              Vol: {formatUsd(token.volume24h)}
                            </span>
                          </>
                        )}
                        <span className="text-muted-foreground">Holders: {token.holders}</span>
                      </div>
                      {lastUpdated && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Updated {updatedLabel} &middot; polling every 15s
                        </p>
                      )}
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
                  >
                    {token.status === "BONDING"
                      ? "Bonding Curve"
                      : token.status === "GRADUATED"
                        ? "Graduated"
                        : "Failed"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* The curve, for a token on Meteora */}
            {onCurve && (
              <TokenCurveCard
                tokenId={token.id}
                curve={liveCurve}
                loading={curveLoading}
                stale={curveStale}
                onChanged={refreshAfterAction}
              />
            )}

            {/* Price Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Price Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <TokenChart data={chartData} width={700} height={300} showAxes />
                </div>
              </CardContent>
            </Card>

            {/* Trade History */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Trades</CardTitle>
                <CardDescription>{trades.length} trades</CardDescription>
              </CardHeader>
              <CardContent>
                {trades.length === 0 ? (
                  <EmptyState
                    icon={ArrowRightLeft}
                    title="No trades yet"
                    description="No buys or sells have been recorded for this token yet."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="pb-2 font-medium text-muted-foreground">Type</th>
                          <th className="pb-2 font-medium text-muted-foreground">Price</th>
                          <th className="pb-2 font-medium text-muted-foreground">SOL</th>
                          <th className="pb-2 font-medium text-muted-foreground">Tokens</th>
                          <th className="pb-2 font-medium text-muted-foreground">Trader</th>
                          <th className="pb-2 font-medium text-muted-foreground">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((trade) => (
                          <tr key={trade.id} className="border-b last:border-0">
                            <td className="py-2">
                              <span
                                className={cn(
                                  "font-medium",
                                  trade.side === "buy" ? "text-green-500" : "text-red-500"
                                )}
                              >
                                {trade.side === "buy" ? "Buy" : "Sell"}
                              </span>
                            </td>
                            <td className="py-2 font-mono">
                              {/* A trade on the curve is saved with 0 when no SOL price could be read: that is no price, not a price of zero. */}
                              {onCurve && !(trade.priceUsd > 0) ? NO_FIGURE : formatUsd(trade.priceUsd)}
                            </td>
                            <td className="py-2 font-mono">{trade.solAmount.toFixed(4)}</td>
                            <td className="py-2 font-mono">
                              {trade.tokenAmount.toLocaleString(undefined, {
                                maximumFractionDigits: 0,
                              })}
                            </td>
                            <td className="py-2">
                              <button
                                className="font-mono text-xs text-primary hover:underline"
                                onClick={() => copyAddress(trade.traderAddress)}
                              >
                                {shortenAddress(trade.traderAddress)}
                              </button>
                            </td>
                            <td className="py-2 text-muted-foreground text-xs">
                              {new Date(trade.timestamp).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right Column: Trade Panel + Agent Info */}
          <div className="space-y-6">
            {/* Trade Panel */}
            <TokenTradePanel
              tokenId={token.id}
              tokenName={token.name}
              symbol={token.symbol}
              priceUsd={token.priceUsd}
              status={token.status}
              pumpfunUrl={token.pumpfunUrl}
              mintAddress={token.mintAddress}
              launchpad={token.launchpad}
              curve={liveCurve}
              curveLoading={curveLoading}
              onTraded={refreshAfterAction}
            />

            {/* The creator's fees: renders only for the creator's own wallet */}
            {onCurve && (
              <TokenCreatorFeesCard
                tokenId={token.id}
                curve={liveCurve}
                onChanged={refreshAfterAction}
              />
            )}

            {/* Bonding Curve: pump.fun's own threshold, so not for a token on Meteora */}
            {!onCurve && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Bonding Curve</CardTitle>
                </CardHeader>
                <CardContent>
                  <BondingCurveProgress
                    status={token.status}
                    marketCapUsd={token.marketCapUsd}
                    priceUsd={token.priceUsd}
                    holders={token.holders}
                    volume24h={token.volume24h}
                  />
                </CardContent>
              </Card>
            )}

            {/* Token Info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Token Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mint</span>
                  <button
                    className="font-mono text-xs text-primary hover:underline flex items-center gap-1"
                    onClick={() => copyAddress(token.mintAddress)}
                  >
                    {shortenAddress(token.mintAddress)}
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Creator</span>
                  <button
                    className="font-mono text-xs text-primary hover:underline flex items-center gap-1"
                    onClick={() => copyAddress(token.creatorAddress)}
                  >
                    {shortenAddress(token.creatorAddress)}
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Supply</span>
                  <span className="font-mono">{(token.totalSupply / 1e6).toFixed(0)}M</span>
                </div>
                {/* These three are pump.fun's split and our 30-day rule as the row holds them. On Meteora the curve's own lock is in the Curve card. */}
                {!onCurve && (
                  <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Curve Supply</span>
                  <span className="font-mono">{(token.curveSupply / 1e6).toFixed(0)}M</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reserved</span>
                  <span className="font-mono">{(token.reservedSupply / 1e6).toFixed(0)}M</span>
                </div>
                {token.creatorLockupEnd && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Creator Lockup</span>
                    <span className="text-xs">
                      Until {new Date(token.creatorLockupEnd).toLocaleDateString()}
                    </span>
                  </div>
                )}
                  </>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Created</span>
                  <span className="text-xs">{new Date(token.createdAt).toLocaleDateString()}</span>
                </div>
                {token.graduatedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Graduated</span>
                    <span className="text-xs">
                      {new Date(token.graduatedAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Agent Info */}
            {token.agentListing && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Agent Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Name</span>
                    <span className="font-medium">{token.agentListing.title}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Category</span>
                    <Badge variant="outline" className="text-xs">
                      {token.agentListing.category}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Rating</span>
                    <span>{token.agentListing.avgRating.toFixed(1)} / 5.0</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Installs</span>
                    <span>{token.agentListing.totalInstalls.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Requests</span>
                    <span>{Number(token.agentListing.totalRequests).toLocaleString()}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() =>
                      router.push(`/dashboard/marketplace/${token.agentListing!.slug}`)
                    }
                  >
                    View Agent Listing
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
