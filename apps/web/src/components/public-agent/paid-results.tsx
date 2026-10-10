"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, paidUseApi, paidUseRefusalOf, type PaidResults as PaidResultsAnswer } from "@/lib/api";
import { paidRefusalNotice } from "@/lib/paid-use";
import { PanelNoticeView } from "./panel-notice";
import { PublicResultsPanel } from "./public-results-panel";

export interface PaidResultsProps {
  /** The name in the page's address, `/a/<handle>`. */
  handle: string;
  /** Changes when the results should be read again. */
  read: number;
  /** The read was refused: the page reads where the person stands. */
  onRefused?: () => void;
}

/** A self-running agent's results as a subscriber reads them, in the page's own results panel. */
export function PaidResults({ handle, read, onRefused }: PaidResultsProps) {
  const [answer, setAnswer] = useState<PaidResultsAnswer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRefusal(null);
    paidUseApi
      .results(handle)
      .then((next) => {
        if (!cancelled) setAnswer(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const notice = paidRefusalNotice({
          status: error instanceof ApiError ? error.status : 0,
          refusal: paidUseRefusalOf(error),
          act: "results",
          unit: "message",
        });
        setAnswer(null);
        setRefusal(notice.message);
        // A refusal the API gave (not a lost connection) may mean the access changed.
        if (error instanceof ApiError) onRefused?.();
      });
    return () => {
      cancelled = true;
    };
    // onRefused is the page's own callback and changes with every draw of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, read, attempt]);

  if (refusal !== null) {
    return (
      <div className="p-4 sm:p-5">
        <PanelNoticeView
          notice={{
            message: refusal,
            fields: {},
            retryAfterSeconds: null,
            paused: false,
            action: { label: "Try again", run: () => setAttempt((n) => n + 1) },
          }}
        />
      </div>
    );
  }

  if (answer === null) {
    return (
      <div className="space-y-3 p-4 sm:p-5" aria-busy="true">
        <span className="sr-only">Loading results</span>
        <Skeleton className="h-4 w-40 max-w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <>
      <PublicResultsPanel resultsPublic latest={answer.results} />
      {answer.hasMore && (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Showing the latest {answer.results.length} results.
        </p>
      )}
    </>
  );
}
