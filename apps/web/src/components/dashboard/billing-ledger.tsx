"use client";

/**
 * The Billing page's credit ledger: the four tiles, what is held, the month's spending by kind, and
 * the transaction history with its filter, "Load more" and Export.
 *
 * Every figure, label and note here is the API's. What is drawn and how is decided in
 * lib/billing-view.ts, which is pure and tested.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CreditCard,
  DollarSign,
  Download,
  Lock,
  Minus,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  billingApi,
  downloadCreditLedger,
  type CreditBalance,
  type CreditHold,
  type CreditTransaction,
  type UsageSummary,
} from "@/lib/api";
import {
  HELD_TITLE,
  HISTORY_FILTERS,
  NOTHING_SPENT,
  SPENDING_TITLE,
  appendPage,
  balanceAfterText,
  drawAmount,
  exportFailure,
  exportRangeFor,
  exportRanges,
  filterOf,
  formatUsd,
  heldShown,
  listFailure,
  spendingShown,
  tilesShown,
  type ExportRange,
  type HistoryFilterKey,
} from "@/lib/billing-view";
import { cn } from "@/lib/utils";

const TILE_GRID = "mb-8 grid gap-6 sm:grid-cols-2 xl:grid-cols-4";

/** Stands in for the four tiles. */
export function BalanceTilesSkeleton() {
  return (
    <div className={TILE_GRID}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-6">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
              <div className="min-w-0 space-y-2">
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

function Tile({
  icon: Icon,
  tint,
  label,
  value,
}: {
  icon: LucideIcon;
  tint: string;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="py-6">
        <div className="flex items-center gap-4">
          <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-lg", tint)}>
            <Icon className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="break-words text-3xl font-bold tabular-nums text-foreground">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** The four tiles and, when anything is held, what holds it and why. */
export function BalanceTiles({
  balance,
  usage,
  holds,
}: {
  balance: CreditBalance | null;
  usage: UsageSummary | null;
  /** null when the list of holds did not arrive. */
  holds: CreditHold[] | null;
}) {
  const tiles = tilesShown(balance, usage);
  const held = heldShown(balance, holds);

  return (
    <>
      <div className={cn(TILE_GRID, (held.holds.length > 0 || held.notice) && "mb-4")}>
        <Tile
          icon={DollarSign}
          tint="bg-success/10 text-success"
          label="Available Credits"
          value={tiles.available}
        />
        <Tile
          icon={TrendingUp}
          tint="bg-primary/10 text-primary"
          label="Spent This Month"
          value={tiles.spent}
        />
        <Tile icon={Lock} tint="bg-muted text-muted-foreground" label="Held" value={tiles.held} />
        <Tile
          icon={Zap}
          tint="bg-primary/10 text-primary"
          label="GPU Hours This Month"
          value={tiles.gpuHours}
        />
      </div>

      {held.notice && (
        <p className="mb-8 text-sm text-muted-foreground" role="status">
          {held.notice}
        </p>
      )}

      {held.holds.length > 0 && (
        <Card className="mb-8" data-testid="billing-holds">
          <CardHeader>
            <CardTitle className="text-base">{HELD_TITLE}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {held.holds.map((hold) => (
                <li
                  key={`${hold.kind}:${hold.id}`}
                  className="flex items-start justify-between gap-4 rounded-lg border border-border p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-foreground">{hold.name}</p>
                    <p className="mt-0.5 break-words text-sm text-muted-foreground">{hold.note}</p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums text-foreground">
                    {formatUsd(hold.amount)}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** "Spending this month": the API's groups that are not zero, and its total. */
export function SpendingCard({ usage }: { usage: UsageSummary }) {
  const spending = spendingShown(usage);

  return (
    <Card className="mb-8" data-testid="billing-spending">
      <CardHeader>
        <CardTitle className="text-base">{SPENDING_TITLE}</CardTitle>
        <CardDescription>What your credits went to this calendar month (UTC)</CardDescription>
      </CardHeader>
      <CardContent>
        {spending.empty ? (
          <p className="text-sm text-muted-foreground">{NOTHING_SPENT}</p>
        ) : (
          <div className="space-y-4">
            {spending.lines.map((line) => (
              <div key={line.key} className="flex items-center justify-between gap-4">
                <p className="min-w-0 break-words font-medium text-foreground">{line.label}</p>
                <p className={cn("shrink-0 text-lg font-semibold tabular-nums", line.className)}>
                  {line.text}
                </p>
              </div>
            ))}

            {spending.total && (
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-lg font-semibold text-foreground">Total this month</p>
                  <p className={cn("shrink-0 text-xl font-bold tabular-nums", spending.total.className)}>
                    {spending.total.text}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* The month's counts, as the API measured them. They carry no price. */}
        <p className="mt-4 break-words text-sm text-muted-foreground">
          {usage.requests.toLocaleString()} requests, {usage.inputTokens.toLocaleString()} input
          tokens and {usage.outputTokens.toLocaleString()} output tokens this month.
        </p>
      </CardContent>
    </Card>
  );
}

function RowIcon({ direction }: { direction: "in" | "out" | "none" }) {
  const Icon = direction === "in" ? ArrowDownRight : direction === "out" ? ArrowUpRight : Minus;
  return (
    <div
      className={cn(
        "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg sm:flex",
        direction === "in" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-24 max-w-full sm:w-40" />
            <Skeleton className="h-4 w-32 max-w-full sm:w-56" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Skeleton className="h-6 w-16 sm:w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The transaction history: every row by its own sign with the balance after it, a filter of four
 * choices, "Load more" by cursor, and Export, which downloads the ledger as a file.
 *
 * It reads its own pages. `reloadKey` changes when the page has read the balance again (credits
 * were added), and the list starts over from the newest row.
 */
export function TransactionHistoryCard({ reloadKey }: { reloadKey: number }) {
  const [filter, setFilter] = useState<HistoryFilterKey>("all");
  const [rows, setRows] = useState<CreditTransaction[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportRange["key"] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // An answer for a filter that is no longer chosen is dropped.
  const asked = useRef(0);

  const loadFirst = useCallback(async (key: HistoryFilterKey) => {
    const mine = ++asked.current;
    setIsLoading(true);
    setListError(null);
    try {
      const page = await billingApi.getTransactions({ filter: filterOf(key) });
      if (mine !== asked.current) return;
      setRows(page.transactions);
      setNextCursor(page.nextCursor ?? null);
    } catch (error) {
      if (mine !== asked.current) return;
      setRows([]);
      setNextCursor(null);
      setListError(listFailure(error));
    } finally {
      if (mine === asked.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirst(filter);
  }, [filter, reloadKey, loadFirst]);

  async function loadMore() {
    if (!nextCursor || isLoadingMore) return;
    const mine = asked.current;
    setIsLoadingMore(true);
    setListError(null);
    try {
      const page = await billingApi.getTransactions({ filter: filterOf(filter), cursor: nextCursor });
      if (mine !== asked.current) return;
      setRows((shown) => appendPage(shown, page.transactions));
      setNextCursor(page.nextCursor ?? null);
    } catch (error) {
      // The rows already shown stay; the button stays, to ask again.
      if (mine === asked.current) setListError(listFailure(error));
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function runExport(key: ExportRange["key"]) {
    if (exporting) return;
    setExporting(key);
    setExportError(null);
    try {
      // Worked out at the click, so "today" is today even on a page left open past midnight (UTC).
      const range = exportRangeFor(key, new Date());
      await downloadCreditLedger({ from: range.from, to: range.to });
    } catch (error) {
      setExportError(exportFailure(error));
    } finally {
      setExporting(null);
    }
  }

  const chosen = HISTORY_FILTERS.find((choice) => choice.key === filter);

  return (
    <Card data-testid="billing-history">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle className="text-base">Transaction History</CardTitle>
          <CardDescription>Every change to your credits, newest first</CardDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0" isLoading={exporting !== null}>
              <Download className="mr-2 h-4 w-4" aria-hidden />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            {/* Only the choices are drawn here; the dates are worked out when one is clicked. */}
            {exportRanges(new Date()).map((range) => (
              <DropdownMenuItem key={range.key} onClick={() => void runExport(range.key)}>
                {range.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent>
        <div role="status" aria-live="polite">
          {exportError && (
            <p className="mb-4 break-words rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-foreground">
              {exportError}
            </p>
          )}
        </div>

        <div
          role="radiogroup"
          aria-label="Show"
          className="mb-4 inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border bg-muted p-1"
        >
          {HISTORY_FILTERS.map((choice) => (
            <label
              key={choice.key}
              className={cn(
                "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-ring",
                choice.key === filter
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <input
                type="radio"
                name="ledger-filter"
                value={choice.key}
                className="sr-only"
                checked={choice.key === filter}
                onChange={() => setFilter(choice.key)}
              />
              {choice.label}
            </label>
          ))}
        </div>

        <div aria-busy={isLoading}>
          {isLoading ? (
            <>
              <HistorySkeleton />
              <span className="sr-only">Loading transactions</span>
            </>
          ) : rows.length === 0 && listError ? null : rows.length === 0 ? (
            filter === "all" ? (
              <EmptyState
                icon={CreditCard}
                title="No transactions yet"
                description="Credit purchases, bonuses, usage charges and refunds will show here."
                actionLabel="Add Credits"
                actionHref="#add-credits"
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing under {chosen?.label ?? "this filter"} yet.
              </p>
            )
          ) : (
            <ul className="space-y-3">
              {rows.map((tx) => {
                const amount = drawAmount(tx.amount);
                return (
                  <li
                    key={tx.id}
                    className="flex flex-col gap-2 rounded-lg border border-border p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-4">
                      <RowIcon direction={amount.direction} />
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium text-foreground">{tx.label}</p>
                        {tx.description && tx.description !== tx.label && (
                          <p className="break-words text-sm text-muted-foreground">{tx.description}</p>
                        )}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          <time dateTime={tx.createdAt}>{new Date(tx.createdAt).toLocaleString()}</time>
                        </p>
                      </div>
                    </div>

                    {/* Beside the row on a wide screen, under it on a narrow one. */}
                    <div className="flex items-baseline justify-between gap-3 sm:block sm:shrink-0 sm:text-right">
                      <p className={cn("text-lg font-semibold tabular-nums", amount.className)}>
                        {amount.text}
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {balanceAfterText(tx.balanceAfter)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div role="status" aria-live="polite">
          {listError && !isLoading && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <p className="break-words text-sm text-foreground">{listError}</p>
              {rows.length === 0 && (
                <Button variant="outline" size="sm" onClick={() => void loadFirst(filter)}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>

        {!isLoading && nextCursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={() => void loadMore()} isLoading={isLoadingMore}>
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
