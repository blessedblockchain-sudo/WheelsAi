"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Trophy,
  Medal,
  Crown,
  Users,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { reputationApi, type LeaderboardEntry } from "@/lib/api";
import {
  ReputationScore,
  ReputationTierBadge,
} from "@/components/reputation/reputation-score";
import { ReputationBadgeList } from "@/components/reputation/reputation-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder shaped like one of the four stat cards in the header. */
function StatCardSkeleton() {
  return (
    <div className="bg-card rounded-lg p-4 border">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="mt-1 h-8 w-12" />
    </div>
  );
}

/** Placeholder shaped like one publisher row: rank, avatar, info, score, link. */
function PublisherRowSkeleton() {
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-center gap-4">
        <div className="flex-shrink-0 w-12">
          <Skeleton className="mx-auto h-8 w-8" />
        </div>
        <Skeleton className="h-12 w-12 flex-shrink-0 rounded-full" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="flex-shrink-0 space-y-1">
          <Skeleton className="ml-auto h-8 w-10" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="h-9 w-9 flex-shrink-0 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * The publisher leaderboard itself, without a page frame: the public page
 * draws it inside the marketplace header and footer, the dashboard page
 * inside the menu and the Listings tab bar.
 */
export function Leaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [stats, setStats] = useState<{
    totalPublishers: number;
    averageScore: number;
    tierDistribution: Record<string, number>;
  } | null>(null);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (selectedTier) {
      loadTierPublishers(selectedTier);
    } else {
      loadData();
    }
  }, [selectedTier]);

  async function loadData() {
    setLoading(true);
    try {
      const [leaderboardRes, statsRes] = await Promise.all([
        reputationApi.getLeaderboard(20),
        reputationApi.getStats(),
      ]);
      setLeaderboard(leaderboardRes.data);
      setStats(statsRes.data);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to load leaderboard:", error);
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }

  async function loadTierPublishers(tier: string) {
    setLoading(true);
    try {
      const res = await reputationApi.getPublishersByTier(tier, 20);
      setLeaderboard(res.data);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to load tier publishers:", error);
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }

  // Re-runs whichever load the current tier filter uses.
  function retryLoad() {
    setLoadError(null);
    if (selectedTier) {
      loadTierPublishers(selectedTier);
    } else {
      loadData();
    }
  }

  const tiers = [
    { id: "platinum", label: "Platinum", color: "bg-cyan-500/20 text-cyan-400" },
    { id: "gold", label: "Gold", color: "bg-yellow-500/20 text-yellow-400" },
    { id: "silver", label: "Silver", color: "bg-gray-400/20 text-gray-300" },
    { id: "bronze", label: "Bronze", color: "bg-orange-500/20 text-orange-400" },
  ];
  const selectedTierLabel = tiers.find((t) => t.id === selectedTier)?.label;

  return (
    <div className="bg-background">
      {/* Header */}
      <div className="border-b bg-card/50">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-yellow-500/20 rounded-lg">
              <Trophy className="h-8 w-8 text-yellow-500" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Leaderboard</h1>
              <p className="text-muted-foreground">
                Top rated publishers on WheelsAI Marketplace
              </p>
            </div>
          </div>

          {/* Stats */}
          {!stats && loading && selectedTier === null && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <StatCardSkeleton key={i} />
              ))}
            </div>
          )}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              <div className="bg-card rounded-lg p-4 border">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Users className="h-4 w-4" />
                  <span className="text-sm">Total Publishers</span>
                </div>
                <div className="text-2xl font-bold">{stats.totalPublishers}</div>
              </div>
              <div className="bg-card rounded-lg p-4 border">
                <div className="text-sm text-muted-foreground mb-1">
                  Average Score
                </div>
                <div className="text-2xl font-bold">
                  {Math.round(stats.averageScore)}
                </div>
              </div>
              {tiers.slice(0, 2).map((tier) => (
                <div key={tier.id} className="bg-card rounded-lg p-4 border">
                  <div className="text-sm text-muted-foreground mb-1">
                    {tier.label} Publishers
                  </div>
                  <div className="text-2xl font-bold">
                    {stats.tierDistribution[tier.id] || 0}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tier Filter */}
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setSelectedTier(null)}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              selectedTier === null
                ? "bg-primary text-primary-foreground"
                : "bg-card border hover:bg-accent"
            }`}
          >
            All
          </button>
          {tiers.map((tier) => (
            <button
              key={tier.id}
              onClick={() => setSelectedTier(tier.id)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                selectedTier === tier.id
                  ? tier.color + " border"
                  : "bg-card border hover:bg-accent"
              }`}
            >
              {tier.label}
            </button>
          ))}
        </div>

        {/* Leaderboard Table */}
        {loading ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <PublisherRowSkeleton key={i} />
            ))}
            <span className="sr-only">Loading publishers</span>
          </div>
        ) : loadError !== null ? (
          <ErrorState
            title="Couldn't load the leaderboard"
            error={loadError}
            onRetry={retryLoad}
          />
        ) : leaderboard.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No publishers found"
            description={
              selectedTierLabel
                ? `There are no ${selectedTierLabel} publishers right now.`
                : "There are no publishers on the leaderboard right now."
            }
            actionLabel={selectedTier ? "Show all publishers" : "Browse the marketplace"}
            actionHref={selectedTier ? undefined : "/marketplace"}
            onAction={selectedTier ? () => setSelectedTier(null) : undefined}
          />
        ) : (
          <div className="space-y-3">
            {leaderboard.map((publisher, index) => (
              <div
                key={publisher.orgId}
                className="bg-card border rounded-lg p-4 hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center gap-4">
                  {/* Rank */}
                  <div className="flex-shrink-0 w-12 text-center">
                    {index === 0 && !selectedTier ? (
                      <Crown className="h-8 w-8 text-yellow-500 mx-auto" />
                    ) : index === 1 && !selectedTier ? (
                      <Medal className="h-8 w-8 text-gray-300 mx-auto" />
                    ) : index === 2 && !selectedTier ? (
                      <Medal className="h-8 w-8 text-orange-400 mx-auto" />
                    ) : (
                      <span className="text-2xl font-bold text-muted-foreground">
                        #{index + 1}
                      </span>
                    )}
                  </div>

                  {/* Avatar */}
                  <div className="flex-shrink-0">
                    {publisher.avatarUrl ? (
                      <img
                        src={publisher.avatarUrl}
                        alt={publisher.displayName}
                        className="w-12 h-12 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-xl font-bold">
                        {publisher.displayName.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">
                        {publisher.displayName}
                      </h3>
                      {publisher.isVerified && (
                        <span className="text-blue-500">
                          <svg
                            className="h-4 w-4"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </span>
                      )}
                      <ReputationTierBadge tier={publisher.reputationTier} size="sm" />
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                      <span>{publisher.totalListings} agents</span>
                      <span>{publisher.totalInstalls} installs</span>
                    </div>
                    {publisher.badges.length > 0 && (
                      <div className="mt-2">
                        <ReputationBadgeList
                          badges={publisher.badges}
                          size="sm"
                          maxShow={5}
                        />
                      </div>
                    )}
                  </div>

                  {/* Score */}
                  <div className="flex-shrink-0 text-right">
                    <div className="text-2xl font-bold">
                      {Math.round(publisher.reputationScore)}
                    </div>
                    <div className="text-sm text-muted-foreground">points</div>
                  </div>

                  {/* Link */}
                  <Link
                    href={`/marketplace?publisher=${publisher.slug}`}
                    className="flex-shrink-0 p-2 hover:bg-accent rounded-lg transition-colors"
                  >
                    <ArrowRight className="h-5 w-5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
