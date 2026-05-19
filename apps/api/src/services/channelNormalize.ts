/**
 * Inbound webhook payload normalization (plan A6).
 *
 * Takes a raw platform-specific webhook body and flattens it to a single
 * `InboundMessage` shape the agent-message queue can consume. Platforms we
 * currently support: Discord (gateway MESSAGE_CREATE), Telegram (bot API
 * update), Slack (events API event_callback). Everything else returns null.
 *
 * Bot-authored messages are dropped here so the agent doesn't chat with
 * itself or with other bots (loop prevention). Slack's url_verification
 * handshake is returned as a sentinel so the route can respond with the
 * challenge without enqueueing.
 */

export type SupportedPlatform = "discord" | "telegram" | "slack";

export interface InboundMessage {
  platform: SupportedPlatform;
  messageId: string;
  channelId: string;
  userId: string;
  userName: string | null;
  text: string;
  raw: unknown;
}

export interface SlackUrlVerification {
  __special: "slack_url_verification";
  challenge: string;
}

export type NormalizedResult = InboundMessage | SlackUrlVerification | null;

export interface NormalizeInput {
  platform: SupportedPlatform | string;
  payload: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeDiscord(payload: unknown): InboundMessage | null {
  if (!isRecord(payload)) return null;
  if (payload.t !== "MESSAGE_CREATE") return null;
  const d = payload.d;
  if (!isRecord(d)) return null;
  const author = isRecord(d.author) ? d.author : null;
  if (!author) return null;
  if (author.bot === true) return null;
  const id = typeof d.id === "string" ? d.id : null;
  const channelId = typeof d.channel_id === "string" ? d.channel_id : null;
  const userId = typeof author.id === "string" ? author.id : null;
  const text = typeof d.content === "string" ? d.content : null;
  if (!id || !channelId || !userId || text === null) return null;
  return {
    platform: "discord",
    messageId: id,
    channelId,
    userId,
    userName: typeof author.username === "string" ? author.username : null,
    text,
    raw: payload,
  };
}

function normalizeTelegram(payload: unknown): InboundMessage | null {
  if (!isRecord(payload)) return null;
  const message = isRecord(payload.message) ? payload.message : null;
  if (!message) return null;
  const text = typeof message.text === "string" ? message.text : null;
  if (text === null) return null;
  const chat = isRecord(message.chat) ? message.chat : null;
  const from = isRecord(message.from) ? message.from : null;
  if (!chat || !from) return null;
  const channelId =
    typeof chat.id === "number" || typeof chat.id === "string" ? String(chat.id) : null;
  const userId =
    typeof from.id === "number" || typeof from.id === "string" ? String(from.id) : null;
  const messageId =
    typeof message.message_id === "number" || typeof message.message_id === "string"
      ? String(message.message_id)
      : null;
  if (!channelId || !userId || !messageId) return null;
  return {
    platform: "telegram",
    messageId,
    channelId,
    userId,
    userName: typeof from.username === "string" ? from.username : null,
    text,
    raw: payload,
  };
}

function normalizeSlack(payload: unknown): NormalizedResult {
  if (!isRecord(payload)) return null;
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return { __special: "slack_url_verification", challenge: payload.challenge };
  }
  if (payload.type !== "event_callback") return null;
  const event = isRecord(payload.event) ? payload.event : null;
  if (!event) return null;
  if (event.type !== "message") return null;
  if (event.subtype === "bot_message" || event.bot_id) return null;
  const channelId = typeof event.channel === "string" ? event.channel : null;
  const userId = typeof event.user === "string" ? event.user : null;
  const ts = typeof event.ts === "string" ? event.ts : null;
  const text = typeof event.text === "string" ? event.text : null;
  if (!channelId || !userId || !ts || text === null) return null;
  return {
    platform: "slack",
    messageId: ts,
    channelId,
    userId,
    userName: null,
    text,
    raw: payload,
  };
}

export function normalizeInboundMessage(input: NormalizeInput): NormalizedResult {
  switch (input.platform) {
    case "discord":
      return normalizeDiscord(input.payload);
    case "telegram":
      return normalizeTelegram(input.payload);
    case "slack":
      return normalizeSlack(input.payload);
    default:
      return null;
  }
}
