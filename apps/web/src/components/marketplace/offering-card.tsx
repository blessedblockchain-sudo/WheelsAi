import Link from "next/link";
import { Bot, Box, Clock, ShieldCheck, Workflow } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { PublicOffering } from "@/lib/api";
import { PRODUCT_KIND_LABEL, formatCents, formatDuration } from "@/lib/jobs";

const KIND_ICON = { agent: Bot, workflow: Workflow, model: Box } as const;

/** One offering in a grid: what it does, who runs it, the price and the delivery time. */
export function OfferingCard({ offering }: { offering: PublicOffering }) {
  const Icon = KIND_ICON[offering.productKind] ?? Bot;
  return (
    <Link
      href={`/marketplace/offerings/${offering.slug}`}
      className="group block rounded-lg border bg-card p-5 transition-all hover:border-primary/30 hover:shadow-md"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/25">
          <Icon className="h-6 w-6 text-primary-600" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-foreground group-hover:text-primary-600">{offering.title}</h3>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <span className="truncate">by {offering.publisher.name}</span>
            {offering.publisher.isVerified && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Verified publisher" />
            )}
          </p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{offering.description}</p>

      <div className="mt-4 flex items-center gap-3 text-sm text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{PRODUCT_KIND_LABEL[offering.productKind]}</span>
        <span className="flex min-w-0 items-center gap-1">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">within {formatDuration(offering.slaSeconds)}</span>
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="truncate text-xs text-muted-foreground">Runs on {offering.product.name}</span>
        <span className="font-semibold text-foreground">{formatCents(offering.priceCents)} per job</span>
      </div>
    </Link>
  );
}

/** Placeholder shaped like one <OfferingCard>. */
export function OfferingCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-12 flex-shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-20" />
      </div>
    </div>
  );
}
