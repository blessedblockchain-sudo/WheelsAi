"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, Code2, KeyRound, Workflow } from "lucide-react";

import { CodeBlock } from "@/components/marketing/code-block";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";
import { API_BASE_URL, ApiError, paidWorkflowApi, publicAgentApi, type AgentApiPage, type WorkflowApiPage } from "@/lib/api";
import {
  API_PAGE_HEADINGS,
  API_PAGE_WORDS,
  WORKFLOW_API_PAGE_WORDS,
  apiPageView,
  createKeyHref,
  isApiPageFor,
  type ApiPageHeader,
  type ApiPageReader,
} from "@/lib/api-page";
import { cn } from "@/lib/utils";

export interface ApiPageViewProps {
  /** The name in the page's address: an agent's handle in `/a/<handle>/api`, a listing's slug in `/w/<slug>/api`. */
  handle: string;
  /**
   * What the server read for this page: the page's data, "not_found" when
   * this address has no API page, or null when the read failed and the
   * browser should try for itself.
   */
  initial: AgentApiPage | WorkflowApiPage | "not_found" | null;
  /** Which API page this is, and so which read the browser makes: an agent's unless it says. */
  reader?: ApiPageReader;
}

/** Placeholder shaped like the page: the header band, then its parts. */
function ApiPageSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="border-b bg-card/50">
        <div className="container mx-auto max-w-3xl px-4 py-8">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="mt-4 h-8 w-64 max-w-full" />
          <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="container mx-auto max-w-3xl space-y-6 px-4 py-8">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** One part of the page: a heading and what stands under it. */
