"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  DollarSign,
  TrendingUp,
  Download,
  Store,
  CreditCard,
  Wallet,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  ArrowRight,
  Ban,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorCode, capabilitiesApi, marketplaceApi, getErrorMessage } from "@/lib/api";
import {
  EARNINGS_WORDS,
  PAYOUTS_UNAVAILABLE_CODE,
  PAYOUTS_UNAVAILABLE_MESSAGE,
  PAYOUT_IN_PROGRESS_CODE,
  PAYOUT_METHOD_LABELS,
  PAYOUT_NOT_CANCELLABLE_CODE,
  cancelPayoutDescription,
  defaultAmountText,
  defaultPayoutMethod,
  formatCents,
  payoutCancelledMessage,
  payoutDialog,
  payoutRefusal,
  payoutRequest,
  payoutRequestedMessage,
  payoutRow,
  payoutSubmission,
  readPayoutLimits,
  revenueRow,
  type PayoutMethod,
  type PayoutRefusal,
} from "@/lib/earnings";
import { ContributionsCard } from "@/components/marketplace/contributions-card";
import { EscrowBadge } from "@/components/marketplace/escrow-badge";
import { JOBS_RECEIVED_HREF, JOBS_TAB_PARAM, JOBS_TAB_RECEIVED } from "@/lib/nav";
import { cn } from "@/lib/utils";

// The one shape the API client declares, so a field added there reaches this page.
type RevenueData = Awaited<ReturnType<typeof marketplaceApi.getRevenue>>;

type Payout = Awaited<ReturnType<typeof marketplaceApi.getPayoutHistory>>["payouts"][number];

