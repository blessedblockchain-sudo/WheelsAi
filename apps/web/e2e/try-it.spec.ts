import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * The Try it tab of a marketplace listing, against a mocked API. The real
 * run (a real model, the real limits) is docs/WEB-WIDGET-RUN.md.
 */

const SLUG = "demo-agent";
const LISTING = {
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  title: "Demo Agent",
  slug: SLUG,
  shortDescription: "An agent used by the Try it tests.",
  longDescription: null,
  category: "productivity",
  iconUrl: null,
  screenshots: [],
  readme: null,
  pricingModel: "free",
  pricePerRequestCents: null,
  monthlyPriceCents: null,
  publisherId: "33333333-3333-4333-8333-333333333333",
  publisherName: "Test Publisher",
  status: "published",
  isFeatured: false,
  totalInstalls: 0,
  activeInstalls: 0,
  avgRating: 0,
  reviewCount: 0,
  totalRequests: 0,
  publishedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  trial: { enabled: true },
  agent: { id: "22222222-2222-4222-8222-222222222222", framework: "mastra", tags: [] },
};

const availability = (gate: "session" | "turnstile" | "signin") => ({
  enabled: true,
  disabledReason: null,
  gate,
  turnstileSiteKey: null,
  model: {
    id: "free/groq/llama-3.3-70b",
    label: "A free model",
    substituted: true,
    note: "This preview runs on a free model that WheelsAI provides. The installed agent is set up with a different model, so its answers can differ.",
  },
  limits: { messagesPerSession: 10, maxMessageChars: 4000, maxMessages: 20, maxTotalChars: 16000 },
  disabledTools: ["http_request"],
});

/** Every API call the page makes, answered here. Cross-origin, with credentials. */
async function mockApi(
  page: Page,
  appOrigin: string,
  options: { signedIn: boolean; chat?: (route: Route) => Promise<void> | void },
) {
  const requests: string[] = [];
  await page.route(
    // Whatever API origin the app was built against; never the app's own pages.
    (url) => url.pathname.startsWith("/api/") && url.origin !== appOrigin,
    async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const origin = (await request.headerValue("origin")) ?? "*";
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = url.pathname;
    requests.push(`${request.method()} ${path}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, json: body });

    if (path === "/api/auth/me") {
      return options.signedIn ? json({ user: { id: "u1", email: "a@b.c" } }) : json({ error: "Unauthorized" }, 401);
    }
    if (path === `/api/marketplace/listings/${SLUG}`) return json({ listing: LISTING });
    if (path === `/api/marketplace/listings/${SLUG}/try`) return json(availability(options.signedIn ? "session" : "signin"));
    if (path === `/api/marketplace/listings/${SLUG}/try/session`) {
      return options.signedIn
        ? json({ sessionToken: "session-token", expiresAt: new Date(Date.now() + 600_000).toISOString(), messagesRemaining: 10 })
        : json({ error: "signin_required", message: "Sign in to try this agent." }, 401);
    }
    if (path === `/api/marketplace/listings/${SLUG}/try/chat` && options.chat) {
      // route.fulfill replaces headers wholesale, so the handler gets them.
      (route as Route & { cors?: Record<string, string> }).cors = headers;
      return options.chat(route);
    }
    if (path.endsWith("/reviews")) return json({ reviews: [], total: 0 });
    if (path.startsWith("/api/offerings")) return json({ offerings: [], total: 0 });
    if (path.startsWith("/api/tokens")) return json({ tokens: [], total: 0 });
    return json({ error: "not_found" }, 404);
    },
  );
  return requests;
}

const corsOf = (route: Route) => (route as Route & { cors?: Record<string, string> }).cors ?? {};

test.describe("Marketplace listing: Try it", () => {
  test("with no human check configured, an anonymous visitor sees the sign-in gate and cannot type", async ({ page, baseURL }) => {
    const requests = await mockApi(page, new URL(baseURL!).origin, { signedIn: false });
    await page.goto(`/marketplace/${SLUG}#try`);

    const gate = page.getByTestId("try-it-signin");
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("Sign in to try this agent.");
    await expect(gate).toContainText("human check");
    await expect(gate.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/marketplace/${SLUG}#try`)}`,
    );
    await expect(page.getByLabel("Your message")).toHaveCount(0);
    // No session is even asked for, and no third-party check is loaded.
    expect(requests.some((entry) => entry.endsWith("/try/session"))).toBe(false);
    await expect(page.locator('script[src*="challenges.cloudflare.com"]')).toHaveCount(0);
  });

  test("the tab says which model answers and which tools are off", async ({ page, baseURL }) => {
    await mockApi(page, new URL(baseURL!).origin, { signedIn: true });
    await page.goto(`/marketplace/${SLUG}`);
    await page.getByRole("button", { name: "Try it", exact: true }).click();

    await expect(page.getByText("Answering model:")).toContainText("A free model");
    await expect(page.getByText("its answers can differ")).toBeVisible();
    await expect(page.getByText("switched off in previews")).toContainText("http_request");
  });

  test("a signed-in visitor chats, and the remaining-messages count goes down", async ({ page, baseURL }) => {
    let sent: Record<string, unknown> | null = null;
    await mockApi(page, new URL(baseURL!).origin, {
      signedIn: true,
      chat: (route) => {
        sent = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          headers: corsOf(route),
          contentType: "text/event-stream",
          body:
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: "<i>there</i>" } }] })}\n\n` +
            "data: [DONE]\n\n",
        });
      },
    });
    await page.goto(`/marketplace/${SLUG}#try`);

    const input = page.getByLabel("Your message");
    await input.fill("Hi");
    await input.press("Enter");

    const log = page.getByRole("log", { name: "Preview conversation" });
    await expect(log.getByText("Hello <i>there</i>")).toBeVisible();
    await expect(page.getByTestId("try-it-remaining")).toHaveText("9 of 10 messages left");
    expect(sent).toEqual({ sessionToken: "session-token", messages: [{ role: "user", content: "Hi" }], stream: true });
  });

  test("the listing's daily cap ends the preview and says so", async ({ page, baseURL }) => {
    await mockApi(page, new URL(baseURL!).origin, {
      signedIn: true,
      chat: (route) =>
        route.fulfill({
          status: 429,
          headers: corsOf(route),
          json: { error: "trial_cap_reached", message: "Used up.", resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
        }),
    });
    await page.goto(`/marketplace/${SLUG}#try`);
    const input = page.getByLabel("Your message");
    await input.fill("Hi");
    await input.press("Enter");

    await expect(page.getByTestId("try-it-notice")).toContainText("free previews are used up for today");
    await expect(input).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send again" })).toHaveCount(0);
  });

  test("when the limits cannot be counted the tab says previews are off, and nothing is retried silently", async ({ page, baseURL }) => {
    let calls = 0;
    await mockApi(page, new URL(baseURL!).origin, {
      signedIn: true,
      chat: (route) => {
        calls += 1;
        return route.fulfill({
          status: 503,
          headers: corsOf(route),
          json: { error: "rate_limiter_unavailable", message: "Chat is temporarily unavailable.", retryAfterSeconds: 30 },
        });
      },
    });
    await page.goto(`/marketplace/${SLUG}#try`);
    const input = page.getByLabel("Your message");
    await input.fill("Hi");
    await input.press("Enter");

    await expect(page.getByTestId("try-it-notice")).toContainText("limits cannot be counted");
    await expect(page.getByRole("button", { name: "Send again" })).toBeVisible();
    expect(calls).toBe(1);
  });
});
