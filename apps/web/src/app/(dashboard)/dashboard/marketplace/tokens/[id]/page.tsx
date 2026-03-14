"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { TokenChart } from "@/components/dashboard/token-chart";
import { TokenTradePanel } from "@/components/dashboard/token-trade-panel";
import { usePolling } from "@/lib/use-polling";
import { cn } from "@/lib/utils";
import { ArrowLeft, Copy } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface TokenDetail {
  id: string;
  name: string;
  symbol: string;
  imageUri?: string | null;
  mintAddress: string;
  pumpfunUrl?: string | null;
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

  const { data, isLoading: loading } = usePolling<TokenPageData>({
    fetcher,
    interval: 15_000,
    onError: () => toast.error("Failed to load token details"),
  });

  const token = data?.token ?? null;
  const trades = data?.trades ?? [];
  const chartData = data?.chartData ?? [];

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    toast.success("Address copied");
  };

  if (loading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex flex-col">
        <Header title="Token Not Found" />
        <div className="p-8">
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <h3 className="text-lg font-semibold mb-2">Token not found</h3>
              <Button onClick={() => router.push("/dashboard/marketplace/tokens")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Marketplace
              </Button>
            </CardContent>
          </Card>
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
                        <h2 className="text-2xl font-bold">{formatUsd(token.priceUsd)}</h2>
                        <LiveDot />
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm">
                        <span className="text-muted-foreground">
                          MCap: {formatUsd(token.marketCapUsd)}
                        </span>
                        <span className="text-muted-foreground">
                          Vol: {formatUsd(token.volume24h)}
                        </span>
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
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    No trades yet
                  </div>
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
                            <td className="py-2 font-mono">{formatUsd(trade.priceUsd)}</td>
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
            />

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
