"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpCircle,
  Download,
  Star,
  ExternalLink,
  Trash2,
  Bot,
  MessageSquare,
  MoreVertical,
  Play,
  RefreshCw,
  Workflow,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ReviewForm } from "@/components/marketplace/review-form";
import { marketplaceApi, ApiError, getErrorMessage, type PlanOffer } from "@/lib/api";
import { INSTALLED_PLAN_WORDS, moveUpChoice, moveUpConfirm, moveUpRefusal, movedLine } from "@/lib/installed-plans";
import {
  INSTALLED_PAGE_WORDS,
  INSTALLED_WORKFLOW_WORDS,
  askAdminOnce,
  installedConfirm,
  installedRow,
  licenceProductKind,
  type InstalledAction,
  type InstalledActionId,
  type InstalledLicence,
} from "@/lib/installed-rows";
import { USAGE_HREF, USAGE_WORDS } from "@/lib/usage-view";
import { useConfirm } from "@/components/ui/confirm-dialog";

/** A row of Installed: an agent or a workflow the organization uses, or a copy it owns. */
type Install = InstalledLicence;

type RenewalAction = Extract<InstalledActionId, "cancel" | "resume" | "resubscribe" | "accept_pricing">;

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

const ACTION_ICON: Record<InstalledActionId, typeof Bot> = {
  open: Bot,
  view_listing: ExternalLink,
  accept_pricing: RefreshCw,
  resubscribe: RefreshCw,
  move_up: ArrowUpCircle,
  resume: RefreshCw,
  cancel: XCircle,
  review: MessageSquare,
  uninstall: Trash2,
};

