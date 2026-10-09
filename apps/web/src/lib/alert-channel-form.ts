/**
 * The "Add notification channel" form of the Monitoring page: which setting
 * each kind of channel is saved under, what is wrong with what was typed,
 * and where a refusal's sentences go. Pure, so the dialog only lays it out.
 *
 * Slack and Discord take the link the service gave (`config.webhookUrl`), a
 * webhook takes an address (`config.url`), and email takes one address or
 * several (`config.emails`).
 */

export const ALERT_CHANNEL_TYPES = ["slack", "discord", "webhook", "email"] as const;
export type AlertChannelFormType = (typeof ALERT_CHANNEL_TYPES)[number];

export interface AlertChannelDraft {
  name: string;
  type: AlertChannelFormType;
  /** The link, the address or the email addresses, as typed. */
  target: string;
}

export interface AlertChannelTarget {
  /** The name on the menu. */
  option: string;
  /** The label of the input. */
  label: string;
  placeholder: string;
  inputType: "url" | "text";
  hint: string | null;
}

export const ALERT_CHANNEL_TARGETS: Record<AlertChannelFormType, AlertChannelTarget> = {
  slack: {
    option: "Slack",
    label: "Slack link",
    placeholder: "https://hooks.slack.com/services/...",
    inputType: "url",
    hint: "Paste the link Slack gave you for this channel.",
  },
  discord: {
    option: "Discord",
    label: "Discord link",
    placeholder: "https://discord.com/api/webhooks/...",
    inputType: "url",
    hint: "Paste the link Discord gave you for this channel.",
  },
  webhook: {
    option: "Webhook",
    label: "Webhook address",
    placeholder: "https://example.com/alerts",
    inputType: "url",
    hint: null,
  },
  email: {
    option: "Email",
    label: "Email addresses",
    placeholder: "you@example.com, team@example.com",
    inputType: "text",
    hint: "Separate several addresses with commas.",
  },
};

export const ALERT_CHANNEL_MESSAGES = {
  name: "Give this channel a name.",
  link: "Enter a link that starts with https://.",
  noEmail: "Enter at least one email address.",
  failed: "The channel could not be saved. Try again.",
} as const;

export type AlertChannelErrors = Partial<Record<"name" | "target" | "form", string>>;

/** The addresses typed into the email input: split on commas, semicolons and white space. */
export function emailsOf(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

function isLink(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AlertChannelBody {
  name: string;
  type: AlertChannelFormType;
  config: { webhookUrl: string } | { url: string } | { emails: string[] };
}

/** What is sent for a draft, with each kind's setting under its own name, and what is wrong with the draft. */
export function alertChannelBody(draft: AlertChannelDraft): { body: AlertChannelBody; errors: AlertChannelErrors } {
  const errors: AlertChannelErrors = {};
  const name = draft.name.trim();
  const target = draft.target.trim();
  if (!name) errors.name = ALERT_CHANNEL_MESSAGES.name;

  let config: AlertChannelBody["config"];
  if (draft.type === "email") {
    const emails = emailsOf(target);
    const bad = emails.find((address) => !EMAIL.test(address));
    if (emails.length === 0) errors.target = ALERT_CHANNEL_MESSAGES.noEmail;
    else if (bad) errors.target = `"${bad}" is not an email address.`;
    config = { emails };
  } else {
    if (!isLink(target)) errors.target = ALERT_CHANNEL_MESSAGES.link;
    config = draft.type === "webhook" ? { url: target } : { webhookUrl: target };
  }
  return { body: { name, type: draft.type, config }, errors };
}

const TARGET_PATHS = new Set(["config", "config.webhookUrl", "config.url", "config.emails", "webhookUrl", "url", "emails"]);

/**
 * A refused save, as sentences under the inputs. A body with `fields` files
 * each one under its input; any other refusal gives the server's own
 * sentence for the form as a whole.
 */
export function alertChannelServerErrors(err: unknown): AlertChannelErrors {
  const data = (err as { data?: unknown } | null)?.data;
  const body = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  const errors: AlertChannelErrors = {};

  const fields = body?.fields;
  if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
    for (const [path, sentence] of Object.entries(fields)) {
      if (typeof sentence !== "string") continue;
      if (path === "name") errors.name ??= sentence;
      else if (TARGET_PATHS.has(path) || path.startsWith("config.")) errors.target ??= sentence;
      else errors.form ??= sentence;
    }
  }
  if (Object.keys(errors).length > 0) return errors;

  const sentence = [body?.message, body?.error].find((value) => typeof value === "string" && value.trim());
  return { form: typeof sentence === "string" ? sentence : ALERT_CHANNEL_MESSAGES.failed };
}
