"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Search,
  SlidersHorizontal,
  Star,
  Download,
  Cpu,
  ArrowRight,
  X,
  ChevronDown,
  Coins,
  TrendingUp,
  ShieldCheck,
} from "lucide-react";
import {
  marketplaceApi,
  tokenApi,
  type MarketplaceListing,
  type MarketplaceCategory,
  type AgentToken,
} from "@/lib/api";
import { TokenCard, type TokenCardData } from "@/components/dashboard/token-card";
import { MarketplaceAuthNav } from "@/components/marketplace/auth-nav";

const SORT_OPTIONS = [
  { value: "popular", label: "Most Popular" },
  { value: "rating", label: "Highest Rated" },
  { value: "newest", label: "Newest" },
  { value: "price_low", label: "Price: Low to High" },
  { value: "price_high", label: "Price: High to Low" },
];

const PRICING_OPTIONS = [
  { value: "all", label: "All Pricing" },
  { value: "free", label: "Free" },
  { value: "per_request", label: "Pay per Request" },
  { value: "monthly", label: "Monthly" },
  { value: "tokenized", label: "Token Gated" },
];

function formatPrice(
  listing: MarketplaceListing,
  tokenPriceMap: Map<string, number>
): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") {
    const price = tokenPriceMap.get(listing.id);
    if (price !== undefined) {
      if (price >= 1) return `$${price.toFixed(2)}`;
      if (price >= 0.01) return `$${price.toFixed(4)}`;
      return `$${price.toFixed(6)}`;
    }
    return "Token Gated";
  }
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    const price = listing.pricePerRequestCents / 100;
    return `$${price.toFixed(4)}/req`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    const price = listing.monthlyPriceCents / 100;
    return `$${price.toFixed(2)}/mo`;
  }
  return "Free";
}

function agentTokenToCardData(token: AgentToken): TokenCardData {
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    imageUri: token.imageUri,
    priceUsd: token.priceUsd,
    marketCapUsd: token.marketCapUsd,
    volume24h: token.volume24h,
    holders: token.holders,
    status: token.status,
    agentName: token.agentListing?.title,
    createdAt: token.createdAt,
  };
}

