"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { toast } from "sonner";
import { type TokenCardData } from "@/components/dashboard/token-card";
import {
  Search,
  TrendingUp,
  TrendingDown,
  Coins,
  BarChart3,
  Users,
  ArrowUpDown,
} from "lucide-react";
import { getErrorMessage } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type SortKey = "marketCap" | "volume" | "newest" | "holders" | "price";
type StatusFilter = "all" | "BONDING" | "GRADUATED";

function formatUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(8)}`;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export default function TokenMarketplacePage() {
  const router = useRouter();
  const [tokens, setTokens] = useState<TokenCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("volume");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [stats, setStats] = useState({
    totalTokens: 0,
    totalVolume: 0,
    totalHolders: 0,
    graduated: 0,
  });

  const fetchTokens = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (sortBy) params.set("sortBy", sortBy);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (search) params.set("search", search);

      const response = await fetch(`${API_URL}/api/tokens?${params.toString()}`, {
        credentials: "include",
      });

      if (!response.ok) throw new Error("Failed to fetch tokens");

      const data = await response.json();
      setTokens(data.tokens || []);

      // Calculate stats from the data
      const all = data.tokens || [];
      setStats({
        totalTokens: all.length,
        totalVolume: all.reduce((sum: number, t: TokenCardData) => sum + t.volume24h, 0),
        totalHolders: all.reduce((sum: number, t: TokenCardData) => sum + t.holders, 0),
        graduated: all.filter((t: TokenCardData) => t.status === "GRADUATED").length,
      });
    } catch (error) {
      console.error("Error fetching tokens:", error);
      toast.error(getErrorMessage(error, "Failed to load tokens"));
      setTokens([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokens();
  }, [sortBy, statusFilter]);

  const filteredTokens = useMemo(() => {
    if (!search) return tokens;
    const q = search.toLowerCase();
    return tokens.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.symbol.toLowerCase().includes(q) ||
        t.agentName?.toLowerCase().includes(q)
    );
  }, [tokens, search]);

  const tokenColumns: Column<TokenCardData>[] = [
    {
      key: "name",
      header: "Name / Symbol",
      sortable: true,
      render: (token) => (
        <div className="flex items-center gap-3">
          {token.imageUri ? (
            <img
              src={token.imageUri}
              alt={token.name}
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center font-bold text-xs">
              {token.symbol.slice(0, 2)}
            </div>
          )}
          <div>
            <div className="font-medium">{token.name}</div>
            <div className="text-xs text-muted-foreground font-mono">${token.symbol}</div>
          </div>
        </div>
      ),
    },
    {
      key: "priceUsd",
      header: "Price",
      sortable: true,
      className: "text-right",
      render: (token) => {
        const priceChange =
          token.priceHistory && token.priceHistory.length >= 2
            ? (((token.priceHistory[token.priceHistory.length - 1] ?? 0) -
                (token.priceHistory[0] ?? 0)) /
                (token.priceHistory[0] || 1)) *
              100
            : 0;
        const isPositive = priceChange >= 0;
        return (
          <div className="text-right">
            <div className="font-medium">{formatUsd(token.priceUsd)}</div>
            <div
              className={`flex items-center justify-end gap-1 text-xs font-medium ${
                isPositive ? "text-green-500" : "text-red-500"
              }`}
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
        );
      },
    },
    {
      key: "marketCapUsd",
      header: "Market Cap",
      sortable: true,
      className: "text-right",
      render: (token) => (
        <span className="text-right block font-medium">{formatUsd(token.marketCapUsd)}</span>
      ),
    },
    {
      key: "volume24h",
      header: "24h Volume",
      sortable: true,
      className: "text-right",
      render: (token) => (
        <span className="text-right block font-medium">{formatUsd(token.volume24h)}</span>
      ),
    },
    {
      key: "holders",
      header: "Holders",
      sortable: true,
      className: "text-right",
      render: (token) => (
        <span className="text-right block font-medium">{formatCompact(token.holders)}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (token) => (
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
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (token) => (
        <span className="text-sm text-muted-foreground">
          {new Date(token.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <Header
        title="Agent Token Marketplace"
        description="Discover and trade AI agent tokens on Solana"
        action={{ label: "Create Token", href: "/dashboard/marketplace/tokens/create" }}
      />

      <div className="p-8 space-y-6">
        {/* Stats Row */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Coins className="h-8 w-8 text-primary" />
              <div>
                <div className="text-sm text-muted-foreground">Total Tokens</div>
                <div className="text-2xl font-bold">{stats.totalTokens}</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <BarChart3 className="h-8 w-8 text-blue-500" />
              <div>
                <div className="text-sm text-muted-foreground">24h Volume</div>
                <div className="text-2xl font-bold">{formatUsd(stats.totalVolume)}</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <Users className="h-8 w-8 text-green-500" />
              <div>
                <div className="text-sm text-muted-foreground">Total Holders</div>
                <div className="text-2xl font-bold">{stats.totalHolders.toLocaleString()}</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <TrendingUp className="h-8 w-8 text-purple-500" />
              <div>
                <div className="text-sm text-muted-foreground">Graduated</div>
                <div className="text-2xl font-bold">{stats.graduated}</div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tokens by name, symbol, or agent..."
              className="pl-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            {/* Status filter */}
            {(["all", "BONDING", "GRADUATED"] as StatusFilter[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={statusFilter === s ? "default" : "outline"}
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All" : s === "BONDING" ? "Bonding" : "Graduated"}
              </Button>
            ))}
          </div>

          <div className="flex gap-2">
            {/* Sort buttons */}
            {([
              { key: "volume", label: "Volume" },
              { key: "marketCap", label: "MCap" },
              { key: "newest", label: "Newest" },
              { key: "holders", label: "Holders" },
            ] as { key: SortKey; label: string }[]).map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant={sortBy === s.key ? "secondary" : "ghost"}
                onClick={() => setSortBy(s.key)}
                className="text-xs"
              >
                <ArrowUpDown className="mr-1 h-3 w-3" />
                {s.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Token Table */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
              <p className="mt-4 text-sm text-muted-foreground">Loading tokens...</p>
            </div>
          </div>
        ) : (
          <DataTable
            data={filteredTokens}
            columns={tokenColumns}
            pageSize={10}
            emptyMessage={
              search
                ? "No tokens match your search. Try a different query."
                : "No agent tokens have been created yet. Deploy an agent and tokenize it to get started."
            }
            keyExtractor={(token) => token.id}
            onRowClick={(token) => router.push(`/dashboard/marketplace/tokens/${token.id}`)}
          />
        )}
      </div>
    </div>
  );
}
