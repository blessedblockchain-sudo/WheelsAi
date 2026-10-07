"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Bot, Box, CheckCircle, ChevronRight, Clock, SearchX, ShieldCheck, Star, Workflow } from "lucide-react";

import { HirePanel } from "@/components/marketplace/hire-panel";
import { MarketplacePublicShell } from "@/components/marketplace/public-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, offeringsApi, type OfferingTrackRecord, type PublicOffering } from "@/lib/api";
import { PRODUCT_KIND_LABEL, describeCheck, formatCents, formatDuration } from "@/lib/jobs";
import { fieldsFromSchema, type FieldKind } from "@/lib/schema-form";

type Offering = PublicOffering & { trackRecord: OfferingTrackRecord };

const KIND_ICON = { agent: Bot, workflow: Workflow, model: Box } as const;

/** A field's type, for a reader who has never seen a JSON Schema. */
const KIND_WORDS: Record<FieldKind, string> = {
  string: "Text",
  text: "Text",
  number: "Number",
  integer: "Whole number",
  boolean: "Yes or no",
  enum: "One of a list",
  "string-array": "A list of text items",
  json: "JSON",
};

/** The page's frame with placeholders where the offering will be. */
function OfferingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
      <span className="sr-only">Loading offering</span>
      <Skeleton className="h-4 w-56" />
      <div className="mt-6 grid gap-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <div className="flex gap-4">
              <Skeleton className="h-16 w-16 shrink-0 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-7 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </div>
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-5/6" />
          </div>
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
        <Skeleton className="h-96 w-full rounded-lg" />
      </div>
    </div>
  );
}

function TrackRecord({ record }: { record: OfferingTrackRecord }) {
  const finished = record.completed + record.rejected + record.failed + record.expired;
  if (finished === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No jobs have finished on this offering yet. Your payment is held in escrow either way: you pay only for a
        result you accept.
      </p>
    );
  }
  const stats = [
    { label: "Completed", value: record.completed.toLocaleString() },
    {
      label: "Success rate",
      value: record.successRate === null ? "n/a" : `${Math.round(record.successRate * 100)}%`,
    },
    {
      label: "Typical delivery",
      value: record.medianTurnaroundSeconds === null ? "n/a" : formatDuration(record.medianTurnaroundSeconds),
    },
    {
      label: "Buyer rating",
      value: record.avgRating === null ? "n/a" : `${record.avgRating.toFixed(1)} (${record.ratingCount})`,
    },
  ];
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="mt-1 text-lg font-semibold text-foreground">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Of {finished.toLocaleString()} finished jobs: {record.completed} completed, {record.rejected} rejected by the
        buyer, {record.failed} failed, {record.expired} expired. Every job that did not complete was refunded.
      </p>
    </>
  );
}

