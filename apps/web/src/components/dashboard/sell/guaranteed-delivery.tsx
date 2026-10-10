"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, offeringsApi, type PublisherOffering } from "@/lib/api";
import { OFFERING_STATUS } from "@/lib/jobs";
import {
  DEFAULT_DELIVERY_SECONDS,
  GUARANTEED_PRICE_LABEL,
  LISTING_LINE_MAX,
  SELL_LINE_TOO_SHORT,
  SELL_WORDS,
  checkTaskPrice,
  deliveryOptions,
  guaranteedOfferingBody,
  guaranteedOfferingOf,
  handWrittenOfferings,
  sellLineOf,
} from "@/lib/sell-choice";

export interface GuaranteedDeliveryProps {
  agent: { id: string; name: string; description: string | null };
  /** The line the agent's listing opens with, when it has one. */
  listingLine?: string | null;
  /** Whether a paid task can be run now; null when the server did not say. */
  paidTasksAvailable: boolean | null;
}

const OFFERINGS_HREF = "/dashboard/marketplace/offerings";

/**
 * A task agent sold with guaranteed delivery: one offering whose form is the
 * agent's own. It sets the price and the delivery time, turns the offering
 * on and off, and shows buyers the new form after the agent's form changed.
 */
export function GuaranteedDelivery({ agent, listingLine, paidTasksAvailable }: GuaranteedDeliveryProps) {
  const id = useId();
  const [offerings, setOfferings] = useState<PublisherOffering[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [price, setPrice] = useState("");
  const [seconds, setSeconds] = useState(DEFAULT_DELIVERY_SECONDS);
  const [lineDraft, setLineDraft] = useState("");
  const [priceError, setPriceError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  const offering = offerings ? guaranteedOfferingOf(offerings, agent.id) : null;
  const others = offerings ? handWrittenOfferings(offerings, agent.id) : 0;
  const knownLine = sellLineOf([listingLine, agent.description]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { offerings: mine } = await offeringsApi.listMine();
      if (!mounted.current) return;
      setOfferings(mine);
      const current = guaranteedOfferingOf(mine, agent.id);
      if (current) {
        setPrice((current.priceCents / 100).toFixed(2));
        setSeconds(current.slaSeconds);
      }
    } catch (err) {
      if (mounted.current) setLoadError(err);
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  /** One change. The offerings are read again whether it worked or not: a refused change may have saved a part. */
  async function run(what: string, done: string, change: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await change();
      toast.success(done);
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, "That could not be saved. Try again."));
    } finally {
      await load();
      if (mounted.current) setBusy(null);
    }
  }

  function checkedPrice(): number | null {
    const checked = checkTaskPrice(price);
    if (checked.ok) {
      setPriceError(null);
      return checked.cents;
    }
    setPriceError(checked.message);
    priceRef.current?.focus();
    return null;
  }

  async function turnOn(event: React.FormEvent) {
    event.preventDefault();
    const cents = checkedPrice();
    if (cents === null) return;
    if (offering) {
      await run("on", "Guaranteed delivery is on", async () => {
        await offeringsApi.update(offering.id, { priceCents: cents, slaSeconds: seconds });
        await offeringsApi.setStatus(offering.id, "activate");
      });
      return;
    }
    const line = sellLineOf([knownLine, lineDraft]);
    if (!line) {
      setLineError(SELL_LINE_TOO_SHORT);
      lineRef.current?.focus();
      return;
    }
    setLineError(null);
    await run("on", "Guaranteed delivery is on", async () => {
      const { offering: made } = await offeringsApi.create(guaranteedOfferingBody(agent, line, cents, seconds));
      await offeringsApi.setStatus(made.id, "activate");
    });
  }

  async function saveTerms(event: React.FormEvent) {
    event.preventDefault();
    if (!offering) return;
    const cents = checkedPrice();
    if (cents === null) return;
    await run("save", "Changes saved", () => offeringsApi.update(offering.id, { priceCents: cents, slaSeconds: seconds }));
  }

  if (loadError !== null && offerings === null) {
    return <ErrorState title="Couldn't load guaranteed delivery" error={loadError} onRetry={() => void load()} />;
  }

  if (offerings === null) {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">Loading guaranteed delivery</span>
        <Skeleton className="h-4 w-full max-w-lg" />
        <Skeleton className="h-10 w-full max-w-sm" />
      </div>
    );
  }

  const active = offering?.status === "active";
  const status = offering ? OFFERING_STATUS[offering.status] : null;
  const unchanged = offering !== null && price.trim() === (offering.priceCents / 100).toFixed(2) && seconds === offering.slaSeconds;

  return (
    <form onSubmit={active ? saveTerms : turnOn} className="space-y-4" noValidate>
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-sm text-foreground">{SELL_WORDS.guaranteed}</p>
        {status && <Badge variant={status.tone}>{status.label}</Badge>}
      </div>

      {paidTasksAvailable === false && (
        <p role="status" className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-foreground">
          {SELL_WORDS.paidTasksUnavailable}
        </p>
      )}

      {offering?.formInSync === false && (
        <div className="flex flex-col gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">{SELL_WORDS.formDrift}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 self-start sm:self-auto"
            isLoading={busy === "form"}
            disabled={busy !== null}
            onClick={() =>
              void run("form", "Buyers now see the new form", () => offeringsApi.update(offering.id, { fromAgentForm: true }))
            }
          >
            {SELL_WORDS.showNewForm}
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-price`}>{GUARANTEED_PRICE_LABEL}</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground" aria-hidden="true">
              $
            </span>
            <Input
              ref={priceRef}
              id={`${id}-price`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="5.00"
              value={price}
              onChange={(event) => {
                setPrice(event.target.value);
                setPriceError(null);
              }}
              aria-describedby={priceError ? `${id}-price-error` : undefined}
              aria-invalid={priceError ? true : undefined}
              disabled={busy !== null}
            />
          </div>
          {priceError && (
            <p id={`${id}-price-error`} role="alert" className="text-sm text-danger">
              {priceError}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-time`}>{SELL_WORDS.deliveredWithin}</Label>
          <Select
            id={`${id}-time`}
            value={String(seconds)}
            onChange={(event) => setSeconds(Number(event.target.value))}
            disabled={busy !== null}
          >
            {deliveryOptions(offering?.slaSeconds).map((option) => (
              <option key={option.seconds} value={option.seconds}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!offering && !knownLine && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-line`}>{SELL_WORDS.describe}</Label>
          <Input
            ref={lineRef}
            id={`${id}-line`}
            value={lineDraft}
            maxLength={LISTING_LINE_MAX}
            onChange={(event) => {
              setLineDraft(event.target.value);
              setLineError(null);
            }}
            aria-describedby={lineError ? `${id}-line-error` : undefined}
            aria-invalid={lineError ? true : undefined}
            disabled={busy !== null}
          />
          {lineError && (
            <p id={`${id}-line-error`} role="alert" className="text-sm text-danger">
              {lineError}
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {active ? (
          <>
            <Button type="submit" size="sm" isLoading={busy === "save"} disabled={busy !== null || unchanged}>
              {SELL_WORDS.saveChanges}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              isLoading={busy === "pause"}
              disabled={busy !== null}
              onClick={() =>
                void run("pause", "Guaranteed delivery is paused", () => offeringsApi.setStatus(offering.id, "pause"))
              }
            >
              Pause guaranteed delivery
            </Button>
          </>
        ) : (
          <Button type="submit" size="sm" isLoading={busy === "on"} disabled={busy !== null}>
            Turn on guaranteed delivery
          </Button>
        )}
      </div>

      {others > 0 && (
        <p className="text-sm text-muted-foreground">
          {others === 1
            ? "This agent also has 1 offering with a form written by hand."
            : `This agent also has ${others.toLocaleString("en-US")} offerings with a form written by hand.`}{" "}
          <Link
            href={OFFERINGS_HREF}
            className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open Offerings
          </Link>
        </p>
      )}
    </form>
  );
}
