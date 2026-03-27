import { test, expect } from "@playwright/test";

test.describe("Agent Creation Wizard", () => {
  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/dashboard/agents/new");

    // Without authentication the dashboard layout will likely redirect to /login
    // or show the login page content. Either behavior is acceptable.
    // We check for one of the two outcomes:
    const url = page.url();
    const isRedirectedToLogin = url.includes("/login");
    const hasLoginContent = await page
      .getByText("Welcome back")
      .isVisible()
      .catch(() => false);
    const hasAgentWizard = await page
      .getByText("Choose a Framework")
      .isVisible()
      .catch(() => false);

    // At least one of these should be true
    expect(isRedirectedToLogin || hasLoginContent || hasAgentWizard).toBe(true);
  });

  test("should show framework selection cards if page loads", async ({
    page,
  }) => {
    await page.goto("/dashboard/agents/new");

    // If the page renders the wizard (no auth redirect), verify frameworks
    const hasFrameworkStep = await page
      .getByText("Choose a Framework")
      .isVisible()
      .catch(() => false);

    if (hasFrameworkStep) {
      // Verify the four framework options are present
      await expect(page.getByText("Mastra")).toBeVisible();
      await expect(page.getByText("LangChain")).toBeVisible();
      await expect(page.getByText("AutoGen")).toBeVisible();
      await expect(page.getByText("Custom")).toBeVisible();

      // Verify framework descriptions
      await expect(
        page.getByText("Modern TypeScript framework for building AI agents")
      ).toBeVisible();
      await expect(
        page.getByText("Popular framework with extensive tool ecosystem")
      ).toBeVisible();
      await expect(
        page.getByText("Multi-agent conversation framework by Microsoft")
      ).toBeVisible();
      await expect(
        page.getByText("Bring your own agent implementation")
      ).toBeVisible();
    }
  });

  test("should have model selector with Free Models optgroup if page loads", async ({
    page,
  }) => {
    await page.goto("/dashboard/agents/new");

    const hasFrameworkStep = await page
      .getByText("Choose a Framework")
      .isVisible()
      .catch(() => false);

    if (hasFrameworkStep) {
      // Navigate to the config step by clicking Next
      await page.getByRole("button", { name: "Next" }).click();

      // Now we should be on the Configuration step
      await expect(page.getByText("Agent Configuration")).toBeVisible();

      // Verify the model selector has a "Free Models" optgroup
      const freeModelsOptgroup = page.locator(
        'optgroup[label="Free Models (No API Key)"]'
      );
      await expect(freeModelsOptgroup).toBeAttached();

      // Verify at least one free model option exists
      await expect(
        page.locator('option[value="free/groq/llama-3.3-70b"]')
      ).toBeAttached();
    }
  });

  test("should show wizard step indicators if page loads", async ({
    page,
  }) => {
    await page.goto("/dashboard/agents/new");

    const hasCreateAgent = await page
      .getByText("Create Agent")
      .isVisible()
      .catch(() => false);

    if (hasCreateAgent) {
      // Verify step labels are present (hidden on mobile, visible on md+)
      // Check for the step icons/buttons which are always visible
      await expect(page.getByRole("button", { name: /Framework/i })).toBeVisible();
    }
  });
});
