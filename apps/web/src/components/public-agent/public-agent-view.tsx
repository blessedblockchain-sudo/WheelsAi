"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, PauseCircle } from "lucide-react";

import { AgentKindBadge } from "@/components/dashboard/agent-kind-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, publicAgentApi, type PublicAgentDetail } from "@/lib/api";
import { PUBLIC_USE_MESSAGES } from "@/lib/public-use";
import { useHydrated } from "./local-time";
import { PaidGate } from "./paid-gate";
import { PublicChatPanel } from "./public-chat-panel";
import { PublicReceipts, PublicReceiptsSkeleton } from "./public-receipts";
import { PublicResultsPanel } from "./public-results-panel";
import { PublicTaskPanel } from "./public-task-panel";
import { freeChatTransport, freeTaskTransport } from "./transport";

export interface PublicAgentViewProps {
  /** The name in the page's address, `/a/<handle>`. */
  handle: string;
  /**
   * What the server read for this page: the agent, "not_found" when there is
   * no public agent at this address, or null when the read failed and the
   * browser should try for itself.
   */
  initial: PublicAgentDetail | "not_found" | null;
}

/** Placeholder shaped like the page: the header band, the panel and the receipts. */
function PublicAgentSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <span className="sr-only">Loading agent</span>
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
        <div className="mt-10">
          <PublicReceiptsSkeleton />
        </div>
      </div>
    </div>
  );
}

const PANEL_TITLES = {
  chat: (name: string) => `Chat with ${name}`,
  task: () => "Give it a task",
  scheduled: () => "Latest results",
} as const;

/** The panel of the agent's kind, or the sentence that stands in for it. */
function UsePanel({ detail }: { detail: PublicAgentDetail }) {
  const { agent, use } = detail;
  // Public use was stopped while this visitor was here: a send found the page off.
  const [stopped, setStopped] = useState(false);
  const key = use.state === "on" ? use.key : null;
  const chatTransport = useMemo(() => (key && use.chat ? freeChatTransport(key) : null), [key, use.chat]);
  const taskTransport = useMemo(() => (key && use.task ? freeTaskTransport(key) : null), [key, use.task]);

  // The page is shown and nobody can use the agent from it yet: receipts only.
  if (use.state === "view_only") return null;

  const kind = use.chat ? "chat" : use.task ? "task" : "scheduled";
  // Sold: people sign in and pay to use it. The price, the sign-in and the panel are the gate's.
  if (use.state === "paid" && use.paid) {
    return <PaidGate detail={detail} terms={use.paid} title={PANEL_TITLES[kind](agent.name)} />;
  }
  const usable = use.state === "on" && !stopped && (kind === "scheduled" || key !== null);
  const titleId = "public-use-title";

  if (!usable) {
    return (
      <section
        aria-label="Use this agent"
        className="flex items-start gap-3 rounded-xl border bg-card p-5 text-sm text-muted-foreground"
        role="status"
      >
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>{PUBLIC_USE_MESSAGES.paused}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3 sm:px-5">
        <h2 id={titleId} className="text-base font-semibold">
          {PANEL_TITLES[kind](agent.name)}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {PUBLIC_USE_MESSAGES.noCharge}
          {use.transcriptsStored && ` ${PUBLIC_USE_MESSAGES.transcriptsStored}`}
        </p>
      </div>
      {use.chat && chatTransport && (
        <PublicChatPanel
          agentName={agent.name}
          limits={use.chat}
          transport={chatTransport}
          onPaused={() => setStopped(true)}
        />
      )}
      {use.task && taskTransport && (
        <PublicTaskPanel
          inputSchema={use.task.inputSchema}
          maxInputChars={use.task.maxInputChars}
          transport={taskTransport}
          onPaused={() => setStopped(true)}
        />
      )}
      {use.scheduled && (
        <PublicResultsPanel
          resultsPublic={use.scheduled.resultsPublic}
          latest={use.scheduled.latest.map((result) => ({ finishedAt: result.finishedAt, text: result.text ?? "" }))}
        />
      )}
    </section>
  );
}

/**
 * An agent's public page: its name, how it is used, what it does, the panel
 * of its kind, then its receipts. Anyone with the link can open it; only
 * using an agent that is sold needs a sign-in.
 */
export function PublicAgentView({ handle, initial }: PublicAgentViewProps) {
  const hydrated = useHydrated();
  const [detail, setDetail] = useState<PublicAgentDetail | null>(initial !== null && initial !== "not_found" ? initial : null);
  const [notFound, setNotFound] = useState(initial === "not_found");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(initial === null);
  // 0 = what the server read; bumped by retryLoad() to read again from the browser.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The server already answered; the browser reads only after a failed read or a retry.
    if (initial !== null && attempt === 0) return;
    let cancelled = false;
    publicAgentApi
      .get(encodeURIComponent(handle))
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The API answers 404 for a missing or private agent (never revealing
        // which); anything else is a failed load the visitor can retry.
        if (error instanceof ApiError && error.status === 404) setNotFound(true);
        else setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, initial, attempt]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  if (loading) return <PublicAgentSkeleton />;

  if (loadError !== null && !notFound) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <ErrorState
            title="Couldn't load this agent"
            error={loadError}
            onRetry={retryLoad}
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto max-w-3xl px-4 py-24">
          <EmptyState
            icon={Bot}
            title="Agent not found"
            description="This agent doesn't exist or isn't public."
            actionLabel="Browse the marketplace"
            actionHref="/marketplace"
          />
        </div>
      </div>
    );
  }

  const { agent } = detail;

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
              <Bot className="h-7 w-7 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 className="min-w-0 break-words text-2xl font-bold">{agent.name}</h1>
                <AgentKindBadge kind={agent.agentKind} />
              </div>
              {agent.description && (
                <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{agent.description}</p>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl space-y-10 px-4 py-8">
        {/* Keyed by the address, so a panel never carries one agent's chat to another. */}
        <UsePanel key={agent.handle} detail={detail} />
        {hydrated ? <PublicReceipts detail={detail} /> : <PublicReceiptsSkeleton />}
      </main>
    </div>
  );
}
