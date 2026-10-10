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
  PAYOUT_NOT_CANCELLABLE_CODE,
  cancelPayoutDescription,
  payoutCancelledMessage,
  payoutRequest,
  payoutRow,
  revenueRow,
} from "@/lib/earnings";
import { ContributionsCard } from "@/components/marketplace/contributions-card";
import { EscrowBadge } from "@/components/marketplace/escrow-badge";
import { JOBS_RECEIVED_HREF, JOBS_TAB_PARAM, JOBS_TAB_RECEIVED } from "@/lib/nav";
import { cn } from "@/lib/utils";

// The one shape the API client declares, so a field added there reaches this page.
type RevenueData = Awaited<ReturnType<typeof marketplaceApi.getRevenue>>;

type Payout = Awaited<ReturnType<typeof marketplaceApi.getPayoutHistory>>["payouts"][number];

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const payoutMethodLabels: Record<string, string> = {
  credits: "Platform Credits",
  crypto_usdc: "USDC (Solana)",
  crypto_sol: "SOL",
};

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
  const [payoutMethod, setPayoutMethod] = useState<"credits" | "crypto_usdc" | "crypto_sol">("credits");
  const [payoutAddress, setPayoutAddress] = useState("");
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

  async function handleRequestPayout() {
    if (payoutMethod !== "credits" && !payoutAddress) {
      toast.error("Please enter a wallet address");
      return;
    }

    setIsRequestingPayout(true);
    try {
      await marketplaceApi.requestPayout(
        payoutMethod,
        payoutMethod !== "credits" ? payoutAddress : undefined
      );
      toast.success("Payout requested successfully!");
      setShowPayoutDialog(false);
      loadData();
    } catch (error) {
      if (apiErrorCode(error) === PAYOUTS_UNAVAILABLE_CODE) {
        // Nothing was reserved. The button goes until payouts are back.
        toast.error(getErrorMessage(error, PAYOUTS_UNAVAILABLE_MESSAGE));
        setShowPayoutDialog(false);
        setPayoutsAvailable(false);
        loadData();
      } else {
        toast.error(getErrorMessage(error, "Failed to request payout"));
      }
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
    toast.success(payoutCancelledMessage(payout.amountCents));
    await loadData();
  }

  const hasPendingPayout = Boolean(revenue?.pendingPayouts && revenue.pendingPayouts.length > 0);
  const request = payoutRequest({
    payoutsAvailable,
    availableCents: revenue?.pendingPayoutCents ?? 0,
    hasPendingPayout,
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
                    <p className="mt-1 text-sm text-muted-foreground">{request.line}</p>
                  </div>
                  {request.offered && (
                    <Button onClick={() => setShowPayoutDialog(true)} disabled={!request.enabled}>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Payout</DialogTitle>
            <DialogDescription>
              Choose how you'd like to receive your earnings of{" "}
              {revenue && formatCurrency(revenue.pendingPayoutCents)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <RadioGroup
              value={payoutMethod}
              onValueChange={(v) => setPayoutMethod(v as typeof payoutMethod)}
            >
              <div
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                  payoutMethod === "credits" && "border-primary-500 bg-primary/10"
                )}
                onClick={() => setPayoutMethod("credits")}
              >
                <RadioGroupItem value="credits" id="credits" className="mt-1" />
                <div>
                  <label htmlFor="credits" className="cursor-pointer font-medium">
                    Platform Credits
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Add to your WheelsAI balance instantly
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                  payoutMethod === "crypto_usdc" && "border-primary-500 bg-primary/10"
                )}
                onClick={() => setPayoutMethod("crypto_usdc")}
              >
                <RadioGroupItem value="crypto_usdc" id="crypto_usdc" className="mt-1" />
                <div>
                  <label htmlFor="crypto_usdc" className="cursor-pointer font-medium">
                    USDC (Solana)
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Receive USDC to your Solana wallet (1-3 business days)
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                  payoutMethod === "crypto_sol" && "border-primary-500 bg-primary/10"
                )}
                onClick={() => setPayoutMethod("crypto_sol")}
              >
                <RadioGroupItem value="crypto_sol" id="crypto_sol" className="mt-1" />
                <div>
                  <label htmlFor="crypto_sol" className="cursor-pointer font-medium">
                    SOL
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Receive SOL to your Solana wallet (1-3 business days)
                  </p>
                </div>
              </div>
            </RadioGroup>

            {payoutMethod !== "credits" && (
              <div>
                <Label htmlFor="wallet-address">Solana Wallet Address</Label>
                <Input
                  id="wallet-address"
                  value={payoutAddress}
                  onChange={(e) => setPayoutAddress(e.target.value)}
                  placeholder="Enter your Solana wallet address"
                  className="mt-1"
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setShowPayoutDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleRequestPayout} disabled={isRequestingPayout}>
              {isRequestingPayout ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Requesting...
                </>
              ) : (
                <>
                  Request {revenue && formatCurrency(revenue.pendingPayoutCents)}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
