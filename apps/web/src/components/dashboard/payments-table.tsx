"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  XCircle,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import {
  treasuryApi,
  type AgentPaymentsResponse,
  type ComputePaymentStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: Array<{
  value: ComputePaymentStatus | "ALL";
  label: string;
}> = [
  { value: "ALL", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "FAILED", label: "Failed" },
];

const STATUS_BADGE: Record<
  ComputePaymentStatus,
  {
    variant: "success" | "warning" | "destructive" | "secondary";
    icon: typeof CheckCircle2;
  }
> = {
  CONFIRMED: { variant: "success", icon: CheckCircle2 },
  FAILED: { variant: "destructive", icon: XCircle },
  SUBMITTED: { variant: "warning", icon: Clock },
  PENDING: { variant: "secondary", icon: Clock },
};

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
const PAGE_SIZE = 20;

function formatSol(lamportsStr: string): string {
  try {
    const lamports = BigInt(lamportsStr);
    const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
    if (sol >= 1) return `${sol.toFixed(3)}`;
    if (sol >= 0.001) return `${sol.toFixed(6)}`;
    return sol.toExponential(2);
  } catch {
    return "—";
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSig(sig: string | null): string {
  if (!sig) return "—";
  if (sig.length <= 12) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-4)}`;
}

interface Props {
  slug: string;
  /** Solana cluster for the explorer link suffix; default devnet. */
  cluster?: "mainnet-beta" | "devnet" | "testnet";
  className?: string;
}

export function PaymentsTable({ slug, cluster = "devnet", className }: Props) {
  const [data, setData] = useState<AgentPaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    ComputePaymentStatus | "ALL"
  >("ALL");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await treasuryApi.payments(slug, {
          limit: PAGE_SIZE,
          offset,
          status: statusFilter === "ALL" ? undefined : statusFilter,
        });
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load payments",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, statusFilter, offset]);

  const onChangeFilter = (next: ComputePaymentStatus | "ALL") => {
    setStatusFilter(next);
    setOffset(0); // reset pagination when the filter changes
  };

  const hasPrev = offset > 0;
  const hasNext = data ? offset + data.payments.length < data.totalCount : false;

  return (
    <Card className={className}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Compute payments</h3>
            <p className="text-xs text-muted-foreground">
              Treasury → Nosana host history
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={statusFilter}
              onChange={(e) =>
                onChangeFilter(e.target.value as typeof statusFilter)
              }
              className="h-8 w-[140px] text-xs"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {error ? (
          <div className="py-8 text-center text-sm text-red-500">{error}</div>
        ) : loading && !data ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data && data.payments.length === 0 ? (
          <div className="py-12 text-center">
            <Clock className="mx-auto mb-2 h-8 w-8 text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              {statusFilter === "ALL"
                ? "No compute payments yet."
                : `No ${statusFilter.toLowerCase()} payments.`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Payments appear here once the treasury starts auto-paying.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto -mx-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-left text-xs uppercase text-muted-foreground">
                    <th className="px-4 py-2 font-normal">Status</th>
                    <th className="px-4 py-2 font-normal">Amount (SOL)</th>
                    <th className="px-4 py-2 font-normal">Compute (s)</th>
                    <th className="px-4 py-2 font-normal">Scheduled</th>
                    <th className="px-4 py-2 font-normal">Paid</th>
                    <th className="px-4 py-2 font-normal">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.payments.map((p) => {
                    const badge = STATUS_BADGE[p.status];
                    const Icon = badge.icon;
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-border/20 hover:bg-muted/30"
                      >
                        <td className="px-4 py-2">
                          <Badge
                            variant={badge.variant}
                            className="gap-1 px-2 py-0.5 text-[10px]"
                          >
                            <Icon className="h-3 w-3" />
                            {p.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 font-mono tabular-nums">
                          {formatSol(p.amountLamports)}
                        </td>
                        <td className="px-4 py-2 font-mono tabular-nums">
                          {p.computeSeconds}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {formatTimestamp(p.scheduledFor)}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-2 text-xs",
                            p.paidAt
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatTimestamp(p.paidAt)}
                        </td>
                        <td className="px-4 py-2">
                          {p.txSignature ? (
                            <a
                              href={`https://explorer.solana.com/tx/${p.txSignature}?cluster=${cluster}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-xs text-blue-500 hover:underline"
                            >
                              {shortSig(p.txSignature)}
                              <ArrowUpRight className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {p.errorMessage ?? "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {offset + 1}–{offset + data!.payments.length} of {data!.totalCount}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={!hasPrev}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={!hasNext}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
