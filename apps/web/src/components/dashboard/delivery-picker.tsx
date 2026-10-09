"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { destinationsApi, getErrorMessage, type Destination } from "@/lib/api";

export interface DeliveryPickerProps {
  /** The chosen place (`channelId` of `destinationsApi.list`), or null for "Only here". */
  value: string | null;
  onChange: (channelId: string | null) => void;
  /** A sentence under the picker, from the server ("That place was not found…"). */
  error?: string;
  /** The question above the picker. */
  label?: string;
  disabled?: boolean;
  /**
   * Told true while Slack or Discord is chosen and its link has not been
   * saved with "Use this channel", and false again once it has (or another
   * place was chosen). A form that would otherwise be sent without the link
   * holds its button meanwhile.
   */
  onPendingChange?: (pending: boolean) => void;
}

/** The sentences this picker shows; the server's own words for the same refusals are preferred when it sends them. */
export const DELIVERY_MESSAGES = {
  always: "Results are always saved here, on this agent's page.",
  webhooks: "Every finished run is also sent to your webhooks.",
  slackLink: "Paste the link Slack gave you for this channel.",
  discordLink: "Paste the link Discord gave you for this channel.",
  emailOff: "Email delivery is temporarily unavailable. Results are still saved here.",
  emailNotVerified: "Verify your email address first, then choose Email.",
  testSent: "Test sent.",
  testFailed: "The test could not be sent. Check the link and try again.",
  listFailed: "Your saved places could not be loaded. Results are still saved here.",
  removed: "A place that is no longer available",
} as const;

type LinkService = "slack" | "discord";

const SERVICE_NAMES: Record<LinkService, string> = { slack: "Slack", discord: "Discord" };

function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function codeOf(err: unknown): string | null {
  const data = (err as { data?: unknown } | null)?.data;
  const code = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : null;
  return typeof code === "string" ? code : null;
}

/** Why "Email me" could not be chosen, in the plan's words. */
function emailRefusal(err: unknown): string {
  if (statusOf(err) === 501 || codeOf(err) === "email_not_configured") return DELIVERY_MESSAGES.emailOff;
  if (codeOf(err) === "email_not_verified") return DELIVERY_MESSAGES.emailNotVerified;
  return getErrorMessage(err, DELIVERY_MESSAGES.emailOff);
}

/**
 * "Where should results go?": only the agent's page, the owner's own email,
 * a Slack or Discord channel by pasted link, or a place saved earlier.
 * Holds no choice of its own: `value` in, `onChange` out. It loads the saved
 * places itself and creates one when a link is pasted or "Email me" is
 * chosen for the first time.
 */
