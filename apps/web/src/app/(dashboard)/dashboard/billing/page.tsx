"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import {
  CreditCard,
  Activity,
  Download,
  TrendingUp,
  DollarSign,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  CheckCircle2,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PlanCard } from "@/components/dashboard/plan-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  billingApi,
  type BillingRails,
  type CreditBalance,
  type CreditTransaction,
  type UsageSummary,
  type X402MetricsHistoryPoint,
  type X402MetricsResponse,
  type CreditPackage,
  type TopupAsset,
  type TopupPrepareResponse,
  getErrorMessage,
} from "@/lib/api";
import { packPayment } from "@/lib/credit-purchase";
import {
  CONNECT_TO_PAY,
  FOLLOW_EVERY_MS,
  WALLET_CANNOT_SIGN,
  type NextStep,
  type ShownLine,
  type StatusLine,
  afterPrepareError,
  afterReconcileError,
  afterSettle,
  afterSignError,
  afterSubmitError,
  assetToPayWith,
  lineFor,
  lineForPrepared,
  lineWhileFollowing,
  shouldCarryOn,
  shouldKeepFollowing,
  topupsToFollow,
  walletAssetsOffered,
} from "@/lib/wallet-topup";
import { cn } from "@/lib/utils";

// Fallback only — the real ladder is served by GET /api/billing/packages
// so what the buyer sees is what the grant math uses (B2/T1). A second
// hardcoded copy here is how "$100 → +$15" drifts from what's granted.
const fallbackPackages: CreditPackage[] = [
  { amount: 10, bonus: 0 },
  { amount: 50, bonus: 5, popular: true },
  { amount: 100, bonus: 15 },
  { amount: 500, bonus: 100 },
];

// The skeleton comes in three pieces so each can stand in for its own section
// while <PlanCard> stays mounted above them.

