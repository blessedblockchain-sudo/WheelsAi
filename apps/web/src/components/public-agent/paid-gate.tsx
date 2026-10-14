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
  type PaidUseBilling,
  type PaidUseRefusal,
  type PaidUseTerms,
  type PlanOffer,
  type PublicAgentPaidTerms,
  type PublicAgentUse,
  type TrialOffer,
} from "@/lib/api";
import { AGENT_PAUSED_MESSAGE, PAUSED_RECHECK_MS, PUBLIC_PAUSED_NOTICE, accessIsPaused } from "@/lib/listing-pause";
import {
  ADD_CREDITS_HREF,
  PAID_USE_MESSAGES,
  PAID_WORKFLOW_MESSAGES,
  STOPPED_REREADS_MS,
  expectedTerms,
  lastResultLine,
  noticeOfView,
  pageTermsFor,
  paidRefusalNotice,
  priceLine,
  priceOfPage,
  privacyLine,
  registerHref,
  scheduleLines,
  signInHref,
  tryFreeHref,
  type PaidAgentKind,
  type PaidDialog,
  type PaidNotice,
  type PaidUnit,
  type PaidView,
} from "@/lib/paid-use";
import {
  MOVE_UP_WORDS,
  TRIAL_WORDS,
  USE_PLAN_WORDS,
  accessAfterRefusal,
  accessAfterUse,
  planMoveDialog,
  planMoveNotice,
  planMoveNow,
  planPageView,
  planStartDialog,
  planStartNotice,
  planTermsOf,
  trialStartDialog,
  trialTermsOf,
} from "@/lib/use-plans";
import { cn } from "@/lib/utils";
import { useHydrated } from "./local-time";
import { PaidResults } from "./paid-results";
import { paidChatTransport, type PaidDoor } from "./paid-transport";
import { PanelActionLink } from "./panel-notice";
import { PlanCards } from "./plan-cards";
import { PublicChatPanel } from "./public-chat-panel";
import { PublicTaskPanel } from "./public-task-panel";
import type { PanelNotice } from "./transport";

/**
 * What the panel under the gate needs: exactly one of an agent's chat, a
 * form (an agent's task, or a workflow's input), or a self-running agent's
 * results.
 */
export interface PaidGateUse {
  chat?: PublicAgentUse["chat"];
  task?: { inputSchema: unknown; maxInputChars: number };
  scheduled?: PublicAgentUse["scheduled"];
}

