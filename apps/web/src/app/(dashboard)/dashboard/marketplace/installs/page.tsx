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
  RefreshCw,
  XCircle,
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
import {
  marketplaceApi,
  type MarketplaceListing,
  type MarketplaceSubscription,
  ApiError,
  getErrorMessage,
} from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Install {
  id: string;
  listingId: string;
  clonedAgentId: string;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  listing: MarketplaceListing;
  subscription: MarketplaceSubscription | null;
}

/** One line describing where a monthly subscription stands. */
function subscriptionLine(install: Install): { text: string; tone: "ok" | "warn" | "bad" } | null {
  const sub = install.subscription;
  if (install.listing.pricingModel !== "monthly") return null;
  if (install.status === "suspended" || !sub || !sub.hasAccess) {
    return { text: "Subscription lapsed. Resubscribe to use this agent again.", tone: "bad" };
  }
  if (sub.status === "past_due") {
    return {
      text: `Renewal failed: add credits before ${formatDate(sub.graceEndsAt ?? sub.currentPeriodEnd)} to keep access.`,
      tone: "warn",
    };
  }
  if (sub.cancelAtPeriodEnd) {
    return { text: `Cancelled. Access ends ${formatDate(sub.currentPeriodEnd)}.`, tone: "warn" };
  }
  return { text: `Renews ${formatDate(sub.currentPeriodEnd)}`, tone: "ok" };
}

const TONE_CLASS = {
  ok: "text-muted-foreground",
  warn: "text-amber-500",
  bad: "text-red-500",
} as const;

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
  const confirmAction = useConfirm();
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
      toast.error(getErrorMessage(error, "Failed to load installed agents"));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRenewal(install: Install, action: "cancel" | "resume" | "resubscribe") {
    try {
      if (action === "cancel") {
        await marketplaceApi.cancelSubscription(install.listingId);
        toast.success("Renewal cancelled. You keep access until the end of this period.");
      } else if (action === "resume") {
        await marketplaceApi.resumeSubscription(install.listingId);
        toast.success("Renewal turned back on.");
      } else {
        await marketplaceApi.installAgent(install.listingId);
        toast.success(`Resubscribed to ${install.listing.title}.`);
      }
      loadInstalls();
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        toast.error(getErrorMessage(error, "Not enough credits"), {
          action: { label: "Add credits", onClick: () => (window.location.href = "/dashboard/billing") },
        });
        return;
      }
      toast.error(getErrorMessage(error, "Could not update the subscription"));
    }
  }

  async function handleUninstall(install: Install) {
    const listingId = install.listingId;
    const paidUp = install.listing.pricingModel === "monthly" && install.subscription?.hasAccess;
    const ok = await confirmAction({
      title: `Uninstall ${install.listing.title}?`,
      description: paidUp
        ? "This ends your subscription now, and the current period is not refunded. To keep access until the period ends, cancel renewal instead."
        : "Its copy in your workspace stops working. You can reinstall it later.",
      confirmLabel: "Uninstall",
      destructive: true,
    });
    if (!ok) return;

    try {
      await marketplaceApi.uninstallAgent(listingId);
      toast.success("Agent uninstalled");
      loadInstalls();
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to uninstall agent"));
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
                  <p className="text-sm text-muted-foreground">Installed Agents</p>
                  <p className="text-2xl font-bold">{installs.length}</p>
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
                  <p className="text-sm text-muted-foreground">Total Requests</p>
                  <p className="text-2xl font-bold">{totalRequests.toLocaleString()}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
                  <Play className="h-5 w-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Spent</p>
                  <p className="text-2xl font-bold">${totalSpent.toFixed(2)}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
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
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : installs.length === 0 ? (
              <div className="py-12 text-center">
                <Bot className="mx-auto h-12 w-12 text-gray-300" />
                <h3 className="mt-4 font-semibold text-foreground">No installed agents</h3>
                <p className="mt-2 text-sm text-muted-foreground">
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
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/25">
                        <Bot className="h-6 w-6 text-primary-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-foreground">
                            {install.listing.title}
                          </h3>
                          <Badge variant="secondary">
                            {formatPrice(install.listing)}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          by {install.listing.publisherName} &middot; Installed{" "}
                          {formatDate(install.installedAt)}
                        </p>
                        {(() => {
                          const line = subscriptionLine(install);
                          return line ? (
                            <p className={`text-xs ${TONE_CLASS[line.tone]}`}>{line.text}</p>
                          ) : null;
                        })()}
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="hidden text-right md:block">
                        <p className="text-sm font-medium text-foreground">
                          {install.totalRequests.toLocaleString()} requests
                        </p>
                        <p className="text-xs text-muted-foreground">
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
                          {install.listing.pricingModel === "monthly" &&
                            (install.status === "suspended" || !install.subscription?.hasAccess ? (
                              <DropdownMenuItem onClick={() => handleRenewal(install, "resubscribe")}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                Resubscribe
                              </DropdownMenuItem>
                            ) : install.subscription.cancelAtPeriodEnd ? (
                              <DropdownMenuItem onClick={() => handleRenewal(install, "resume")}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                Resume renewal
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => handleRenewal(install, "cancel")}>
                                <XCircle className="mr-2 h-4 w-4" />
                                Cancel renewal
                              </DropdownMenuItem>
                            ))}
                          <DropdownMenuItem
                            onClick={() => setReviewingListingId(install.listingId)}
                          >
                            <MessageSquare className="mr-2 h-4 w-4" />
                            Write Review
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleUninstall(install)}
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