/** The way to add credits, offered with a refusal for too few of them. */
const ADD_CREDITS = { label: "Add credits", onClick: () => (window.location.href = "/dashboard/billing") };

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
  // Whether the person may start, move up or resume, as the API says it beside the rows. Only a clear
  // "no" changes the page: until it is known, and from an API that does not say, the rows are what
  // they have always been.
  const [canSpend, setCanSpend] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    loadInstalls();
  }, []);

  async function loadInstalls() {
    try {
      const { installs, canSpend } = await marketplaceApi.getMyInstalls();
      // Every row: an agent's, a workflow's (which has no agent: lib/installed-rows.ts opens it at /w/<slug>)
      // and a copy's.
      setInstalls(installs);
      setCanSpend(canSpend);
      // Someone who may not spend is offered no bigger plan: a list of them left open closes.
      if (canSpend === false) setChoosingFor(null);
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

  async function handleRenewal(install: Install, action: RenewalAction) {
    if (busyListingId) return;
    const using = install.kind === "use";
    // The pricing this row shows. It is what the dialog names and what goes
    // with the acceptance: if the publisher moved it again meanwhile, the API
    // refuses (409) and the list reloads with the pricing as it stands.
    const { terms } = installedRow(install);
    const dialog = installedConfirm(install, action);
    // Agreeing to a price for use is always a click on a button that names it.
    if (using && (action === "accept_pricing" || action === "resubscribe") && !dialog) return;
    if (dialog) {
      const ok = await confirmAction(dialog);
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
      } else if (using) {
        // Use of the creator's agent: the install route refuses it. No copy is made.
        await marketplaceApi.startUsing(install.listingId, {
          expected: terms,
          ...(action === "accept_pricing" ? { acceptNewPricing: true } : {}),
        });
        toast.success(
          action === "accept_pricing"
            ? `New price accepted for ${install.listing.title}.`
            : `Subscribed to ${install.listing.title} again.`,
        );
      } else if (action === "accept_pricing") {
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
        toast.error(getErrorMessage(error, "Not enough credits"), { action: ADD_CREDITS });
        return;
      }
      // The API's own sentence when it gives one (a changed price, a copy
      // whose month is still paid for, a member who may not agree to a price).
      toast.error(getErrorMessage(error, "Could not update the subscription"));
      // A 409 means the state moved under us (already paid up, or repriced).
      // For use, a 404 says the listing left the marketplace meanwhile.
      if (error instanceof ApiError && (error.status === 409 || (using && error.status === 404))) loadInstalls();
    } finally {
      setBusyListingId(null);
    }
  }

  // Moving up. The row whose bigger plans are listed: read from `installs` each time it is drawn, so
  // once the rows are read again the dialog lists the plans as they are now, or closes when the row
  // is no longer on a plan.
  const [choosingFor, setChoosingFor] = useState<string | null>(null);
  const choosing = installs.find((install) => install.listingId === choosingFor) ?? null;
  const choice = choosing ? moveUpChoice(choosing) : null;
  // One move at a time, from the press of a card to the API's answer: a second press does nothing.
  const moving = useRef(false);

  async function handleMoveUp(install: Install, offer: PlanOffer) {
    if (moving.current || busyListingId) return;
    // The words of the confirm and the terms that are sent are taken here, once, from the card that
    // was pressed: what is sent is what the dialog named, whatever is read meanwhile.
    const dialog = moveUpConfirm(install, offer);
    if (!dialog) return;
    const { terms, ...asked } = dialog;
    moving.current = true;
    try {
      setChoosingFor(null);
      const ok = await confirmAction(asked);
      if (!ok) return;
      setBusyListingId(install.listingId);
      try {
        await marketplaceApi.movePlan(install.listingId, terms);
        toast.success(movedLine(offer));
      } catch (error) {
        // The API's own sentence as it comes: the plan changed, too few credits, not a bigger plan,
        // a change that got there first, a member who may not spend. Nothing was charged.
        const answered = error instanceof ApiError;
        const refusal = moveUpRefusal(answered ? error.status : 0, answered ? getErrorMessage(error, "") : null);
        toast.error(refusal.message, refusal.addCredits ? { action: ADD_CREDITS } : undefined);
      } finally {
        // After a move and after a refusal alike, the row and the plans on offer are read again. The row
        // stays held until that read is in, so nothing can be pressed on the plan it has just left.
        await loadInstalls();
        setBusyListingId(null);
      }
    } finally {
      moving.current = false;
    }
  }

  async function handleUninstall(install: Install) {
    const using = install.kind === "use";
    const dialog = installedConfirm(install, "uninstall");
    if (!dialog) return;
    const ok = await confirmAction(dialog);
    if (!ok) return;

    try {
      // Stopping use and removing a copy are the same route.
      await marketplaceApi.uninstallAgent(install.listingId);
      toast.success(using ? `You no longer use ${install.listing.title}.` : "Agent uninstalled");
      loadInstalls();
    } catch (error: any) {
      const fallback = !using
        ? "Failed to uninstall agent"
        : licenceProductKind(install) === "workflow"
          ? INSTALLED_WORKFLOW_WORDS.stopFailed
          : "Could not stop using this agent";
      toast.error(getErrorMessage(error, fallback));
    }
  }

  function runAction(install: Install, action: InstalledAction) {
    if (action.id === "review") setReviewingListingId(install.listingId);
    else if (action.id === "uninstall") void handleUninstall(install);
    else if (action.id === "move_up") setChoosingFor(install.listingId);
    else if (
      action.id === "cancel" ||
      action.id === "resume" ||
      action.id === "resubscribe" ||
      action.id === "accept_pricing"
    ) {
      void handleRenewal(install, action.id);
    }
  }

  // Each row as it is drawn for this person, and the one sentence for a member whose rows hold
  // back moving up or resuming a renewal.
  const rows = installs.map((install) => ({ install, row: installedRow(install, {}, { canSpend }) }));
  const askAdmin = askAdminOnce(rows.map(({ row }) => row));
  // The review dialog names what the licence is for: "this workflow" on a workflow's row.
  const reviewing = installs.find((install) => install.listingId === reviewingListingId);
  const reviewingSubject = reviewing ? licenceProductKind(reviewing) : "agent";

  const totalSpent = installs.reduce((sum, i) => sum + i.totalSpentCents, 0) / 100;
  const totalRequests = installs.reduce((sum, i) => sum + i.totalRequests, 0);

  return (
    <div className="flex flex-col">
      <Header
        title="Installed"
        description={INSTALLED_PAGE_WORDS.header}
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
                        <p className="text-sm text-muted-foreground">{INSTALLED_PAGE_WORDS.count}</p>
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
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle>{INSTALLED_PAGE_WORDS.listTitle}</CardTitle>
                <Link href={USAGE_HREF} className="text-sm text-primary underline-offset-4 hover:underline">
                  {USAGE_WORDS.linkLabel}
                </Link>
              </CardHeader>
              <CardContent>
                {/* Said once, to a member whose rows hold back moving up or resuming a renewal */}
                {askAdmin && <p className="mb-2 text-sm text-muted-foreground">{askAdmin}</p>}
                {isLoading ? (
                  <InstallRowsSkeleton />
                ) : installs.length === 0 ? (
                  <EmptyState
                    icon={Bot}
                    title="No agents yet"
                    description="Browse the marketplace to find agents to use or install."
                    actionLabel="Browse the marketplace"
                    actionHref="/marketplace"
                  />
                ) : (
                  <div className="divide-y">
                    {rows.map(({ install, row }) => {
                      // A workflow's row has its own icon, and does not name who sells it.
                      const workflow = licenceProductKind(install) === "workflow";
                      return (
                        <div key={install.id} className="flex items-center justify-between gap-4 py-4">
                          <div className="flex min-w-0 items-center gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/25">
                              {workflow ? (
                                <Workflow className="h-6 w-6 text-primary-600" aria-hidden="true" />
                              ) : (
                                <Bot className="h-6 w-6 text-primary-600" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium text-foreground">{install.listing.title}</h3>
                                <Badge variant={row.kind === "use" ? "default" : "outline"}>{row.badge}</Badge>
                                <Badge variant="secondary">{row.priceLabel}</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {!workflow && <>by {install.listing.publisherName} &middot; </>}
                                {row.kind === "use" ? "Started" : "Installed"} {formatDate(install.installedAt)}
                              </p>
                              {row.line && <p className={`text-xs ${TONE_CLASS[row.line.tone]}`}>{row.line.text}</p>}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-4">
                            {row.usage && (
                              <div className="hidden text-right md:block">
                                <p className="text-sm font-medium text-foreground">{row.usage.count}</p>
                                <p className="text-xs text-muted-foreground">{row.usage.spent}</p>
                              </div>
                            )}

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Actions for ${install.listing.title}`}
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {row.actions.map((action) => {
                                  const Icon = ACTION_ICON[action.id];
                                  if (action.href) {
                                    return (
                                      <DropdownMenuItem key={action.id} asChild>
                                        <Link href={action.href} {...(action.newTab ? { target: "_blank" } : {})}>
                                          <Icon className="mr-2 h-4 w-4" />
                                          {action.label}
                                        </Link>
                                      </DropdownMenuItem>
                                    );
                                  }
                                  const waits = action.id !== "review" && action.id !== "uninstall";
                                  return (
                                    <DropdownMenuItem
                                      key={action.id}
                                      disabled={waits && busyListingId !== null}
                                      onClick={() => runAction(install, action)}
                                      className={action.destructive ? "text-red-600" : undefined}
                                    >
                                      <Icon className="mr-2 h-4 w-4" />
                                      {action.label}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Moving up: the bigger plans to choose from. Pressing one asks once more before it charges. */}
      <Dialog
        open={choice !== null}
        onOpenChange={(open) => {
          if (!open) setChoosingFor(null);
        }}
      >
        <DialogContent>
          {choosing && choice && (
            <>
              <DialogHeader>
                <DialogTitle>{choice.title}</DialogTitle>
                <DialogDescription>
                  {choice.cards.length > 0 ? choice.intro : INSTALLED_PLAN_WORDS.noneBigger}
                </DialogDescription>
              </DialogHeader>
              <ul className="space-y-3">
                {choice.cards.map((card) => (
                  <li key={card.id} className="flex items-center justify-between gap-4 rounded-lg border p-4">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{card.name}</p>
                      <p className="text-sm text-muted-foreground">{card.price}</p>
                      <p className="text-sm text-muted-foreground">
                        {card.uses}, {card.after}
                      </p>
                    </div>
                    <Button
                      type="button"
                      aria-label={card.moveLabel}
                      disabled={busyListingId !== null}
                      onClick={() => void handleMoveUp(choosing, card.offer)}
                    >
                      {INSTALLED_PLAN_WORDS.moveUp}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </DialogContent>
      </Dialog>

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
              subject={reviewingSubject}
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
