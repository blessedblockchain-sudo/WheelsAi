import { test, expect } from "@playwright/test";

test.describe("Landing Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should render the navbar with WheelsAI branding", async ({ page }) => {
    const navbar = page.locator("nav");
    await expect(navbar).toBeVisible();

    // Verify logo text
    await expect(navbar.getByText("WheelsAI")).toBeVisible();

    // Verify navigation links exist (hidden on mobile, visible on desktop)
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByRole("link", { name: "Features" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "How It Works" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Frameworks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Pricing" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Marketplace" }).first()
    ).toBeVisible();
  });

  test("should render the navbar with Sign In and Get Started buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    await expect(
      page.locator("nav").getByRole("link", { name: "Sign In" })
    ).toBeVisible();
    await expect(
      page.locator("nav").getByRole("link", { name: "Get Started" })
    ).toBeVisible();
  });

  test("should render the hero section with CTA buttons", async ({ page }) => {
    // Verify headline text
    await expect(page.getByText("Everyone Needs AI Agents.")).toBeVisible();
    await expect(page.getByText("We Make It Simple.")).toBeVisible();

    // Verify CTA buttons
    await expect(
      page.getByRole("link", { name: /Start Building Free/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Explore Marketplace/i })
    ).toBeVisible();
  });

  test("should render the hero stats highlights", async ({ page }) => {
    await expect(page.getByText("Free")).toBeVisible();
    await expect(page.getByText("To List")).toBeVisible();
    await expect(page.getByText("90%")).toBeVisible();
    await expect(page.getByText("Revenue Share")).toBeVisible();
    await expect(page.getByText("10+")).toBeVisible();
    await expect(page.getByText("Channels")).toBeVisible();
  });

  test("should have the features section", async ({ page }) => {
    const featuresSection = page.locator("section#features");
    await expect(featuresSection).toBeAttached();

    // Scroll into view to verify it renders
    await featuresSection.scrollIntoViewIfNeeded();
    await expect(featuresSection).toBeVisible();
  });

  test("should have the how-it-works section", async ({ page }) => {
    const howItWorksSection = page.locator("section#how-it-works");
    await expect(howItWorksSection).toBeAttached();

    await howItWorksSection.scrollIntoViewIfNeeded();
    await expect(howItWorksSection).toBeVisible();
  });

  test("should have the frameworks section", async ({ page }) => {
    const frameworksSection = page.locator("section#frameworks");
    await expect(frameworksSection).toBeAttached();

    await frameworksSection.scrollIntoViewIfNeeded();
    await expect(frameworksSection).toBeVisible();
  });

  test("should have the pricing section", async ({ page }) => {
    const pricingSection = page.locator("section#pricing");
    await expect(pricingSection).toBeAttached();

    await pricingSection.scrollIntoViewIfNeeded();
    await expect(pricingSection).toBeVisible();
  });

  test("should render the footer with branding and link columns", async ({
    page,
  }) => {
    const footer = page.locator("footer");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();

    // Verify WheelsAI branding in footer
    await expect(footer.getByText("WheelsAI")).toBeVisible();

    // Verify footer column headings
    await expect(footer.getByText("Product")).toBeVisible();
    await expect(footer.getByText("Developers")).toBeVisible();
    await expect(footer.getByText("Company")).toBeVisible();
    await expect(footer.getByText("Community")).toBeVisible();

    // Verify copyright text
    await expect(footer.getByText(/WheelsAI\. All rights reserved/)).toBeVisible();
  });

  test("should navigate to pricing section when clicking pricing nav link", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    // Click the pricing link in the navbar
    await page.locator("nav").getByRole("link", { name: "Pricing" }).click();

    // Verify the pricing section scrolled into view
    // The URL should have the #pricing hash
    await expect(page).toHaveURL(/#pricing/);

    // The pricing section should be visible in the viewport
    const pricingSection = page.locator("section#pricing");
    await expect(pricingSection).toBeInViewport();
  });

  test("should have the badge text in hero", async ({ page }) => {
    await expect(
      page.getByText("The All-in-One AI Agent Platform")
    ).toBeVisible();
  });
});

// The terminal's "Latency:" line is the platform's measured p50, read from
// GET /api/public/stats. It used to be a constant ("47ms avg").
test.describe("Landing page latency line", () => {
  const stats = (latency: Record<string, unknown>) => ({
    frameworks: 6,
    models: 21,
    pricingModels: 4,
    channels: 3,
    latency: {
      metric: "response_time",
      definition: "Time the WheelsAI API took to produce the complete answer to a chat request.",
      windowHours: 24,
      minSampleCount: 50,
      minOrgCount: 3,
      computedAt: "2026-10-07T00:00:00.000Z",
      ...latency,
    },
  });

  test("shows the measured p50 and links to how it is measured", async ({ page }) => {
    await page.route("**/api/public/stats", (route) =>
      route.fulfill({ json: stats({ status: "measured", sampleCount: 1284, p50Ms: 612, p95Ms: 2140 }) })
    );
    await page.goto("/");
    await expect(page.locator('[data-latency-status="measured"]')).toHaveText("612 ms p50");
    await expect(page.getByRole("link", { name: "How it is measured" })).toHaveAttribute("href", "/status#latency");
    await expect(page.getByText(/measured over 1,284 answered requests in the last 24 hours/)).toBeVisible();
  });

  test("shows no number while the platform is below the publication thresholds", async ({ page }) => {
    await page.route("**/api/public/stats", (route) =>
      route.fulfill({ json: stats({ status: "insufficient_data", sampleCount: 12, p50Ms: null, p95Ms: null }) })
    );
    await page.goto("/");
    await expect(page.locator('[data-latency-status="insufficient_data"]')).toHaveText("measuring");
    await expect(page.getByText(/12 of 50/)).toHaveCount(0);
  });

  test("says the figure is unavailable when the API cannot be read, and never prints 47ms", async ({ page }) => {
    await page.route("**/api/public/stats", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await page.goto("/");
    await expect(page.locator('[data-latency-status="unavailable"]')).toHaveText("live figure unavailable");
    await expect(page.locator("body")).not.toContainText("47ms");
    await expect(page.locator("body")).not.toContainText("47 ms");
  });
});
