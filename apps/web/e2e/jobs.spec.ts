import { test, expect, type Page } from "@playwright/test";

/**
 * Offerings and jobs, end to end through the UI: a publisher's offering is
 * hired by a second organization through the form drawn from its input
 * schema, the deliverable arrives, and the buyer accepts it.
 *
 * Money moves here, so it needs what a fresh sign-up does not have: a buyer
 * with credits, a publisher with an agent, and an API running the job
 * worker with a model it can call. It runs against the seeded demo
 * organizations and skips itself when they, or the API, are not there.
 *
 *   NEXT_PUBLIC_API_URL   the API the web app talks to (default :4000)
 *   E2E_BUYER_EMAIL       default demo@northwind.ai
 *   E2E_PUBLISHER_EMAIL   default team@kestrel.ai
 *   E2E_DEMO_PASSWORD     the seeded users' password; unset = skip
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const BUYER = process.env.E2E_BUYER_EMAIL || "demo@northwind.ai";
const PUBLISHER = process.env.E2E_PUBLISHER_EMAIL || "team@kestrel.ai";
const PASSWORD = process.env.E2E_DEMO_PASSWORD;

interface Setup {
  slug: string;
  title: string;
  publisherToken: string;
  offeringId: string;
}

async function api<T>(path: string, token: string | null, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method ?? "POST"} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The publisher's offering for this run, or the reason there cannot be one. */
async function prepare(): Promise<Setup | string> {
  if (!PASSWORD) return "E2E_DEMO_PASSWORD is not set";
  let publisherToken: string;
  try {
    ({ token: publisherToken } = await api<{ token: string }>("/api/auth/login", null, {
      email: PUBLISHER,
      password: PASSWORD,
    }));
  } catch (err) {
    return `the seeded publisher could not sign in (${(err as Error).message.slice(0, 80)})`;
  }
  const { agents } = await api<{ agents: Array<{ id: string; name: string }> }>("/api/agents", publisherToken);
  // An agent installed from the marketplace cannot be sold; the seed names those copies.
  const agent = agents.find((a) => !a.name.includes("(Marketplace)"));
  if (!agent) return "the seeded publisher has no agent of its own";

  const title = `E2E brief ${Date.now().toString(36)}`;
  try {
    const { offering } = await api<{ offering: { id: string; slug: string } }>("/api/offerings", publisherToken, {
      productKind: "agent",
      agentId: agent.id,
      title,
      description: "A two-sentence brief on a topic you send. Created by the jobs end-to-end test.",
      priceCents: 50,
      slaSeconds: 600,
      inputSchema: {
        type: "object",
        required: ["topic"],
        properties: {
          topic: { type: "string", title: "Topic", minLength: 3, maxLength: 120 },
          tone: { type: "string", title: "Tone", enum: ["plain", "formal"], default: "plain" },
        },
      },
      sampleInputs: [{ topic: "Why escrow protects a buyer", tone: "plain" }],
      instructions: "Answer in exactly two sentences.",
      deliverableChecks: [{ type: "min_length", value: 20, label: "At least 20 characters" }],
    });
    await api(`/api/offerings/${offering.id}/activate`, publisherToken, undefined, "POST");
    return { slug: offering.slug, title, publisherToken, offeringId: offering.id };
  } catch (err) {
    return `the offering could not be published (${(err as Error).message.slice(0, 120)})`;
  }
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
}

