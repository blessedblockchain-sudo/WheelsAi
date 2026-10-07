/**
 * Registers a deployment's Telegram bot with Telegram (setWebhook), so
 * updates reach POST /api/channels/webhooks/:deploymentId/telegram carrying
 * the per-deployment secret token the webhook route verifies.
 *
 * Before this, nothing called setWebhook: a Telegram channel could be
 * saved but Telegram never sent it anything, and the route checked a
 * signature header Telegram does not send.
 */
import { telegramWebhookSecret } from "./channelAuth.js";

const TELEGRAM_API = "https://api.telegram.org";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type TelegramWebhookResult =
  | { registered: true; url: string }
  | { registered: false; reason: string };

export class TelegramRejectedError extends Error {
  readonly code = "telegram_rejected";
  constructor(description: string) {
    super(`Telegram rejected this bot: ${description}`);
    this.name = "TelegramRejectedError";
  }
}

export function telegramWebhookUrl(publicApiUrl: string, deploymentId: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}/api/channels/webhooks/${encodeURIComponent(deploymentId)}/telegram`;
}

async function callBotApi(
  fetchFn: FetchFn,
  botToken: string,
  method: "setWebhook" | "deleteWebhook" | "getWebhookInfo",
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    return { ok: false, description: "the bot token is not in the 123456:ABC... format BotFather issues" };
  }
  const res = await fetchFn(`${TELEGRAM_API}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  return {
    ok: res.ok && body.ok === true,
    description: body.description ?? `HTTP ${res.status}`,
    result: body.result,
  };
}

/**
 * Point the bot at this deployment. Throws TelegramRejectedError when
 * Telegram refuses (bad token, unreachable URL); returns registered:false
 * without calling Telegram when the API has no public URL to give it.
 */
export async function registerTelegramWebhook(args: {
  botToken: string;
  deploymentId: string;
  publicApiUrl: string | undefined;
  fetchFn?: FetchFn;
}): Promise<TelegramWebhookResult> {
  if (!args.publicApiUrl) {
    return { registered: false, reason: "Telegram delivery is temporarily unavailable. Try again later." };
  }
  const url = telegramWebhookUrl(args.publicApiUrl, args.deploymentId);
  const result = await callBotApi(args.fetchFn ?? (fetch as unknown as FetchFn), args.botToken, "setWebhook", {
    url,
    secret_token: telegramWebhookSecret(args.botToken, args.deploymentId),
    allowed_updates: ["message"],
  });
  if (!result.ok) throw new TelegramRejectedError(result.description ?? "unknown error");
  return { registered: true, url };
}

/**
 * Best effort: stop Telegram delivering to a removed or disabled channel.
 *
 * Only deletes the bot's webhook while it still points at `onlyIfUrl`
 * (this deployment's webhook URL). A bot the owner has since pointed
 * somewhere else, including another deployment, is left alone.
 */
export async function unregisterTelegramWebhook(args: {
  botToken: string;
  onlyIfUrl: string;
  fetchFn?: FetchFn;
}): Promise<boolean> {
  const fetchFn = args.fetchFn ?? (fetch as unknown as FetchFn);
  try {
    const info = await callBotApi(fetchFn, args.botToken, "getWebhookInfo", {});
    const currentUrl = (info.result as { url?: unknown } | undefined)?.url;
    if (!info.ok || currentUrl !== args.onlyIfUrl) return false;
    const result = await callBotApi(fetchFn, args.botToken, "deleteWebhook", {});
    return result.ok;
  } catch {
    return false;
  }
}
