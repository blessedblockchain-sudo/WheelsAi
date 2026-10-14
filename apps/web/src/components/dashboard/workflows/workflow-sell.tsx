"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { CopyRow } from "@/components/dashboard/agent-tabs/api-tab";
import { WhoCanUse } from "@/components/dashboard/sell/who-can-use";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  capabilitiesApi,
  getErrorMessage,
  getValidationError,
  marketplaceApi,
  type Capabilities,
  type MarketplaceListing,
  type OrchestrationDetail,
  type OwnedMarketplaceListing,
} from "@/lib/api";
import { codeOf } from "@/lib/agent-page";
import {
  LISTING_LINE_MAX,
  SELL_LINE_TOO_SHORT,
  buildSellSave,
  buyerStats,
  earnedOf,
  formOfListing,
  sameSellForm,
  sellFieldErrors,
  sellLimitsOf,
  sellLineOf,
  sellUpdateOf,
  sellWordsOf,
  type SellErrors,
  type SellForm,
} from "@/lib/sell-choice";
import {
  PLANS_RELOAD_WORDS,
  PLAN_WORDS,
  hasPlanErrors,
  noPlanErrors,
  partSavedLine,
  planFieldErrors,
  planLimitsOf,
  planSaleLines,
  plansFormOf,
  plansRefusedLine,
  plansReloadOffered,
  plansSaveOf,
  savedPlansOf,
  type PlanErrors,
  type PlansForm,
  type SavedPlan,
} from "@/lib/sell-plans";
import {
  WORKFLOW_SELL_WORDS,
  firstWorkflowListingOf,
  listingForWorkflow,
  maxRunMinutesOf,
  workflowModelId,
  workflowPageAddress,
  workflowPagePath,
  workflowSaleStatus,
  workflowSellLines,
  workflowSellProblem,
  workflowStopSellingSentence,
} from "@/lib/workflow-sell";

type Revenue = Awaited<ReturnType<typeof marketplaceApi.getRevenue>>;

interface SellData {
  listing: OwnedMarketplaceListing | null;
  /** null when it could not be read: the card then names no limit it does not know. */
  capabilities: Capabilities | null;
  revenue: Revenue | null;
}

const REVENUE_HREF = "/dashboard/marketplace/revenue";

const textLink =
  "rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The workflow's words of "Who can use it?". */
const WORDS = sellWordsOf("workflow");

/** This site's origin, for the page address a creator copies; null before the page runs in a browser. */
function siteOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured && configured.trim()) return configured;
  return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * Selling the workflow, on its API tab. Not on sale: the question "Who can
 * use it?" with its one answer, pay per run, the plans under it, what the
 * creator should know, and one button. On sale: the status, the buyer's page
 * and model id (the LISTING's slug, never the workflow's own), the plans and
 * what it earned, the question again to change the price or the plans, and
 * Stop selling.
 *
 * It follows the agent's Sell tab: the listing is saved first, then its plans
 * as a whole set; after any save my listings are read again, because a
 * publish answers the raw row.
 */
