"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Download,
  Star,
  ExternalLink,
  Trash2,
  Bot,
  MessageSquare,
  MoreVertical,
  Play,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReviewForm } from "@/components/marketplace/review-form";
import { marketplaceApi, type MarketplaceListing } from "@/lib/api";

interface Install {
  id: string;
  listingId: string;
  clonedAgentId: string;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  listing: MarketplaceListing;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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

export default function InstalledAgentsPage() {
  const [installs, setInstalls] = useState<Install[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [reviewingListingId, setReviewingListingId] = useState<string | null>(null);

  useEffect(() => {
    loadInstalls();
  }, []);

  async function loadInstalls() {
    try {
      const { installs } = await marketplaceApi.getMyInstalls();
      setInstalls(installs);
    } catch (error) {
      toast.error("Failed to load installed agents");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUninstall(listingId: string) {
    if (!confirm("Are you sure you want to uninstall this agent?")) return;

    try {
      await marketplaceApi.uninstallAgent(listingId);
      toast.success("Agent uninstalled");
      loadInstalls();
    } catch (error: any) {
      toast.error(error.message || "Failed to uninstall agent");
    }
  }

  const totalSpent = installs.reduce((sum, i) => sum + i.totalSpentCents, 0) / 100;
  const totalRequests = installs.reduce((sum, i) => sum + i.totalRequests, 0);

  return (
    <div className="flex flex-col">
      <Header
        title="Installed Agents"
        description="Manage agents you've installed from the marketplace"
      />

      <div className="p-8">
        {/* Stats */}
        <div className="mb-8 grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Installed Agents</p>
                  <p className="text-2xl font-bold">{installs.length}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                  <Download className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Requests</p>
                  <p className="text-2xl font-bold">{totalRequests.toLocaleString()}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
                  <Play className="h-5 w-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Spent</p>
                  <p className="text-2xl font-bold">${totalSpent.toFixed(2)}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                  <Star className="h-5 w-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Installed Agents List */}
        <Card>
          <CardHeader>
            <CardTitle>My Installed Agents</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
                ))}
              </div>
            ) : installs.length === 0 ? (
              <div className="py-12 text-center">
                <Bot className="mx-auto h-12 w-12 text-gray-300" />
                <h3 className="mt-4 font-semibold text-gray-900">No installed agents</h3>
                <p className="mt-2 text-sm text-gray-500">
                  Browse the marketplace to find agents
                </p>
                <Link href="/marketplace">
                  <Button className="mt-4">Browse Marketplace</Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y">
                {installs.map((install) => (
                  <div key={install.id} className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-primary-100 to-primary-200">
                        <Bot className="h-6 w-6 text-primary-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-gray-900">
                            {install.listing.title}
                          </h3>
                          <Badge variant="secondary">
                            {formatPrice(install.listing)}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-500">
                          by {install.listing.publisherName} &middot; Installed{" "}
                          {formatDate(install.installedAt)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="hidden text-right md:block">
                        <p className="text-sm font-medium text-gray-900">
                          {install.totalRequests.toLocaleString()} requests
                        </p>
                        <p className="text-xs text-gray-500">
                          ${(install.totalSpentCents / 100).toFixed(2)} spent
                        </p>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/dashboard/agents/${install.clonedAgentId}`}>
                              <Bot className="mr-2 h-4 w-4" />
                              View Agent
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link
                              href={`/marketplace/${install.listing.slug}`}
                              target="_blank"
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Listing
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setReviewingListingId(install.listingId)}
                          >
                            <MessageSquare className="mr-2 h-4 w-4" />
                            Write Review
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleUninstall(install.listingId)}
                            className="text-red-600"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Uninstall
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Review Dialog */}
      <Dialog
        open={!!reviewingListingId}
        onOpenChange={() => setReviewingListingId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Write a Review</DialogTitle>
          </DialogHeader>
          {reviewingListingId && (
            <ReviewForm
              listingId={reviewingListingId}
              onSuccess={() => {
                setReviewingListingId(null);
                toast.success("Thank you for your review!");
              }}
              onCancel={() => setReviewingListingId(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
