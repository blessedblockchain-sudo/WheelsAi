"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Star,
  Download,
  Cpu,
  ExternalLink,
  Shield,
  Clock,
  Users,
  CheckCircle,
  ChevronRight,
  MessageSquare,
  Play,
  Coins,
  TrendingUp,
  TrendingDown,
  BarChart3,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  marketplaceApi,
  tokenApi,
  type MarketplaceListing,
  type MarketplaceReview,
  type AgentToken,
  type AgentTokenHolder,
  type TokenSnapshot,
  ApiError,
  getErrorMessage,
} from "@/lib/api";
import { TokenChart } from "@/components/dashboard/token-chart";
import { MarketplaceAuthNav } from "@/components/marketplace/auth-nav";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";

function formatPrice(listing: MarketplaceListing): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") return "Token Gated";
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    const price = listing.pricePerRequestCents / 100;
    return `$${price.toFixed(4)} per request`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    const price = listing.monthlyPriceCents / 100;
    return `$${price.toFixed(2)}/month`;
  }
  return "Free";
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`h-4 w-4 ${
            star <= rating
              ? "fill-yellow-400 text-yellow-400"
              : "fill-gray-200 text-gray-200"
          }`}
        />
      ))}
    </div>
  );
}

function ReviewCard({ review }: { review: MarketplaceReview }) {
  return (
    <div className="border-b py-4 last:border-0">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">
              {review.reviewerName}
            </span>
            {review.isVerified && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle className="h-3 w-3" />
                Verified
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StarRating rating={review.rating} />
            <span className="text-sm text-muted-foreground">
              {formatDate(review.createdAt)}
            </span>
          </div>
        </div>
      </div>
      {review.title && (
        <h4 className="mt-2 font-medium text-foreground">{review.title}</h4>
      )}
      {review.content && (
        <p className="mt-1 text-sm text-muted-foreground">{review.content}</p>
      )}
    </div>
  );
}

type TabType = "overview" | "reviews" | "token";

/** Placeholder shaped like a sidebar card of label / value rows. */
function InfoCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <Skeleton className="h-5 w-28" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Placeholder shaped like the review list: name, stars and date, text. */
function ReviewListSkeleton() {
  return (
    <div className="divide-y" aria-busy="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="py-4">
          <Skeleton className="h-5 w-32" />
          <div className="mt-1 flex items-center gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="mt-2 h-4 w-full" />
          <Skeleton className="mt-1 h-4 w-2/3" />
        </div>
      ))}
      <span className="sr-only">Loading reviews</span>
    </div>
  );
}

/**
 * Placeholder shaped like the listing page: header, breadcrumb, the details
 * column (summary card, tabs, overview card) and the sidebar cards.
 */
function ListingDetailSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <span className="sr-only">Loading agent</span>
      <header className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-9 w-44" />
        </div>
      </header>

      <div className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <Skeleton className="h-5 w-56" />
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Details column */}
          <div className="lg:col-span-2">
            <div className="rounded-lg border bg-card p-6">
              <div className="flex items-start gap-4">
                <Skeleton className="h-16 w-16 flex-shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="mt-2 h-5 w-40" />
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </div>
                </div>
              </div>
              <Skeleton className="mt-4 h-5 w-full" />
            </div>

            <div className="mt-6 flex gap-6 border-b pb-3">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-24" />
            </div>

            <div className="mt-6 rounded-lg border bg-card p-6">
              <Skeleton className="h-5 w-28" />
              <div className="mt-4 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          </div>

          {/* Sidebar: pricing, statistics, information, publisher */}
          <div className="space-y-6">
            <div className="rounded-lg border bg-card p-6">
              <div className="flex flex-col items-center">
                <Skeleton className="h-9 w-32" />
                <Skeleton className="mt-2 h-4 w-40" />
              </div>
              <Skeleton className="mt-6 h-12 w-full rounded-lg" />
              <Skeleton className="mx-auto mt-3 h-3 w-4/5" />
            </div>
            <InfoCardSkeleton rows={4} />
            <InfoCardSkeleton rows={3} />
            <div className="rounded-lg border bg-card p-6">
              <Skeleton className="h-5 w-24" />
              <div className="mt-4 flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-36" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ListingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Reviews are secondary: when only they fail the page still renders, and
  // the Reviews tab says so instead of claiming there are none.
  const [reviewsError, setReviewsError] = useState<unknown>(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("overview");

  // Install flow (INT-M1) — the buyer conversion.
  const { authed } = useSession();
  const [installState, setInstallState] = useState<{
    installed: boolean;
    clonedAgentId: string | null;
  } | null>(null);
  const [installing, setInstalling] = useState(false);

  // Token data
  const [tokenData, setTokenData] = useState<AgentToken | null>(null);
  const [chartData, setChartData] = useState<TokenSnapshot[]>([]);
  const [holders, setHolders] = useState<AgentTokenHolder[]>([]);

  // Handle hash-based tab selection
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#token") {
      setActiveTab("token");
    }
  }, []);

  // The reviews route takes the listing's id (a UUID), not the slug in this
  // page's URL. Never throws: a failure lands in reviewsError.
  const loadReviews = useCallback(async (listingId: string) => {
    setReviewsLoading(true);
    setReviewsError(null);
    try {
      const res = await marketplaceApi.getListingReviews(listingId, 1, 10);
      setReviews(res.reviews);
    } catch (error) {
      setReviews([]);
      setReviewsError(error);
    } finally {
      setReviewsLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const listingRes = await marketplaceApi.getListing(slug);
      setListing(listingRes.listing);
      // Not awaited: the page does not wait for its Reviews tab.
      void loadReviews(listingRes.listing.id);

      // If tokenized, fetch token data
      if (listingRes.listing.pricingModel === "tokenized") {
        try {
          const tokensRes = await tokenApi.list({ limit: 50 });
          const matchingToken = tokensRes.tokens.find(
            (t) => t.agentListingId === listingRes.listing.id
          );
          if (matchingToken) {
            setTokenData(matchingToken);
            // Fetch chart and holders in parallel
            const [chartRes, holdersRes] = await Promise.all([
              tokenApi.getChart(matchingToken.id).catch(() => ({ snapshots: [] })),
              tokenApi.getHolders(matchingToken.id).catch(() => ({ holders: [] })),
            ]);
            setChartData(chartRes.snapshots);
            setHolders(holdersRes.holders);
          }
        } catch {
          // Token data is optional, don't block page
        }
      }
    } catch (error) {
      console.error("Failed to load listing:", error);
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }, [slug, loadReviews]);

  useEffect(() => {
    if (slug) {
      loadData();
    }
  }, [slug, loadData]);

  useEffect(() => {
    if (!authed || !listing) return;
    let cancelled = false;
    marketplaceApi
      .checkInstallStatus(listing.id)
      .then((res) => {
        if (!cancelled) {
          setInstallState({
            installed: res.isInstalled,
            clonedAgentId: res.install?.clonedAgentId ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setInstallState({ installed: false, clonedAgentId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [authed, listing]);

  async function handleInstall() {
    if (!listing || installing) return;
    setInstalling(true);
    try {
      const res = await marketplaceApi.installAgent(listing.id);
      setInstallState({ installed: true, clonedAgentId: res.clonedAgent.id });
      if (res.subscription) {
        const renews = new Date(res.subscription.currentPeriodEnd).toLocaleDateString();
        toast.success(`Subscribed to ${listing.title}. Renews on ${renews}.`);
      } else {
        toast.success(`${listing.title} installed. It's now in your agents.`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        toast.error(getErrorMessage(error, "Not enough credits"), {
          action: { label: "Add credits", onClick: () => router.push("/dashboard/billing") },
        });
      } else if (
        error instanceof ApiError &&
        (error.data as { error?: string } | null)?.error === "token_required"
      ) {
        toast.error(getErrorMessage(error, "This agent is token-gated"), {
          duration: 12000,
          action: tokenData
            ? { label: `Get ${tokenData.symbol}`, onClick: () => setActiveTab("token") }
            : { label: "Link a wallet", onClick: () => router.push("/dashboard/settings") },
        });
      } else {
        toast.error(getErrorMessage(error, "Failed to install agent"));
      }
    } finally {
      setInstalling(false);
    }
  }

  const hasToken = listing?.pricingModel === "tokenized" && tokenData !== null;
  const isMonthly = listing?.pricingModel === "monthly" && !!listing?.monthlyPriceCents;
  const monthlyPrice = isMonthly ? `$${(listing!.monthlyPriceCents! / 100).toFixed(2)}` : "";

  if (isLoading) {
    return <ListingDetailSkeleton />;
  }

  if (loadError !== null || !listing) {
    // The API answers 404 for a slug with no listing; anything else is a
    // failed load the visitor can retry.
    const notFound =
      loadError === null ||
      (loadError instanceof ApiError && loadError.status === 404);
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
                <Cpu className="h-5 w-5 text-white" />
              </div>
              <span className="text-xl font-bold">WheelsAI</span>
            </Link>
          </div>
        </header>
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          {notFound ? (
            <EmptyState
              icon={Cpu}
              title="Agent not found"
              description="The agent you're looking for doesn't exist or has been removed."
              actionLabel="Back to Marketplace"
              actionHref="/marketplace"
            />
          ) : (
            <ErrorState
              title="Couldn't load this agent"
              error={loadError}
              onRetry={() => void loadData()}
              actionLabel="Back to Marketplace"
              actionHref="/marketplace"
            />
          )}
        </div>
      </div>
    );
  }

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
          <MarketplaceAuthNav />
        </div>
      </header>

      {/* Breadcrumb */}
      <div className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <nav className="flex items-center gap-2 text-sm">
            <Link
              href="/marketplace"
              className="text-muted-foreground hover:text-foreground"
            >
              Marketplace
            </Link>
            <ChevronRight className="h-4 w-4 text-gray-400" />
            <span className="text-foreground">{listing.title}</span>
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Left Column - Details */}
          <div className="lg:col-span-2">
            {/* Header */}
            <div className="rounded-lg border bg-card p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/25">
                  {listing.iconUrl ? (
                    <img
                      src={listing.iconUrl}
                      alt={listing.title}
                      className="h-10 w-10 rounded-lg"
                    />
                  ) : (
                    <Cpu className="h-8 w-8 text-primary-600" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="text-2xl font-bold text-foreground">
                      {listing.title}
                    </h1>
                    {listing.isFeatured && (
                      <span className="rounded bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-500">
                        Featured
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    by{" "}
                    <span className="font-medium text-foreground">
                      {listing.publisherName}
                    </span>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-1 text-yellow-600">
                      <Star className="h-4 w-4 fill-current" />
                      <span className="font-medium">
                        {listing.avgRating.toFixed(1)}
                      </span>
                      <span className="text-gray-400">
                        ({listing.reviewCount} reviews)
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Download className="h-4 w-4" />
                      <span>
                        {listing.totalInstalls.toLocaleString()} installs
                      </span>
                    </div>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {listing.agent?.framework || "custom"}
                    </span>
                  </div>
                </div>
              </div>

              <p className="mt-4 text-foreground">{listing.shortDescription}</p>
            </div>

            {/* Tabs */}
            <div className="mt-6">
              <div className="border-b">
                <nav className="-mb-px flex gap-6">
                  <button
                    onClick={() => setActiveTab("overview")}
                    className={`border-b-2 pb-3 text-sm font-medium ${
                      activeTab === "overview"
                        ? "border-primary-600 text-primary-600"
                        : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                    }`}
                  >
                    Overview
                  </button>
                  <button
                    onClick={() => setActiveTab("reviews")}
                    className={`flex items-center gap-2 border-b-2 pb-3 text-sm font-medium ${
                      activeTab === "reviews"
                        ? "border-primary-600 text-primary-600"
                        : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                    }`}
                  >
                    Reviews
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {listing.reviewCount}
                    </span>
                  </button>
                  {hasToken && (
                    <button
                      onClick={() => setActiveTab("token")}
                      className={`flex items-center gap-2 border-b-2 pb-3 text-sm font-medium ${
                        activeTab === "token"
                          ? "border-cyan-600 text-cyan-600"
                          : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                      }`}
                    >
                      <Coins className="h-4 w-4" />
                      Token
                    </button>
                  )}
                </nav>
              </div>

              {/* Tab Content */}
              <div className="mt-6">
                {activeTab === "overview" && (
                  <div className="space-y-6">
                    {/* Description */}
                    {listing.longDescription && (
                      <div className="rounded-lg border bg-card p-6">
                        <h2 className="font-semibold text-foreground">
                          Description
                        </h2>
                        <div className="prose prose-sm mt-4 max-w-none text-muted-foreground">
                          {listing.longDescription}
                        </div>
                      </div>
                    )}

                    {/* Screenshots */}
                    {listing.screenshots && listing.screenshots.length > 0 && (
                      <div className="rounded-lg border bg-card p-6">
                        <h2 className="font-semibold text-foreground">
                          Screenshots
                        </h2>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          {listing.screenshots.map((url, i) => (
                            <img
                              key={i}
                              src={url}
                              alt={`Screenshot ${i + 1}`}
                              className="rounded-lg border"
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Tags */}
                    {listing.agent?.tags && listing.agent.tags.length > 0 && (
                      <div className="rounded-lg border bg-card p-6">
                        <h2 className="font-semibold text-foreground">Tags</h2>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {listing.agent.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "reviews" && (
                  <div className="rounded-lg border bg-card p-6">
                    <div className="flex items-center justify-between">
                      <h2 className="font-semibold text-foreground">
                        User Reviews
                      </h2>
                      <Link
                        href="/login"
                        className="text-sm text-primary-600 hover:text-primary-700"
                      >
                        Write a Review
                      </Link>
                    </div>

                    {/* Rating Summary */}
                    <div className="mt-4 flex items-center gap-4 rounded-lg bg-muted p-4">
                      <div className="text-center">
                        <div className="text-4xl font-bold text-foreground">
                          {listing.avgRating.toFixed(1)}
                        </div>
                        <StarRating rating={Math.round(listing.avgRating)} />
                        <div className="mt-1 text-sm text-muted-foreground">
                          {listing.reviewCount} reviews
                        </div>
                      </div>
                    </div>

                    {/* Review List */}
                    <div className="mt-6">
                      {reviewsLoading ? (
                        <ReviewListSkeleton />
                      ) : reviewsError !== null ? (
                        <ErrorState
                          title="Couldn't load reviews"
                          error={reviewsError}
                          onRetry={() => void loadReviews(listing.id)}
                        />
                      ) : reviews.length === 0 ? (
                        <EmptyState
                          icon={MessageSquare}
                          title="No reviews yet"
                          description="Be the first to review this agent."
                          actionLabel="Write a Review"
                          actionHref="/login"
                        />
                      ) : (
                        <div className="divide-y">
                          {reviews.map((review) => (
                            <ReviewCard key={review.id} review={review} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "token" && hasToken && tokenData && (
                  <div className="space-y-6">
                    {/* Token Header */}
                    <div className="rounded-lg border bg-card p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-4">
                          {tokenData.imageUri ? (
                            <img
                              src={tokenData.imageUri}
                              alt={tokenData.name}
                              className="h-12 w-12 rounded-full object-cover"
                            />
                          ) : (
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/10 to-cyan-500/20 font-bold text-cyan-500">
                              {tokenData.symbol.slice(0, 2)}
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <h2 className="text-xl font-bold text-foreground">
                                {tokenData.name}
                              </h2>
                              <span className="font-mono text-sm text-muted-foreground">
                                ${tokenData.symbol}
                              </span>
                            </div>
                            <span
                              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                tokenData.status === "GRADUATED"
                                  ? "bg-green-500/10 text-green-500"
                                  : tokenData.status === "FAILED"
                                  ? "bg-red-500/10 text-red-500"
                                  : "bg-muted text-foreground"
                              }`}
                            >
                              {tokenData.status === "BONDING"
                                ? "Bonding Curve"
                                : tokenData.status === "GRADUATED"
                                ? "Graduated"
                                : "Failed"}
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold text-foreground">
                            {formatUsd(tokenData.priceUsd)}
                          </div>
                          {chartData.length >= 2 && (
                            <div
                              className={`flex items-center justify-end gap-1 text-sm font-medium ${
                                (chartData[chartData.length - 1]?.priceUsd ?? 0) >=
                                (chartData[0]?.priceUsd ?? 0)
                                  ? "text-green-600"
                                  : "text-red-600"
                              }`}
                            >
                              {(chartData[chartData.length - 1]?.priceUsd ?? 0) >=
                              (chartData[0]?.priceUsd ?? 0) ? (
                                <TrendingUp className="h-4 w-4" />
                              ) : (
                                <TrendingDown className="h-4 w-4" />
                              )}
                              {(
                                (((chartData[chartData.length - 1]?.priceUsd ?? 0) -
                                  (chartData[0]?.priceUsd ?? 0)) /
                                  ((chartData[0]?.priceUsd ?? 0) || 1)) *
                                100
                              ).toFixed(2)}
                              %
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Price Chart */}
                    {chartData.length >= 2 && (
                      <div className="rounded-lg border bg-card p-6">
                        <h3 className="mb-4 font-semibold text-foreground">
                          Price Chart
                        </h3>
                        <div className="h-[200px]">
                          <TokenChart
                            data={chartData.map((s) => ({
                              timestamp: s.timestamp,
                              priceUsd: s.priceUsd,
                            }))}
                            width={700}
                            height={200}
                            showAxes
                          />
                        </div>
                      </div>
                    )}

                    {/* Token Stats */}
                    <div className="grid gap-4 sm:grid-cols-4">
                      <div className="rounded-lg border bg-card p-4 text-center">
                        <BarChart3 className="mx-auto h-5 w-5 text-gray-400" />
                        <div className="mt-2 text-lg font-bold text-foreground">
                          {formatUsd(tokenData.marketCapUsd)}
                        </div>
                        <div className="text-xs text-muted-foreground">Market Cap</div>
                      </div>
                      <div className="rounded-lg border bg-card p-4 text-center">
                        <TrendingUp className="mx-auto h-5 w-5 text-gray-400" />
                        <div className="mt-2 text-lg font-bold text-foreground">
                          {formatUsd(tokenData.volume24h)}
                        </div>
                        <div className="text-xs text-muted-foreground">24h Volume</div>
                      </div>
                      <div className="rounded-lg border bg-card p-4 text-center">
                        <Users className="mx-auto h-5 w-5 text-gray-400" />
                        <div className="mt-2 text-lg font-bold text-foreground">
                          {tokenData.holders.toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">Holders</div>
                      </div>
                      <div className="rounded-lg border bg-card p-4 text-center">
                        <Coins className="mx-auto h-5 w-5 text-gray-400" />
                        <div className="mt-2 text-lg font-bold text-foreground">
                          {tokenData.totalSupply.toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">Total Supply</div>
                      </div>
                    </div>

                    {/* Token Info */}
                    <div className="rounded-lg border bg-card p-6">
                      <h3 className="font-semibold text-foreground">
                        Token Details
                      </h3>
                      <dl className="mt-4 space-y-3 text-sm">
                        <div className="flex items-center justify-between">
                          <dt className="text-muted-foreground">Mint Address</dt>
                          <dd className="font-mono text-xs text-foreground">
                            <a
                              href={`https://solscan.io/token/${tokenData.mintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary-600 hover:text-primary-700"
                            >
                              {tokenData.mintAddress.slice(0, 8)}...
                              {tokenData.mintAddress.slice(-6)}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </dd>
                        </div>
                        <div className="flex items-center justify-between">
                          <dt className="text-muted-foreground">Creator</dt>
                          <dd className="font-mono text-xs text-foreground">
                            {tokenData.creatorAddress.slice(0, 8)}...
                            {tokenData.creatorAddress.slice(-6)}
                          </dd>
                        </div>
                        {tokenData.creatorLockupEnd && (
                          <div className="flex items-center justify-between">
                            <dt className="text-muted-foreground">Creator Lockup Until</dt>
                            <dd className="text-foreground">
                              {formatDate(tokenData.creatorLockupEnd)}
                            </dd>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <dt className="text-muted-foreground">Created</dt>
                          <dd className="text-foreground">
                            {formatDate(tokenData.createdAt)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    {/* CTA */}
                    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-6 text-center">
                      <Coins className="mx-auto h-8 w-8 text-cyan-600" />
                      <h3 className="mt-2 font-semibold text-foreground">
                        Trade ${tokenData.symbol}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Sign in and connect your wallet to buy or sell this token
                      </p>
                      <Link
                        href="/login"
                        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-6 py-2.5 font-medium text-white hover:bg-cyan-700"
                      >
                        Sign in to Trade
                      </Link>
                      {tokenData.pumpfunUrl && (
                        <a
                          href={tokenData.pumpfunUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 flex items-center justify-center gap-1 text-sm text-cyan-600 hover:text-cyan-500"
                        >
                          View on pump.fun
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column - Sidebar */}
          <div className="space-y-6">
            {/* Pricing Card */}
            <div className="rounded-lg border bg-card p-6">
              <div className="text-center">
                {hasToken && tokenData ? (
                  <>
                    <div className="flex items-center justify-center gap-2 text-3xl font-bold text-cyan-600">
                      <Coins className="h-6 w-6" />
                      {formatUsd(tokenData.priceUsd)}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      ${tokenData.symbol} token price
                    </p>
                  </>
                ) : (
                  <>
                    <div
                      className={`text-3xl font-bold ${listing.pricingModel === "free" ? "text-green-600" : "text-foreground"}`}
                    >
                      {formatPrice(listing)}
                    </div>
                    {listing.pricingModel !== "free" && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {listing.pricingModel === "per_request"
                          ? "Pay only for what you use"
                          : listing.pricingModel === "tokenized"
                          ? "Free until this agent's token launches, then for token holders"
                          : "Billed monthly"}
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Install CTA (INT-M1) — the buyer conversion */}
              {authed && installState?.installed ? (
                <Link
                  href={
                    installState.clonedAgentId
                      ? `/dashboard/agents/${installState.clonedAgentId}`
                      : "/dashboard/marketplace/installs"
                  }
                  className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-3 font-medium text-white hover:bg-green-700"
                >
                  <CheckCircle className="h-4 w-4" />
                  Installed — Open in Dashboard
                </Link>
              ) : authed ? (
                <button
                  onClick={handleInstall}
                  disabled={installing || installState === null}
                  className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-3 font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Download className="h-4 w-4" />
                  {installing
                    ? isMonthly
                      ? "Subscribing…"
                      : "Installing…"
                    : isMonthly
                    ? `Subscribe · ${monthlyPrice}/month`
                    : "Install Agent"}
                </button>
              ) : (
                <Link
                  href={`/login?next=/marketplace/${slug}`}
                  className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-3 font-medium text-white hover:bg-primary-700"
                >
                  <Play className="h-4 w-4" />
                  Sign in to install
                </Link>
              )}

              {hasToken && (
                <button
                  onClick={() => setActiveTab("token")}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 text-sm font-medium text-cyan-500 hover:bg-cyan-500/10"
                >
                  <Coins className="h-4 w-4" />
                  View Token
                </button>
              )}

              {listing.agent?.slug && listing.agent?.isPublic && (
                <Link
                  href={`/a/${listing.agent.slug}`}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-sm font-medium text-green-500 hover:bg-green-500/10"
                >
                  <ShieldCheck className="h-4 w-4" />
                  On-chain transparency
                </Link>
              )}

              <p className="mt-3 text-center text-xs text-muted-foreground">
                {authed
                  ? installState?.installed
                    ? "Installed as a private copy in your workspace."
                    : isMonthly
                    ? `Charges ${monthlyPrice} from your credits now and every 30 days. Cancel anytime from Installed Agents.`
                    : hasToken
                    ? `Requires at least 1 ${tokenData!.symbol} in a wallet linked to your organization.`
                    : "Installs a private copy of this agent into your workspace."
                  : "Sign in to install this agent to your account."}
              </p>
            </div>

            {/* Stats Card */}
            <div className="rounded-lg border bg-card p-6">
              <h3 className="font-semibold text-foreground">Statistics</h3>
              <dl className="mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Download className="h-4 w-4" />
                    Total Installs
                  </dt>
                  <dd className="font-medium text-foreground">
                    {listing.totalInstalls.toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    Active Users
                  </dt>
                  <dd className="font-medium text-foreground">
                    {listing.activeInstalls.toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Star className="h-4 w-4" />
                    Rating
                  </dt>
                  <dd className="font-medium text-foreground">
                    {listing.avgRating.toFixed(1)} / 5
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    Published
                  </dt>
                  <dd className="font-medium text-foreground">
                    {listing.publishedAt
                      ? formatDate(listing.publishedAt)
                      : "Draft"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Info Card */}
            <div className="rounded-lg border bg-card p-6">
              <h3 className="font-semibold text-foreground">Information</h3>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Category</dt>
                  <dd className="font-medium capitalize text-foreground">
                    {listing.category.replace("-", " ")}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Framework</dt>
                  <dd className="font-medium capitalize text-foreground">
                    {listing.agent?.framework || "Custom"}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Last Updated</dt>
                  <dd className="font-medium text-foreground">
                    {formatDate(listing.updatedAt)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Publisher Card */}
            <div className="rounded-lg border bg-card p-6">
              <h3 className="font-semibold text-foreground">Publisher</h3>
              <div className="mt-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15">
                  <span className="text-sm font-semibold text-primary-600">
                    {listing.publisherName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <div className="font-medium text-foreground">
                    {listing.publisherName}
                  </div>
                  <Link
                    href="/marketplace/leaderboard"
                    className="text-sm text-primary-600 hover:text-primary-700"
                  >
                    Publisher leaderboard
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-12 border-t bg-card py-8">
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
