/**
 * The chat channels an agent can be reached on today, for every place this
 * site states them: the landing page's count and copy, the terminal preview,
 * the dashboard's Channels tab.
 *
 * It mirrors LIVE_CHAT_CHANNELS in apps/api/src/routes/channelWebhooks.ts,
 * the list GET /api/public/stats counts. The two cannot share a module (the
 * API is not a dependency of the site), so
 * apps/api/src/tests/chatChannelsClaim.unit.test.ts fails when they differ:
 * a channel is added to both in the change that makes it live, or to neither.
 */
export const LIVE_CHAT_CHANNELS = ["discord", "telegram", "slack", "web"] as const;

export type LiveChatChannel = (typeof LIVE_CHAT_CHANNELS)[number];

const LABELS: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  web: "Web",
  webchat: "Web",
  twitter: "X",
  api: "API",
};

/** A channel's name as written in the UI; an unknown platform keeps its own. */
export function chatChannelLabel(platform: string): string {
  return LABELS[platform] ?? platform;
}

/** "Discord, Telegram, Slack & Web": the live channels as one phrase. */
export function liveChatChannelList(lastSeparator: " & " | " and " | ", " = " & "): string {
  const names = LIVE_CHAT_CHANNELS.map(chatChannelLabel);
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")}${lastSeparator}${names[names.length - 1]}`;
}
