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
import { cn } from "@/lib/utils";
import { CopyRow } from "./api-tab";

export interface SellTabProps {
  agent: AgentDetail;
  /** Called after a change the rest of the page should see (the agent went on sale and got its page). */
  onAgentChanged?: () => void;
}

type Revenue = Awaited<ReturnType<typeof marketplaceApi.getRevenue>>;

interface SellData {
  listing: MarketplaceListing | null;
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
  const [errors, setErrors] = useState<SellErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [lineError, setLineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "stop" | null>(null);
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

  const load = useCallback(async () => {
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
      if (!mounted.current) return;
      const listing = listingForAgent(listings, agent.id);
      const kept = pageKey?.storeTranscripts ?? false;
      setData({ listing, capabilities, link, revenue, keepCopy: kept });
      setForm(formOfListing(listing, agent.agentKind));
      setKeepCopy(kept);
      setErrors({});
    } catch (err) {
      if (mounted.current) setLoadError(err);
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
  const unchanged = sameSellForm(form, baseline) && (!asksForPayment(form) || keepCopy === data.keepCopy);

  function change(next: SellForm) {
    setForm(next);
    setErrors({});
    setError(null);
  }

  async function save(sent: SellForm = form) {
    setError(null);
    const built = buildSellSave(sent, agent, limits);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    const line = sellLineOf([knownLine, lineDraft]);
    if (!listing && !line) {
      setLineError(SELL_LINE_TOO_SHORT);
      lineRef.current?.focus();
      return;
    }
    setLineError(null);

    setBusy("save");
    try {
      if (listing) await marketplaceApi.updateListing(listing.id, sellUpdateOf(built.save, listing));
      else await marketplaceApi.createListing(firstListingOf(agent, line ?? "", built.save));
    } catch (err) {
      if (!mounted.current) return;
      const fields = getValidationError(err)?.fields;
      const fieldErrors = fields ? sellFieldErrors(fields) : {};
      setErrors(fieldErrors);
      // The API's own sentence, as it came.
      if (Object.keys(fieldErrors).length === 0) setError(getErrorMessage(err, "That could not be saved. Try again."));
      setBusy(null);
      // Another tab or a teammate listed this agent meanwhile: show that listing.
      if (codeOf(err) === "listing_exists") {
        const message = getErrorMessage(err, "This agent already has a listing.");
        await load();
        if (mounted.current) setError(message);
      }
      return;
    }

    // The agent has its page now, so the copy setting has a place to be saved.
    let keepProblem: string | null = null;
    if (asksForPayment(sent)) {
      try {
        await saveKeepCopy(agent.id, keepCopy);
      } catch (err) {
        keepProblem = getErrorMessage(err, "Try again.");
      }
    }

    toast.success(onSale ? "Changes saved" : "Your agent is on sale");
    focusStatus.current = !onSale;
    await load();
    if (!mounted.current) return;
    setBusy(null);
    if (keepProblem) setError(`Your choice was saved. The setting to keep a copy was not: ${keepProblem}`);
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

  const question = (
    <WhoCanUse
      agent={agent}
      form={form}
      onChange={change}
      errors={errors}
      limits={limits}
      capacity={capabilities?.paidUse.freeModelDailyAllowance ?? null}
      keepCopy={{ checked: keepCopy, onChange: setKeepCopy }}
      listing={listing}
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
    <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </p>
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
