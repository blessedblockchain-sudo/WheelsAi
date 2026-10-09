"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Store } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { marketplaceApi, type AgentDetail, type MarketplaceListing } from "@/lib/api";
import { listAgentHref, listingForAgent, listingStatus } from "@/lib/agent-page";
import { cn } from "@/lib/utils";

export interface SellTabProps {
  agent: AgentDetail;
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "secondary"> = {
  published: "success",
  pending_review: "warning",
  draft: "secondary",
  archived: "secondary",
};

/**
 * Putting the agent on the marketplace: one card that leads to the listing
 * wizard, or, for an agent that is listed, the listing's state and a link to it.
 */
export function SellTab({ agent }: SellTabProps) {
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { listings } = await marketplaceApi.getMyListings();
      setListing(listingForAgent(listings, agent.id));
      setLoaded(true);
    } catch (err) {
      setError(err);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !loaded) {
    return <ErrorState title="Couldn't check this agent's listing" error={error} onRetry={load} />;
  }

  if (!loaded) {
    return (
      <Card aria-busy="true">
        <CardHeader>
          <Skeleton className="h-5 w-64 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-10 w-40" />
          <span className="sr-only">Loading</span>
        </CardContent>
      </Card>
    );
  }

  if (listing) {
    const status = listingStatus(listing.status);
    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="min-w-0 break-words text-base">{listing.title}</CardTitle>
            <Badge variant={STATUS_VARIANT[listing.status] ?? "secondary"}>{status.label}</Badge>
          </div>
          <CardDescription>{status.sentence}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {listing.status === "published" && (
            <Link href={`/marketplace/${listing.slug}`} className={cn(buttonVariants({ variant: "default" }))}>
              Open the listing
            </Link>
          )}
          <Link
            href={`/dashboard/marketplace/publish?edit=${encodeURIComponent(listing.id)}`}
            className={cn(buttonVariants({ variant: listing.status === "published" ? "outline" : "default" }))}
          >
            Edit the listing
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-6 sm:flex-row">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15" aria-hidden="true">
          <Store className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Put this agent on the marketplace</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You give it a title, a description and a category, and people can find it on the marketplace.
            </p>
          </div>
          <Link href={listAgentHref(agent.id)} className={cn(buttonVariants({ variant: "default" }))}>
            List this agent
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