export function DeliveryPicker({
  value,
  onChange,
  error,
  label = "Where should results go?",
  disabled,
  onPendingChange,
}: DeliveryPickerProps) {
  const id = useId();
  const [places, setPlaces] = useState<Destination[] | null>(null);
  const [listError, setListError] = useState(false);
  /** Slack or Discord was chosen and its link has not been saved yet. */
  const [adding, setAdding] = useState<LinkService | null>(null);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setListError(false);
    destinationsApi
      .list()
      .then((list) => setPlaces(Array.isArray(list) ? list : []))
      .catch(() => {
        setPlaces([]);
        setListError(true);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pending = adding !== null;
  const reportPending = useRef(onPendingChange);
  useEffect(() => {
    reportPending.current = onPendingChange;
  });
  useEffect(() => {
    reportPending.current?.(pending);
    return () => {
      if (pending) reportPending.current?.(false);
    };
  }, [pending]);

  // A test result belongs to the place it was sent to.
  useEffect(() => setTestResult(null), [value]);

  const myEmail = places?.find((place) => place.type === "email" && place.mine) ?? null;
  const chosen = value ? (places?.find((place) => place.channelId === value) ?? null) : null;
  const others = (places ?? []).filter((place) => place !== myEmail && place.name !== "");

  const selected = adding
    ? adding
    : value === null
      ? "none"
      : myEmail && value === myEmail.channelId
        ? "email"
        : `place:${value}`;

  async function chooseEmail() {
    setEmailError(null);
    if (myEmail) {
      onChange(myEmail.channelId);
      return;
    }
    setEmailBusy(true);
    try {
      const place = await destinationsApi.create({ type: "email" });
      setPlaces((list) => [...(list ?? []).filter((p) => p.channelId !== place.channelId), { ...place, mine: true }]);
      onChange(place.channelId);
    } catch (err) {
      // The place that was chosen before stays chosen: a refusal changes nothing.
      setEmailError(emailRefusal(err));
    } finally {
      setEmailBusy(false);
    }
  }

  function choose(next: string) {
    setEmailError(null);
    setLinkError(null);
    setTestResult(null);
    if (next === "slack" || next === "discord") {
      setAdding(next);
      setLink("");
      return;
    }
    setAdding(null);
    if (next === "none") onChange(null);
    else if (next === "email") void chooseEmail();
    else if (next.startsWith("place:")) onChange(next.slice("place:".length));
  }

  async function saveLink() {
    if (!adding) return;
    const pasted = link.trim();
    if (!pasted) {
      setLinkError(DELIVERY_MESSAGES[adding === "slack" ? "slackLink" : "discordLink"]);
      return;
    }
    setSaving(true);
    setLinkError(null);
    try {
      const place = await destinationsApi.create({ type: adding, link: pasted });
      setPlaces((list) => [...(list ?? []).filter((p) => p.channelId !== place.channelId), place]);
      setAdding(null);
      setLink("");
      onChange(place.channelId);
    } catch (err) {
      setLinkError(getErrorMessage(err, DELIVERY_MESSAGES[adding === "slack" ? "slackLink" : "discordLink"]));
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!value) return;
    setTesting(true);
    setTestResult(null);
    try {
      await destinationsApi.test(value);
      setTestResult({ ok: true, text: DELIVERY_MESSAGES.testSent });
    } catch (err) {
      setTestResult({ ok: false, text: getErrorMessage(err, DELIVERY_MESSAGES.testFailed) });
    } finally {
      setTesting(false);
    }
  }

  if (places === null) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-place`}>{label}</Label>
        <Skeleton className="h-10 w-full max-w-sm" />
      </div>
    );
  }

  const linkHint = adding ? DELIVERY_MESSAGES[adding === "slack" ? "slackLink" : "discordLink"] : "";

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-place`}>{label}</Label>
        <div className="max-w-sm">
          <Select
            id={`${id}-place`}
            value={selected}
            disabled={disabled || emailBusy || saving}
            aria-describedby={`${id}-always`}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="none">Only here</option>
            <option value="email">Email me</option>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            {others.length > 0 && (
              <optgroup label="Saved places">
                {others.map((place) => (
                  <option key={place.channelId} value={`place:${place.channelId}`}>
                    {place.name}
                  </option>
                ))}
              </optgroup>
            )}
            {value !== null && !chosen && <option value={`place:${value}`}>{DELIVERY_MESSAGES.removed}</option>}
          </Select>
        </div>
        <p id={`${id}-always`} className="text-sm text-muted-foreground">
          {DELIVERY_MESSAGES.always}
        </p>
        {emailError && (
          <p role="alert" className="text-sm text-danger">
            {emailError}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {listError && (
          <p className="text-sm text-muted-foreground">
            {DELIVERY_MESSAGES.listFailed}{" "}
            <button
              type="button"
              onClick={load}
              className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </p>
        )}
      </div>

      {adding && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-link`}>{SERVICE_NAMES[adding]} link</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <Input
                id={`${id}-link`}
                type="url"
                value={link}
                disabled={disabled || saving}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  adding === "slack" ? "https://hooks.slack.com/services/..." : "https://discord.com/api/webhooks/..."
                }
                aria-describedby={`${id}-link-hint`}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveLink();
                  }
                }}
              />
            </div>
            <Button type="button" variant="outline" onClick={saveLink} isLoading={saving} disabled={disabled}>
              Use this channel
            </Button>
          </div>
          <p
            id={`${id}-link-hint`}
            role={linkError === linkHint ? "alert" : undefined}
            className={linkError === linkHint ? "text-sm text-danger" : "text-sm text-muted-foreground"}
          >
            {linkHint}
          </p>
          {linkError && linkError !== linkHint && (
            <p role="alert" className="text-sm text-danger">
              {linkError}
            </p>
          )}
        </div>
      )}

      {value !== null && !adding && chosen && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={sendTest} isLoading={testing} disabled={disabled}>
            Send a test
          </Button>
          {testResult && (
            <p role="status" className={testResult.ok ? "text-sm text-muted-foreground" : "text-sm text-danger"}>
              {testResult.text}
            </p>
          )}
        </div>
      )}

      <p className="text-sm text-muted-foreground">{DELIVERY_MESSAGES.webhooks}</p>
    </div>
  );
}
