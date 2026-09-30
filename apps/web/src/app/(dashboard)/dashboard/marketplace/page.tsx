"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Store,
  Plus,
  Eye,
  Edit,
  Archive,
  MoreVertical,
  Star,
  Download,
  ExternalLink,
  TrendingUp,
  Package,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { marketplaceApi, type MarketplaceListing, getErrorMessage } from "@/lib/api";

type RevenueSummary = Pick<
  Awaited<ReturnType<typeof marketplaceApi.getRevenue>>,
  "totalRevenueCents" | "pendingPayoutCents" | "totalInstalls" | "revenueByListing"
>;
import { cn } from "@/lib/utils";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  published: "success",
  pending_review: "warning",
  draft: "secondary",
  archived: "destructive",
};

const statusLabels: Record<string, string> = {
  published: "Published",
  pending_review: "Pending Review",
  draft: "Draft",
  archived: "Archived",
};

function formatPrice(listing: MarketplaceListing): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") return "Token Gated";
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

export default function MarketplaceDashboardPage() {
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);

  useEffect(() => {
    loadListings();
  }, []);

  async function loadListings() {
    try {
      marketplaceApi
        .getRevenue()
        .then(setRevenue)
        .catch(() =>
          setRevenue({ totalRevenueCents: 0, pendingPayoutCents: 0, totalInstalls: 0, revenueByListing: [] })
        );
      const { listings } = await marketplaceApi.getMyListings();
      setListings(listings);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load listings"));
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePublish(listingId: string) {
    try {
      await marketplaceApi.publishListing(listingId);
      toast.success("Listing published successfully");
      loadListings();
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to publish listing"));
    }
  }

  async function handleArchive(listingId: string) {
    try {
      await marketplaceApi.archiveListing(listingId);
      toast.success("Listing archived");
      loadListings();
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to archive listing"));
    }
  }

  const publishedCount = listings.filter((l) => l.status === "published").length;
  const draftCount = listings.filter((l) => l.status === "draft").length;
  const totalInstalls = listings.reduce((sum, l) => sum + l.totalInstalls, 0);
  const avgRating =
    listings.length > 0
      ? listings.reduce((sum, l) => sum + l.avgRating, 0) / listings.length
      : 0;

  return (
    <div className="flex flex-col">
      <Header
        title="Marketplace"
        description="Publish and manage your agents on the marketplace"
        action={{ label: "Publish Agent", href: "/dashboard/marketplace/publish" }}
      />

      <div className="p-8">
        {/* Quick Links */}
        <div className="mb-6 flex gap-4">
          <Link
            href="/dashboard/marketplace/installs"
            className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Package className="h-4 w-4" />
            My Installed Agents
          </Link>
          <Link
            href="/marketplace"
            target="_blank"
            className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <ExternalLink className="h-4 w-4" />
            Browse Marketplace
          </Link>
        </div>

        {/* Stats */}
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Published</p>
                  <p className="text-2xl font-bold">{publishedCount}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                  <Store className="h-5 w-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Drafts</p>
                  <p className="text-2xl font-bold">{draftCount}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <Edit className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Installs</p>
                  <p className="text-2xl font-bold">{totalInstalls.toLocaleString()}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                  <Download className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg Rating</p>
                  <p className="text-2xl font-bold">{avgRating.toFixed(1)}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                  <Star className="h-5 w-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Listings */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>My Listings</CardTitle>
              <Link href="/dashboard/marketplace/publish">
                <Button size="sm">
                  <Plus className="mr-2 h-4 w-4" />
                  New Listing
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : listings.length === 0 ? (
              <div className="py-12 text-center">
                <Store className="mx-auto h-12 w-12 text-gray-300" />
                <h3 className="mt-4 font-semibold text-foreground">No listings yet</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Publish your first agent to the marketplace
                </p>
                <Link href="/dashboard/marketplace/publish">
                  <Button className="mt-4">
                    <Plus className="mr-2 h-4 w-4" />
                    Publish Agent
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y">
                {listings.map((listing) => (
                  <div
                    key={listing.id}
                    className="flex items-center justify-between py-4"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/25">
                        <Store className="h-6 w-6 text-primary-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-foreground">
                            {listing.title}
                          </h3>
                          <Badge variant={statusColors[listing.status]}>
                            {statusLabels[listing.status]}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {listing.category.replace("-", " ")} &middot;{" "}
                          {formatPrice(listing)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="hidden text-right md:block">
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Download className="h-4 w-4" />
                            {listing.totalInstalls}
                          </span>
                          <span className="flex items-center gap-1">
                            <Star className="h-4 w-4" />
                            {listing.avgRating.toFixed(1)}
                          </span>
                        </div>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {listing.status === "published" && (
                            <DropdownMenuItem asChild>
                              <Link
                                href={`/marketplace/${listing.slug}`}
                                target="_blank"
                              >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                View Public Page
                              </Link>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem asChild>
                            <Link
                              href={`/dashboard/marketplace/publish?edit=${listing.id}`}
                            >
                              <Edit className="mr-2 h-4 w-4" />
                              Edit Listing
                            </Link>
                          </DropdownMenuItem>
                          {listing.status === "draft" && (
                            <DropdownMenuItem
                              onClick={() => handlePublish(listing.id)}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              Publish
                            </DropdownMenuItem>
                          )}
                          {listing.status === "published" && (
                            <DropdownMenuItem
                              onClick={() => handleArchive(listing.id)}
                              className="text-red-600"
                            >
                              <Archive className="mr-2 h-4 w-4" />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Revenue overview: settled earnings from the ledger */}
        {publishedCount > 0 && (
          <Card className="mt-8">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Revenue Overview
              </CardTitle>
              <Link
                href="/dashboard/marketplace/revenue"
                className="text-sm font-medium text-primary hover:underline"
              >
                Revenue &amp; payouts
              </Link>
            </CardHeader>
            <CardContent>
              {revenue === null ? (
                <div className="h-16 animate-pulse rounded-lg bg-muted" />
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-sm text-muted-foreground">Total earned</p>
                      <p className="font-mono text-2xl font-semibold tabular-nums">
                        ${(revenue.totalRevenueCents / 100).toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Available to pay out</p>
                      <p className="font-mono text-2xl font-semibold tabular-nums">
                        ${(revenue.pendingPayoutCents / 100).toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Installs</p>
                      <p className="font-mono text-2xl font-semibold tabular-nums">
                        {revenue.totalInstalls.toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {revenue.revenueByListing.length > 0 && (
                    <div className="mt-6 divide-y border-t">
                      {revenue.revenueByListing.slice(0, 5).map((row) => (
                        <div key={row.listingId} className="flex items-center justify-between py-2 text-sm">
                          <span className="truncate text-foreground">
                            {row.listing?.title ?? "Archived listing"}
                          </span>
                          <span className="font-mono tabular-nums text-muted-foreground">
                            ${(row.totalRevenueCents / 100).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground">
                    You keep 90% of what buyers pay, less any shares you give contributors.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
