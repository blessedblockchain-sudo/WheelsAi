"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorCode, getErrorMessage, tryItApi, type ListingTrialSettings } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";

/** The most funded messages a day a listing may be set to (routes/tryIt.ts). */
const MAX_FUNDED_DAILY_CAP = 10_000;

/**
 * A publisher's Try it settings for one listing. Try it itself has no
 * switch: every published listing can be tried, on a free model the platform
 * provides, up to the platform's daily messages. What a publisher can change
 * is how many more messages a day they pay for.
 */
export function TrialSettingsDialog({
  listing,
  onOpenChange,
}: {
  /** null = closed. */
  listing: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [settings, setSettings] = useState<ListingTrialSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [cap, setCap] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listingId = listing?.id ?? null;

  async function load(target: string) {
    setSettings(null);
    setLoadError(null);
    setSaveError(null);
    try {
      const loaded = await tryItApi.getSettings(target);
      setSettings(loaded);
      setCap(String(loaded.trial.fundedDailyCap));
    } catch (error) {
      setLoadError(error);
    }
  }

  useEffect(() => {
    if (listingId) void load(listingId);
  }, [listingId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!listingId) return;
    const trimmed = cap.trim();
    const value = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || value > MAX_FUNDED_DAILY_CAP) {
      setSaveError(`A whole number from 0 to ${formatNumber(MAX_FUNDED_DAILY_CAP)}.`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await tryItApi.updateSettings(listingId, { fundedDailyCap: value });
      setSettings(saved);
      setCap(String(saved.trial.fundedDailyCap));
      toast.success("Try it settings saved");
    } catch (error) {
      // 501 while a funded message has no price. The response names the
      // missing setting for operators; publishers get a product sentence.
      // Nothing was changed.
      setSaveError(
        apiErrorCode(error) === "trial_funding_not_configured"
          ? "Paid Try it messages are temporarily unavailable. Nothing was changed."
          : getErrorMessage(error, "The settings could not be saved."),
      );
    } finally {
      setSaving(false);
    }
  }

  const priced = settings !== null && settings.pricing.fundedMessageCents !== null;

  return (
    <Dialog open={listing !== null} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
        <DialogHeader>
          <DialogTitle id={`${id}-title`}>Try it: {listing?.title}</DialogTitle>
          <DialogDescription id={`${id}-description`}>
            Visitors can chat with this agent for free before they install or hire it. Previews run on a free model
            WheelsAI provides, never on your keys, and without tools that spend, write, read saved files or send
            requests out.
          </DialogDescription>
        </DialogHeader>

        {loadError !== null ? (
          <div className="mt-4">
            <ErrorState title="Couldn't load the Try it settings" error={loadError} onRetry={() => listingId && void load(listingId)} />
          </div>
        ) : settings === null ? (
          <div className="mt-4 space-y-3" aria-busy="true">
            <span className="sr-only">Loading Try it settings</span>
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form onSubmit={save} className="mt-4 space-y-5" noValidate>
            <p className="text-sm text-foreground">
              {settings.trial.enabled
                ? "Try it is on: every published listing has it."
                : "Try it turns on when this listing is published."}
            </p>

            <dl className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
              <dt className="text-muted-foreground">Free messages a day (paid by WheelsAI)</dt>
              <dd className="text-right text-foreground">{formatNumber(settings.pricing.baseDailyMessages)}</dd>
              <dt className="text-muted-foreground">Used today ({settings.today.day}, UTC)</dt>
              <dd className="text-right text-foreground">
                {settings.today.baseCount === null ? "Unavailable right now" : formatNumber(settings.today.baseCount)}
              </dd>
              <dt className="text-muted-foreground">Messages you paid for today</dt>
              <dd className="text-right text-foreground">
                {formatNumber(settings.today.fundedCount)} ({formatCurrency(settings.today.fundedSpentCents)})
              </dd>
            </dl>

            <div>
              <Label htmlFor={`${id}-cap`}>Extra messages a day that you pay for</Label>
              <Input
                id={`${id}-cap`}
                className="mt-1"
                inputMode="numeric"
                value={cap}
                disabled={!priced && settings.trial.fundedDailyCap === 0}
                onChange={(event) => setCap(event.target.value)}
                aria-describedby={`${id}-cap-help`}
              />
              <p id={`${id}-cap-help`} className="mt-1 text-xs text-muted-foreground">
                {priced
                  ? `Used only after the free messages run out. Each one costs ${formatCurrency(
                      settings.pricing.fundedMessageCents!,
                    )} from your credits, charged when the answer is delivered and returned if it is not. 0 turns this off.`
                  : "Paid Try it messages are temporarily unavailable, so nothing is charged. Your listing keeps its free daily messages."}
              </p>
              {saveError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {saveError}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Close
              </Button>
              <Button type="submit" disabled={saving || (!priced && settings.trial.fundedDailyCap === 0)}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