function formatCurrency(cents: number): string {
  return formatCents(cents);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const payoutMethodLabels: Record<string, string> = PAYOUT_METHOD_LABELS;

/** Placeholder shaped like the loaded page: stats, payout CTA, two lists, transactions table. */
function RevenuePageSkeleton() {
  return (
    <>
      <div className="mb-8 grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-7 w-20" />
                </div>
                <Skeleton className="h-10 w-10 rounded-lg" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mb-8">
        <CardContent className="py-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-36 max-w-full" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            <Skeleton className="h-10 w-40 shrink-0" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-8 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="h-16 w-full rounded-lg" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-8">
        <CardHeader>
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-60 max-w-full" />
        </CardHeader>
        <CardContent>
          <SkeletonTable rows={5} cols={7} />
        </CardContent>
      </Card>
    </>
  );
}

export default function RevenueDashboardPage() {
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [payoutHistory, setPayoutHistory] = useState<Payout[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [showPayoutDialog, setShowPayoutDialog] = useState(false);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod | null>(null);
  const [payoutAmount, setPayoutAmount] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  // What the dialog was last refused for, and the field it is about. Any edit clears it.
  const [refusal, setRefusal] = useState<PayoutRefusal | null>(null);
  // The API's sentence for the payout just requested.
  const [requestedMessage, setRequestedMessage] = useState<string | null>(null);
  const [isRequestingPayout, setIsRequestingPayout] = useState(false);
  // Whether payouts are running now; null until read, and when it could not be read.
  const [payoutsAvailable, setPayoutsAvailable] = useState<boolean | null>(null);
  const [payoutToCancel, setPayoutToCancel] = useState<Payout | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [revenueData, payoutsData, capabilities] = await Promise.all([
        marketplaceApi.getRevenue(),
        marketplaceApi.getPayoutHistory(),
        // Its failure does not hide the earnings: the page then offers no request button and says why.
        capabilitiesApi.get().catch(() => null),
      ]);
      setRevenue(revenueData);
      setPayoutHistory(payoutsData.payouts);
      setPayoutsAvailable(capabilities ? capabilities.payouts.available === true : null);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Couldn't load your earnings"));
    } finally {
      setIsLoading(false);
    }
  }

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadData();
  }

  // The limits as the API answered them; null when the answer carries none the page can read.
  const limits = readPayoutLimits(revenue?.payoutLimits);
  const availableCents = revenue?.pendingPayoutCents ?? 0;
  const dialog = limits
    ? payoutDialog({ limits, availableCents, method: payoutMethod, amountText: payoutAmount })
    : null;

  /** A method starts at the largest amount it allows right now. */
  function choosePayoutMethod(method: PayoutMethod) {
    if (!limits) return;
    setPayoutMethod(method);
    setPayoutAmount(defaultAmountText(limits, method));
    setRefusal(null);
  }

  function openPayoutDialog() {
    if (!limits) return;
    const method = defaultPayoutMethod(limits);
    setPayoutMethod(method);
    setPayoutAmount(method ? defaultAmountText(limits, method) : "");
    setRefusal(null);
    // The sentence for an earlier request is not about this one.
    setRequestedMessage(null);
    setShowPayoutDialog(true);
  }

  async function handleRequestPayout() {
    if (!dialog) return;
    const submission = payoutSubmission(dialog, payoutAddress);
    if (!submission.ok) {
      setRefusal(submission.refusal);
      return;
    }

    setIsRequestingPayout(true);
    setRefusal(null);
    try {
      const answer = await marketplaceApi.requestPayout(submission.body);
      const said = payoutRequestedMessage(answer.message, answer.payout.amountCents);
      toast.success(said);
      setRequestedMessage(said);
      setShowPayoutDialog(false);
      loadData();
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === PAYOUTS_UNAVAILABLE_CODE) {
        // Nothing was reserved. The button goes until payouts are back.
        toast.error(getErrorMessage(error, PAYOUTS_UNAVAILABLE_MESSAGE));
        setShowPayoutDialog(false);
        setPayoutsAvailable(false);
        loadData();
        return;
      }
      // Only a sentence the API wrote is shown; anything else gets the page's own.
      const refused = payoutRefusal(code, code === null ? null : getErrorMessage(error, ""));
      if (code === PAYOUT_IN_PROGRESS_CODE) {
        // The payout in progress is in the history: show it there.
        toast.error(refused.message);
        setShowPayoutDialog(false);
      } else {
        setRefusal({ field: refused.field, message: refused.message });
      }
      if (refused.reload) loadData();
    } finally {
      setIsRequestingPayout(false);
    }
  }

  /** Runs inside the confirm dialog, which stays open and shows the error when this throws. */
  async function handleCancelPayout(payout: Payout) {
    try {
      await marketplaceApi.cancelPayout(payout.id);
    } catch (error) {
      if (apiErrorCode(error) !== PAYOUT_NOT_CANCELLABLE_CODE) throw error;
      // It is being sent or is finished: say so in the API's words and show the row as it is now.
      toast.error(getErrorMessage(error, "This payout can no longer be cancelled."));
      await loadData();
      return;
    }
    // The card must not go on saying a cancelled payout was requested.
    setRequestedMessage(null);
    toast.success(payoutCancelledMessage(payout.amountCents));
    await loadData();
  }

  const hasPendingPayout = Boolean(revenue?.pendingPayouts && revenue.pendingPayouts.length > 0);
  const request = payoutRequest({
    payoutsAvailable,
    availableCents,
    hasPendingPayout,
    limits,
  });

  return (
    <div className="flex flex-col">
      <Header
        title="Earnings"
        description="Track your marketplace earnings and request payouts"
      />

      <div className="p-8">
        {isLoading ? (
          <RevenuePageSkeleton />
        ) : loadError !== null || !revenue ? (
          <ErrorState
            title="Couldn't load your earnings"
            error={loadError}
            onRetry={retryLoad}
          />
        ) : (
          <>
            {/* Stats */}
            <div className="mb-8 grid gap-4 md:grid-cols-4">
              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Earned</p>
                      <p className="text-2xl font-bold text-green-600">
                        {formatCurrency(revenue.totalRevenueCents)}
                      </p>
                    </div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                      <TrendingUp className="h-5 w-5 text-green-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Available to Withdraw</p>
                      <p className="text-2xl font-bold">
                        {formatCurrency(revenue.pendingPayoutCents)}
                      </p>
                    </div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                      <Wallet className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Published Agents</p>
                      <p className="text-2xl font-bold">{revenue.totalListings}</p>
                    </div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
                      <Store className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Installs</p>
                      <p className="text-2xl font-bold">{revenue.totalInstalls}</p>
                    </div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                      <Download className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {revenue.heldInEscrow && revenue.heldInEscrow.jobs > 0 && (
              <Card className="mb-8">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Held in escrow</p>
                    <p className="text-2xl font-bold text-foreground">
                      {formatCurrency(revenue.heldInEscrow.creatorAmountCents)}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Your share of {revenue.heldInEscrow.jobs}{" "}
                      {revenue.heldInEscrow.jobs === 1 ? "job" : "jobs"} buyers have paid for. It is not yours yet: it
                      is released when the buyer accepts the result or the 72-hour review window closes, and refunded
                      if the job is rejected, fails or expires.
                    </p>
                  </div>
                  <Link
                    href={JOBS_RECEIVED_HREF}
                    className="text-sm font-medium text-primary underline underline-offset-2"
                  >
                    See these jobs
                  </Link>
                </CardContent>
              </Card>
            )}

            <ContributionsCard />

            {/* Payout CTA */}
            <Card className="mb-8">
              <CardContent className="py-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-foreground">Request Payout</h3>
                    <p className="mt-1 break-words text-sm text-muted-foreground">{request.line}</p>
                    {requestedMessage && (
                      <p role="status" className="mt-2 break-words text-sm text-foreground">
                        {requestedMessage}
                      </p>
                    )}
                  </div>
                  {request.offered && (
                    <Button onClick={openPayoutDialog} disabled={!request.enabled}>
                      <DollarSign className="mr-2 h-4 w-4" />
                      {request.buttonLabel}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-8 lg:grid-cols-2">
              {/* Revenue by Listing */}
              <Card>
                <CardHeader>
                  <CardTitle>Earnings by agent</CardTitle>
                  <CardDescription>Earnings breakdown by published agent</CardDescription>
                </CardHeader>
                <CardContent>
                  {revenue.revenueByListing.length === 0 && !(revenue.unlistedJobRevenue?.jobs) ? (
                    <EmptyState
                      icon={Store}
                      title="No earnings yet"
                      description="Earnings from your published agents will show here."
                    />
                  ) : (
                    <div className="space-y-4">
                      {revenue.revenueByListing.map((item) => (
                        <div
                          key={item.listingId}
                          className="flex items-center justify-between rounded-lg border p-3"
                        >
                          <div>
                            <p className="font-medium text-foreground">
                              {item.listing?.title || "Unknown Agent"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {item.totalRequests.toLocaleString()} requests
                            </p>
                          </div>
                          <p className="font-semibold text-green-600">
                            {formatCurrency(item.totalRevenueCents)}
                          </p>
                        </div>
                      ))}
                      {revenue.unlistedJobRevenue && revenue.unlistedJobRevenue.jobs > 0 && (
                        <div className="flex items-center justify-between rounded-lg border p-3">
                          <div>
                            <p className="font-medium text-foreground">Jobs on unlisted products</p>
                            <p className="text-sm text-muted-foreground">
                              {revenue.unlistedJobRevenue.jobs.toLocaleString()} completed{" "}
                              {revenue.unlistedJobRevenue.jobs === 1 ? "job" : "jobs"} on workflows, models and agents
                              without a listing
                            </p>
                          </div>
                          <p className="font-semibold text-green-600">
                            {formatCurrency(revenue.unlistedJobRevenue.totalRevenueCents)}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Payout History */}
              <Card>
                <CardHeader>
                  <CardTitle>Payout History</CardTitle>
                  <CardDescription>Your previous payout requests</CardDescription>
                </CardHeader>
                <CardContent>
                  {payoutHistory.length === 0 ? (
                    <EmptyState
                      icon={CreditCard}
                      title="No payouts yet"
                      description="Payouts you request will be listed here."
                    />
                  ) : (
                    <div className="space-y-3">
                      {payoutHistory.slice(0, 5).map((payout) => {
                        const row = payoutRow(payout);
                        return (
                          <div key={payout.id} className="rounded-lg border p-3">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-3">
                                {row.icon === "done" ? (
                                  <CheckCircle className="h-5 w-5 shrink-0 text-green-500" aria-hidden="true" />
                                ) : row.icon === "failed" ? (
                                  <XCircle className="h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
                                ) : row.icon === "cancelled" ? (
                                  <Ban className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                ) : (
                                  <Clock className="h-5 w-5 shrink-0 text-yellow-500" aria-hidden="true" />
                                )}
                                <div className="min-w-0">
                                  <p className="font-medium text-foreground">
                                    {formatCurrency(payout.amountCents)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {payoutMethodLabels[payout.payoutMethod] ?? payout.payoutMethod} &middot;{" "}
                                    {formatDate(payout.requestedAt)}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant={row.tone}>{row.statusLabel}</Badge>
                                {row.canCancel && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPayoutToCancel(payout)}
                                    aria-label={`Cancel the ${formatCurrency(payout.amountCents)} payout`}
                                  >
                                    {EARNINGS_WORDS.cancel}
                                  </Button>
                                )}
                              </div>
                            </div>
                            {row.note && (
                              <p className="mt-2 break-words text-sm text-muted-foreground">{row.note}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent Transactions */}
            <Card className="mt-8">
              <CardHeader>
                <CardTitle>Recent Transactions</CardTitle>
                <CardDescription>Your latest earnings</CardDescription>
              </CardHeader>
              <CardContent>
                {revenue.recentTransactions.length === 0 ? (
                  <EmptyState
                    icon={TrendingUp}
                    title="No transactions yet"
                    description="Earnings appear here when people pay for your agents."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 font-medium">Type</th>
                          <th className="pb-2 font-medium">Requests</th>
                          <th className="pb-2 font-medium">Gross</th>
                          <th className="pb-2 font-medium">Platform Fee</th>
                          <th className="pb-2 font-medium">Your Earnings</th>
                          <th className="pb-2 font-medium">Status</th>
                          <th className="pb-2 font-medium">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {revenue.recentTransactions.map((tx) => {
                          const row = revenueRow(tx);
                          return (
                          <tr key={tx.id}>
                            <td className="py-3 pr-4">
                              {row.jobId ? (
                                <Link
                                  href={`/dashboard/jobs/${row.jobId}?${JOBS_TAB_PARAM}=${JOBS_TAB_RECEIVED}`}
                                  className="text-primary underline underline-offset-2"
                                >
                                  {row.label}
                                </Link>
                              ) : (
                                row.label
                              )}
                              {row.modelCostCents !== null && (
                                <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">
                                  {EARNINGS_WORDS.modelCost} {formatCurrency(row.modelCostCents)}
                                </span>
                              )}
                            </td>
                            <td className="py-3">{tx.requestCount}</td>
                            <td className="py-3">{formatCurrency(tx.grossAmountCents)}</td>
                            <td className="py-3 text-muted-foreground">
                              -{formatCurrency(tx.platformFeeCents)}
                            </td>
                            {/* Only money that is yours reads as an earning: a held or
                                refunded job, or a pending or refunded charge, is not. */}
                            <td
                              className={
                                tx.status === "settled"
                                  ? "py-3 font-medium text-green-600"
                                  : tx.status === "refunded"
                                    ? "py-3 text-muted-foreground line-through"
                                    : "py-3 text-muted-foreground"
                              }
                            >
                              {formatCurrency(tx.creatorAmountCents)}
                            </td>
                            <td className="py-3">
                              {tx.escrow ? (
                                <EscrowBadge state={tx.escrow} />
                              ) : (
                                <Badge
                                  variant={
                                    tx.status === "settled" ? "success" : tx.status === "refunded" ? "secondary" : "warning"
                                  }
                                >
                                  {tx.status === "settled" ? "Paid" : tx.status === "refunded" ? "Refunded" : "Pending"}
                                </Badge>
                              )}
                            </td>
                            <td className="py-3 text-muted-foreground">
                              {formatDate(tx.createdAt)}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Cancel a payout that has not started to be sent */}
      <ConfirmDialog
        open={payoutToCancel !== null}
        onOpenChange={(open) => {
          if (!open) setPayoutToCancel(null);
        }}
        title={EARNINGS_WORDS.cancelTitle}
        description={payoutToCancel ? cancelPayoutDescription(payoutToCancel.amountCents) : undefined}
        confirmLabel={EARNINGS_WORDS.cancelConfirm}
        cancelLabel={EARNINGS_WORDS.cancelKeep}
        onConfirm={async () => {
          if (payoutToCancel) await handleCancelPayout(payoutToCancel);
        }}
      />

      {/* Payout Dialog */}
      <Dialog open={showPayoutDialog} onOpenChange={setShowPayoutDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto" aria-labelledby="payout-dialog-title">
          <DialogHeader>
            <DialogTitle id="payout-dialog-title">{EARNINGS_WORDS.dialogTitle}</DialogTitle>
            <DialogDescription>
              You have {formatCurrency(availableCents)} in earnings. Choose how to receive it and how much to
              take out.
            </DialogDescription>
          </DialogHeader>

          {dialog && (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!isRequestingPayout) handleRequestPayout();
              }}
            >
              <div className="space-y-4 py-4">
                <div role="group" aria-labelledby="payout-method-legend">
                  <p id="payout-method-legend" className="mb-2 text-sm font-medium text-foreground">
                    {EARNINGS_WORDS.methodLegend}
                  </p>
                  <RadioGroup
                    value={dialog.method ?? ""}
                    onValueChange={(v) => choosePayoutMethod(v as PayoutMethod)}
                  >
                    {dialog.options.map((option) => {
                      const id = `payout-method-${option.value}`;
                      return (
                        <div
                          key={option.value}
                          className={cn(
                            "flex items-start gap-3 rounded-lg border p-3",
                            option.enabled ? "cursor-pointer" : "opacity-60",
                            dialog.method === option.value && "border-primary bg-primary/10"
                          )}
                          onClick={() => {
                            if (option.enabled && dialog.method !== option.value) choosePayoutMethod(option.value);
                          }}
                        >
                          <RadioGroupItem
                            value={option.value}
                            id={id}
                            className="mt-1 shrink-0"
                            disabled={!option.enabled}
                            aria-describedby={`${id}-about`}
                            onClick={(e) => {
                              // The row's own click chooses; one click is one choice.
                              e.stopPropagation();
                              if (option.enabled && dialog.method !== option.value) choosePayoutMethod(option.value);
                            }}
                          />
                          <div className="min-w-0">
                            <label
                              htmlFor={id}
                              className={cn("font-medium text-foreground", option.enabled && "cursor-pointer")}
                            >
                              {option.label}
                            </label>
                            <p id={`${id}-about`} className="break-words text-sm text-muted-foreground">
                              {option.description}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </RadioGroup>
                  {refusal?.field === "method" && (
                    <p role="alert" className="mt-2 break-words text-sm text-destructive">
                      {refusal.message}
                    </p>
                  )}
                </div>

                {dialog.method !== null && (
                  <div>
                    <Label htmlFor="payout-amount">{EARNINGS_WORDS.amountLabel}</Label>
                    <Input
                      id="payout-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      value={payoutAmount}
                      onChange={(e) => {
                        setPayoutAmount(e.target.value);
                        setRefusal(null);
                      }}
                      aria-invalid={Boolean(dialog.amountError) || refusal?.field === "amount"}
                      aria-describedby="payout-amount-help payout-amount-error"
                      className="mt-1"
                    />
                    <p id="payout-amount-help" className="mt-1 break-words text-sm text-muted-foreground">
                      {dialog.amountHelp}
                      {dialog.limitsLine && <> {dialog.limitsLine}</>}
                    </p>
                    <p id="payout-amount-error" role="alert" className="break-words text-sm text-destructive">
                      {refusal?.field === "amount" ? refusal.message : dialog.amountError}
                    </p>
                  </div>
                )}

                {dialog.needsAddress && (
                  <div>
                    <Label htmlFor="wallet-address">{EARNINGS_WORDS.addressLabel}</Label>
                    <Input
                      id="wallet-address"
                      autoComplete="off"
                      spellCheck={false}
                      value={payoutAddress}
                      onChange={(e) => {
                        setPayoutAddress(e.target.value);
                        setRefusal(null);
                      }}
                      placeholder={EARNINGS_WORDS.addressPlaceholder}
                      aria-invalid={refusal?.field === "address"}
                      aria-describedby="wallet-address-error"
                      className="mt-1"
                    />
                    <p id="wallet-address-error" role="alert" className="mt-1 break-words text-sm text-destructive">
                      {refusal?.field === "address" ? refusal.message : null}
                    </p>
                  </div>
                )}

                {refusal?.field === "form" && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {refusal.message}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowPayoutDialog(false)}>
                  {EARNINGS_WORDS.dialogCancel}
                </Button>
                <Button type="submit" disabled={isRequestingPayout || !dialog.canSubmit}>
                  {isRequestingPayout ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {EARNINGS_WORDS.submitting}
                    </>
                  ) : (
                    <>
                      {dialog.submitLabel}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