export interface PaidGateProps {
  /** How the gate reaches what is sold: an agent by its handle, or a workflow on sale by its listing's slug. */
  door: PaidDoor;
  /** What the panel needs: an agent's page passes its `use`. */
  use: PaidGateUse;
  /** The terms on the page: an agent's `detail.use.paid`, or a workflow's as its public read gives them. */
  terms: PublicAgentPaidTerms;
  /** The panel's heading: "Chat with Support Bot", "Give it a task", "Latest results", "Run it". */
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

/**
 * The plan a person is looking at when they agree, to start it or to move up
 * to it. `card` is the object the dialog's sentence was made from, held from
 * the moment the dialog opened: its terms are what is sent, whatever the page
 * has read since.
 */
interface ShownPlan {
  listingId: string;
  card: PlanOffer;
  dialog: PaidDialog;
}

/**
 * The free trial a person is looking at when they agree to start it. `trial`
 * is the object the dialog's sentence was made from, held from the moment the
 * dialog opened: its terms are what is sent, whatever the page has read since.
 */
interface ShownTrial {
  listingId: string;
  trial: TrialOffer;
  dialog: PaidDialog;
}

/** The task form stays on screen in these states, so answers typed early are never lost. */
const TASK_FORM_STATES: ReadonlyArray<PaidView["kind"]> = [
  "signed_out",
  "not_started",
  "price_changed",
  "lapsed",
  "plan_ended",
  "in_use",
];

/**
 * The door of an agent or a workflow that is sold: its price, where the
 * person stands (signed out, not started, a changed price, in use ...), the
 * one thing they can do about it, and the panel of its kind once they may
 * use it. A workflow is drawn as an agent that does a task from a form, in
 * its own words: no chat, no results, no free try, no pause.
 *
 * The access is read after sign-in, after every use and after every start,
 * and everything here is drawn from that read.
 */
export function PaidGate({ door, use, terms: pageTerms, title }: PaidGateProps) {
  // An agent's handle: its chat, its results and the recheck of a pause go by it. Null on a workflow's page.
  const handle = door.agent?.handle ?? null;
  const subject = door.subject;
  // The view's sentences are worded for what the door sells. An agent's terms are passed on as they are.
  const terms = useMemo(() => pageTermsFor(pageTerms, subject), [pageTerms, subject]);
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
  // The plan whose start dialog is open.
  const [shownPlan, setShownPlan] = useState<ShownPlan | null>(null);
  // The free trial whose start dialog is open.
  const [shownTrial, setShownTrial] = useState<ShownTrial | null>(null);
  // Whether someone who already pays per use has opened the plans.
  const [plansOpen, setPlansOpen] = useState(false);
  // The bigger plan whose dialog is open, for someone on a plan.
  const [shownMove, setShownMove] = useState<ShownPlan | null>(null);
  // Whether someone on a plan has opened the bigger plans.
  const [biggerOpen, setBiggerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // True from the press that starts a plan until its answer: a second press starts nothing.
  const startingPlan = useRef(false);
  // The same for the free trial: a second press starts nothing.
  const startingTrial = useRef(false);
  // The same for a move to a bigger plan: a second press charges nothing.
  const movingPlan = useRef(false);
  // True from the press on a bigger plan's card until its dialog is ready: the access is read first.
  const openingMove = useRef(false);
  // Why a start, a subscription or accepting a price was refused.
  const [notice, setNotice] = useState<PaidNotice | null>(null);
  const [everUsable, setEverUsable] = useState(false);
  // Bumped when the results should be read again.
  const [resultsRead, setResultsRead] = useState(0);
  // A run of a workflow that the person stopped, or that the page cancelled, before its answer came.
  const [runStopped, setRunStopped] = useState(false);
  // The later reads of the access after a stopped run: the API gives back what it took once the run has ended.
  const stoppedReads = useRef<number[]>([]);
  const reads = useRef(0);

  const signedIn = authed === true && !sessionEnded;
  // The model the agent runs on is not running: the access says so, and it is read again after every use.
  const paused = signedIn && accessIsPaused(access);

  /** Reads the access as it is now. A later read wins over an earlier one that answers late. */
  const readAccess = useCallback(async (): Promise<PaidUseAccessState | null> => {
    const read = ++reads.current;
    try {
      const next = await door.readAccess();
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
  }, [door]);

  useEffect(() => {
    if (authed === true) void readAccess();
  }, [authed, readAccess]);

  // While the page shows the pause nothing on it reads the access: sending is disabled and there is no
  // button. So the page asks again by itself, and the pause ends here without anyone pressing anything.
  // A read that fails changes nothing: the page stays paused and asks again.
  useEffect(() => {
    if (!paused) return;
    // Only an agent's page pauses: a workflow's access always says it is not paused.
    if (handle === null) return;
    let gone = false;
    const recheck = async () => {
      if (document.visibilityState !== "visible") return;
      const at = reads.current;
      try {
        const next = await paidUseApi.access(handle);
        // A read the person caused since then is newer than this one.
        if (!gone && at === reads.current) setAccess(next);
      } catch {
        // Asked again at the next turn.
      }
    };
    const timer = window.setInterval(() => void recheck(), PAUSED_RECHECK_MS);
    const onVisible = () => void recheck();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paused, handle]);

  const ready = authed === false || sessionEnded || (authed === true && access !== null);
  // `view` is paidView with, for someone on a plan, the count of what is left as its sentence. `plans` is what
  // the page draws of plans: the cards and where they go, whether they can be started, the count beside
  // the sentence. `moveUp` is the bigger plans someone on a plan can move to, null for everyone else.
  // `trial` is the listing's free trial: its offer above the cards for someone who could take it, and what
  // is said under the count while on it. A listing with no plans and no trial gives paidView and nothing else.
  const { view, plans, moveUp, trial } = useMemo(
    () => planPageView({ authed: signedIn, access: signedIn ? access : null, page: terms, kind }),
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
            subject,
          }),
        );
      } finally {
        await readAccess();
        setBusy(false);
        setResultsRead((n) => n + 1);
      }
    },
    [readAccess, unit, subject],
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
   * Starts the plan of the card that was pressed, with that card's terms, then reads where the person
   * stands. Never throws. A refusal ends in its sentence, and nothing was charged: plans that changed
   * are drawn again from the refusal, and the read that follows makes the page true for every other.
   */
  const agreeToPlan = useCallback(
    async (agreed: ShownPlan) => {
      if (startingPlan.current) return;
      startingPlan.current = true;
      setBusy(true);
      setNotice(null);
      try {
        await marketplaceApi.startPlan(agreed.listingId, planTermsOf(agreed.card));
        setPlansOpen(false);
      } catch (error) {
        const refusal = paidUseRefusalOf(error);
        setNotice(planStartNotice({ status: error instanceof ApiError ? error.status : 0, refusal, unit, subject }));
        setAccess((held) => accessAfterRefusal(held, refusal));
      } finally {
        await readAccess();
        startingPlan.current = false;
        setBusy(false);
        setResultsRead((n) => n + 1);
      }
    },
    [readAccess, unit, subject],
  );

  /** A card's button, pressed: its dialog opens, made from that card. Nothing is sent yet. */
  const pressPlan = useCallback(
    (card: PlanOffer) => {
      if (!access || !plans.canStart) return;
      setShownPlan({ listingId: access.listingId, card, dialog: planStartDialog(card) });
    },
    [access, plans.canStart],
  );

  /**
   * Starts the free trial that was shown, with that trial's own terms (no price, no price for an extra
   * use), then reads where the person stands. Never throws. Nothing is charged, started or refused. A
   * refusal ends in the API's sentence: a trial that was used before, one that waits for credits to be
   * added once (with the way to add them), or a trial that changed, which is drawn again from the refusal.
   */
  const agreeToTrial = useCallback(
    async (agreed: ShownTrial) => {
      if (startingTrial.current) return;
      startingTrial.current = true;
      setBusy(true);
      setNotice(null);
      try {
        await marketplaceApi.startPlan(agreed.listingId, trialTermsOf(agreed.trial));
      } catch (error) {
        const refusal = paidUseRefusalOf(error);
        setNotice(planStartNotice({ status: error instanceof ApiError ? error.status : 0, refusal, unit, subject }));
        setAccess((held) => accessAfterRefusal(held, refusal));
      } finally {
        await readAccess();
        startingTrial.current = false;
        setBusy(false);
        setResultsRead((n) => n + 1);
      }
    },
    [readAccess, unit, subject],
  );

  /** "Start the free trial", pressed: its dialog opens, made from the trial on the page. Nothing is sent yet. */
  const pressTrial = useCallback(() => {
    const offer = trial.offer;
    if (!access || offer?.kind !== "start") return;
    setShownTrial({ listingId: access.listingId, trial: offer.trial, dialog: trialStartDialog(offer.trial, offer.after) });
  }, [access, trial.offer]);

  // Only the people who may start a plan may move up.
  const canMoveUp = moveUp?.canMove === true;

  /**
   * Moves to the bigger plan of the card that was pressed, with that card's terms, then reads where the
   * person stands: the count line then shows the new plan with the uses brought along. Never throws. A
   * refusal ends in its sentence, and nothing was charged or changed: plans that changed are drawn again
   * from the refusal, and the read that follows makes the page true for every other.
   */
  const agreeToMove = useCallback(
    async (agreed: ShownPlan) => {
      if (movingPlan.current) return;
      movingPlan.current = true;
      setBusy(true);
      setNotice(null);
      try {
        await marketplaceApi.movePlan(agreed.listingId, planTermsOf(agreed.card));
        setBiggerOpen(false);
      } catch (error) {
        const refusal = paidUseRefusalOf(error);
        setNotice(planMoveNotice({ status: error instanceof ApiError ? error.status : 0, refusal, unit, subject }));
        setAccess((held) => accessAfterRefusal(held, refusal));
      } finally {
        await readAccess();
        movingPlan.current = false;
        setBusy(false);
        setResultsRead((n) => n + 1);
      }
    },
    [readAccess, unit, subject],
  );

  /**
   * A bigger plan's button, pressed. The access is read again first, as a refusal's action does for a
   * price: the dialog says how many uses come along, and that number must be the one of this moment, not
   * of when the page loaded (a teammate's uses, or an answer still arriving, are seen only by a read).
   * The dialog opens only when the card pressed is still on offer with the terms it showed; otherwise the
   * read has drawn the page as it is and nothing opens. Nothing is sent or charged here.
   */
  const pressMove = useCallback(
    async (card: PlanOffer) => {
      if (!canMoveUp || openingMove.current) return;
      openingMove.current = true;
      setBusy(true);
      try {
        const state = await readAccess();
        if (!state || accessIsPaused(state)) return;
        const now = planMoveNow(planPageView({ authed: true, access: state, page: terms, kind }).moveUp, card);
        if (!now) return;
        setShownMove({ listingId: state.listingId, card: now.card, dialog: planMoveDialog(now.card, now.carriedUses, now.leftUses) });
      } finally {
        openingMove.current = false;
        setBusy(false);
      }
    },
    [canMoveUp, readAccess, terms, kind],
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
      // The view that knows plans and the free trial: on a trial, accepting a price that went up is its action.
      const current = planPageView({ authed: true, access: state, page: terms, kind }).view;
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
          return { ...base, action: { label, href: signInHref({ path: door.path }) } };
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
    [door, followUp],
  );

  // The transports live as long as the page, so a chat keeps its session; they read what is current through this.
  const live = useRef({ view, toPanel, readAccess, paused });
  useEffect(() => {
    live.current = { view, toPanel, readAccess, paused };
  });
  // Nothing is read for a page that has closed.
  useEffect(() => () => stoppedReads.current.forEach((timer) => window.clearTimeout(timer)), []);
  const hasChat = Boolean(use.chat);
  const hasTask = Boolean(use.task);
  const transports = useMemo(() => {
    const hooks = {
      unit,
      subject,
      heldBack: () => {
        // Paused: nothing is sent, so nothing is charged.
        if (live.current.paused) {
          return { message: AGENT_PAUSED_MESSAGE, fields: {}, retryAfterSeconds: null, paused: false };
        }
        const current = live.current.view;
        return current.usable ? null : live.current.toPanel(noticeOfView(current));
      },
      toPanel: (refused: PaidNotice) => live.current.toPanel(refused),
      onUsed: () => void live.current.readAccess(),
      // On a plan: the count after this answer, and where a refusal leaves the person, are drawn at once
      // from what the use itself answered. The read that onUsed began replaces both when it arrives.
      onBilled: (billing: PaidUseBilling) => setAccess((held) => accessAfterUse(held, billing)),
      onRefused: (refusal: PaidUseRefusal) => setAccess((held) => accessAfterRefusal(held, refusal)),
      // A workflow's run that was stopped: said under the form until the next run is sent. The read made at
      // the moment of Stop comes before the refund, so the access is read again a little later.
      onStopped: (stopped: boolean) => {
        setRunStopped(stopped);
        stoppedReads.current.forEach((timer) => window.clearTimeout(timer));
        stoppedReads.current = stopped
          ? STOPPED_REREADS_MS.map((ms) => window.setTimeout(() => void live.current.readAccess(), ms))
          : [];
      },
    };
    return {
      chat: hasChat && handle !== null ? paidChatTransport({ ...hooks, handle }) : null,
      task: hasTask ? door.taskTransport(hooks) : null,
    };
  }, [door, handle, subject, unit, hasChat, hasTask]);

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
  // The privacy sentence, and on a workflow's page how long a run may take: above for an agent, under the form for a workflow.
  const notesUnderForm = door.runNote !== null;
  const notes = (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{privacyLine(keepsCopy, subject)}</p>
      {terms.sendsRequests && <p>{PAID_USE_MESSAGES.sendsRequests}</p>}
      {door.runNote && <p>{door.runNote}</p>}
    </div>
  );
  const planCards = (
    <>
      <PlanCards cards={plans.cards} canStart={plans.canStart} busy={busy} onStart={pressPlan} />
      {plans.askAdmin && <p className="text-muted-foreground">{plans.askAdmin}</p>}
    </>
  );

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
          ) : paused ? (
            // In place of the price to agree to: while it is paused there is nothing to start or pay.
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-foreground">
              {PUBLIC_PAUSED_NOTICE}
            </p>
          ) : (
            <>
              <p className="break-words text-foreground">{view.sentence}</p>
              {/* On a plan whose renewal is being retried: what is left, beside the sentence that asks for credits. */}
              {plans.countLine && <p className="break-words text-foreground">{plans.countLine}</p>}
              {/* On the free trial, for someone who agreed to a price per use: what a use costs after the free ones. */}
              {trial.afterLine && <p className="break-words text-muted-foreground">{trial.afterLine}</p>}
              {view.lowCredits && <p className="text-muted-foreground">{view.lowCredits}</p>}

              {/* On a plan, with a bigger one on offer: the bigger plans are one press away, and a move is still asked first. */}
              {moveUp && (
                <div className="space-y-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={biggerOpen}
                    onClick={() => setBiggerOpen((open) => !open)}
                  >
                    {biggerOpen ? MOVE_UP_WORDS.hideBigger : MOVE_UP_WORDS.seeBigger}
                  </Button>
                  {biggerOpen && (
                    <>
                      <PlanCards
                        cards={moveUp.cards}
                        canStart={moveUp.canMove}
                        busy={busy}
                        onStart={(card) => void pressMove(card)}
                        label={MOVE_UP_WORDS.cardsLabel}
                        buttonLabel={MOVE_UP_WORDS.button}
                      />
                      {moveUp.askAdmin && <p className="text-muted-foreground">{moveUp.askAdmin}</p>}
                    </>
                  )}
                </div>
              )}

              {/* The listing's free trial, above the plans. Drawn only for someone whose organization could still
                  take it: the button for those who may start it, the way to add credits when that is the one
                  thing missing, the page's own sign-in below for someone signed out, and who to ask otherwise. */}
              {trial.offer && (
                <div className="space-y-2 rounded-lg border bg-background p-4">
                  <p className="break-words font-medium text-foreground">{trial.offer.line}</p>
                  {trial.offer.note && <p className="break-words text-muted-foreground">{trial.offer.note}</p>}
                  {trial.offer.kind === "start" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-10 w-full whitespace-normal sm:w-auto"
                      disabled={busy}
                      onClick={pressTrial}
                    >
                      {TRIAL_WORDS.startButton}
                    </Button>
                  )}
                  {trial.offer.kind === "needs_credits" && (
                    <p>
                      <PanelActionLink action={{ label: PAID_USE_MESSAGES.addCredits, href: ADD_CREDITS_HREF }} />
                    </p>
                  )}
                </div>
              )}

              {/* Nothing agreed to yet, or on the free trial: the plans first, then the price per use with the action below. */}
              {plans.place === "first" && (
                <>
                  {planCards}
                  {plans.payAsYouGo && <p className="text-foreground">{plans.payAsYouGo}</p>}
                </>
              )}

              {view.action.kind === "signin" && (
                <div className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Link href={signInHref({ path: door.path })} className={linkButton("default")}>
                      {PAID_USE_MESSAGES.signInButton}
                    </Link>
                    <Link href={registerHref({ path: door.path })} className={linkButton("outline")}>
                      {PAID_USE_MESSAGES.createAccount}
                    </Link>
                  </div>
                  {/* An agent's listing can be tried free on its page; a workflow's cannot. */}
                  {door.agent && (
                    <p>
                      <Link
                        href={tryFreeHref(terms.listingSlug)}
                        className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {PAID_USE_MESSAGES.tryFree}
                      </Link>
                    </p>
                  )}
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

              {/* Already paying per use: the plans are one press away, and starting one is still asked first. */}
              {plans.place === "behind" && (
                <div className="space-y-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={plansOpen}
                    onClick={() => setPlansOpen((open) => !open)}
                  >
                    {plansOpen ? USE_PLAN_WORDS.hidePlans : USE_PLAN_WORDS.seePlans}
                  </Button>
                  {plansOpen && planCards}
                </div>
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

        {!notesUnderForm && notes}
      </div>

      {showPanel && use.chat && transports.chat && door.agent && (
        <PublicChatPanel
          agentName={door.agent.name}
          limits={use.chat}
          transport={transports.chat}
          noticeKey={noticeKey}
          sendDisabled={paused}
        />
      )}
      {showPanel && use.task && transports.task && (
        <PublicTaskPanel
          inputSchema={use.task.inputSchema}
          maxInputChars={use.task.maxInputChars}
          transport={transports.task}
          noticeKey={noticeKey}
          sendDisabled={paused}
          draft={{ key: door.draftKey, keep: view.kind === "signed_out" }}
        />
      )}
      {kind === "scheduled" && ready && view.usable && handle !== null && (
        <PaidResults handle={handle} read={resultsRead} onRefused={() => void readAccess()} />
      )}
      {notesUnderForm && (
        <div className="space-y-2 border-t px-4 py-4 sm:px-5">
          {runStopped && (
            <p role="status" className="text-sm text-foreground">
              {PAID_WORKFLOW_MESSAGES.stopped}
            </p>
          )}
          {notes}
        </div>
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

      {shownPlan && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setShownPlan(null);
          }}
          title={shownPlan.dialog.title}
          description={shownPlan.dialog.body}
          confirmLabel={shownPlan.dialog.confirmLabel}
          onConfirm={() => agreeToPlan(shownPlan)}
        />
      )}

      {shownTrial && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setShownTrial(null);
          }}
          title={shownTrial.dialog.title}
          description={shownTrial.dialog.body}
          confirmLabel={shownTrial.dialog.confirmLabel}
          onConfirm={() => agreeToTrial(shownTrial)}
        />
      )}

      {shownMove && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setShownMove(null);
          }}
          title={shownMove.dialog.title}
          description={shownMove.dialog.body}
          confirmLabel={shownMove.dialog.confirmLabel}
          onConfirm={() => agreeToMove(shownMove)}
        />
      )}
    </section>
  );
}