export default function OfferingPage() {
  const { slug } = useParams<{ slug: string }>();
  const [offering, setOffering] = useState<Offering | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await offeringsApi.get(slug);
      setOffering(res.offering);
    } catch (error) {
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    if (slug) void load();
  }, [slug, load]);

  // A hire was refused because the offering changed: show it as it is now,
  // in place, so what the buyer typed and the notice telling them why stay.
  const refresh = useCallback(async () => {
    try {
      setOffering((await offeringsApi.get(slug)).offering);
    } catch (error) {
      // Gone or unreachable: the full load says which.
      setOffering(null);
      setLoadError(error);
    }
  }, [slug]);

  if (isLoading) {
    return (
      <MarketplacePublicShell>
        <OfferingSkeleton />
      </MarketplacePublicShell>
    );
  }

  if (loadError !== null || !offering) {
    const missing = loadError instanceof ApiError && loadError.status === 404;
    return (
      <MarketplacePublicShell>
        <div className="mx-auto max-w-3xl px-4 py-16">
          {missing ? (
            <EmptyState
              icon={SearchX}
              title="This offering is not available"
              description="It may have been paused or withdrawn by its publisher."
              actionLabel="Browse the marketplace"
              actionHref="/marketplace"
            />
          ) : (
            <ErrorState title="Couldn't load this offering" error={loadError} onRetry={() => void load()} />
          )}
        </div>
      </MarketplacePublicShell>
    );
  }

  const Icon = KIND_ICON[offering.productKind] ?? Bot;
  const { fields, freeform } = fieldsFromSchema(offering.inputSchema);

  return (
    <MarketplacePublicShell>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/marketplace" className="hover:text-foreground">
            Marketplace
          </Link>
          <ChevronRight className="h-4 w-4" aria-hidden />
          <Link href={`/marketplace?type=${offering.productKind}s&view=tasks`} className="hover:text-foreground">
            {PRODUCT_KIND_LABEL[offering.productKind]} offerings
          </Link>
          <ChevronRight className="h-4 w-4" aria-hidden />
          <span className="truncate text-foreground">{offering.title}</span>
        </nav>

        <div className="mt-6 grid gap-8 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="rounded-lg border bg-card p-6" aria-labelledby="offering-title">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/25">
                  <Icon className="h-8 w-8 text-primary-600" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 id="offering-title" className="text-2xl font-bold text-foreground">
                    {offering.title}
                  </h1>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>by {offering.publisher.name}</span>
                    {offering.publisher.isVerified && (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <ShieldCheck className="h-4 w-4" aria-hidden />
                        Verified
                      </span>
                    )}
                    <span aria-hidden>·</span>
                    <span>
                      {PRODUCT_KIND_LABEL[offering.productKind]}: {offering.product.name}
                    </span>
                  </p>
                </div>
              </div>

              <p className="mt-5 whitespace-pre-line text-foreground">{offering.description}</p>

              <dl className="mt-6 grid grid-cols-2 gap-4 border-t pt-5 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Price per job</dt>
                  <dd className="mt-1 font-semibold text-foreground">{formatCents(offering.priceCents)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Delivered within</dt>
                  <dd className="mt-1 flex items-center gap-1 font-semibold text-foreground">
                    <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {formatDuration(offering.slaSeconds)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Time to review</dt>
                  <dd className="mt-1 font-semibold text-foreground">{offering.reviewWindowHours} hours</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">You receive</dt>
                  <dd className="mt-1 font-semibold text-foreground">
                    {offering.outputFormat === "json" ? "Structured JSON" : "Text"}
                  </dd>
                </div>
              </dl>

              {offering.listing && (
                <p className="mt-5 text-sm text-muted-foreground">
                  Runs on the listed agent{" "}
                  <Link
                    href={`/marketplace/${offering.listing.slug}`}
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    {offering.listing.title}
                  </Link>
                  , which you can also install and run yourself.
                </p>
              )}
            </section>

            <section className="rounded-lg border bg-card p-6" aria-labelledby="offering-input">
              <h2 id="offering-input" className="font-semibold text-foreground">
                What you send
              </h2>
              {freeform ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Any JSON object. The publisher has not described specific fields.
                </p>
              ) : (
                <ul className="mt-3 divide-y">
                  {fields.map((field) => (
                    <li key={field.name} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
                      <span className="font-medium text-foreground">
                        {field.title}
                        {field.required && <span className="ml-2 text-xs font-normal text-muted-foreground">required</span>}
                      </span>
                      <span className="text-muted-foreground">
                        {field.description ?? (field.options ? field.options.join(", ") : KIND_WORDS[field.kind])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border bg-card p-6" aria-labelledby="offering-checks">
              <h2 id="offering-checks" className="font-semibold text-foreground">
                Checks the result must pass
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                A result that fails any of these is never delivered: the job fails and you are refunded.
              </p>
              <ul className="mt-3 space-y-2 text-sm text-foreground">
                {offering.deliverableChecks.map((check, index) => (
                  <li key={index} className="flex gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    {describeCheck(check as Parameters<typeof describeCheck>[0])}
                  </li>
                ))}
                <li className="flex gap-2">
                  <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  {describeCheck({ type: "confidentiality" })}
                </li>
              </ul>
            </section>

            <section className="rounded-lg border bg-card p-6" aria-labelledby="offering-record">
              <h2 id="offering-record" className="flex items-center gap-2 font-semibold text-foreground">
                <Star className="h-4 w-4 text-muted-foreground" aria-hidden />
                Track record
              </h2>
              <TrackRecord record={offering.trackRecord} />
            </section>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start" aria-label="Hire">
            <HirePanel offering={offering} onTermsChanged={() => void refresh()} />
          </aside>
        </div>
      </div>
    </MarketplacePublicShell>
  );
}
