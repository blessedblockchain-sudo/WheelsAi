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
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ReviewForm } from "@/components/marketplace/review-form";
import {
  marketplaceApi,
  type MarketplaceAcceptedPricing,
  type MarketplaceInstallAccess,
  type MarketplaceInstallKind,
  type MarketplaceLicenceAgent,
  type MarketplaceListing,
  type MarketplaceSubscription,
  ApiError,
  getErrorMessage,
} from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Install {
  id: string;
  listingId: string;
  /** "use": the buyer uses the creator's agent on its page and has no copy. */
  kind: MarketplaceInstallKind;
  /** null for a "use" row: there is no copy to open. */
  clonedAgentId: string | null;
  agent: MarketplaceLicenceAgent;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  access: MarketplaceInstallAccess;
  acceptedPricing: MarketplaceAcceptedPricing;
  listing: MarketplaceListing;
  subscription: MarketplaceSubscription | null;
}

/**
 * Where a row's agent is opened: a copy in the buyer's dashboard, the
 * creator's agent (which a "use" row has no copy of) on its own page. null
 * when there is nowhere to go.
 */
function agentLinkOf(install: Install): string | null {
  if (install.kind === "use") return install.agent.handle ? `/a/${install.agent.handle}` : null;
  return install.clonedAgentId ? `/dashboard/agents/${install.clonedAgentId}` : null;
}

function formatMonthly(cents: number): string {
  return `$${(cents / 100).toFixed(2)}/mo`;
}

/** Whether the listing can still be subscribed to or its pricing accepted. */
function stillSold(install: Install): boolean {
  return install.listing.status === "published";
}

/** Inside a period the buyer already paid for, whatever the listing charges now. */
function paidUp(install: Install): boolean {
  return install.access === "subscribed" && !!install.subscription?.hasAccess;
}

/**
 * One line describing where the install stands. Driven by the access the
 * API reports and the subscription's own agreed price, never by the
 * listing's current pricing model: a publisher can change that while a
 * paid period is still running.
 */