function Part({ id, heading, children }: { id: string; heading: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <h2 id={id} className="text-base font-semibold text-foreground">
        {heading}
      </h2>
      <div className="mt-3 min-w-0 space-y-3 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

/** Something a caller types or reads as it is: an address, a model id, a header's name. Long ones wrap. */
function Literal({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground", className)}>{children}</code>;
}

/** The headers of one group, each with its sentence. */
function HeaderList({ headers }: { headers: ApiPageHeader[] }) {
  return (
    <dl className="space-y-2">
      {headers.map((header) => (
        <div key={header.name} className="min-w-0">
          <dt>
            <Literal>{header.name}</Literal>
          </dt>
          {header.says && <dd className="mt-1">{header.says}</dd>}
        </div>
      ))}
    </dl>
  );
}

/**
 * The API page of a listing: where to send a request, three snippets, the
 * price and the plans, the limits, the usage headers and the refusals.
 * Anyone with the link can open it, signed in or not. Every word and number
 * on it comes from `apiPageView` (lib/api-page.ts), an agent's page and a
 * workflow's alike; only the read and the not-found words are the reader's.
 */
export function ApiPageView({ handle, initial, reader = "agent" }: ApiPageViewProps) {
  const { authed } = useSession();
  const [page, setPage] = useState<AgentApiPage | WorkflowApiPage | null>(
    initial !== null && initial !== "not_found" ? initial : null,
  );
  const [notFound, setNotFound] = useState(initial === "not_found");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(initial === null);
  // 0 = what the server read; bumped by retryLoad() to read again from the browser.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The server already answered; the browser reads only after a failed read or a retry.
    if (initial !== null && attempt === 0) return;
    let cancelled = false;
    // An agent's page by its handle, or a workflow's by its listing's slug: the one public read of each.
    const read: Promise<unknown> =
      reader === "workflow" ? paidWorkflowApi.getApiPage(handle) : publicAgentApi.getApiPage(handle);
    read
      .then((res) => {
        if (cancelled) return;
        if (!isApiPageFor(reader, res)) throw new Error(API_PAGE_WORDS.loadFailed);
        setPage(res);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The API answers 404 for an unknown handle and for an agent whose use
        // is not sold (never revealing which), and for a slug with no workflow
        // on sale, with no sentence; anything else can be retried.
        if (error instanceof ApiError && error.status === 404) setNotFound(true);
        else setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, initial, attempt, reader]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  if (loading) return <ApiPageSkeleton />;

  if (loadError !== null && !notFound) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <ErrorState
            title={API_PAGE_WORDS.loadFailed}
            error={loadError}
            onRetry={retryLoad}
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  // Null when the answer names nothing to call: shown as a page that does not exist.
  const view = page && !notFound ? apiPageView(page, API_BASE_URL) : null;

  if (!view) {
    // What the agent's public page, or the workflow's, shows for a page that does not exist.
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          {reader === "workflow" ? (
            <EmptyState
              icon={Workflow}
              title={WORKFLOW_API_PAGE_WORDS.notFoundTitle}
              description={WORKFLOW_API_PAGE_WORDS.notFound}
              actionLabel="Browse the marketplace"
              actionHref="/marketplace"
            />
          ) : (
            <EmptyState
              icon={Bot}
              title={API_PAGE_WORDS.notFoundTitle}
              description={API_PAGE_WORDS.notFound}
              actionLabel="Browse the marketplace"
              actionHref="/marketplace"
            />
          )}
        </div>
      </div>
    );
  }

  const hasHeaders = view.headers.always.length > 0 || view.headers.onPlan.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50">
        <div className="container mx-auto max-w-3xl px-4 py-8">
          <Link
            href={view.agentHref}
            className="inline-flex items-center gap-2 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {view.pageLabel}
          </Link>
          <div className="mt-4 flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Code2 className="h-7 w-7 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="min-w-0 break-words text-2xl font-bold">{view.title}</h1>
              <p className="mt-2 break-words text-sm text-muted-foreground">{view.intro}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl space-y-6 px-4 py-8">
        {/* Where to send a request, and the three snippets. Each snippet scrolls inside its own box. */}
        <Part id="api-call" heading={API_PAGE_HEADINGS.call}>
          {view.callNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          <p>
            <Literal>{view.callLine}</Literal>
          </p>
          {view.modelLine && (
            <p>
              <Literal>{view.modelLine}</Literal>
            </p>
          )}
          {view.snippets.map((snippet) => (
            <CodeBlock key={snippet.id} title={snippet.label} code={snippet.code} className="min-w-0 max-w-full" />
          ))}
          <p>{view.keyNote}</p>
          {view.otherEndpoints.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">{view.otherAddresses}</h3>
              <dl className="space-y-2">
                {view.otherEndpoints.map((endpoint) => (
                  <div key={endpoint.id} className="min-w-0">
                    <dt>
                      <Literal>{endpoint.line}</Literal>
                    </dt>
                    <dd className="mt-1">{endpoint.says}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Part>

        {/* With plans: the plans, then the price per use. Without: the one price. */}
        {view.plans.length > 0 ? (
          <Part id="api-plans" heading={API_PAGE_HEADINGS.plans}>
            <ul aria-labelledby="api-plans" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {view.plans.map((plan) => (
                <li key={plan.id} className="min-w-0 space-y-1 rounded-lg border bg-background p-4">
                  <h3 className="break-words text-sm font-semibold text-foreground">{plan.name}</h3>
                  <p className="text-base font-semibold text-foreground">{plan.price}</p>
                  <p>{plan.uses}</p>
                  <p>{plan.after}</p>
                </li>
              ))}
            </ul>
            {view.payAsYouGo && <p className="font-medium text-foreground">{view.payAsYouGo}</p>}
            <p>{view.priceNote}</p>
            {/* The listing's free trial, in one line. It is started on the agent's page, linked just below. */}
            {view.trialLine && <p>{view.trialLine}</p>}
            <p>
              {view.startPlan}{" "}
              <Link
                href={view.agentHref}
                className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {view.pageLabel}
              </Link>
            </p>
          </Part>
        ) : (
          <Part id="api-price" heading={API_PAGE_HEADINGS.price}>
            {view.priceLine && <p className="text-base font-semibold text-foreground">{view.priceLine}</p>}
            <p>{view.priceNote}</p>
            {/* A free trial beside a price with no plans: the same line, with the way to the agent's page. */}
            {view.trialLine && (
              <p>
                {view.trialLine}{" "}
                <Link
                  href={view.agentHref}
                  className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {view.pageLabel}
                </Link>
              </p>
            )}
          </Part>
        )}

        {view.limits.length > 0 && (
          <Part id="api-limits" heading={API_PAGE_HEADINGS.limits}>
            {view.limits.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Part>
        )}

        {hasHeaders && (
          <Part id="api-headers" heading={API_PAGE_HEADINGS.headers}>
            {view.headers.always.length > 0 && (
              <>
                <p>{API_PAGE_WORDS.headersAlways}</p>
                <HeaderList headers={view.headers.always} />
              </>
            )}
            {view.headers.onPlan.length > 0 && (
              <>
                <p>{API_PAGE_WORDS.headersOnPlan}</p>
                <HeaderList headers={view.headers.onPlan} />
              </>
            )}
          </Part>
        )}

        {view.refusals.length > 0 && (
          <Part id="api-refusals" heading={API_PAGE_HEADINGS.refusals}>
            <ul className="space-y-3">
              {view.refusals.map((refusal) => (
                <li key={refusal.code} className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">{refusal.status}</span>
                    <Literal>{refusal.code}</Literal>
                  </p>
                  <p className="mt-1">{refusal.message}</p>
                </li>
              ))}
            </ul>
          </Part>
        )}

        <Part id="api-key" heading={API_PAGE_HEADINGS.key}>
          <p>{view.oneKey}</p>
          <p>{view.keyScope}</p>
          <p>
            {view.startFirst}{" "}
            <Link
              href={view.agentHref}
              className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {view.pageLabel}
            </Link>
          </p>
          {/* Someone signed out goes through sign-in and lands on the keys page after it. */}
          <Link href={createKeyHref(authed)} className={cn(buttonVariants({ variant: "default" }), "w-full sm:w-auto")}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            {view.createKeyLabel}
          </Link>
        </Part>
      </main>
    </div>
  );
}