test.describe("Offerings and jobs", () => {
  test.describe.configure({ mode: "serial" });
  let setup: Setup | string;

  test.beforeAll(async () => {
    try {
      setup = await prepare();
    } catch (err) {
      setup = `the API at ${API_URL} is not reachable (${(err as Error).message.slice(0, 80)})`;
    }
  });

  test.afterAll(async () => {
    // Leave the marketplace as it was found.
    if (typeof setup === "object") {
      await api(`/api/offerings/${setup.offeringId}/archive`, setup.publisherToken, undefined, "POST").catch(() => {});
    }
  });

  test("a signed-out visitor sees the offering, its escrow terms and no private instructions", async ({ page }) => {
    test.skip(typeof setup === "string", String(setup));
    const { slug, title } = setup as Setup;

    await page.goto(`/marketplace/offerings/${slug}`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const hire = page.getByRole("complementary", { name: "Hire" });
    await expect(hire.getByText("held in escrow", { exact: true })).toBeVisible();
    await expect(hire.getByText("72 hours", { exact: true })).toBeVisible();
    await expect(hire.getByText("sees what you send", { exact: true })).toBeVisible();
    await expect(hire.getByRole("link", { name: "Sign in to hire" })).toBeVisible();
    await expect(page.getByText("Answer in exactly two sentences")).toHaveCount(0);
  });

  test("the marketplace filters by product type", async ({ page }) => {
    test.skip(typeof setup === "string", String(setup));
    const { title } = setup as Setup;

    await page.goto("/marketplace?view=tasks");
    await expect(page.getByRole("button", { name: "Agents", pressed: true })).toBeVisible();
    await expect(page.getByText(title)).toBeVisible();

    await page.getByRole("button", { name: "Workflows" }).click();
    await expect(page).toHaveURL(/type=workflows/);
    await expect(page.getByText(title)).toHaveCount(0);
  });

  for (const colorScheme of ["dark", "light"] as const) {
    test(`a buyer hires through the schema form, reviews and accepts (${colorScheme})`, async ({ browser }, testInfo) => {
      test.skip(typeof setup === "string", String(setup));
      test.setTimeout(180_000);
      const { slug } = setup as Setup;
      const context = await browser.newContext({ colorScheme });
      // The app keeps its own theme choice; it does not follow the OS setting.
      await context.addInitScript((theme) => localStorage.setItem("wheelsai-theme", theme), colorScheme);
      const page = await context.newPage();

      await signIn(page, BUYER);
      await page.goto(`/marketplace/offerings/${slug}`);

      // A missing required field is caught before anything is sent or charged.
      await page.getByRole("button", { name: /Review and hire/ }).click();
      await expect(page.getByText("Topic is required")).toBeVisible();

      await page.getByRole("button", { name: "Use sample" }).click();
      await expect(page.getByLabel("Topic")).toHaveValue("Why escrow protects a buyer");
      await page.getByRole("button", { name: /Review and hire/ }).click();

      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toContainText("held in escrow");
      await page.screenshot({ path: testInfo.outputPath(`jobs-hire-confirm-${colorScheme}.png`), fullPage: true });
      await confirm.getByRole("button", { name: "Pay $0.50 into escrow" }).click();

      await page.waitForURL(/\/dashboard\/jobs\/[0-9a-f-]{36}/);
      await expect(page.getByText("Your result is ready. Review it.")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText("$0.50 · Held in escrow")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`jobs-review-${colorScheme}.png`), fullPage: true });

      await page.getByRole("radio", { name: "5 stars" }).click();
      await page.getByRole("button", { name: /Accept and release/ }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Accept and release payment" }).click();

      await expect(page.getByText("$0.50 · Released to publisher")).toBeVisible();
      await expect(page.getByText("Completed, publisher paid")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`jobs-completed-${colorScheme}.png`), fullPage: true });

      // The job is in the buyer's list, and the accept button is gone for good.
      await page.goto("/dashboard/jobs");
      await expect(page.getByRole("tab", { name: /Hired by you/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("link", { name: new RegExp((setup as Setup).title) }).first()).toBeVisible();
      await context.close();
    });
  }

  test("the publisher sees the job, what it earned and no way to accept it", async ({ page }) => {
    test.skip(typeof setup === "string", String(setup));
    const { title } = setup as Setup;

    await signIn(page, PUBLISHER);
    await page.goto("/dashboard/jobs?tab=received");
    await page.getByRole("link", { name: new RegExp(title) }).first().click();
    await expect(page.getByText("What the buyer sent")).toBeVisible();
    await expect(page.getByText("You earned")).toBeVisible();
    await expect(page.getByRole("button", { name: /Accept and release/ })).toHaveCount(0);

    await page.goto("/dashboard/marketplace/offerings");
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  });
});