export function WorkflowSell({ workflow }: { workflow: OrchestrationDetail }) {
  const id = useId();
  const confirm = useConfirm();
  const [data, setData] = useState<SellData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [form, setForm] = useState<SellForm>(() => formOfListing(null, null, "workflow"));
  const [errors, setErrors] = useState<SellErrors>({});
  // The plans under "Pay per run", as typed. Not loaded until the listing's own were read.
  const [plans, setPlans] = useState<PlansForm>({ loaded: false, rows: [] });
  // The plans those rows were made from: a save ends only a plan that is among them.
  const [plansRead, setPlansRead] = useState<SavedPlan[] | null>(null);
  const [planErrors, setPlanErrors] = useState<PlanErrors>(noPlanErrors);
  // The last save of plans was refused because they changed somewhere else: a way to read them again is offered.
  const [plansStale, setPlansStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [lineError, setLineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "stop" | "reload" | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const focusStatus = useRef(false);
  const mounted = useRef(true);

  // `keepPlans`: the listing was saved and its plans were refused, so the rows stay as they were typed.
  // Answers whether the listing was read.
  const load = useCallback(
    async (keepPlans = false): Promise<boolean> => {
      setLoadError(null);
      try {
        // The listing decides the card. The rest only adds to it, so a part that cannot be read is left out.
        const [{ listings }, capabilities, revenue] = await Promise.all([
          marketplaceApi.getMyListings(),
          capabilitiesApi.get().catch(() => null),
          marketplaceApi.getRevenue().catch(() => null),
        ]);
        if (!mounted.current) return false;
        const listing = listingForWorkflow(listings, workflow.id);
        setData({ listing, capabilities, revenue });
        setForm(formOfListing(listing, null, "workflow"));
        setErrors({});
        if (!keepPlans) {
          setPlans(plansFormOf(listing));
          setPlansRead(savedPlansOf(listing));
          setPlanErrors(noPlanErrors());
        }
        return true;
      } catch (err) {
        if (mounted.current) setLoadError(err);
        return false;
      }
    },
    [workflow.id],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // After going on sale or stopping, the button that did it is gone: focus goes to the new status.
  useEffect(() => {
    if (!focusStatus.current || !data) return;
    focusStatus.current = false;
    statusRef.current?.focus();
  }, [data]);

  if (loadError !== null && !data) {
    return <ErrorState title="Couldn't load what this workflow sells" error={loadError} onRetry={() => void load()} />;
  }

  if (!data) {
    return (
      <Card aria-busy="true">
        <CardHeader>
          <span className="sr-only">Loading</span>
          <Skeleton className="h-6 w-48 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>
    );
  }

  const { listing, capabilities, revenue } = data;
  const limits = sellLimitsOf(capabilities);
  const planLimits = planLimitsOf(capabilities);
  // How long a paid run may last, from the capabilities; null when they could not be read.
  const maxRunMinutes = maxRunMinutesOf(capabilities);
  const status = listing ? workflowSaleStatus(listing) : null;
  const onSale = status?.standing === "on_sale";
  // Why it cannot go on sale as it is now (disabled, no steps, too long a time limit); null when it can.
  const notSellable = workflowSellProblem(workflow, maxRunMinutes);
  const knownLine = sellLineOf([listing?.shortDescription, workflow.description]);
  const baseline = formOfListing(listing, null, "workflow");
  // The listing's plans as they were last read, each with its subscribers. A save is measured against `plansRead`.
  const savedPlans = savedPlansOf(listing);
  const plansUnchanged = plansSaveOf({ sell: form, form: plans, saved: plansRead, limits: planLimits }).kind === "none";
  const unchanged = sameSellForm(form, baseline) && plansUnchanged;

  function change(next: SellForm) {
    setForm(next);
    setErrors({});
    setError(null);
    setPlansStale(false);
  }

  function changePlans(next: PlansForm) {
    setPlans(next);
    setPlanErrors(noPlanErrors());
    setError(null);
    setPlansStale(false);
  }

  // After a save refused because the plans changed somewhere else: read again, rows filled from what is there.
  async function reloadPlans() {
    setBusy("reload");
    const read = await load();
    if (!mounted.current) return;
    setBusy(null);
    if (read) {
      setError(null);
      setPlansStale(false);
    } else {
      setError(PLANS_RELOAD_WORDS.failed);
    }
  }

  async function save() {
    setError(null);
    setPlansStale(false);
    const built = buildSellSave(form, {}, limits, "workflow");
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    // The plans are checked before anything is saved, so a row that cannot be sent holds the listing back too.
    const plansSave = plansSaveOf({ sell: form, form: plans, saved: plansRead, limits: planLimits });
    if (plansSave.kind === "invalid") {
      setPlanErrors(plansSave.errors);
      return;
    }
    setPlanErrors(noPlanErrors());
    const line = sellLineOf([knownLine, lineDraft]);
    if (!listing && !line) {
      setLineError(SELL_LINE_TOO_SHORT);
      lineRef.current?.focus();
      return;
    }
    setLineError(null);

    setBusy("save");
    let savedListing: MarketplaceListing;
    try {
      const saved = listing
        ? await marketplaceApi.updateListing(listing.id, sellUpdateOf(built.save, listing))
        : await marketplaceApi.createListing(firstWorkflowListingOf(workflow, line ?? "", built.save));
      savedListing = saved.listing;
    } catch (err) {
      if (!mounted.current) return;
      const fields = getValidationError(err)?.fields;
      const fieldErrors = fields ? sellFieldErrors(fields) : {};
      setErrors(fieldErrors);
      // The API's own sentence, as it came: a price under the floor, a title with no letters, a workflow
      // that cannot be sold as it is.
      if (Object.keys(fieldErrors).length === 0) setError(getErrorMessage(err, "That could not be saved. Try again."));
      setBusy(null);
      // Another tab or a teammate listed this workflow meanwhile: show that listing.
      if (codeOf(err) === "listing_exists") {
        const message = getErrorMessage(err, "This workflow already has a listing.");
        await load();
        if (mounted.current) setError(message);
      }
      return;
    }

    // The listing is saved. Its plans go second and always as the whole set, with the ids of the plans that were ended here.
    let plansProblem: string | null = null;
    if (plansSave.kind === "send") {
      try {
        const res = await marketplaceApi.setListingPlans(savedListing.id, plansSave.plans, plansSave.ended);
        // Kept at once: the new plans have their ids from here on, even if the read below fails.
        if (mounted.current) {
          setPlans(plansFormOf({ plans: res.plans }));
          setPlansRead(savedPlansOf({ plans: res.plans }));
        }
      } catch (err) {
        const fields = getValidationError(err)?.fields;
        const fieldErrors = fields ? planFieldErrors(fields) : noPlanErrors();
        if (mounted.current) setPlanErrors(fieldErrors);
        plansProblem = plansRefusedLine(hasPlanErrors(fieldErrors) ? null : getErrorMessage(err, "Try again."));
        if (mounted.current) setPlansStale(plansReloadOffered(codeOf(err)));
      }
    }

    if (plansProblem === null) toast.success(onSale ? WORKFLOW_SELL_WORDS.savedToast : WORKFLOW_SELL_WORDS.onSaleToast);
    focusStatus.current = !onSale;
    // Read again whatever happened: a publish answers the raw row, with no productKind and no unit.
    await load(plansProblem !== null);
    if (!mounted.current) return;
    setBusy(null);
    const partSaved = partSavedLine(plansProblem, null);
    if (partSaved) setError(partSaved);
  }

  async function stop() {
    if (!listing) return;
    const ok = await confirm({
      title: WORKFLOW_SELL_WORDS.stopTitle,
      description: workflowStopSellingSentence(listing),
      confirmLabel: WORDS.stopSelling,
      destructive: true,
    });
    if (!ok) return;
    setBusy("stop");
    setError(null);
    setPlansStale(false);
    try {
      await marketplaceApi.archiveListing(listing.id);
      toast.success(WORKFLOW_SELL_WORDS.stoppedToast);
      focusStatus.current = true;
      await load();
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, "That could not be stopped. Try again."));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const earned = listing ? earnedOf(revenue?.revenueByListing, listing.id) : null;
  const stats = listing ? buyerStats(listing) : [];
  // One line for each plan, with how many people are on it: the creator's to see.
  const planLines = planSaleLines(listing, planLimits);

  const question = (
    <WhoCanUse
      subject="workflow"
      form={form}
      onChange={change}
      errors={errors}
      limits={limits}
      listing={listing}
      plans={{ form: plans, onChange: changePlans, errors: planErrors, limits: planLimits, saved: savedPlans }}
      disabled={busy !== null}
    />
  );

  // What the creator should know about a paid run, in the order it happens.
  const sellLines = (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {workflowSellLines(maxRunMinutes).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );

  // Why it cannot go on sale as it is: said before the question, beside nothing that could hide it.
  const notSellableNotice = notSellable && (
    <p role="status" className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-foreground">
      {notSellable}
    </p>
  );

  const problem = error && (
    <div className="space-y-2">
      <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
        {error}
      </p>
      {plansStale && (
        <Button type="button" variant="outline" size="sm" onClick={() => void reloadPlans()} isLoading={busy === "reload"} disabled={busy !== null}>
          {PLANS_RELOAD_WORDS.button}
        </Button>
      )}
    </div>
  );

  const header = (
    <CardHeader>
      <CardTitle className="text-base">{WORKFLOW_SELL_WORDS.title}</CardTitle>
      <CardDescription>{WORKFLOW_SELL_WORDS.description}</CardDescription>
    </CardHeader>
  );

  if (listing && status && onSale) {
    const pageAddress = workflowPageAddress(siteOrigin(), listing.slug);
    return (
      <Card>
        {header}
        <CardContent className="space-y-6">
          <div className="space-y-1">
            <div ref={statusRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 rounded focus-visible:outline-none">
              <p className="min-w-0 break-words font-medium text-foreground">{listing.title}</p>
              <Badge variant="success">{status.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{status.sentence}</p>
          </div>

          {/* Where buyers use it: the listing's slug, never the workflow's own. */}
          <div className="space-y-3">
            <CopyRow label={WORKFLOW_SELL_WORDS.pageLabel} value={pageAddress} />
            <a
              href={workflowPagePath(listing.slug)}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 text-sm ${textLink}`}
            >
              {WORKFLOW_SELL_WORDS.openPage}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">the workflow&apos;s page in a new tab</span>
            </a>
            <CopyRow label={WORKFLOW_SELL_WORDS.modelLabel} value={workflowModelId(listing.slug)} />
          </div>

          {planLines.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs text-muted-foreground">{PLAN_WORDS.title}</h3>
              <ul className="space-y-1">
                {planLines.map((plan) => (
                  <li key={plan.id} className="break-words text-sm text-foreground">
                    {plan.line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(earned || stats.length > 0) && (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {earned && (
                <>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">You earned</dt>
                    <dd className="break-words font-mono text-lg font-semibold tabular-nums text-foreground">{earned.earned}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Paid runs</dt>
                    <dd className="break-words font-mono text-lg font-semibold tabular-nums text-foreground">{earned.uses}</dd>
                  </div>
                </>
              )}
              {stats.map((stat) => (
                <div key={stat.label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                  <dd className="break-words font-mono text-lg font-semibold tabular-nums text-foreground">{stat.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-sm text-muted-foreground">
            {revenue === null
              ? "What it earned cannot be shown right now."
              : earned
                ? "Your share of payments that are settled."
                : "Nothing earned yet."}{" "}
            <Link href={REVENUE_HREF} className={textLink}>
              See earnings and payouts
            </Link>
          </p>

          <div className="space-y-5 border-t pt-6">
            {notSellableNotice}
            {question}
            {sellLines}
            {problem}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void save()} isLoading={busy === "save"} disabled={busy !== null || unchanged}>
                {WORDS.saveChanges}
              </Button>
              <Button type="button" variant="outline" onClick={() => void stop()} isLoading={busy === "stop"} disabled={busy !== null}>
                {WORDS.stopSelling}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent className="space-y-5">
        {status && (
          <div ref={statusRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 rounded focus-visible:outline-none">
            <Badge variant={status.standing === "in_review" ? "warning" : "secondary"}>{status.label}</Badge>
            <p className="min-w-0 text-sm text-muted-foreground">{status.sentence}</p>
          </div>
        )}
        {notSellableNotice}
        {question}
        {!listing && !knownLine && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-line`}>{WORDS.describe}</Label>
            <Input
              ref={lineRef}
              id={`${id}-line`}
              value={lineDraft}
              maxLength={LISTING_LINE_MAX}
              placeholder="Turns your meeting notes into a weekly report"
              onChange={(event) => {
                setLineDraft(event.target.value);
                setLineError(null);
              }}
              aria-describedby={lineError ? `${id}-line-error` : `${id}-line-hint`}
              aria-invalid={lineError ? true : undefined}
              disabled={busy !== null}
            />
            {lineError ? (
              <p id={`${id}-line-error`} role="alert" className="text-sm text-danger">
                {lineError}
              </p>
            ) : (
              <p id={`${id}-line-hint`} className="text-xs text-muted-foreground">
                {WORKFLOW_SELL_WORDS.lineHint}
              </p>
            )}
          </div>
        )}
        {sellLines}
        {problem}
        <div className="flex flex-wrap items-center gap-2">
          {/* A workflow that cannot be sold as it is cannot be put on sale: the notice above says why. */}
          <Button type="button" onClick={() => void save()} isLoading={busy === "save"} disabled={busy !== null || notSellable !== null}>
            {WORDS.putOnSale}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
