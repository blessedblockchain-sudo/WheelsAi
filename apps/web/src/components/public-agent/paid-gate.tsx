"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";
import {
  ApiError,
  marketplaceApi,
  paidUseApi,
  paidUseRefusalOf,
  type PaidUseAccessState,
  type PaidUseTerms,
  type PublicAgentDetail,
  type PublicAgentPaidTerms,
} from "@/lib/api";
import {
  ADD_CREDITS_HREF,
  PAID_USE_MESSAGES,
  expectedTerms,
  lastResultLine,
  noticeOfView,
  paidRefusalNotice,
  paidView,
  priceLine,
  priceOfPage,
  privacyLine,
  registerHref,
  scheduleLines,
  signInHref,
  taskDraftKey,
  tryFreeHref,
  type PaidAgentKind,
  type PaidDialog,
  type PaidNotice,
  type PaidUnit,
  type PaidView,
} from "@/lib/paid-use";
import { cn } from "@/lib/utils";
import { useHydrated } from "./local-time";
import { PaidResults } from "./paid-results";
import { paidChatTransport, paidTaskTransport } from "./paid-transport";
import { PanelActionLink } from "./panel-notice";
import { PublicChatPanel } from "./public-chat-panel";
import { PublicTaskPanel } from "./public-task-panel";
import type { PanelNotice } from "./transport";

export interface PaidGateProps {
  /** The page as the API described it; its `use.state` is "paid". */
  detail: PublicAgentDetail;
  /** The terms on the page, `detail.use.paid`. */
  terms: PublicAgentPaidTerms;
  /** The panel's heading: "Chat with Support Bot", "Give it a task", "Latest results". */
  title: string;
}

/** The terms a person is looking at when they agree: sent back exactly as shown. */
interface Shown {
  listingId: string;
  terms: PaidUseTerms;
  acceptNewPricing: boolean;
  /** What a start or a subscription says before it charges; null when the button itself named the price. */
  dialog: PaidDialog | null;
}

/** The task form stays on screen in these states, so answers typed early are never lost. */
const TASK_FORM_STATES: ReadonlyArray<PaidView["kind"]> = ["signed_out", "not_started", "price_changed", "lapsed", "in_use"];

/**
 * The door of an agent that is sold: its price, where the person stands
 * (signed out, not started, a changed price, in use ...), the one thing they
 * can do about it, and the panel of the agent's kind once they may use it.
 *
 * The access is read after sign-in, after every use and after every start,
 * and everything here is drawn from that read.
 */
