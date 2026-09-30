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
import { marketplaceApi, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

interface RevenueData {
  totalRevenueCents: number;
  pendingPayoutCents: number;
  totalListings: number;
  totalInstalls: number;
  revenueByListing: Array<{
    listingId: string;
    listing: { id: string; title: string; slug: string } | undefined;
    totalRevenueCents: number;
    totalRequests: number;
  }>;
  recentTransactions: Array<{
    id: string;
    type: string;
    grossAmountCents: number;
    platformFeeCents: number;
    creatorAmountCents: number;
    requestCount: number;
    status: string;
    createdAt: string;
  }>;
  pendingPayouts: Array<{
    id: string;
    amountCents: number;
    payoutMethod: string;
    status: string;
    requestedAt: string;
  }>;
}

interface Payout {
  id: string;
  amountCents: number;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  requestedAt: string;
  processedAt: string | null;
}

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

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  completed: "success",
  processing: "warning",
  pending: "secondary",
  failed: "destructive",
  settled: "success",
};

const payoutMethodLabels: Record<string, string> = {
  credits: "Platform Credits",
  crypto_usdc: "USDC (Solana)",
  crypto_sol: "SOL",
};

export default function RevenueDashboardPage() {
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [payoutHistory, setPayoutHistory] = useState<Payout[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showPayoutDialog, setShowPayoutDialog] = useState(false);
  const [payoutMethod, setPayoutMethod] = useState<"credits" | "crypto_usdc" | "crypto_sol">("credits");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [isRequestingPayout, setIsRequestingPayout] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [revenueData, payoutsData] = await Promise.all([
        marketplaceApi.getRevenue(),
        marketplaceApi.getPayoutHistory(),
      ]);
      setRevenue(revenueData);
      setPayoutHistory(payoutsData.payouts);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load revenue data"));
    } finally {
      setIsLoading(false);
    }
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
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to request payout"));
    } finally {
      setIsRequestingPayout(false);
    }
  }

  const canRequestPayout = revenue && revenue.pendingPayoutCents >= 1000;
  const hasPendingPayout = revenue?.pendingPayouts && revenue.pendingPayouts.length > 0;

  return (
    <div className="flex flex-col">
      <Header
        title="Revenue & Payouts"
        description="Track your marketplace earnings and request payouts"
      />

      <div className="p-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : !revenue ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">Failed to load revenue data</p>
          </div>
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

            {/* Payout CTA */}
            <Card className="mb-8">
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-foreground">Request Payout</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {canRequestPayout
                        ? `You have ${formatCurrency(revenue.pendingPayoutCents)} available for withdrawal`
                        : "Minimum payout amount is $10.00"}
                    </p>
                  </div>
                  <Button
                    onClick={() => setShowPayoutDialog(true)}
                    disabled={!canRequestPayout || hasPendingPayout}
                  >
                    <DollarSign className="mr-2 h-4 w-4" />
                    {hasPendingPayout ? "Payout Pending" : "Request Payout"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-8 lg:grid-cols-2">
              {/* Revenue by Listing */}
              <Card>
                <CardHeader>
                  <CardTitle>Revenue by Agent</CardTitle>
                  <CardDescription>Earnings breakdown by published agent</CardDescription>
                </CardHeader>
                <CardContent>
                  {revenue.revenueByListing.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">
                      <Store className="mx-auto h-8 w-8 text-gray-300" />
                      <p className="mt-2">No revenue yet</p>
                    </div>
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
                    <div className="py-8 text-center text-muted-foreground">
                      <CreditCard className="mx-auto h-8 w-8 text-gray-300" />
                      <p className="mt-2">No payouts yet</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {payoutHistory.slice(0, 5).map((payout) => (
                        <div
                          key={payout.id}
                          className="flex items-center justify-between rounded-lg border p-3"
                        >
                          <div className="flex items-center gap-3">
                            {payout.status === "completed" ? (
                              <CheckCircle className="h-5 w-5 text-green-500" />
                            ) : payout.status === "failed" ? (
                              <XCircle className="h-5 w-5 text-red-500" />
                            ) : (
                              <Clock className="h-5 w-5 text-yellow-500" />
                            )}
                            <div>
                              <p className="font-medium text-foreground">
                                {formatCurrency(payout.amountCents)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {payoutMethodLabels[payout.payoutMethod]} &middot;{" "}
                                {formatDate(payout.requestedAt)}
                              </p>
                            </div>
                          </div>
                          <Badge variant={statusColors[payout.status]}>
                            {payout.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent Transactions */}
            <Card className="mt-8">
              <CardHeader>
                <CardTitle>Recent Transactions</CardTitle>
                <CardDescription>Latest revenue from your agents</CardDescription>
              </CardHeader>
              <CardContent>
                {revenue.recentTransactions.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    <TrendingUp className="mx-auto h-8 w-8 text-gray-300" />
                    <p className="mt-2">No transactions yet</p>
                    <p className="text-sm">
                      Revenue will appear here when users use your agents
                    </p>
                  </div>
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
                          <th className="pb-2 font-medium">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {revenue.recentTransactions.map((tx) => (
                          <tr key={tx.id}>
                            <td className="py-3 capitalize">{tx.type.replace("_", " ")}</td>
                            <td className="py-3">{tx.requestCount}</td>
                            <td className="py-3">{formatCurrency(tx.grossAmountCents)}</td>
                            <td className="py-3 text-muted-foreground">
                              -{formatCurrency(tx.platformFeeCents)}
                            </td>
                            <td className="py-3 font-medium text-green-600">
                              {formatCurrency(tx.creatorAmountCents)}
                            </td>
                            <td className="py-3 text-muted-foreground">
                              {formatDate(tx.createdAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

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
