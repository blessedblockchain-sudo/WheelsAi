/**
 * The web chat key form. Run with:
 *   cd apps/web && npx tsx --test src/lib/web-channel.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WidgetKey } from "./api";
import { EMPTY_WEB_KEY_FORM, formFromKey, inputFromForm, parseOrigins, usageLabel } from "./web-channel";

const key: WidgetKey = {
  id: "k1",
  agentId: "a1",
  agentName: "Support",
  name: "Main site",
  publicKey: "wpk_" + "a".repeat(32),
  allowedOrigins: ["https://example.com", "https://*.example.com"],
  dailyMessageCap: 500,
  perIpPerMinute: null,
  appearance: { title: "Ask us", greeting: null, primaryColor: "#112233", position: "bottom-left" },
  storeTranscripts: true,
  hideBranding: false,
  enabled: true,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-07T00:00:00.000Z",
  usageToday: 3,
  snippet: null,
  snippetUnavailableReason: null,
};

test("origins: one a line or comma-separated, blanks dropped, nothing rewritten", () => {
  assert.deepEqual(parseOrigins(" https://a.com \n\nhttps://b.com, https://c.com\n"), [
    "https://a.com",
    "https://b.com",
    "https://c.com",
  ]);
  assert.deepEqual(parseOrigins("   \n  "), []);
});

test("a key round-trips through the form unchanged", () => {
  const result = inputFromForm(formFromKey(key));
  assert.ok(result.ok);
  assert.deepEqual(result.input, {
    name: "Main site",
    allowedOrigins: ["https://example.com", "https://*.example.com"],
    dailyMessageCap: 500,
    perIpPerMinute: null,
    appearance: { title: "Ask us", greeting: null, primaryColor: "#112233", position: "bottom-left" },
    storeTranscripts: true,
    hideBranding: false,
  });
});

test("blank limits and looks are sent as null, which clears them to the default", () => {
  const result = inputFromForm({ ...EMPTY_WEB_KEY_FORM, name: "  Docs  " });
  assert.ok(result.ok);
  assert.equal(result.input.name, "Docs");
  assert.equal(result.input.dailyMessageCap, null);
  assert.equal(result.input.perIpPerMinute, null);
  assert.deepEqual(result.input.appearance, { title: null, greeting: null, primaryColor: null, position: "bottom-right" });
  assert.deepEqual(result.input.allowedOrigins, []);
});

test("what cannot be sent names its field", () => {
  const bad = (patch: Partial<typeof EMPTY_WEB_KEY_FORM>) => {
    const result = inputFromForm({ ...EMPTY_WEB_KEY_FORM, name: "n", ...patch });
    assert.equal(result.ok, false);
    return result.ok ? null : result.field;
  };
  assert.equal(bad({ name: " " }), "name");
  assert.equal(bad({ dailyMessageCap: "0" }), "dailyMessageCap");
  assert.equal(bad({ dailyMessageCap: "1.5" }), "dailyMessageCap");
  assert.equal(bad({ dailyMessageCap: "100001" }), "dailyMessageCap");
  assert.equal(bad({ perIpPerMinute: "61" }), "perIpPerMinute");
  assert.equal(bad({ primaryColor: "blue" }), "primaryColor");
  assert.equal(bad({ primaryColor: "#12345" }), "primaryColor");
  assert.equal(bad({ title: "x".repeat(61) }), "title");
  assert.equal(bad({ greeting: "x".repeat(501) }), "greeting");
});

test("usage: the count against the cap, the default cap when none is set, and never an invented zero", () => {
  assert.equal(usageLabel(12, 1000, 500), "12 of 1,000 messages today");
  assert.equal(usageLabel(0, null, 1000), "0 of 1,000 messages today");
  assert.equal(usageLabel(null, null, 1000), "Today's count is unavailable (cap 1,000)");
});