function subscriptionLine(install: Install): { text: string; tone: "ok" | "warn" | "bad" } | null {
  const sub = install.subscription;
  if (install.access === "pricing_changed") {
    if (!stillSold(install)) {
      return { text: "Paused. This agent is no longer sold on the marketplace.", tone: "bad" };
    }
    const agreedTo = agreedPricing(install);
    return {
      text: `The publisher changed this agent's pricing${agreedTo ? ` (you agreed to ${agreedTo}; it is now ${formatPrice(install.listing)})` : ""}. It is paused, and nothing is charged, until you accept the new pricing.`,
      tone: "bad",
    };
  }
  if (install.access === "subscription_lapsed") {
    return stillSold(install)
      ? { text: "Subscription lapsed. Resubscribe to use this agent again.", tone: "bad" }
      : { text: "Subscription ended. This agent is no longer sold on the marketplace.", tone: "bad" };
  }
  if (install.access === "unlisted") {
    return { text: "No longer sold on the marketplace. Your copy keeps running at no charge.", tone: "ok" };
  }
  if (!sub || !paidUp(install)) return null;

  const agreed = sub.priceCents !== null ? ` at ${formatMonthly(sub.priceCents)}` : "";
  if (install.listing.pricingModel !== "monthly") {
    return {
      text: `The publisher changed this agent's pricing. Your subscription${agreed} runs until ${formatDate(sub.currentPeriodEnd)}; after that it pauses until you accept the new pricing.`,
      tone: "warn",
    };
  }
  if (sub.status === "past_due") {
    return {
      text: `Renewal${agreed} failed: add credits before ${formatDate(sub.graceEndsAt ?? sub.currentPeriodEnd)} to keep access.`,
      tone: "warn",
    };
  }
  if (sub.cancelAtPeriodEnd) {
    return { text: `Cancelled. Access ends ${formatDate(sub.currentPeriodEnd)}.`, tone: "warn" };
  }
  if (sub.priceCents === null) {
    return {
      text: `Paid until ${formatDate(sub.currentPeriodEnd)}. You will be asked to confirm the price before it renews.`,
      tone: "warn",
    };
  }
  return { text: `Renews ${formatDate(sub.currentPeriodEnd)}${agreed}`, tone: "ok" };
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

/**
 * What the buyer agreed to when they installed or last accepted a change,
 * in the listing's own wording. Null when nothing is on record, or when a
 * subscription's agreed price says it better (see subscriptionLine).
 */
function agreedPricing(install: Install): string | null {
  const agreed = install.acceptedPricing;
  if (!agreed?.pricingModel || agreed.pricingModel === "monthly") return null;
  return formatPrice({
    ...install.listing,
    pricingModel: agreed.pricingModel,
    pricePerRequestCents: agreed.pricePerRequestCents,
  });
}

/** A subscriber sees the price they agreed to, which is what a renewal charges. */
function priceBadge(install: Install): string {
  const agreed = install.subscription?.priceCents;
  if (paidUp(install) && agreed != null) return formatMonthly(agreed);
  return formatPrice(install.listing);
}

/** Placeholder shaped like one of the three stat cards. */
function StatCardSkeleton() {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-16" />
          </div>
          <Skeleton className="h-10 w-10 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

/** Placeholder shaped like the rows of the installed agents list. */
function InstallRowsSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between py-4">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-48 max-w-full" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="hidden flex-col items-end space-y-2 md:flex">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-10 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function InstalledAgentsPage() {
  const confirmAction = useConfirm();
  const [installs, setInstalls] = useState<Install[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reviewingListingId, setReviewingListingId] = useState<string | null>(null);

  useEffect(() => {
    loadInstalls();
  }, []);

  async function loadInstalls() {
    try {
      const { installs } = await marketplaceApi.getMyInstalls();
      setInstalls(installs);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load installed agents"));
    } finally {
      setIsLoading(false);
    }
  }

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadInstalls();
  }

  // One subscription request per install at a time: a second click while
  // the first is in flight must not send a second subscribe.
  const [busyListingId, setBusyListingId] = useState<string | null>(null);

  async function handleRenewal(
    install: Install,
    action: "cancel" | "resume" | "resubscribe" | "accept_pricing",
  ) {
    if (busyListingId) return;
    if (action === "accept_pricing") {
      const ok = await confirmAction({
        title: `Accept the new pricing for ${install.listing.title}?`,
        description:
          install.listing.pricingModel === "monthly"
            ? `The publisher now charges ${formatPrice(install.listing)}. Accepting starts a new subscription and charges the first month from your credits now.`
            : `The publisher changed this agent's pricing to: ${formatPrice(install.listing)}. Accepting turns your copy back on under that pricing.`,
        confirmLabel: "Accept new pricing",
      });
      if (!ok) return;
    }
    setBusyListingId(install.listingId);
    try {
      if (action === "cancel") {
        await marketplaceApi.cancelSubscription(install.listingId);
        toast.success("Renewal cancelled. You keep access until the end of this period.");
      } else if (action === "resume") {
        await marketplaceApi.resumeSubscription(install.listingId);
        toast.success("Renewal turned back on.");
      } else if (action === "accept_pricing") {
        // The pricing the dialog showed goes with the acceptance: if the
        // publisher moved it again meanwhile, the API refuses (409) and the
        // list reloads with the pricing as it stands.
        await marketplaceApi.installAgent(install.listingId, {
          acceptNewPricing: true,
          expectedPricing: {
            pricingModel: install.listing.pricingModel,
            pricePerRequestCents: install.listing.pricePerRequestCents,
            monthlyPriceCents: install.listing.monthlyPriceCents,
          },
        });
        toast.success(`New pricing accepted for ${install.listing.title}.`);
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
      // A 409 means the state moved under us (already paid up, or repriced).
      if (error instanceof ApiError && error.status === 409) loadInstalls();
    } finally {
      setBusyListingId(null);
    }
  }

  async function handleUninstall(install: Install) {
    const listingId = install.listingId;
    // A paid-up period that uninstalling would give up without a refund.
    const forfeits = paidUp(install) ? install.subscription : null;
    const ok = await confirmAction({
      title: `Uninstall ${install.listing.title}?`,
      description: forfeits
        ? install.listing.pricingModel === "monthly"
          ? `This ends your subscription now, and the current period (paid until ${formatDate(forfeits.currentPeriodEnd)}) is not refunded. To keep access until the period ends, cancel renewal instead.`
          : `You have paid for access until ${formatDate(forfeits.currentPeriodEnd)}. Uninstalling gives that up without a refund, and the publisher has since changed the pricing: reinstalling would be under the new pricing (${formatPrice(install.listing)}).`
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
        title="Installed"
        description="Manage agents you've installed from the marketplace"
      />

      <div className="p-8">
        {loadError !== null ? (
          <ErrorState
            title="Couldn't load installed agents"
            error={loadError}
            onRetry={retryLoad}
          />
        ) : (
          <>
            {/* Stats */}
            {isLoading ? (
              <div className="mb-8 grid gap-4 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <StatCardSkeleton key={i} />
                ))}
              </div>
            ) : (
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
            )}

            {/* Installed Agents List */}
            <Card>
              <CardHeader>
                <CardTitle>Installed agents</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <InstallRowsSkeleton />
                ) : installs.length === 0 ? (
                  <EmptyState
                    icon={Bot}
                    title="No installed agents"
                    description="Browse the marketplace to find agents."
                    actionLabel="Browse the marketplace"
                    actionHref="/marketplace"
                  />
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
                                {priceBadge(install)}
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
                              {agentLinkOf(install) && (
                                <DropdownMenuItem asChild>
                                  <Link href={agentLinkOf(install)!}>
                                    <Bot className="mr-2 h-4 w-4" />
                                    View Agent
                                  </Link>
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem asChild>
                                <Link
                                  href={`/marketplace/${install.listing.slug}`}
                                  target="_blank"
                                >
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  View Listing
                                </Link>
                              </DropdownMenuItem>
                              {install.access === "pricing_changed" && stillSold(install) && (
                                <DropdownMenuItem
                                  disabled={busyListingId !== null}
                                  onClick={() => handleRenewal(install, "accept_pricing")}
                                >
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                  Accept new pricing
                                </DropdownMenuItem>
                              )}
                              {install.access === "subscription_lapsed" && stillSold(install) && (
                                <DropdownMenuItem
                                  disabled={busyListingId !== null}
                                  onClick={() => handleRenewal(install, "resubscribe")}
                                >
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                  Resubscribe
                                </DropdownMenuItem>
                              )}
                              {paidUp(install) &&
                                install.listing.pricingModel === "monthly" &&
                                (install.subscription?.cancelAtPeriodEnd ? (
                                  <DropdownMenuItem
                                    disabled={busyListingId !== null}
                                    onClick={() => handleRenewal(install, "resume")}
                                  >
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                    Resume renewal
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    disabled={busyListingId !== null}
                                    onClick={() => handleRenewal(install, "cancel")}
                                  >
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
          </>
        )}
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
