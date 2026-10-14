"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Code2, Workflow } from "lucide-react";

import { PaidGate } from "@/components/public-agent/paid-gate";
import { workflowDoor } from "@/components/public-agent/paid-transport";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, paidWorkflowApi, type PublicWorkflowRead } from "@/lib/api";
import { API_PAGE_WORDS, workflowApiPagePath } from "@/lib/api-page";
import { PAID_WORKFLOW_MESSAGES, isPublicWorkflowRead, workflowPageTerms } from "@/lib/paid-use";

export interface PublicWorkflowViewProps {
  /** The name in the page's address, `/w/<slug>`: the listing's slug. */
  slug: string;
  /**
   * What the server read for this page: the workflow on sale, "not_found"
   * when nothing is on sale at this address, or null when the read failed and
   * the browser should try for itself.
   */
  initial: PublicWorkflowRead | "not_found" | null;
}

/** Placeholder shaped like the page: the header band, then the gate. */
function PublicWorkflowSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="border-b bg-card/50">
        <div className="container mx-auto max-w-3xl px-4 py-8">
          <Skeleton className="h-5 w-28" />
          <div className="mt-4 flex items-start gap-4">
            <Skeleton className="h-14 w-14 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-8 w-48 max-w-full" />
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
          </div>
        </div>
      </div>
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** The gate of the workflow on this page, with the door built from what the read said. */
function WorkflowGate({ read }: { read: PublicWorkflowRead }) {
  const door = useMemo(() => workflowDoor(read.slug, read.maxRunMinutes), [read.slug, read.maxRunMinutes]);
  const terms = useMemo(() => workflowPageTerms(read), [read]);
  const use = useMemo(
    // The form the read gives; a workflow whose own form has no fields is given one text box by the API.
    () => ({ task: { inputSchema: read.input.schema, maxInputChars: read.input.maxInputBytes } }),
    [read.input.schema, read.input.maxInputBytes],
  );
  return <PaidGate door={door} use={use} terms={terms} title={PAID_WORKFLOW_MESSAGES.panelTitle} />;
}

/**
 * The page of a workflow on sale: the listing's title and one line, the way
 * to its API page, then the gate (the plans first, pay as you go, the start,
 * the count, moving up) and the form that runs it. Anyone with the link can
 * open it; only running it needs a sign-in.
 *
 * Never on it: a chat, a list of results, receipts, a free try, a step, an
 * agent or a model inside the workflow, who sells it or how many use it.
 */
export function PublicWorkflowView({ slug, initial }: PublicWorkflowViewProps) {
  const [read, setRead] = useState<PublicWorkflowRead | null>(initial !== null && initial !== "not_found" ? initial : null);
  const [notFound, setNotFound] = useState(initial === "not_found");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(initial === null);
  // 0 = what the server read; bumped by retryLoad() to read again from the browser.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The server already answered; the browser reads only after a failed read or a retry.
    if (initial !== null && attempt === 0) return;
    let cancelled = false;
    paidWorkflowApi
      .get(slug)
      .then((res) => {
        if (cancelled) return;
        if (!isPublicWorkflowRead(res)) throw new Error(PAID_WORKFLOW_MESSAGES.loadFailed);
        setRead(res);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The API answers 404, with no sentence, for an unknown slug, a listing of an agent and one not on
        // sale for use (never revealing which); anything else is a failed load the visitor can retry.
        if (error instanceof ApiError && error.status === 404) setNotFound(true);
        else setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, initial, attempt]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  if (loading) return <PublicWorkflowSkeleton />;

  if (loadError !== null && !notFound) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <ErrorState
            title={PAID_WORKFLOW_MESSAGES.loadFailed}
            error={loadError}
            onRetry={retryLoad}
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  if (notFound || !read) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <EmptyState
            icon={Workflow}
            title={PAID_WORKFLOW_MESSAGES.notFoundTitle}
            description={PAID_WORKFLOW_MESSAGES.notFoundPage}
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50">
        <div className="container mx-auto max-w-3xl px-4 py-8">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Marketplace
          </Link>
          <div className="mt-4 flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Workflow className="h-7 w-7 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              {/* The listing's title and one line: never the workflow's own name. */}
              <h1 className="min-w-0 break-words text-2xl font-bold">{read.title}</h1>
              {read.description && (
                <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{read.description}</p>
              )}
              <Link
                href={workflowApiPagePath(read.slug)}
                className="mt-3 inline-flex items-center gap-2 rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Code2 className="h-4 w-4" aria-hidden="true" />
                {API_PAGE_WORDS.link}
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-8">
        {/* Keyed by the listing's slug, so a form never carries one workflow's answers to another. */}
        <WorkflowGate key={read.slug} read={read} />
      </main>
    </div>
  );
}