/** Stands in for the three balance tiles. */
function BalanceTilesSkeleton() {
  return (
    <div className="mb-8 grid gap-6 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-6">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Stands in for the Add Credits card. */
function AddCreditsSkeleton() {
  return (
    <Card className="mb-8">
      <CardHeader>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col items-center rounded-lg border-2 border-border p-6"
            >
              <Skeleton className="h-9 w-16" />
              <Skeleton className="mt-3 h-4 w-24" />
              <Skeleton className="mt-4 h-10 w-full" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Stands in for the usage breakdown and the transaction history. */
function BillingDetailsSkeleton() {
  return (
    <>
      <Card className="mb-8">
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-28 max-w-full sm:w-40" />
                <Skeleton className="h-4 w-56 max-w-full" />
              </div>
              <Skeleton className="h-6 w-20 shrink-0" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
            >
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-20 max-w-full sm:w-24" />
                  <Skeleton className="h-4 w-24 max-w-full sm:w-40" />
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Skeleton className="h-6 w-16 sm:w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

export default function BillingPage() {
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [x402Metrics, setX402Metrics] = useState<X402MetricsResponse | null>(null);
  const [x402History, setX402History] = useState<X402MetricsHistoryPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isPurchasing, setIsPurchasing] = useState<number | null>(null);
  const [isWalletPaying, setIsWalletPaying] = useState<number | null>(null);
  const [rails, setRails] = useState<BillingRails | null>(null);
  const [railsReadFailed, setRailsReadFailed] = useState(false);
  // Which asset "Pay with Wallet" uses; null until chosen, which means the first one offered.
  const [chosenAsset, setChosenAsset] = useState<TopupAsset | null>(null);
  // The line under the packs: the API's sentence for the step a wallet payment is at.
  const [topupLine, setTopupLine] = useState<ShownLine | null>(null);
  // Top-ups sent and not yet final: each is asked about until the API says how it ended.
  const [following, setFollowing] = useState<string[]>([]);
  const followBusy = useRef(false);
  // When each one was first asked about here, so a page left open does not ask for ever.
  const followSince = useRef(new Map<string, number>());
  // The pack chosen before any wallet was connected: paid for once one connects.
  const [waitingPack, setWaitingPack] = useState<{ index: number; askedAt: number } | null>(null);
  const { publicKey, connected, connecting, wallet, signTransaction } = useWallet();
  const { visible, setVisible } = useWalletModal();

  async function loadBillingData() {
    try {
      const [
        balanceData,
        transactionsData,
        usageData,
        x402MetricsData,
        x402HistoryData,
      ] = await Promise.all([
        billingApi.getBalance(),
        billingApi.getTransactions(),
        billingApi.getUsage(),
        billingApi.getX402Metrics().catch(() => null),
        billingApi.getX402MetricsHistory(24, 96).catch(() => null),
      ]);
      setBalance(balanceData.balance);
      setTransactions(transactionsData.transactions);
      setUsage(usageData.usage);
      setX402Metrics(x402MetricsData);
      setX402History(x402HistoryData?.history ?? []);
      setLoadError(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load billing data"));
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadBillingData();
  }

  const [creditPackages, setCreditPackages] =
    useState<CreditPackage[]>(fallbackPackages);

  useEffect(() => {
    loadBillingData();
    // Serve-side ladder wins over the local fallback; `rails` tells us
    // which payment paths this deployment actually supports.
    billingApi
      .getPackages()
      .then((res) => {
        setCreditPackages(res.packages);
        setRails(res.rails ?? null);
        // An answer without rails cannot say what is live either.
        setRailsReadFailed(!res.rails);
      })
      .catch(() => setRailsReadFailed(true));
    // A top-up sent before this page was closed is picked up again here.
    billingApi
      .listTopups()
      .then((res) => {
        const open = topupsToFollow(res.topups);
        const newest = open[open.length - 1];
        if (!newest) return;
        setFollowing((ids) => [...ids, ...open.map((t) => t.id).filter((id) => !ids.includes(id))]);
        setTopupLine((line) => line ?? { ...lineFor(newest), topupId: newest.id });
      })
      .catch(() => undefined);
  }, []);

  // Follow every top-up in flight until it is final, then read the balance again.
  useEffect(() => {
    if (following.length === 0) return;
    let stopped = false;
    const ask = async () => {
      if (followBusy.current) return;
      followBusy.current = true;
      try {
        for (const id of following) {
          const since = followSince.current.get(id) ?? Date.now();
          followSince.current.set(id, since);
          let next: Pick<NextStep, "follow" | "reloadBalance"> & { line: StatusLine | null };
          try {
            next = afterSettle(await billingApi.reconcileTopup(id));
          } catch (error) {
            next = { ...afterReconcileError(error), reloadBalance: false };
          }
          if (stopped) return;
          setTopupLine((shown) => lineWhileFollowing(shown, id, next));
          // Still not final after a long while: the server finishes it; stop asking from here.
          if (!next.follow || !shouldKeepFollowing(since, Date.now())) {
            followSince.current.delete(id);
            setFollowing((ids) => ids.filter((other) => other !== id));
          }
          if (next.reloadBalance) loadBillingData();
        }
      } finally {
        followBusy.current = false;
      }
    };
    const timer = setInterval(ask, FOLLOW_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [following]);

  // Pricing page "Start Pro Trial" lands on ?upgrade=pro after sign-up;
  // Stripe returns to ?checkout=… / ?subscription=….
  const [autoUpgrade, setAutoUpgrade] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("upgrade") === "pro") setAutoUpgrade(true);
    const checkout = params.get("checkout");
    const subscription = params.get("subscription");
    if (checkout === "success") {
      toast.success("Payment received. Your credits appear as soon as Stripe confirms it.");
    } else if (checkout === "cancelled") {
      toast.info("Checkout cancelled. You were not charged.");
    }
    if (subscription === "success") {
      toast.success("Welcome to Pro. Your plan updates as soon as Stripe confirms the subscription.");
    } else if (subscription === "cancelled") {
      toast.info("Pro checkout cancelled. You were not charged.");
    }
  }, []);

  async function handlePurchase(packageIndex: number) {
    const pkg = creditPackages[packageIndex];
    if (!pkg) {
      toast.error("Invalid credit package selection");
      return;
    }
    setIsPurchasing(packageIndex);

    try {
      const { checkoutUrl } = await billingApi.createCheckout(pkg.amount);
      window.location.href = checkoutUrl;
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create checkout session"));
      setIsPurchasing(null);
    }
  }

  const offeredAssets = walletAssetsOffered(rails);
  const payAsset = assetToPayWith(offeredAssets, chosenAsset);

  // Wallet top-up: the server builds the exact transfer, the connected wallet
  // signs it, and credits are added only once the chain confirms it. Every
  // sentence shown is the API's, except for what only the page can see (a
  // wallet that declined, or a request that got no answer).
  async function handleWalletPurchase(packageIndex: number) {
    const pkg = creditPackages[packageIndex];
    if (!pkg || !payAsset || isWalletPaying !== null) return;
    if (!connected || !publicKey) {
      setWaitingPack({ index: packageIndex, askedAt: Date.now() });
      setTopupLine({ message: CONNECT_TO_PAY, tone: "progress" });
      setVisible(true);
      return;
    }
    if (!signTransaction) {
      setTopupLine({ message: WALLET_CANNOT_SIGN, tone: "error" });
      return;
    }

    setIsWalletPaying(packageIndex);
    try {
      let prepared: TopupPrepareResponse;
      try {
        prepared = await billingApi.prepareTopup({
          amountUsd: pkg.amount,
          asset: payAsset,
          payerAddress: publicKey.toBase58(),
        });
      } catch (error) {
        setTopupLine(afterPrepareError(error));
        return;
      }
      // For SOL this is the price and how long it holds.
      setTopupLine({ ...lineForPrepared(prepared), topupId: prepared.topupId });

      let signedTxBase64: string;
      try {
        const txBytes = Uint8Array.from(atob(prepared.unsignedTxBase64), (c) =>
          c.charCodeAt(0)
        );
        const signedTx = await signTransaction(VersionedTransaction.deserialize(txBytes));
        const signedBytes = signedTx.serialize();
        let binary = "";
        for (let i = 0; i < signedBytes.length; i++) {
          binary += String.fromCharCode(signedBytes[i]!);
        }
        signedTxBase64 = btoa(binary);
      } catch (error) {
        setTopupLine(afterSignError(error));
        return;
      }

      // Once it is signed, a failed request decides nothing: the transfer may
      // have been sent on, so the top-up is followed until the API ends it.
      let next: NextStep;
      try {
        next = afterSettle(await billingApi.submitTopup(prepared.topupId, signedTxBase64));
      } catch (error) {
        next = afterSubmitError(error);
      }
      setTopupLine({ ...next.line, topupId: prepared.topupId });
      if (next.follow) {
        const { topupId } = prepared;
        setFollowing((ids) => (ids.includes(topupId) ? ids : [...ids, topupId]));
      }
      if (next.reloadBalance) loadBillingData();
    } finally {
      setIsWalletPaying(null);
    }
  }

  // "Pay with Wallet" with no wallet connected opened the wallet list: carry
  // the payment on once a wallet connects, and drop it if the list was closed
  // without choosing one.
  useEffect(() => {
    if (!waitingPack) return;
    if (connected && publicKey) {
      setWaitingPack(null);
      if (shouldCarryOn(waitingPack, true, Date.now())) {
        void handleWalletPurchase(waitingPack.index);
      } else {
        setTopupLine((line) => (line?.message === CONNECT_TO_PAY ? null : line));
      }
      return;
    }
    if (!visible && !connecting && !wallet) {
      setWaitingPack(null);
      setTopupLine((line) => (line?.message === CONNECT_TO_PAY ? null : line));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingPack, connected, publicKey, visible, connecting, wallet]);

  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  }

  // Which buttons a pack shows: only a rail that is live gets one.
  const payment = packPayment(rails, railsReadFailed);

  const x402Trend = x402History.slice(-24);
  const maxPending = Math.max(
    1,
    ...x402Trend.map((point) => point.pendingPayments)
  );
  const maxFailureRate = Math.max(
    1,
    ...x402Trend.map((point) => point.failureRatePercent)
  );

  const header = (
    <Header
      title="Billing"
      description="Manage your account balance and view usage"
    />
  );

  // One tree for every state, so <PlanCard> is never unmounted: it fetches the
  // plan itself and its autoUpgrade must fire once, not again after a retry.
  const dataReady = !isLoading && loadError === null;

  return (
    <div className="flex flex-col">
      {header}

      <div className="p-8" aria-busy={isLoading}>
        <PlanCard autoUpgrade={autoUpgrade} />

        {isLoading && <BalanceTilesSkeleton />}

        {/* Balance, usage and history failed to load. Plans and Add Credits
            below do not depend on those requests, so they stay usable. */}
        {!isLoading && loadError !== null && (
          <div className="mb-8">
            <ErrorState
              title="Couldn't load billing data"
              description="Your balance, usage and transaction history are unavailable. You can still add credits or change your plan."
              error={loadError}
              onRetry={retryLoad}
            />
          </div>
        )}

        {/* Balance overview */}
        {dataReady && (
        <div className="mb-8 grid gap-6 md:grid-cols-3">
          <Card>
            <CardContent className="py-6">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-500/10">
                  <DollarSign className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Available Credits</p>
                  <p className="text-3xl font-bold text-foreground">
                    {formatCurrency(balance?.available || 0)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-6">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10">
                  <TrendingUp className="h-6 w-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">This Month's Usage</p>
                  <p className="text-3xl font-bold text-foreground">
                    {formatCurrency(usage?.currentMonth || 0)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-6">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/10">
                  <Zap className="h-6 w-6 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">GPU Hours Used</p>
                  <p className="text-3xl font-bold text-foreground">
                    {(usage?.gpuHours || 0).toFixed(1)}h
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        )}

        {/* Purchase credits */}
        {isLoading ? (
          <AddCreditsSkeleton />
        ) : (
        <Card id="add-credits" className="mb-8 scroll-mt-8">
          <CardHeader>
            <CardTitle className="text-base">Add Credits</CardTitle>
            <CardDescription>
              Purchase credits to pay for GPU compute time
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Drawn only when there is a choice to make. */}
            {payment.wallet && offeredAssets.length > 1 && (
              <div
                role="radiogroup"
                aria-labelledby="pay-with-label"
                className="mb-6 flex flex-wrap items-center gap-3"
              >
                <span id="pay-with-label" className="text-sm font-medium text-foreground">
                  {payment.card ? "Wallet pays with" : "Pay with"}
                </span>
                <div className="inline-flex rounded-lg border border-border bg-muted p-1">
                  {offeredAssets.map((asset) => (
                    <label
                      key={asset}
                      className={cn(
                        "cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-ring",
                        asset === payAsset
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <input
                        type="radio"
                        name="topup-asset"
                        value={asset}
                        className="sr-only"
                        checked={asset === payAsset}
                        disabled={isWalletPaying !== null}
                        onChange={() => setChosenAsset(asset)}
                      />
                      {asset}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-4">
              {creditPackages.map((pkg, index) => (
                <div
                  key={pkg.amount}
                  className={cn(
                    "relative rounded-lg border-2 p-6 text-center transition-all",
                    pkg.popular
                      ? "border-primary-500 bg-primary/10"
                      : "border-border hover:border-muted-foreground/40"
                  )}
                >
                  {pkg.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
                      Most Popular
                    </Badge>
                  )}
                  <p className="text-3xl font-bold text-foreground">
                    ${pkg.amount}
                  </p>
                  {pkg.bonus > 0 && (
                    <p className="mt-1 text-sm font-medium text-green-600">
                      +${pkg.bonus} bonus
                    </p>
                  )}
                  <p className="mt-2 text-sm text-muted-foreground">
                    {formatCurrency(pkg.amount + pkg.bonus)} total
                  </p>
                  {payment.card && (
                    <Button
                      className="mt-4 w-full"
                      variant={pkg.popular ? "default" : "outline"}
                      onClick={() => handlePurchase(index)}
                      isLoading={isPurchasing === index}
                    >
                      Purchase
                    </Button>
                  )}
                  {payment.wallet && (
                    <Button
                      className={cn("w-full", payment.card ? "mt-2" : "mt-4")}
                      variant="outline"
                      onClick={() => handleWalletPurchase(index)}
                      isLoading={isWalletPaying === index}
                      disabled={isWalletPaying !== null}
                    >
                      <Wallet className="mr-2 h-4 w-4" />
                      Pay with Wallet
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {payment.notice && (
              <p className="mt-4 text-center text-sm text-foreground" role="status">
                {payment.notice}
              </p>
            )}

            {/* Where a wallet payment stands, in the API's words. Always in the
                page while the wallet rail is live so a change is announced. */}
            {(payment.wallet || topupLine) && (
              <div role="status" aria-live="polite">
                {topupLine && (
                  <p
                    className={cn(
                      "mt-4 break-words rounded-lg border px-4 py-3 text-center text-sm text-foreground",
                      topupLine.tone === "success" && "border-green-500/30 bg-green-500/10",
                      topupLine.tone === "error" && "border-red-500/30 bg-red-500/10",
                      topupLine.tone === "progress" && "border-border bg-muted"
                    )}
                  >
                    {topupLine.message}
                  </p>
                )}
              </div>
            )}

            <p className="mt-4 text-center text-sm text-muted-foreground">
              {rails?.wallet && rails.walletAssets.length > 0 ? (
                <>
                  Wallet payments ({rails.walletAssets.join("/")}
                  {rails.network === "devnet" ? ", devnet" : ""}) are live:
                  your wallet signs the exact transfer WheelsAI prepares.{" "}
                  {rails.stripeCheckout
                    ? "Card payments go through Stripe."
                    : payment.card
                      ? ""
                      : "Card payments are temporarily unavailable."}{" "}
                  Credits never expire.
                </>
              ) : (
                <>
                  {/* Said only when the server has reported no card rail, never while that is unknown. */}
                  {rails?.stripeCheckout
                    ? "Card payments go through Stripe."
                    : rails && !payment.card
                      ? "Card payments are temporarily unavailable."
                      : ""}{" "}
                  Credits never expire.
                </>
              )}
            </p>
          </CardContent>
        </Card>
        )}

        {isLoading && (
          <>
            <BillingDetailsSkeleton />
            <span className="sr-only">Loading billing</span>
          </>
        )}

        {/* Usage breakdown */}
        {dataReady && usage && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="text-base">Usage Breakdown</CardTitle>
              <CardDescription>
                Your resource consumption this billing period
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Compute (GPU Hours)</p>
                    <p className="text-sm text-muted-foreground">
                      {usage.gpuHours.toFixed(2)} hours @ avg ${usage.avgCostPerHour.toFixed(2)}/hr
                    </p>
                  </div>
                  <p className="text-lg font-semibold">
                    {formatCurrency(usage.computeCost)}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Inference Requests</p>
                    <p className="text-sm text-muted-foreground">
                      {usage.requests.toLocaleString()} requests
                    </p>
                  </div>
                  <p className="text-lg font-semibold">
                    {formatCurrency(usage.requestsCost)}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Token Usage</p>
                    <p className="text-sm text-muted-foreground">
                      {usage.inputTokens.toLocaleString()} input / {usage.outputTokens.toLocaleString()} output
                    </p>
                  </div>
                  <p className="text-lg font-semibold">
                    {formatCurrency(usage.tokensCost)}
                  </p>
                </div>

                <div className="border-t pt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-semibold">Total This Month</p>
                    <p className="text-xl font-bold text-primary-600">
                      {formatCurrency(usage.currentMonth)}
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* X402 settlement health */}
        {dataReady && x402Metrics && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="text-base">X402 Settlement Health</CardTitle>
              <CardDescription>
                Settlement status, alerts and the 24-hour trend for your x402 payments
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6 grid gap-4 md:grid-cols-4">
                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Settlement</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Activity className="h-4 w-4 text-blue-600" />
                    <p className="font-semibold text-foreground">
                      {x402Metrics.worker.enabled
                        ? x402Metrics.worker.running
                          ? "Running"
                          : "Idle"
                        : "Paused"}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last checked:{" "}
                    {x402Metrics.worker.lastTickAt
                      ? new Date(x402Metrics.worker.lastTickAt).toLocaleTimeString()
                      : "Never"}
                  </p>
                </div>

                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Pending Payments</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">
                    {x402Metrics.payments.pending.toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Threshold: {x402Metrics.thresholds.maxPending}
                  </p>
                </div>

                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Failure Rate</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">
                    {x402Metrics.payments.failureRatePercent.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Threshold: {x402Metrics.thresholds.maxFailureRatePercent.toFixed(1)}%
                  </p>
                </div>

                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Open Alerts</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">
                    {x402Metrics.alerts.length}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Retries pending: {x402Metrics.payments.retriable}
                  </p>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <p className="mb-3 text-sm font-medium text-foreground">Active Alerts</p>
                  {x402Metrics.alerts.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <CheckCircle2 className="h-4 w-4" />
                      No active threshold breaches
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {x402Metrics.alerts.map((alert) => (
                        <div
                          key={`${alert.code}-${alert.threshold}`}
                          className={cn(
                            "rounded-md border p-3 text-sm",
                            alert.severity === "critical"
                              ? "border-red-500/30 bg-red-500/10"
                              : "border-amber-500/30 bg-amber-500/10"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="h-4 w-4" />
                              <span className="font-medium">{alert.message}</span>
                            </div>
                            <Badge variant="outline" className="capitalize">
                              {alert.severity}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Value {alert.value} vs threshold {alert.threshold}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-4">
                  <p className="mb-3 text-sm font-medium text-foreground">24h Trend</p>
                  {x402Trend.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No history yet. It appears here as your x402 payments settle.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <p className="mb-2 text-xs text-muted-foreground">Pending Payments</p>
                        <div className="flex h-20 items-end gap-1">
                          {x402Trend.map((point) => (
                            <div
                              key={`pending-${point.timestamp}`}
                              className="flex-1 rounded-t bg-blue-400/80"
                              style={{
                                height: `${Math.max(
                                  8,
                                  Math.round((point.pendingPayments / maxPending) * 100)
                                )}%`,
                              }}
                              title={`${new Date(point.timestamp).toLocaleString()}: ${point.pendingPayments} pending`}
                            />
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="mb-2 text-xs text-muted-foreground">Failure Rate (%)</p>
                        <div className="flex h-16 items-end gap-1">
                          {x402Trend.map((point) => (
                            <div
                              key={`failure-${point.timestamp}`}
                              className="flex-1 rounded-t bg-red-400/80"
                              style={{
                                height: `${Math.max(
                                  6,
                                  Math.round((point.failureRatePercent / maxFailureRate) * 100)
                                )}%`,
                              }}
                              title={`${new Date(point.timestamp).toLocaleString()}: ${point.failureRatePercent.toFixed(2)}% failure`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Transaction history */}
        {dataReady && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Transaction History</CardTitle>
              <CardDescription>
                Your recent credit transactions
              </CardDescription>
            </div>
            <Button variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <EmptyState
                icon={CreditCard}
                title="No transactions yet"
                description="Credit purchases, bonuses, usage charges and refunds will show here."
                actionLabel="Add Credits"
                actionHref="#add-credits"
              />
            ) : (
              <div className="space-y-3">
                {transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-lg",
                          tx.type === "purchase" || tx.type === "bonus"
                            ? "bg-green-500/10"
                            : "bg-red-500/10"
                        )}
                      >
                        {tx.type === "purchase" || tx.type === "bonus" ? (
                          <ArrowDownRight className="h-5 w-5 text-green-600" />
                        ) : (
                          <ArrowUpRight className="h-5 w-5 text-red-600" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium capitalize">{tx.type}</p>
                        <p className="text-sm text-muted-foreground">{tx.description}</p>
                      </div>
                    </div>

                    <div className="text-right">
                      <p
                        className={cn(
                          "text-lg font-semibold",
                          tx.type === "purchase" || tx.type === "bonus"
                            ? "text-green-600"
                            : "text-red-600"
                        )}
                      >
                        {tx.type === "purchase" || tx.type === "bonus" ? "+" : "-"}
                        {formatCurrency(Math.abs(tx.amount))}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(tx.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}
