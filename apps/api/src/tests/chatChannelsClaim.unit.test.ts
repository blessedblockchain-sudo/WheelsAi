/**
 * Every place that states the chat channels agrees with what is live.
 *
 * The API's LIVE_CHAT_CHANNELS is what GET /api/public/stats counts. The
 * site cannot import it, so it keeps a mirror (apps/web/src/lib/
 * chat-channels.ts) that drives the landing page and the README states the
 * count in prose. This test reads both as text and fails when either
 * disagrees, so a channel cannot be claimed in one place and not another.
 *
 * Run with: cd apps/api && npx tsx --test src/tests/chatChannelsClaim.unit.test.ts
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LIVE_CHAT_CHANNELS, WEB_CHAT_CHANNEL } from "../routes/channelWebhooks.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

test("the site's channel list is the API's, in the same order", () => {
  const source = read("apps/web/src/lib/chat-channels.ts");
  const match = /export const LIVE_CHAT_CHANNELS = (\[[^\]]*\]) as const;/.exec(source);
  assert.ok(match, "apps/web/src/lib/chat-channels.ts must export LIVE_CHAT_CHANNELS as a literal array");
  assert.deepEqual(JSON.parse(match[1]!), [...LIVE_CHAT_CHANNELS]);
});

test("the web channel is only claimed while the widget script ships with the site", () => {
  assert.ok((LIVE_CHAT_CHANNELS as readonly string[]).includes(WEB_CHAT_CHANNEL));
  assert.ok(existsSync(join(REPO, "apps/web/public/widget.js")), "apps/web/public/widget.js is the web channel");
});

test("the landing files take the count and the names from the list, not from a written number", () => {
  for (const file of ["social-proof.tsx", "stats-section.tsx", "code-preview.tsx", "features-grid.tsx", "how-it-works.tsx"]) {
    const source = read(`apps/web/src/components/landing/${file}`);
    assert.match(source, /@\/lib\/chat-channels/, `${file} must read lib/chat-channels`);
    assert.doesNotMatch(source, /\b\d+ Chat Channels\b/i, `${file} writes a channel count by hand`);
    assert.doesNotMatch(source, /Discord, Telegram(,| and| &) Slack/, `${file} writes the channel names by hand`);
  }
});

test("the README states the same number of chat channels", () => {
  const match = /(\d+)\s+chat channels/.exec(read("README.md").replace(/\s+/g, " "));
  assert.ok(match, "README.md states the number of chat channels");
  assert.equal(Number(match[1]), LIVE_CHAT_CHANNELS.length);
});
