"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Briefcase, ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, jobsApi, offeringsApi, type JobSummary, type PublisherOffering } from "@/lib/api";
import { OFFERING_STATUS, PRODUCT_KIND_LABEL, formatCents, formatDuration } from "@/lib/jobs";

/** Placeholder shaped like the rows of the offerings list. */
function OfferingRowsSkeleton() {
  return (
    <div className="divide-y" aria-busy="true">
      <span className="sr-only">Loading offerings</span>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}

function jobCount(offering: PublisherOffering, ...statuses: string[]): number {
  return statuses.reduce((sum, status) => sum + (offering.stats.jobs[status] ?? 0), 0);
}

export default function OfferingsPage() {
  const [offerings, setOfferings] = useState<PublisherOffering[]>([]);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  async function load() {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [mine, waiting] = await Promise.all([
        offeringsApi.listMine(),
        // The inbox count is a convenience; the list stands without it.
        jobsApi.summary().catch(() => null),
      ]);
      setOfferings(mine.offerings);
      setSummary(waiting);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load your offerings"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex flex-col">
      <Header
        title="Offerings"
        description="Fixed tasks your agents, workflows and models run for buyers, paid through escrow"
        action={{ label: "New offering", href: "/dashboard/marketplace/offerings/new" }}
      />

      <div className="space-y-6 p-8">
        {summary !== null && summary.toDeliver > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
            <span className="text-foreground">
              {summary.toDeliver} {summary.toDeliver === 1 ? "job is" : "jobs are"} queued or running on your
              offerings.
            </span>
            <Link href="/dashboard/jobs?tab=received" className="font-medium text-primary underline underline-offset-2">
              Open the jobs inbox
            </Link>
          </div>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Your offerings</CardTitle>
            <Link href="/dashboard/jobs?tab=received" className="text-sm font-medium text-primary hover:underline">
              Jobs inbox
            </Link>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <OfferingRowsSkeleton />
            ) : loadError !== null ? (
              <ErrorState title="Couldn't load your offerings" error={loadError} onRetry={() => void load()} />
            ) : offerings.length === 0 ? (
              <EmptyState
                icon={Briefcase}
                title="No offerings yet"
                description="Package one of your agents, workflows or models as a fixed task with a price. Buyers hire it, you are paid when they accept the result."
                actionLabel="Create your first offering"
                actionHref="/dashboard/marketplace/offerings/new"
              />
            ) : (
              <ul className="divide-y">
                {offerings.map((offering) => {
                  const open = jobCount(offering, "funded", "running");
                  const review = jobCount(offering, "submitted");
                  const done = jobCount(offering, "completed");
                  return (
                    <li key={offering.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/dashboard/marketplace/offerings/${offering.id}`}
                            className="truncate font-medium text-foreground hover:text-primary"
                          >
                            {offering.title}
                          </Link>
                          <Badge variant={OFFERING_STATUS[offering.status].tone}>
                            {OFFERING_STATUS[offering.status].label}
                          </Badge>
                          {!offering.productAvailable && <Badge variant="destructive">Product deleted</Badge>}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {PRODUCT_KIND_LABEL[offering.productKind]}: {offering.product.name} ·{" "}
                          {formatCents(offering.priceCents)} per job · within {formatDuration(offering.slaSeconds)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {open} in progress · {review} awaiting the buyer · {done} completed
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {offering.status === "active" && (
                          <Link
                            href={`/marketplace/offerings/${offering.slug}`}
                            className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ExternalLink className="h-4 w-4" aria-hidden />
                            Public page
                          </Link>
                        )}
                        <Link href={`/dashboard/marketplace/offerings/${offering.id}`}>
                          <Button variant="outline" size="sm">
                            {offering.status === "archived" ? "View" : "Edit"}
                          </Button>
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {!isLoading && loadError === null && offerings.length > 0 && (
          <Link
            href="/dashboard/marketplace/offerings/new"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New offering
          </Link>
        )}
      </div>
    </div>
  );
}