function AgentCard({
  listing,
  tokenPriceMap,
}: {
  listing: MarketplaceListing;
  tokenPriceMap: Map<string, number>;
}) {
  const priceText = formatPrice(listing, tokenPriceMap);
  const hasTokenPrice =
    listing.pricingModel === "tokenized" && tokenPriceMap.has(listing.id);

  return (
    <Link
      href={`/marketplace/${listing.slug}`}
      className="group block rounded-lg border bg-card p-5 transition-all hover:border-primary/30 hover:shadow-md"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/25">
          {listing.iconUrl ? (
            <img
              src={listing.iconUrl}
              alt={listing.title}
              className="h-8 w-8 rounded"
            />
          ) : (
            <Cpu className="h-6 w-6 text-primary-600" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-foreground group-hover:text-primary-600">
              {listing.title}
            </h3>
            {listing.isFeatured && (
              <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-xs font-medium text-yellow-500">
                Featured
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">by {listing.publisherName}</p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
        {listing.shortDescription}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1 text-yellow-600">
          <Star className="h-4 w-4 fill-current" />
          <span className="font-medium">{listing.avgRating.toFixed(1)}</span>
          <span className="text-gray-400">({listing.reviewCount})</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Download className="h-4 w-4" />
          <span>{listing.totalInstalls.toLocaleString()} installs</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {listing.agent?.framework || "custom"}
          </span>
          {listing.pricingModel === "tokenized" && (
            <span
              className="flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-500"
              title="Tokenized agent — treasury and compute payments are publicly verifiable on-chain"
            >
              <ShieldCheck className="h-3 w-3" />
              Receipts
            </span>
          )}
        </span>
        {hasTokenPrice ? (
          <span className="flex items-center gap-1 font-semibold text-cyan-600">
            <Coins className="h-3.5 w-3.5" />
            {priceText}
          </span>
        ) : (
          <span
            className={`font-semibold ${listing.pricingModel === "free" ? "text-green-600" : "text-foreground"}`}
          >
            {priceText}
          </span>
        )}
      </div>
    </Link>
  );
}

function CategorySidebar({
  categories,
  selectedCategory,
  onSelectCategory,
}: {
  categories: MarketplaceCategory[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="font-semibold text-foreground">Categories</h3>
      <ul className="mt-3 space-y-1">
        <li>
          <button
            onClick={() => onSelectCategory("all")}
            className={`w-full rounded-md px-3 py-2 text-left text-sm ${
              selectedCategory === "all"
                ? "bg-primary/10 font-medium text-primary-700"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            All Categories
          </button>
        </li>
        {categories.map((cat) => (
          <li key={cat.id}>
            <button
              onClick={() => onSelectCategory(cat.id)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                selectedCategory === cat.id
                  ? "bg-primary/10 font-medium text-primary-700"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <span>{cat.label}</span>
              <span className="text-xs text-gray-400">{cat.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent" /></div>}>
      <MarketplaceContent />
    </Suspense>
  );
}

function MarketplaceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [categories, setCategories] = useState<MarketplaceCategory[]>([]);
  const [featuredListings, setFeaturedListings] = useState<MarketplaceListing[]>([]);
  const [trendingTokens, setTrendingTokens] = useState<AgentToken[]>([]);
  const [tokenPriceMap, setTokenPriceMap] = useState<Map<string, number>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  // Filter state from URL params
  const query = searchParams.get("q") || "";
  const category = searchParams.get("category") || "all";
  const pricingModel = searchParams.get("pricing") || "all";
  const sortBy = (searchParams.get("sort") as any) || "popular";
  const page = parseInt(searchParams.get("page") || "1", 10);

  const updateParams = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === "all" || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    });
    // Reset page when filters change
    if (!("page" in updates)) {
      params.delete("page");
    }
    router.push(`/marketplace?${params.toString()}`);
  };

  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      try {
        const [listingsRes, categoriesRes, featuredRes, trendingRes] =
          await Promise.all([
            marketplaceApi.searchListings({
              query: query || undefined,
              category: category !== "all" ? category : undefined,
              pricingModel: pricingModel !== "all" ? pricingModel : undefined,
              sortBy,
              page,
              limit: 12,
            }),
            marketplaceApi.getCategories(),
            marketplaceApi.getFeatured(4),
            tokenApi.trending().catch(() => ({ tokens: [] })),
          ]);

        setListings(listingsRes.listings);
        setTotalCount(listingsRes.pagination.total);
        setCategories(categoriesRes.categories);
        setFeaturedListings(featuredRes.listings);
        setTrendingTokens(trendingRes.tokens.slice(0, 4));

        // Build price lookup: agentListingId -> priceUsd
        const priceMap = new Map<string, number>();
        for (const token of trendingRes.tokens) {
          priceMap.set(token.agentListingId, token.priceUsd);
        }
        setTokenPriceMap(priceMap);
      } catch (error) {
        console.error("Failed to load marketplace data:", error);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [query, category, pricingModel, sortBy, page]);

  const showUnfilteredSections = !query && category === "all" && pricingModel === "all";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold">WheelsAI</span>
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            <Link
              href="/marketplace"
              className="text-sm font-medium text-primary-600"
            >
              Marketplace
            </Link>
            <Link
              href="/docs"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Docs
            </Link>
          </nav>
          <MarketplaceAuthNav />
        </div>
      </header>

      {/* Hero */}
      <div className="bg-gradient-to-b from-primary-600 to-primary-700 py-12 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold">Agent Marketplace</h1>
          <p className="mt-2 text-primary-100">
            Discover and deploy AI agents built by the community
          </p>

          {/* Search */}
          <div className="mt-6 flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search agents..."
                value={query}
                onChange={(e) => updateParams({ q: e.target.value })}
                className="w-full rounded-lg border-0 py-3 pl-10 pr-4 text-foreground shadow-sm ring-1 ring-inset ring-border placeholder:text-gray-400 focus:ring-2 focus:ring-primary-500"
              />
              {query && (
                <button
                  onClick={() => updateParams({ q: null })}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white hover:bg-white/20 md:hidden"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex gap-8">
          {/* Sidebar - Desktop */}
          <aside className="hidden w-64 flex-shrink-0 md:block">
            <CategorySidebar
              categories={categories}
              selectedCategory={category}
              onSelectCategory={(cat) => updateParams({ category: cat })}
            />

            <div className="mt-6 rounded-lg border bg-card p-4">
              <h3 className="font-semibold text-foreground">Pricing</h3>
              <ul className="mt-3 space-y-1">
                {PRICING_OPTIONS.map((opt) => (
                  <li key={opt.value}>
                    <button
                      onClick={() => updateParams({ pricing: opt.value })}
                      className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                        pricingModel === opt.value
                          ? "bg-primary/10 font-medium text-primary-700"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {opt.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          {/* Mobile Filters */}
          {showFilters && (
            <div className="fixed inset-0 z-50 bg-black/50 md:hidden">
              <div className="absolute right-0 top-0 h-full w-80 bg-card p-6">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Filters</h2>
                  <button onClick={() => setShowFilters(false)}>
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="mt-6">
                  <CategorySidebar
                    categories={categories}
                    selectedCategory={category}
                    onSelectCategory={(cat) => {
                      updateParams({ category: cat });
                      setShowFilters(false);
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Listings */}
          <div className="flex-1">
            {/* Featured Section */}
            {showUnfilteredSections && featuredListings.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-4 text-lg font-semibold text-foreground">
                  Featured Agents
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {featuredListings.map((listing) => (
                    <AgentCard
                      key={listing.id}
                      listing={listing}
                      tokenPriceMap={tokenPriceMap}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Trending Tokens Section */}
            {showUnfilteredSections && trendingTokens.length > 0 && (
              <section className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-cyan-600" />
                    <h2 className="text-lg font-semibold text-foreground">
                      Trending Tokens
                    </h2>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {trendingTokens.map((token) => (
                    <Link
                      key={token.id}
                      href={
                        token.agentListing?.slug
                          ? `/marketplace/${token.agentListing.slug}#token`
                          : "#"
                      }
                    >
                      <TokenCard token={agentTokenToCardData(token)} />
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* Results Header */}
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {isLoading ? (
                  "Loading..."
                ) : (
                  <>
                    <span className="font-medium">{totalCount}</span> agents
                    found
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <label htmlFor="sort" className="text-sm text-muted-foreground">
                  Sort by:
                </label>
                <select
                  id="sort"
                  value={sortBy}
                  onChange={(e) => updateParams({ sort: e.target.value })}
                  className="rounded-md border-border py-1.5 pl-3 pr-8 text-sm focus:border-primary-500 focus:ring-primary-500"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Listings Grid */}
            {isLoading ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[...Array(6)].map((_, i) => (
                  <div
                    key={i}
                    className="h-48 animate-pulse rounded-lg border bg-muted"
                  />
                ))}
              </div>
            ) : listings.length === 0 ? (
              <div className="rounded-lg border bg-card py-12 text-center">
                <p className="text-muted-foreground">No agents found</p>
                {query && (
                  <button
                    onClick={() => updateParams({ q: null })}
                    className="mt-2 text-sm text-primary-600 hover:text-primary-700"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {listings.map((listing) => (
                  <AgentCard
                    key={listing.id}
                    listing={listing}
                    tokenPriceMap={tokenPriceMap}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalCount > 12 && (
              <div className="mt-8 flex items-center justify-center gap-2">
                <button
                  onClick={() => updateParams({ page: String(page - 1) })}
                  disabled={page <= 1}
                  className="rounded-md border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="px-4 text-sm text-muted-foreground">
                  Page {page} of {Math.ceil(totalCount / 12)}
                </span>
                <button
                  onClick={() => updateParams({ page: String(page + 1) })}
                  disabled={page >= Math.ceil(totalCount / 12)}
                  className="rounded-md border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t bg-card py-8">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-primary-600">
                <Cpu className="h-4 w-4 text-white" />
              </div>
              <span className="font-semibold">WheelsAI</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Built on Nosana. Powered by decentralized compute.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
