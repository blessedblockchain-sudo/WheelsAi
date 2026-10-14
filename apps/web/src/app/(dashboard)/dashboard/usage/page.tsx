"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, Wallet, Workflow } from "lucide-react";

import { Header } from "@/components/dashboard/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { billingApi, type MarketplaceUsage } from "@/lib/api";
import {
  ADD_CREDITS_HREF,
  USAGE_BAR_MARKS,
  USAGE_WORDS,
  usageView,
  type UsageBar,
  type UsageRowView,
} from "@/lib/usage-view";

// Every word and every number on this page comes from lib/usage-view.ts, which reads the one answer of
// GET /api/billing/marketplace-usage. The page has three states: loading, could not load, and the answer.

const TONE_CLASS = {
  ok: "text-muted-foreground",
  warn: "text-amber-500",
} as const;

/** The fill of the bar by its warning. The warning is also said in words beside the bar. */
const FILL_CLASS = {
  none: "bg-primary",
  85: "bg-amber-500",
  100: "bg-danger",
} as const;

/**
 * The uses of a plan's period. The bar is one image with a text alternative; the same numbers are in
 * text above it, and a warning is a badge with words and an icon, not a colour alone.
 */
function UsesBar({ bar }: { bar: UsageBar }) {
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{bar.usedText}</p>
        {bar.levelLabel && (
          <Badge variant={bar.level === 100 ? "destructive" : "warning"} className="gap-1">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {bar.levelLabel}
          </Badge>
        )}
      </div>
      <div role="img" aria-label={bar.label} className="relative mt-2 h-3 w-full rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${FILL_CLASS[bar.level ?? "none"]}`}
          style={{ width: `${bar.percent}%` }}
        />
        {USAGE_BAR_MARKS.map((mark) => (
          <span
            key={mark.at}
            className="absolute -top-1 h-5 w-0.5 -translate-x-full bg-foreground/60"
            style={{ left: `${mark.at}%` }}
          />
        ))}
      </div>
      <div aria-hidden="true" className="relative mt-1 h-4 text-[10px] text-muted-foreground">
        {USAGE_BAR_MARKS.map((mark) => (
          <span key={mark.at} className="absolute -translate-x-full" style={{ left: `${mark.at}%` }}>
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One listing the organization pays to use. A row with no plan has no bar and no count. */
function UsageRow({ row }: { row: UsageRowView }) {
  // A workflow's row has a workflow's icon; both open where Installed opens them.
  const Icon = row.productKind === "workflow" ? Workflow : Bot;
  return (
    <li className="py-5">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {row.href ? (
          <Link href={row.href} className="min-w-0 break-words font-medium text-foreground underline-offset-4 hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="min-w-0 break-words font-medium text-foreground">{row.title}</span>
        )}
        {row.planName && <Badge variant="secondary">{row.planName}</Badge>}
      </div>

      {row.bar && <UsesBar bar={row.bar} />}

      <div className="mt-2 space-y-1 text-sm">
        {row.renewalLine && <p className={TONE_CLASS.warn}>{row.renewalLine}</p>}
        {row.countLine && <p className={TONE_CLASS[row.countTone]}>{row.countLine}</p>}
        {row.extraLine && <p className="text-foreground">{row.extraLine}</p>}
        {row.perUseLine && <p className="text-foreground">{row.perUseLine}</p>}
        {row.statusLine && <p className="text-muted-foreground">{row.statusLine}</p>}
      </div>
    </li>
  );
}

/** Stands in for the balance card and two rows while the answer is on its way. */
function UsageSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading your usage</span>
      <Skeleton className="mb-6 h-24 w-full rounded-lg" />
      <div className="space-y-4">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [usage, setUsage] = useState<MarketplaceUsage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  async function loadUsage() {
    setIsLoading(true);
    setLoadError(null);
    try {
      setUsage(await billingApi.getMarketplaceUsage());
    } catch (error) {
      setUsage(null);
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadUsage();
  }, []);

  const view = usageView(usage);

  return (
    <div className="flex flex-col">
      <Header title={USAGE_WORDS.title} description={USAGE_WORDS.description} />

      <div className="p-4 sm:p-8">
        {isLoading ? (
          <UsageSkeleton />
        ) : loadError !== null ? (
          <ErrorState title={USAGE_WORDS.loadFailed} error={loadError} onRetry={loadUsage} />
        ) : (
          <>
            {/* The one balance, and the way to add to it */}
            <Card className="mb-6">
              <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Wallet className="h-5 w-5 text-primary" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground">{USAGE_WORDS.balanceLabel}</p>
                    {view.balance !== null && <p className="text-2xl font-bold text-foreground">{view.balance}</p>}
                    <p className="text-xs text-muted-foreground">{USAGE_WORDS.balanceNote}</p>
                  </div>
                </div>
                <Link href={ADD_CREDITS_HREF}>
                  <Button>{USAGE_WORDS.addCredits}</Button>
                </Link>
              </CardContent>
            </Card>

            {/* A row for each listing in use, or the one sentence of an organization that uses nothing */}
            {view.empty !== null ? (
              <EmptyState
                icon={Bot}
                title={USAGE_WORDS.listTitle}
                description={view.empty}
                actionLabel={USAGE_WORDS.browse}
                actionHref="/marketplace"
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{USAGE_WORDS.listTitle}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {view.rows.map((row) => (
                      <UsageRow key={row.listingId} row={row} />
                    ))}
                  </ul>
                  <p className="mt-4 text-xs text-muted-foreground">{USAGE_WORDS.utcNote}</p>
                </CardContent>
              </Card>
            )}

            <p className="mt-6 text-sm">
              <Link href="/dashboard/keys" className="text-primary underline-offset-4 hover:underline">
                {USAGE_WORDS.keysLink}
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
