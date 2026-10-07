"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Coins,
  ExternalLink,
  Globe,
  Server,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { ApiError, publicAgentApi, type PublicAgentDetail } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { chatChannelLabel } from "@/lib/chat-channels";
import { Skeleton } from "@/components/ui/skeleton";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet";

function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}

function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`;
}

function lamportsToSol(lamports: string): string {
  const value = Number(BigInt(lamports)) / 1_000_000_000;
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const paymentStatusStyles: Record<string, string> = {
  CONFIRMED: "bg-green-500/15 text-green-500",
  SUBMITTED: "bg-blue-500/15 text-blue-400",
  PENDING: "bg-yellow-500/15 text-yellow-500",
  FAILED: "bg-red-500/15 text-red-500",
};

/**
 * Placeholder shaped like the page: header band, the three economics cards,
 * the deployments / channels pair and the payments table.
 */
function PublicAgentSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <span className="sr-only">Loading agent</span>
      <div className="border-b bg-card/50">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-5 w-28" />
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-xl" />
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-5xl px-4 py-8">
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="mt-2 h-8 w-24" />
              <Skeleton className="mt-1 h-4 w-28" />
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-3 h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border bg-card p-5">
          <Skeleton className="h-5 w-48" />
          <div className="mt-3 space-y-3">
            {Array.from({ length: 4 }).map((_, row) => (
              <div key={row} className="grid grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((__, col) => (
                  <Skeleton key={col} className={row === 0 ? "h-3 w-1/2" : "h-5 w-3/4"} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PublicAgentPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [detail, setDetail] = useState<PublicAgentDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by retryLoad() to run the fetch effect again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    publicAgentApi
      .get(slug)
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  if (loading) {
    return <PublicAgentSkeleton />;
  }

  // The API answers 404 for a missing or private agent (never revealing which);
  // anything else is a failed load the visitor can retry.
  const notFound = loadError instanceof ApiError && loadError.status === 404;

  if (loadError !== null && !notFound) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <ErrorState
            title="Couldn't load this agent"
            error={loadError}
            onRetry={retryLoad}
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <EmptyState
            icon={Bot}
            title="Agent not found"
            description="This agent doesn't exist or isn't public."
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  const { agent, treasury, uptime, eligibility, deployments, channels, recentPayments } =
    detail;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card/50">
        <div className="container mx-auto px-4 py-8">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Marketplace
          </Link>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10">
              <Bot className="h-7 w-7 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold">{agent.name}</h1>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium capitalize">
                  {agent.framework}
                </span>
                {eligibility && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      eligibility.eligible
                        ? "bg-green-500/15 text-green-500"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {eligibility.eligible
                      ? "Substance gate: passing"
                      : "Substance gate: not yet"}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Public receipts — every figure on this page is backed by on-chain or
                metered data. Since {formatDate(agent.createdAt)}.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-5xl px-4 py-8">
        {/* Economics cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="h-4 w-4" />
              Treasury balance
            </div>
            <p className="mt-2 text-2xl font-bold">
              {treasury ? `${treasury.balanceSol.toLocaleString()} SOL` : "—"}
            </p>
            {treasury ? (
              <a
                href={explorerAddress(treasury.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
              >
                {shortAddr(treasury.address)}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Not tokenized yet</p>
            )}
          </div>

          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Coins className="h-4 w-4" />
              Compute paid to date
            </div>
            <p className="mt-2 text-2xl font-bold">
              {treasury
                ? `${lamportsToSol(treasury.cumulativeComputePaidLamports)} SOL`
                : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Confirmed payments only
            </p>
          </div>

          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              GPU time served
            </div>
            <p className="mt-2 text-2xl font-bold">
              {uptime ? `${uptime.totalComputeHours.toLocaleString()}h` : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {uptime
                ? `${uptime.totalRequests.toLocaleString()} requests metered`
                : "No deployments measured yet"}
            </p>
          </div>
        </div>

        {/* Deployments + channels */}
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Server className="h-4 w-4 text-muted-foreground" />
              Deployments
            </div>
            {deployments.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No deployments yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {deployments.map((d, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">
                      {d.gpuTier} × {d.replicas}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        d.status === "running"
                          ? "bg-green-500/15 text-green-500"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {d.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" />
              Chat channels
            </div>
            {channels.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No chat channels enabled.
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {channels.map((c) => (
                  // live:false is a channel its owner set up that nothing
                  // serves yet. It is shown as that, never as active.
                  <span
                    key={c.platform}
                    className={`rounded-full px-3 py-1 text-sm ${
                      c.live === false ? "border border-dashed text-muted-foreground" : "bg-muted"
                    }`}
                  >
                    {chatChannelLabel(c.platform)}
                    {c.live === false && " (configured, not live yet)"}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Payments — the receipts */}
        <div className="mt-6 rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Recent compute payments
          </div>
          {recentPayments.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                icon={Activity}
                title="No compute payments yet"
                description="When this agent's treasury pays for GPU time, each settlement lands here with its transaction signature."
              />
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Amount</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Transaction</th>
                    <th className="pb-2 font-medium">Paid at</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPayments.map((p, i) => (
                    <tr key={p.txSignature ?? i} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium">
                        {lamportsToSol(p.amountLamports)} SOL
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            paymentStatusStyles[p.status] ??
                            "bg-muted text-muted-foreground"
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        {p.txSignature ? (
                          <a
                            href={explorerTx(p.txSignature)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                          >
                            {shortAddr(p.txSignature)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {formatDate(p.paidAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* What this page is */}
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-muted-foreground">
            This is a public transparency feed. Treasury balances and payment
            signatures are verifiable on Solana ({CLUSTER}); GPU time is metered
            from the same usage records that back on-chain reputation
            attestations. No account required.
          </p>
        </div>
      </div>
    </div>
  );
}
