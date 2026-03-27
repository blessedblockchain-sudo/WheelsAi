import { test, expect } from "@playwright/test";

test.describe("Marketplace", () => {
  test("should render the marketplace page with title", async ({ page }) => {
    await page.goto("/marketplace");

    // Verify the main heading
    await expect(page.getByRole("heading", { name: "Agent Marketplace" })).toBeVisible();
    await expect(
      page.getByText("Discover and deploy AI agents built by the community")
    ).toBeVisible();
  });

  test("should display the search bar", async ({ page }) => {
    await page.goto("/marketplace");

    const searchInput = page.locator('input[placeholder="Search agents..."]');
    await expect(searchInput).toBeVisible();

    // Verify the search input is functional
    await searchInput.fill("test agent");
    await expect(searchInput).toHaveValue("test agent");
  });

  test("should display category filters sidebar on desktop", async ({
    page,
  }) => {
    // Set a desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/marketplace");

    // The categories sidebar should be visible
    await expect(page.getByText("Categories")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "All Categories" })
    ).toBeVisible();
  });

  test("should display pricing filter sidebar on desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/marketplace");

    // Verify pricing filter heading and options
    await expect(
      page.locator("h3", { hasText: "Pricing" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "All Pricing" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Free" })).toBeVisible();
  });

  test("should display sort dropdown", async ({ page }) => {
    await page.goto("/marketplace");

    const sortSelect = page.locator("select#sort");
    await expect(sortSelect).toBeVisible();

    // Verify sort options exist
    await expect(
      page.locator('option[value="popular"]')
    ).toBeAttached();
    await expect(
      page.locator('option[value="newest"]')
    ).toBeAttached();
    await expect(
      page.locator('option[value="rating"]')
    ).toBeAttached();
  });

  test("should have WheelsAI branding in header", async ({ page }) => {
    await page.goto("/marketplace");

    await expect(page.getByText("WheelsAI").first()).toBeVisible();
  });

  test("should show loading state or results", async ({ page }) => {
    await page.goto("/marketplace");

    // Either "Loading..." or "X agents found" should appear
    const resultsText = page.locator("text=Loading...").or(
      page.locator("text=agents found")
    );
    await expect(resultsText.first()).toBeVisible();
  });
});
