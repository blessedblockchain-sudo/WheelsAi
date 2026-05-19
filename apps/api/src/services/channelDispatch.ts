/**
 * Outbound channel reply builders (plan A6).
 *
 * Pure functions that take the agent's reply text and a channel's outbound
 * credentials, and return a {method, url, headers, body} descriptor. The
 * worker layer performs the actual fetch — these stay deterministic so the
 * dispatch logic is unit-testable without the network.
 *
 * Truncation to each platform's hard limit happens here so the worker never
 * has to care about per-platform lengths. Platform credentials are tagged
 * unions so calling the wrong builder is a type error.
 */

export interface OutboundRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

// ============================================
// Discord
// ============================================

export interface DiscordReplyInput {
  botToken: string;
  channelId: string;
  text: string;
}

const DISCORD_MAX = 2000;

export function buildDiscordReply(input: DiscordReplyInput): OutboundRequest {
  const channel = encodeURIComponent(input.channelId);
  const text = input.text.slice(0, DISCORD_MAX);
  return {
    method: "POST",
    url: `https://discord.com/api/v10/channels/${channel}/messages`,
    headers: {
      "Authorization": `Bot ${input.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: text }),
  };
}

// ============================================
// Telegram
// ============================================

export interface TelegramReplyInput {
  botToken: string;
  chatId: string;
  text: string;
}

const TELEGRAM_MAX = 4096;

export function buildTelegramReply(input: TelegramReplyInput): OutboundRequest {
  if (/\s/.test(input.botToken)) {
    throw new Error("botToken must not contain whitespace");
  }
  const text = input.text.slice(0, TELEGRAM_MAX);
  return {
    method: "POST",
    url: `https://api.telegram.org/bot${input.botToken}/sendMessage`,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: input.chatId, text }),
  };
}

// ============================================
// Slack
// ============================================

export interface SlackReplyInput {
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string;
}

export function buildSlackReply(input: SlackReplyInput): OutboundRequest {
  const bodyObj: Record<string, string> = {
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) bodyObj.thread_ts = input.threadTs;
  return {
    method: "POST",
    url: "https://slack.com/api/chat.postMessage",
    headers: {
      "Authorization": `Bearer ${input.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(bodyObj),
  };
}

// ============================================
// Dispatcher
// ============================================

export type OutboundCredentials =
  | { kind: "discord-bot"; botToken: string }
  | { kind: "telegram-bot"; botToken: string }
  | { kind: "slack-bot"; botToken: string };

export interface BuildReplyInput {
  platform: "discord" | "telegram" | "slack";
  credentials: OutboundCredentials;
  channelId: string;
  text: string;
  threadTs?: string;
}

export function buildReplyForPlatform(input: BuildReplyInput): OutboundRequest {
  if (input.platform === "discord" && input.credentials.kind === "discord-bot") {
    return buildDiscordReply({
      botToken: input.credentials.botToken,
      channelId: input.channelId,
      text: input.text,
    });
  }
  if (input.platform === "telegram" && input.credentials.kind === "telegram-bot") {
    return buildTelegramReply({
      botToken: input.credentials.botToken,
      chatId: input.channelId,
      text: input.text,
    });
  }
  if (input.platform === "slack" && input.credentials.kind === "slack-bot") {
    return buildSlackReply({
      botToken: input.credentials.botToken,
      channel: input.channelId,
      text: input.text,
      threadTs: input.threadTs,
    });
  }
  throw new Error(
    `credential kind mismatch: platform=${input.platform} credentials.kind=${input.credentials.kind}`,
  );
}
