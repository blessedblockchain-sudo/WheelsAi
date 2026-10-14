"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { GuaranteedDelivery } from "@/components/dashboard/sell/guaranteed-delivery";
import { readPageKey, saveKeepCopy } from "@/components/dashboard/sell/page-key";
import { WhoCanUse } from "@/components/dashboard/sell/who-can-use";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  capabilitiesApi,
  getErrorMessage,
  getValidationError,
  marketplaceApi,
  settingsApi,
  type AgentDetail,
  type Capabilities,
  type MarketplaceListing,
  type OwnedMarketplaceListing,
  type PublicLink,
} from "@/lib/api";
import { codeOf, listingForAgent } from "@/lib/agent-page";
import { PUBLIC_LINK_WORDS } from "@/lib/agent-share";
import { SELL_PAUSED_NOTICE, listingIsPaused } from "@/lib/listing-pause";
import { soldByLine } from "@/lib/organization-name";
import {
  LISTING_LINE_MAX,
  SELL_LINE_TOO_SHORT,
  SELL_WORDS,
  asksForPayment,
  buildSellSave,
  buyerStats,
  earnedOf,
  firstListingOf,
  formOfListing,
  sameSellForm,
  saleStatus,
  sellFieldErrors,
  sellLimitsOf,
  sellLineOf,
  sellUpdateOf,
  stopSellingSentence,
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
import { walletPaymentsOnLine, x402SaveOf } from "@/lib/sell-x402";
import { cn } from "@/lib/utils";
import { CopyRow } from "./api-tab";

export interface SellTabProps {
  agent: AgentDetail;
  /** Called after a change the rest of the page should see (the agent went on sale and got its page). */
  onAgentChanged?: () => void;
}

type Revenue = Awaited<ReturnType<typeof marketplaceApi.getRevenue>>;

interface SellData {
  listing: OwnedMarketplaceListing | null;
  /** null when it could not be read: the screen then names no limit it does not know. */
  capabilities: Capabilities | null;
  link: PublicLink | null;
  revenue: Revenue | null;
  /** Whether the agent's page keeps a copy of what people send; false while it has no page. */
  keepCopy: boolean;
}

const REVENUE_HREF = "/dashboard/marketplace/revenue";

const textLink =
  "rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Putting use of the agent on sale. Not on sale: the question "Who can use
 * it?" and one button. On sale: its status, its link and what it earned,
 * the question again to change the answer, and Stop selling.
 */
export function SellTab({ agent, onAgentChanged }: SellTabProps) {
  const id = useId();
  const confirm = useConfirm();
  const [data, setData] = useState<SellData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [form, setForm] = useState<SellForm>(() => formOfListing(null));
  const [keepCopy, setKeepCopy] = useState(false);
  // The switch for paying from a wallet, as on screen. Filled from the listing as it was read.
  const [walletPay, setWalletPay] = useState(false);
  // The API's refusal of the switch, drawn under it. Cleared by any edit, a new save or a read.
  const [walletError, setWalletError] = useState<string | null>(null);
  const [errors, setErrors] = useState<SellErrors>({});
  // The plans under "Pay per use", as typed. Not loaded until the listing's own were read.
  const [plans, setPlans] = useState<PlansForm>({ loaded: false, rows: [] });
  // The plans those rows were made from. A save ends only a plan that is among them, so a plan that a later
  // read brought, and that has no row here, is never named as ended.
  const [plansRead, setPlansRead] = useState<SavedPlan[] | null>(null);
  const [planErrors, setPlanErrors] = useState<PlanErrors>(noPlanErrors);
  // The last save of plans was refused because they changed somewhere else: a way to read them again is offered beside its sentence.
  // It is cleared wherever that sentence is, so the button is never drawn under another one.
  const [plansStale, setPlansStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [lineError, setLineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "stop" | "reload" | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const focusStatus = useRef(false);
  const mounted = useRef(true);
  // The name buyers see. Asked for once; the line about it is left out when it cannot be read.
  const [seller, setSeller] = useState<{ name: string; canRename: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    settingsApi
      .organization()
      .then((res) => {
        if (current) setSeller({ name: res.organization.name, canRename: res.organization.canRename });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  // `keepPlans`: the listing was saved and its plans were refused, so the rows stay as they were typed.
  // Answers whether the listing was read.
  const load = useCallback(async (keepPlans = false): Promise<boolean> => {
    setLoadError(null);
    try {
      // The listing decides the screen. The rest only adds to it, so a part that cannot be read is left out.
      const [{ listings }, capabilities, link, pageKey, revenue] = await Promise.all([
        marketplaceApi.getMyListings(),
        capabilitiesApi.get().catch(() => null),
        agentsApi.getPublicLink(agent.id).catch(() => null),
        readPageKey(agent.id).catch(() => null),
        marketplaceApi.getRevenue().catch(() => null),
      ]);
      if (!mounted.current) return false;
      const listing = listingForAgent(listings, agent.id);
      const kept = pageKey?.storeTranscripts ?? false;
      setData({ listing, capabilities, link, revenue, keepCopy: kept });
      setForm(formOfListing(listing, agent.agentKind));
      setKeepCopy(kept);
      setWalletPay(listing?.x402Enabled === true);
      setWalletError(null);
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
  }, [agent.id, agent.agentKind]);

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
    return <ErrorState title="Couldn't load what this agent sells" error={loadError} onRetry={() => void load()} />;
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
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>
    );
  }

  const { listing, capabilities, link, revenue } = data;
  const limits = sellLimitsOf(capabilities);
  const status = listing ? saleStatus(listing, agent.agentKind) : null;
  const onSale = status?.standing === "on_sale";
  const knownLine = sellLineOf([listing?.shortDescription, agent.description]);
  const baseline = formOfListing(listing, agent.agentKind);
  const planLimits = planLimitsOf(capabilities);
  // The listing's plans as they were last read, each with its subscribers; null when they came without.
  // The block shows these. What a save is measured against is `plansRead`, the plans the rows were made from.
  const savedPlans = savedPlansOf(listing);
  const plansUnchanged = plansSaveOf({ sell: form, form: plans, saved: plansRead, limits: planLimits }).kind === "none";
  // Paying from a wallet is offered only when the capabilities say so; an API that does not say offers nothing.
  const walletAvailable = capabilities?.x402?.available === true;
  const walletUnchanged = x402SaveOf({ form, walletPay, listing, available: walletAvailable }).x402Enabled === undefined;
  const unchanged =
    sameSellForm(form, baseline) && walletUnchanged && (!asksForPayment(form) || keepCopy === data.keepCopy) && plansUnchanged;

  function change(next: SellForm) {
    setForm(next);
    setErrors({});
    setError(null);
    setPlansStale(false);
    setWalletError(null);
  }

  function changeWalletPay(checked: boolean) {
    setWalletPay(checked);
    setError(null);
    setPlansStale(false);
    setWalletError(null);
  }

  function changePlans(next: PlansForm) {
    setPlans(next);
    setPlanErrors(noPlanErrors());
    setError(null);
    setPlansStale(false);
  }

  // After a save refused because the plans changed somewhere else: the listing is read again and the rows
  // are filled from it, so the next save is measured against the plans as they are.
  async function reloadPlans() {
    setBusy("reload");
    const read = await load();
    if (!mounted.current) return;
    setBusy(null);
    if (read) {
      setError(null);
      setPlansStale(false);
    } else {
      // Nothing was read: the rows are as they were, and the button stays to try again.
      setError(PLANS_RELOAD_WORDS.failed);
    }
  }

  async function save(sent: SellForm = form) {
    setError(null);
    setPlansStale(false);
    setWalletError(null);
    const built = buildSellSave(sent, agent, limits);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    // The plans are checked before anything is saved, so a row that cannot be sent holds the listing back too.
    const plansSave = plansSaveOf({ sell: sent, form: plans, saved: plansRead, limits: planLimits });
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

    // The switch for paying from a wallet goes only when it changed, or off when the answer left pay per use:
    // an edit that leaves pay per use while carrying it on is refused whole.
    const walletSave = x402SaveOf({ form: sent, walletPay, listing, available: walletAvailable });

    setBusy("save");
    let savedListing: MarketplaceListing;
    try {
      const saved = listing
        ? await marketplaceApi.updateListing(listing.id, { ...sellUpdateOf(built.save, listing), ...walletSave })
        : await marketplaceApi.createListing({ ...firstListingOf(agent, line ?? "", built.save), ...walletSave });
      savedListing = saved.listing;
    } catch (err) {
      if (!mounted.current) return;
      const fields = getValidationError(err)?.fields;
      const fieldErrors = fields ? sellFieldErrors(fields) : {};
      setErrors(fieldErrors);
      // A refusal of the switch is drawn under the switch, in the API's own sentence.
      const walletRefusal = fields?.x402Enabled ?? null;
      setWalletError(walletRefusal);
      // The API's own sentence, as it came.
      if (Object.keys(fieldErrors).length === 0 && walletRefusal === null) {
        setError(getErrorMessage(err, "That could not be saved. Try again."));
      }
      setBusy(null);
      // Another tab or a teammate listed this agent meanwhile: show that listing.
      if (codeOf(err) === "listing_exists") {
        const message = getErrorMessage(err, "This agent already has a listing.");
        await load();
        if (mounted.current) setError(message);
      }
      return;
    }
    // The switch as the API saved it: off after a move away from pay per use, even if the read below fails.
    if (mounted.current) setWalletPay(savedListing.x402Enabled === true);

    // The agent has its page now, so the copy setting has a place to be saved.
    let keepProblem: string | null = null;
    if (asksForPayment(sent)) {
      try {
        await saveKeepCopy(agent.id, keepCopy);
      } catch (err) {
        keepProblem = getErrorMessage(err, "Try again.");
      }
    }

    // The listing is saved. Its plans go second and always as the whole set, with the ids of the plans that were ended here.
    let plansProblem: string | null = null;
    if (plansSave.kind === "send") {
      try {
        const res = await marketplaceApi.setListingPlans(savedListing.id, plansSave.plans, plansSave.ended);
        // The answer is kept: the new plans have their ids from here on, even if the reload below fails.
        // A second save then sends nothing, where rows without ids would make every plan again and end these.
        if (mounted.current) {
          setPlans(plansFormOf({ plans: res.plans }));
          setPlansRead(savedPlansOf({ plans: res.plans }));
          setData((d) => d && { ...d, listing: { ...(d.listing ?? savedListing), plans: res.plans } });
        }
      } catch (err) {
        const fields = getValidationError(err)?.fields;
        const fieldErrors = fields ? planFieldErrors(fields) : noPlanErrors();
        if (mounted.current) setPlanErrors(fieldErrors);
        // Each sentence is under its field; a refusal with none is said whole, as the API sent it.
        plansProblem = plansRefusedLine(hasPlanErrors(fieldErrors) ? null : getErrorMessage(err, "Try again."));
        if (mounted.current) setPlansStale(plansReloadOffered(codeOf(err)));
      }
    }

    if (plansProblem === null) toast.success(onSale ? "Changes saved" : "Your agent is on sale");
    focusStatus.current = !onSale;
    await load(plansProblem !== null);
    if (!mounted.current) return;
    setBusy(null);
    // Both are said when both failed: neither is taken for saved.
    const partSaved = partSavedLine(plansProblem, keepProblem);
    if (partSaved) setError(partSaved);
    onAgentChanged?.();
  }

  async function stop() {
    if (!listing) return;
    const ok = await confirm({
      title: "Stop selling this agent?",
      description: stopSellingSentence(listing),
      confirmLabel: SELL_WORDS.stopSelling,
      destructive: true,
    });
    if (!ok) return;
    setBusy("stop");
    setError(null);
    setPlansStale(false);
    try {
      await marketplaceApi.archiveListing(listing.id);
      toast.success("This agent is no longer on sale");
      focusStatus.current = true;
      await load();
      onAgentChanged?.();
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, "That could not be stopped. Try again."));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const earned = listing ? earnedOf(revenue?.revenueByListing, listing.id) : null;
  const stats = listing ? buyerStats(listing) : [];
  // One line for each plan of a listing sold per use, and one for its trial of some uses at no price.
  // How many people are on each is the creator's to see.
  const planLines = planSaleLines(listing, planLimits);
  const walletOnLine = walletPaymentsOnLine({ listing, available: walletAvailable });

  const question = (
    <WhoCanUse
      agent={agent}
      form={form}
      onChange={change}
      errors={errors}
      limits={limits}
      capacity={capabilities?.paidUse.freeModelDailyAllowance ?? null}
      keepCopy={{ checked: keepCopy, onChange: setKeepCopy }}
      walletPayments={walletAvailable ? { checked: walletPay, onChange: changeWalletPay, error: walletError } : undefined}
      listing={listing}
      plans={{ form: plans, onChange: changePlans, errors: planErrors, limits: planLimits, saved: savedPlans }}
      // A listing that is on sale changes at once: the dialog said "from now on".
      onSoldAsCopies={onSale ? (next) => void save(next) : undefined}
      disabled={busy !== null}
      moreOptions={
        agent.agentKind === "task" ? (
          <GuaranteedDelivery
            agent={agent}
            listingLine={listing?.shortDescription}
            paidTasksAvailable={capabilities ? capabilities.paidTasks.available : null}
          />
        ) : undefined
      }
    />
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

  // The model this agent runs on is not running: said first, before anything else on the tab.
  const pausedNotice = listingIsPaused(listing) && (
    <p role="status" className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-foreground">
      {SELL_PAUSED_NOTICE.message}{" "}
      <Link href={SELL_PAUSED_NOTICE.action.href} className={textLink}>
        {SELL_PAUSED_NOTICE.action.label}
      </Link>
    </p>
  );

  const soldByWords = seller ? soldByLine(seller.name, seller.canRename) : null;
  const soldBy = soldByWords && (
    <p className="break-words text-sm text-muted-foreground">
      {soldByWords.sentence}
      {soldByWords.action && (
        <>
          {" "}
          <Link href={soldByWords.action.href} className={textLink}>
            {soldByWords.action.label}
          </Link>
        </>
      )}
    </p>
  );

  const editListing = listing && (
    <Link
      href={`/dashboard/marketplace/publish?edit=${encodeURIComponent(listing.id)}`}
      className={cn(buttonVariants({ variant: "ghost" }))}
    >
      Edit the listing
    </Link>
  );

  if (listing && status && onSale) {
    return (
      <div className="space-y-6">
        {pausedNotice}
        <Card>
          <CardHeader>
            <div ref={statusRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 rounded focus-visible:outline-none">
              <CardTitle className="min-w-0 break-words text-base">{listing.title}</CardTitle>
              <Badge variant="success">{status.label}</Badge>
            </div>
            <CardDescription>{status.sentence}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {listing.sells === "copies" ? (
              <Link href={`/marketplace/${listing.slug}`} className={`inline-flex items-center gap-1 text-sm ${textLink}`}>
                Open the listing
              </Link>
            ) : link?.url ? (
              <div className="space-y-2">
                <CopyRow label="Link" value={link.url} />
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1 text-sm ${textLink}`}
                >
                  Open
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">the agent&apos;s page in a new tab</span>
                </a>
              </div>
            ) : link?.handle ? (
              <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {PUBLIC_LINK_WORDS.addressUnavailable} The page is at <code>/a/{link.handle}</code> on WheelsAI.
              </p>
            ) : (
              <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {PUBLIC_LINK_WORDS.addressUnavailable}
              </p>
            )}

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

            {walletOnLine && <p className="text-sm text-foreground">{walletOnLine}</p>}

            {(earned || stats.length > 0) && (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {earned && (
                <>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">You earned</dt>
                    <dd className="break-words font-mono text-lg font-semibold tabular-nums text-foreground">{earned.earned}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Paid uses</dt>
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
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5 py-6">
            {question}
            {soldBy}
            {problem}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void save()} isLoading={busy === "save"} disabled={busy !== null || unchanged}>
                {SELL_WORDS.saveChanges}
              </Button>
              <Button type="button" variant="outline" onClick={() => void stop()} isLoading={busy === "stop"} disabled={busy !== null}>
                {SELL_WORDS.stopSelling}
              </Button>
              {editListing}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        {pausedNotice}
        {status && (
          <div ref={statusRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 rounded focus-visible:outline-none">
            <Badge variant={status.standing === "in_review" ? "warning" : "secondary"}>{status.label}</Badge>
            <p className="min-w-0 text-sm text-muted-foreground">{status.sentence}</p>
          </div>
        )}
        {question}
        {!listing && !knownLine && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-line`}>{SELL_WORDS.describe}</Label>
            <Input
              ref={lineRef}
              id={`${id}-line`}
              value={lineDraft}
              maxLength={LISTING_LINE_MAX}
              placeholder="Answers questions about our opening hours and prices"
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
                It shows with the agent&apos;s name on the marketplace.
              </p>
            )}
          </div>
        )}
        {soldBy}
        {problem}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save()} isLoading={busy === "save"} disabled={busy !== null}>
            {SELL_WORDS.putOnSale}
          </Button>
          {editListing}
        </div>
      </CardContent>
    </Card>
  );
}
