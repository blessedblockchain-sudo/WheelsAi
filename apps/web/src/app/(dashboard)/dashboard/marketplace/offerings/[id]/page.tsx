"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SearchX } from "lucide-react";

import { Header } from "@/components/dashboard/header";
import { OfferingEditor } from "@/components/marketplace/offering-editor";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, offeringsApi, type PublisherOffering } from "@/lib/api";

/** Placeholder shaped like the editor's cards. */
function EditorSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">Loading offering</span>
      <Skeleton className="h-14 w-full rounded-lg" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-4 rounded-lg border bg-card p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

export default function EditOfferingPage() {
  const { id } = useParams<{ id: string }>();
  const [offering, setOffering] = useState<PublisherOffering | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await offeringsApi.getMine(id);
      setOffering(res.offering);
    } catch (error) {
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  const missing = loadError instanceof ApiError && (loadError.status === 404 || loadError.status === 400);

  return (
    <div className="flex flex-col">
      <Header
        title={offering ? offering.title : "Offering"}
        description="Edit, test and publish this offering"
        action={{ label: "All offerings", href: "/dashboard/marketplace/offerings" }}
      />
      <div className="max-w-3xl p-8">
        {isLoading ? (
          <EditorSkeleton />
        ) : missing ? (
          <EmptyState
            icon={SearchX}
            title="Offering not found"
            description="It does not exist in this organization."
            actionLabel="Back to offerings"
            actionHref="/dashboard/marketplace/offerings"
          />
        ) : loadError !== null || !offering ? (
          <ErrorState title="Couldn't load this offering" error={loadError} onRetry={() => void load()} />
        ) : (
          // Keyed by id only: a save updates the offering in place and the
          // editor keeps what is being typed.
          <OfferingEditor key={offering.id} offering={offering} onSaved={setOffering} />
        )}
      </div>
    </div>
  );
}
