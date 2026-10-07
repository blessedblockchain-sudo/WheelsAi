/**
 * The web chat key form, as plain data: what the dialog shows for a key and
 * what it sends back. Pure, so the "blank means the default" and "blank
 * clears it" rules are tested without a browser.
 *
 * Whether an entry really is an origin is decided by the server alone
 * (services/widgetKeys.ts normalizeOrigin); its 400 names the entry and the
 * dialog shows that message. A second copy of those rules here could only
 * drift.
 */
import type { WidgetKey, WidgetKeyInput, WidgetPosition } from "./api";

export interface WebKeyForm {
  agentId: string;
  name: string;
  /** One origin a line. */
  origins: string;
  /** "" = the platform's default. */
  dailyMessageCap: string;
  perIpPerMinute: string;
  title: string;
  greeting: string;
  /** "" = the widget's own blue. */
  primaryColor: string;
  position: WidgetPosition;
  storeTranscripts: boolean;
  hideBranding: boolean;
}

export const EMPTY_WEB_KEY_FORM: WebKeyForm = {
  agentId: "",
  name: "",
  origins: "",
  dailyMessageCap: "",
  perIpPerMinute: "",
  title: "",
  greeting: "",
  primaryColor: "",
  position: "bottom-right",
  storeTranscripts: false,
  hideBranding: false,
};

export function formFromKey(key: WidgetKey): WebKeyForm {
  return {
    agentId: key.agentId,
    name: key.name,
    origins: key.allowedOrigins.join("\n"),
    dailyMessageCap: key.dailyMessageCap === null ? "" : String(key.dailyMessageCap),
    perIpPerMinute: key.perIpPerMinute === null ? "" : String(key.perIpPerMinute),
    title: key.appearance.title ?? "",
    greeting: key.appearance.greeting ?? "",
    primaryColor: key.appearance.primaryColor ?? "",
    position: key.appearance.position,
    storeTranscripts: key.storeTranscripts,
    hideBranding: key.hideBranding,
  };
}

/** The lines of the origins box that say something; commas work as separators too. */
export function parseOrigins(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type WebKeyFormResult =
  | { ok: true; input: WidgetKeyInput & { name: string } }
  | { ok: false; field: keyof WebKeyForm; message: string };

function wholeNumber(text: string, min: number, max: number): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  return value >= min && value <= max ? value : "invalid";
}

/** The request body for a form, or the first field that cannot be sent. */
export function inputFromForm(form: WebKeyForm): WebKeyFormResult {
  const name = form.name.trim();
  if (name === "") return { ok: false, field: "name", message: "Give the key a name you will recognise." };
  if (name.length > 80) return { ok: false, field: "name", message: "The name can be up to 80 characters." };

  const dailyMessageCap = wholeNumber(form.dailyMessageCap, 1, 100_000);
  if (dailyMessageCap === "invalid") {
    return { ok: false, field: "dailyMessageCap", message: "A whole number from 1 to 100,000, or blank for the default." };
  }
  const perIpPerMinute = wholeNumber(form.perIpPerMinute, 1, 60);
  if (perIpPerMinute === "invalid") {
    return { ok: false, field: "perIpPerMinute", message: "A whole number from 1 to 60, or blank for the default." };
  }
  const primaryColor = form.primaryColor.trim();
  if (primaryColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
    return { ok: false, field: "primaryColor", message: "Write the colour as #RRGGBB, or leave it blank." };
  }
  if (form.title.trim().length > 60) return { ok: false, field: "title", message: "The title can be up to 60 characters." };
  if (form.greeting.trim().length > 500) {
    return { ok: false, field: "greeting", message: "The greeting can be up to 500 characters." };
  }

  return {
    ok: true,
    input: {
      name,
      allowedOrigins: parseOrigins(form.origins),
      dailyMessageCap,
      perIpPerMinute,
      appearance: {
        // Blank clears: the server takes null as "back to the default".
        title: form.title.trim() || null,
        greeting: form.greeting.trim() || null,
        primaryColor: primaryColor || null,
        position: form.position,
      },
      storeTranscripts: form.storeTranscripts,
      hideBranding: form.hideBranding,
    },
  };
}

/** "12 of 1,000 today", or that the count could not be read (never a made-up zero). */
export function usageLabel(usageToday: number | null, cap: number | null, defaultCap: number): string {
  const limit = new Intl.NumberFormat("en-US").format(cap ?? defaultCap);
  if (usageToday === null) return `Today's count is unavailable (cap ${limit})`;
  return `${new Intl.NumberFormat("en-US").format(usageToday)} of ${limit} messages today`;
}
