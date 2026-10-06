import assert from "node:assert/strict";
import test from "node:test";

import { telegramWebhookSecret, verifyTelegramSecretToken } from "../services/channelAuth.js";
import {
  registerTelegramWebhook,
  TelegramRejectedError,
  telegramWebhookUrl,
  unregisterTelegramWebhook,
  type FetchFn,
} from "../services/telegramWebhook.js";

// Telegram only delivers updates to a bot after setWebhook. These pin the
// registration call and that its secret is the one the route verifies.

const BOT = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function recordingFetch(response: { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: response.ok, status: response.status ?? 200, json: async () => response.body };
  };
  return { calls, fetchFn };
}

test("registration points the bot at this deployment with the secret the route verifies", async () => {
  const { calls, fetchFn } = recordingFetch({ ok: true, body: { ok: true, result: true } });
  const result = await registerTelegramWebhook({
    botToken: BOT,
    deploymentId: "dep_1",
    publicApiUrl: "https://api.example.com/",
    fetchFn,
  });

  assert.deepEqual(result, {
    registered: true,
    url: "https://api.example.com/api/channels/webhooks/dep_1/telegram",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${BOT}/setWebhook`);
  assert.equal(calls[0]!.body.url, telegramWebhookUrl("https://api.example.com", "dep_1"));
  assert.deepEqual(calls[0]!.body.allowed_updates, ["message"]);
  assert.equal(
    verifyTelegramSecretToken({ botToken: BOT, deploymentId: "dep_1", secretToken: calls[0]!.body.secret_token }),
    true,
  );
  assert.equal(calls[0]!.body.secret_token, telegramWebhookSecret(BOT, "dep_1"));
});

test("a token Telegram refuses is reported, not saved as a silent channel", async () => {
  const { fetchFn } = recordingFetch({ ok: false, status: 401, body: { ok: false, description: "Unauthorized" } });
  await assert.rejects(
    registerTelegramWebhook({ botToken: BOT, deploymentId: "dep_1", publicApiUrl: "https://api.example.com", fetchFn }),
    (err: unknown) => err instanceof TelegramRejectedError && /Unauthorized/.test(err.message),
  );
});

test("a malformed token never reaches Telegram", async () => {
  const { calls, fetchFn } = recordingFetch({ ok: true, body: { ok: true } });
  await assert.rejects(
    registerTelegramWebhook({ botToken: "abc/../x", deploymentId: "dep_1", publicApiUrl: "https://a.b", fetchFn }),
    TelegramRejectedError,
  );
  assert.equal(calls.length, 0);
});

test("without a public API URL nothing is registered and the reason is returned", async () => {
  const { calls, fetchFn } = recordingFetch({ ok: true, body: { ok: true } });
  const result = await registerTelegramWebhook({ botToken: BOT, deploymentId: "dep_1", publicApiUrl: undefined, fetchFn });
  assert.equal(result.registered, false);
  assert.equal(calls.length, 0);
});

test("unregistering only deletes a webhook that still points at this deployment, and never throws", async () => {
  const ours = "https://api.example.com/api/channels/webhooks/dep_1/telegram";
  const calls: string[] = [];
  const fetchWithUrl =
    (url: string): FetchFn =>
    async (u) => {
      calls.push(u.split("/").pop()!);
      return {
        ok: true,
        status: 200,
        json: async () => (u.endsWith("getWebhookInfo") ? { ok: true, result: { url } } : { ok: true, result: true }),
      };
    };

  assert.equal(await unregisterTelegramWebhook({ botToken: BOT, onlyIfUrl: ours, fetchFn: fetchWithUrl(ours) }), true);
  assert.deepEqual(calls, ["getWebhookInfo", "deleteWebhook"]);

  // The owner has since pointed the bot at another deployment: leave it.
  calls.length = 0;
  const elsewhere = "https://api.example.com/api/channels/webhooks/dep_2/telegram";
  assert.equal(await unregisterTelegramWebhook({ botToken: BOT, onlyIfUrl: ours, fetchFn: fetchWithUrl(elsewhere) }), false);
  assert.deepEqual(calls, ["getWebhookInfo"]);

  const failing: FetchFn = async () => {
    throw new Error("network down");
  };
  assert.equal(await unregisterTelegramWebhook({ botToken: BOT, onlyIfUrl: ours, fetchFn: failing }), false);
});