export function PaidGate({ detail, terms, title }: PaidGateProps) {
  const { agent, use } = detail;
  const handle = agent.handle;
  const kind: PaidAgentKind = use.chat ? "chat" : use.task ? "task" : "scheduled";
  const unit: PaidUnit = kind === "task" ? "run" : "message";
  const titleId = "public-use-title";

  const { authed } = useSession();
  const hydrated = useHydrated();
  const [access, setAccess] = useState<PaidUseAccessState | null>(null);
  const [accessError, setAccessError] = useState<unknown>(null);
  // The session ended while the person was here.
  const [sessionEnded, setSessionEnded] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  // Why a start, a subscription or accepting a price was refused.
  const [notice, setNotice] = useState<PaidNotice | null>(null);
  const [everUsable, setEverUsable] = useState(false);
  // Bumped when the results should be read again.
  const [resultsRead, setResultsRead] = useState(0);
  const reads = useRef(0);

  const signedIn = authed === true && !sessionEnded;

  /** Reads the access as it is now. A later read wins over an earlier one that answers late. */
  const readAccess = useCallback(async (): Promise<PaidUseAccessState | null> => {
    const read = ++reads.current;
    try {
      const next = await paidUseApi.access(handle);
      if (read === reads.current) {
        setAccess(next);
        setAccessError(null);
      }
      return next;
    } catch (error) {
      if (read !== reads.current) return null;
      if (error instanceof ApiError && error.status === 401) {
        setSessionEnded(true);
        setAccess(null);
      } else {
        setAccessError(error);
      }
      return null;
    }
  }, [handle]);

  useEffect(() => {
    if (authed === true) void readAccess();
  }, [authed, readAccess]);

  const ready = authed === false || sessionEnded || (authed === true && access !== null);
  const view = useMemo(
    () => paidView({ authed: signedIn, access: signedIn ? access : null, page: terms, kind }),
    [signedIn, access, terms, kind],
  );

  // Counts the times the person became able to use the agent. A refusal shown in a panel leaves only then:
  // a refusal that says they no longer can (a changed price, an ended session) stays where it was said.
  const [usableSince, setUsableSince] = useState(0);
  useEffect(() => {
    if (!view.usable) return;
    setEverUsable(true);
    setUsableSince((n) => n + 1);
  }, [view.usable]);

  /** Sends the terms the person was shown, then reads where they stand. Never throws. */
  const agree = useCallback(
    async (agreed: Shown) => {
      setBusy(true);
      setNotice(null);
      try {
        await marketplaceApi.startUsing(agreed.listingId, {
          expected: expectedTerms(agreed.terms),
          ...(agreed.acceptNewPricing && { acceptNewPricing: true }),
        });
      } catch (error) {
        setNotice(
          paidRefusalNotice({
            status: error instanceof ApiError ? error.status : 0,
            refusal: paidUseRefusalOf(error),
            act: "start",
            unit,
          }),
        );
      } finally {
        await readAccess();
        setBusy(false);
        setResultsRead((n) => n + 1);
      }
    },
    [readAccess, unit],
  );

  /** The action of a view, pressed: a price named on the button is accepted, any other opens its dialog. */
  const press = useCallback(
    (current: PaidView, state: PaidUseAccessState | null) => {
      if (!state?.terms) return;
      const agreed = { listingId: state.listingId, terms: state.terms, acceptNewPricing: current.acceptNewPricing };
      if (current.action.kind === "accept") void agree({ ...agreed, dialog: null });
      else if ((current.action.kind === "start" || current.action.kind === "subscribe") && current.dialog) {
        setShown({ ...agreed, dialog: current.dialog });
      }
    },
    [agree],
  );

  /**
   * The action of a refusal shown inside a panel. The terms are read again
   * first: a button that named a price agrees to that price and no other, so
   * when the price has moved the page shows the new one and waits.
   */
  const followUp = useCallback(
    async (refused: PaidNotice) => {
      const state = await readAccess();
      if (!state) return;
      const current = paidView({ authed: true, access: state, page: terms, kind });
      if (current.action.kind === "accept") {
        const named = refused.action.kind === "accept" ? refused.price : null;
        if (named && current.price && named.model === current.price.model && named.cents === current.price.cents) {
          press(current, state);
        }
        return;
      }
      press(current, state);
    },
    [readAccess, press, terms, kind],
  );

  const toPanel = useCallback(
    (refused: PaidNotice): PanelNotice => {
      const base: PanelNotice = {
        message: refused.message,
        fields: refused.fields,
        retryAfterSeconds: refused.retryAfterSeconds,
        paused: false,
      };
      const label = refused.action.label;
      if (!label) return base;
      switch (refused.action.kind) {
        case "signin":
          return { ...base, action: { label, href: signInHref(handle) } };
        case "add_credits":
          return { ...base, action: { label, href: ADD_CREDITS_HREF } };
        case "start":
        case "subscribe":
        case "accept":
          return { ...base, action: { label, run: () => void followUp(refused) } };
        default:
          return base;
      }
    },
    [handle, followUp],
  );

  // The transports live as long as the page, so a chat keeps its session; they read what is current through this.
  const live = useRef({ view, toPanel, readAccess });
  useEffect(() => {
    live.current = { view, toPanel, readAccess };
  });
  const hasChat = Boolean(use.chat);
  const hasTask = Boolean(use.task);
  const transports = useMemo(() => {
    const hooks = {
      handle,
      unit,
      heldBack: () => {
        const current = live.current.view;
        return current.usable ? null : live.current.toPanel(noticeOfView(current));
      },
      toPanel: (refused: PaidNotice) => live.current.toPanel(refused),
      onUsed: () => void live.current.readAccess(),
    };
    return {
      chat: hasChat ? paidChatTransport(hooks) : null,
      task: hasTask ? paidTaskTransport(hooks) : null,
    };
  }, [handle, unit, hasChat, hasTask]);

  const price = view.price ?? priceOfPage(terms);
  const keepsCopy = (signedIn ? access?.terms?.keepsCopy : undefined) ?? terms.transcriptsStored;
  const scheduled = use.scheduled ?? null;
  const lastResult = scheduled
    ? lastResultLine(scheduled.lastResultAt ?? scheduled.latest[0]?.finishedAt, hydrated ? {} : { timeZone: "UTC", mark: "UTC" })
    : null;
  const noticeKey = String(usableSince);
  const showPanel =
    everUsable || (ready && (view.usable || (kind === "task" && TASK_FORM_STATES.includes(view.kind))));
  const linkButton = (variant: "default" | "outline") => cn(buttonVariants({ variant }), "w-full sm:w-auto");

  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3 sm:px-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm font-semibold text-foreground">{priceLine(price)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{PAID_USE_MESSAGES.paidFromCredits}</p>
      </div>

      <div className="space-y-3 border-b px-4 py-4 text-sm sm:px-5">
        {kind === "scheduled" && (
          <div className="space-y-1 text-muted-foreground">
            <p>{PAID_USE_MESSAGES.runsOnItsOwn}</p>
            {lastResult && <p>{lastResult}</p>}
            {scheduleLines(scheduled?.schedule).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        <div aria-live="polite" aria-busy={!ready} className="space-y-3">
          {accessError !== null ? (
            <ErrorState
              title="Couldn't check your access"
              error={accessError}
              onRetry={() => {
                setAccessError(null);
                void readAccess();
              }}
            />
          ) : !ready ? (
            <div className="space-y-2">
              <span className="sr-only">Checking your access</span>
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-10 w-40 max-w-full" />
            </div>
          ) : (
            <>
              <p className="break-words text-foreground">{view.sentence}</p>
              {view.lowCredits && <p className="text-muted-foreground">{view.lowCredits}</p>}

              {view.action.kind === "signin" && (
                <div className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Link href={signInHref(handle)} className={linkButton("default")}>
                      {PAID_USE_MESSAGES.signInButton}
                    </Link>
                    <Link href={registerHref(handle)} className={linkButton("outline")}>
                      {PAID_USE_MESSAGES.createAccount}
                    </Link>
                  </div>
                  <p>
                    <Link
                      href={tryFreeHref(terms.listingSlug)}
                      className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {PAID_USE_MESSAGES.tryFree}
                    </Link>
                  </p>
                  {kind === "task" && <p className="text-xs text-muted-foreground">{PAID_USE_MESSAGES.draftKept}</p>}
                </div>
              )}

              {(view.action.kind === "start" || view.action.kind === "subscribe" || view.action.kind === "accept") &&
                view.action.label && (
                  <Button
                    type="button"
                    className="h-auto min-h-10 w-full whitespace-normal sm:w-auto"
                    isLoading={busy}
                    onClick={() => press(view, access)}
                  >
                    {view.action.label}
                  </Button>
                )}

              {view.action.kind === "add_credits" && view.action.label && (
                <p>
                  <PanelActionLink action={{ label: view.action.label, href: ADD_CREDITS_HREF }} />
                </p>
              )}
            </>
          )}
        </div>

        {notice && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {notice.message}
            {notice.action.kind === "add_credits" && notice.action.label && (
              <>
                {" "}
                <PanelActionLink action={{ label: notice.action.label, href: ADD_CREDITS_HREF }} />
              </>
            )}
          </p>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{privacyLine(keepsCopy)}</p>
          {terms.sendsRequests && <p>{PAID_USE_MESSAGES.sendsRequests}</p>}
        </div>
      </div>

      {showPanel && use.chat && transports.chat && (
        <PublicChatPanel agentName={agent.name} limits={use.chat} transport={transports.chat} noticeKey={noticeKey} />
      )}
      {showPanel && use.task && transports.task && (
        <PublicTaskPanel
          inputSchema={use.task.inputSchema}
          maxInputChars={use.task.maxInputChars}
          transport={transports.task}
          noticeKey={noticeKey}
          draft={{ key: taskDraftKey(handle), keep: view.kind === "signed_out" }}
        />
      )}
      {kind === "scheduled" && ready && view.usable && (
        <PaidResults handle={handle} read={resultsRead} onRefused={() => void readAccess()} />
      )}

      {shown?.dialog && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setShown(null);
          }}
          title={shown.dialog.title}
          description={shown.dialog.body}
          confirmLabel={shown.dialog.confirmLabel}
          onConfirm={() => agree(shown)}
        />
      )}
    </section>
  );
}
