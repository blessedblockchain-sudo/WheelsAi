import { readFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * The embeddable chat widget (public/widget.js), on a page that is not
 * WheelsAI, against a mocked API. What the real API answers is proven in
 * docs/WEB-WIDGET-RUN.md; this pins what the script does with each answer.
 */

// Both hosts exist only as routes, and the script is answered from the file
// in this repository: a routed page counts as a public address to Chromium,
// which will not let it load a script from the dev server on localhost.
const HOST = "https://shop.example";
const API = "https://api.widget.test";
const WIDGET_JS = readFileSync(join(process.cwd(), "public", "widget.js"), "utf8");
const WIDGET_URL = `${HOST}/widget.js`;
const KEY = `wpk_${"a".repeat(32)}`;

const cors = { "access-control-allow-origin": HOST, "access-control-expose-headers": "Retry-After" };

const CONFIG = {
  agent: { name: "Support Concierge" },
  appearance: { title: "Ask us", greeting: "Hi! How can I help?", primaryColor: "#0f766e", position: "bottom-right" },
  poweredBy: true,
  limits: { maxMessageChars: 4000, maxMessages: 20, maxTotalChars: 16000 },
  transcriptsStored: false,
};

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const delta = (content: string) => ({ choices: [{ delta: { content } }] });

async function serveWidget(page: Page) {
  await page.route(WIDGET_URL, (route) => route.fulfill({ contentType: "application/javascript", body: WIDGET_JS }));
}

async function hostPage(page: Page, chat: (route: Route) => Promise<void> | void, config: unknown = CONFIG) {
  await page.route(`${HOST}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      // A stylesheet that would wreck an unisolated widget.
      body: `<!doctype html><html><head><style>* { font-family: fantasy !important; color: red !important }
        button { width: 400px !important; height: 120px !important }</style></head>
        <body><h1>Shop</h1><button id="own">The shop's button</button>
        <script src="${WIDGET_URL}" data-wheelsai-key="${KEY}" data-api="${API}" async></script></body></html>`,
    }),
  );
  await serveWidget(page);
  await page.route(`${API}/api/widget/${KEY}/config`, (route) =>
    route.fulfill({ json: config, headers: cors }),
  );
  await page.route(`${API}/api/widget/${KEY}/chat`, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "content-type" } })
      : chat(route),
  );
  await page.goto(`${HOST}/`);
}

test.describe("Web chat widget", () => {
  test("the launcher opens a dialog that the host page's styles do not reach", async ({ page }) => {
    await hostPage(page, (route) => route.fulfill({ status: 500 }));

    const launcher = page.getByRole("button", { name: /open chat/i });
    await expect(launcher).toBeVisible();
    await expect(launcher).toHaveCSS("width", "56px");
    await expect(launcher).not.toHaveCSS("color", "rgb(255, 0, 0)");

    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Ask us" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Hi! How can I help?")).toBeVisible();
    await expect(dialog.getByText("Powered by WheelsAI")).toBeVisible();
    await expect(dialog.getByLabel("Your message")).toBeFocused();
    await expect(dialog.getByLabel("Your message")).not.toHaveCSS("color", "rgb(255, 0, 0)");
  });

  test("a streamed reply is shown as text, never as markup, and is sent without cookies", async ({ page }) => {
    let sent: { body: Record<string, unknown>; cookie: string | undefined } | null = null;
    await hostPage(page, async (route) => {
      sent = {
        body: route.request().postDataJSON() as Record<string, unknown>,
        cookie: await route.request().headerValue("cookie").then((value) => value ?? undefined),
      };
      await route.fulfill({
        contentType: "text/event-stream",
        headers: cors,
        body: sse(delta("Returns take <b>30"), delta(' days</b>.<img src=x onerror="window.__pwned=1">'), "[DONE]"),
      });
    });

    await page.getByRole("button", { name: /open chat/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Your message").fill("What is your returns policy?");
    await dialog.getByLabel("Your message").press("Enter");

    await expect(dialog.locator(".msg.assistant").last()).toContainText(
      'Returns take <b>30 days</b>.<img src=x onerror="window.__pwned=1">',
    );
    await expect(dialog.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    expect(sent).not.toBeNull();
    expect(sent!.cookie).toBeUndefined();
    expect(sent!.body.stream).toBe(true);
    expect(sent!.body.messages).toEqual([{ role: "user", content: "What is your returns policy?" }]);
    expect(String(sent!.body.sessionId)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // Only what the server's strict schema accepts: no model, no system turn.
    expect(Object.keys(sent!.body).sort()).toEqual(["messages", "sessionId", "stream"]);
  });

  test("a failure inside the stream discards the half answer and offers to try again", async ({ page }) => {
    await hostPage(page, (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        headers: cors,
        body: sse(delta("Half an ans"), { error: { code: "model_error", message: "x" } }, "[DONE]"),
      }),
    );
    await page.getByRole("button", { name: /open chat/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Your message").fill("Hello");
    await dialog.getByLabel("Your message").press("Enter");

    await expect(dialog.getByRole("alert")).toContainText("cut off before it finished");
    await expect(dialog.getByText("Half an ans")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("a 429 shows how long to wait and holds the send button", async ({ page }) => {
    await hostPage(page, (route) =>
      route.fulfill({
        status: 429,
        headers: { ...cors, "retry-after": "42" },
        json: { error: "rate_limited", message: "Too many messages.", scope: "ip", retryAfterSeconds: 42 },
      }),
    );
    await page.getByRole("button", { name: /open chat/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Your message").fill("Hello");
    await dialog.getByLabel("Your message").press("Enter");

    await expect(dialog.getByRole("alert")).toContainText(/too quickly\. Try again in 4\d seconds\./);
    await expect(dialog.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  test("a site that is not allowed is told so, and cannot type", async ({ page }) => {
    await page.route(`${HOST}/`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body><script src="${WIDGET_URL}" data-wheelsai-key="${KEY}" data-api="${API}"></script></body>`,
      }),
    );
    await serveWidget(page);
    await page.route(`${API}/api/widget/${KEY}/config`, (route) =>
      route.fulfill({ status: 403, headers: cors, json: { error: "origin_not_allowed", message: "no" } }),
    );
    await page.goto(`${HOST}/`);
    await page.getByRole("button", { name: /open chat/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("not set up for this site");
    await expect(dialog.getByLabel("Your message")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeHidden();
  });

  test("Escape closes the dialog and returns focus to the launcher", async ({ page }) => {
    await hostPage(page, (route) => route.fulfill({ status: 500 }));
    const launcher = page.getByRole("button", { name: /open chat/i });
    await launcher.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open chat with Ask us" })).toBeFocused();
  });

  test("the plan's white-label answer hides the Powered by line", async ({ page }) => {
    await hostPage(page, (route) => route.fulfill({ status: 500 }), { ...CONFIG, poweredBy: false });
    await page.getByRole("button", { name: /open chat/i }).click();
    await expect(page.getByRole("dialog").getByLabel("Your message")).toBeEnabled();
    await expect(page.getByRole("dialog").getByText("Powered by WheelsAI")).toBeHidden();
  });

  test("a second copy of the script does nothing", async ({ page }) => {
    await hostPage(page, (route) => route.fulfill({ status: 500 }));
    await expect(page.getByRole("button", { name: /open chat/i })).toBeVisible();
    await page.addScriptTag({ content: `
      const s = document.createElement("script");
      s.src = ${JSON.stringify(WIDGET_URL)};
      s.setAttribute("data-wheelsai-key", ${JSON.stringify(KEY)});
      s.setAttribute("data-api", ${JSON.stringify(API)});
      s.onload = () => { window.__second = true; };
      document.body.appendChild(s);` });
    await page.waitForFunction(() => (window as unknown as { __second?: boolean }).__second === true);
    await expect(page.locator("[data-wheelsai-widget]")).toHaveCount(1);
  });
});
