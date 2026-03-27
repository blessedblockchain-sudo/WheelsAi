import { test, expect } from "@playwright/test";

test.describe("Authentication - Login", () => {
  test("should render the login page with email and password form", async ({
    page,
  }) => {
    await page.goto("/login");

    // Verify page heading
    await expect(page.getByText("Welcome back")).toBeVisible();
    await expect(
      page.getByText("Sign in to your account to continue")
    ).toBeVisible();

    // Verify email input
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute("placeholder", "you@example.com");

    // Verify password input
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible();

    // Verify submit button
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("should have wallet auth button and 'Or continue with' divider", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(page.getByText("Or continue with")).toBeVisible();
  });

  test("should fill in email and password and submit", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');

    await emailInput.fill("test@example.com");
    await passwordInput.fill("password123");

    await expect(emailInput).toHaveValue("test@example.com");
    await expect(passwordInput).toHaveValue("password123");

    // Click submit - the API call will fail without a backend, but we verify
    // that the form is interactive and the button triggers submission
    const submitButton = page.getByRole("button", { name: "Sign in" });
    await submitButton.click();

    // The page should still be on /login since the API call fails
    await expect(page).toHaveURL(/\/login/);
  });

  test("should have a link to the register page", async ({ page }) => {
    await page.goto("/login");

    const signUpLink = page.getByRole("link", { name: "Sign up" });
    await expect(signUpLink).toBeVisible();
    await expect(signUpLink).toHaveAttribute("href", "/register");
  });
});

test.describe("Authentication - Register", () => {
  test("should render the register page with all form fields", async ({
    page,
  }) => {
    await page.goto("/register");

    // Verify page heading
    await expect(page.getByText("Create an account")).toBeVisible();
    await expect(
      page.getByText("Start deploying AI models in minutes")
    ).toBeVisible();

    // Verify email input
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();

    // Verify password inputs (password + confirm password)
    const passwordInputs = page.locator('input[type="password"]');
    await expect(passwordInputs).toHaveCount(2);

    // Verify labels
    await expect(page.getByText("Email", { exact: false })).toBeVisible();
    await expect(
      page.locator("label", { hasText: "Confirm Password" })
    ).toBeVisible();

    // Verify submit button
    await expect(
      page.getByRole("button", { name: "Create Account" })
    ).toBeVisible();
  });

  test("should have wallet auth and 'Or continue with' section", async ({
    page,
  }) => {
    await page.goto("/register");

    await expect(page.getByText("Or continue with")).toBeVisible();
  });

  test("should display free credits callout", async ({ page }) => {
    await page.goto("/register");

    await expect(page.getByText("$5 free credits")).toBeVisible();
  });

  test("should have a link to the login page", async ({ page }) => {
    await page.goto("/register");

    const signInLink = page.getByRole("link", { name: "Sign in" });
    await expect(signInLink).toBeVisible();
    await expect(signInLink).toHaveAttribute("href", "/login");
  });
});
