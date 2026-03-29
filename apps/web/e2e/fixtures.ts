import { test as base, expect } from "@playwright/test";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * Test user credentials — created during test setup.
 * Uses a unique email per test run to avoid conflicts.
 */
function getTestUser() {
  const id = Date.now().toString(36);
  return {
    email: `e2e-${id}@test.wheelsai.io`,
    password: "TestPassword123!",
  };
}

/**
 * Register a test user and return the auth token.
 */
async function registerTestUser(email: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.token;
    }
    // User may already exist — try login
    const loginRes = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (loginRes.ok) {
      const data = await loginRes.json();
      return data.token;
    }
  } catch {
    // API not available — tests will run in UI-only mode
  }
  return null;
}

/**
 * Extended test fixture that provides an authenticated page context.
 *
 * Usage:
 * ```ts
 * import { test, expect } from "./fixtures";
 * test("authenticated test", async ({ authedPage }) => {
 *   await authedPage.goto("/dashboard");
 * });
 * ```
 */
export const test = base.extend<{
  authedPage: ReturnType<typeof base["page"]> extends Promise<infer T> ? T : never;
}>({
  authedPage: async ({ page, context }, use) => {
    const user = getTestUser();
    const token = await registerTestUser(user.email, user.password);

    if (token) {
      // Set the auth cookie so dashboard pages don't redirect to login
      await context.addCookies([
        {
          name: "wheelsai_token",
          value: token,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
        },
      ]);
    }

    await use(page);
  },
});

export { expect };
