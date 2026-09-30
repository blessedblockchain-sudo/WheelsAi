"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";

import { getErrorMessage } from "@/lib/api";

/**
 * Error counterpart of <EmptyState>: same props (all optional here, with
 * sensible defaults) plus `error` and `onRetry`.
 *
 *   <ErrorState
 *     title="Couldn't load deployments"
 *     error={error}
 *     onRetry={refetch}
 *   />
 *
 * `error` is rendered through getErrorMessage(), so API error bodies show the
 * server's message and generic "API Error: 500" text never reaches the user.
 */
interface ErrorStateProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  retryLabel?: string;
  /** The thrown value; its message is shown under the description. */
  error?: unknown;
}

const actionClass =
  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ErrorState({
  icon: Icon = AlertTriangle,
  title = "Something went wrong",
  description,
  actionLabel,
  actionHref,
  onAction,
  onRetry,
  retryLabel = "Try again",
  error,
}: ErrorStateProps) {
  const message = error !== undefined ? getErrorMessage(error, "") : "";

  const ActionButton = actionLabel
    ? actionHref
      ? (
        <Link
          href={actionHref}
          className={`${actionClass} border border-border text-foreground hover:bg-muted`}
        >
          {actionLabel}
        </Link>
      )
      : onAction
        ? (
          <button
            type="button"
            onClick={onAction}
            className={`${actionClass} border border-border text-foreground hover:bg-muted`}
          >
            {actionLabel}
          </button>
        )
        : null
    : null;

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center"
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
        <Icon className="h-7 w-7 text-destructive" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {message && (
        <p className="mt-2 max-w-md break-words font-mono text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {(onRetry || ActionButton) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`${actionClass} bg-primary text-primary-foreground hover:bg-primary/90`}
            >
              <RotateCw className="h-4 w-4" aria-hidden="true" />
              {retryLabel}
            </button>
          )}
          {ActionButton}
        </div>
      )}
    </div>
  );
}
