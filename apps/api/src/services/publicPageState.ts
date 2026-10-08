/**
 * How an agent's public page (/a/<handle>) can be used right now.
 *
 * Two switches decide it, and both are needed: `isPublic` shows the page, and
 * a live page key (a WidgetKey whose `pageOfAgentId` is the agent) lets people
 * use it. Agents that were public before public use existed have no page key,
 * so nobody starts using them unasked.
 */
export const PUBLIC_PAGE_STATES = ["off", "view_only", "on", "paused"] as const;
export type PublicPageState = (typeof PUBLIC_PAGE_STATES)[number];

/** The two columns of a page key that decide whether it can be used. */
export interface PageKeySwitch {
  enabled: boolean;
  revokedAt: Date | null;
}

/** Uses a page allows in a day unless its owner sets another number. */
export const PAGE_DAILY_CAP_DEFAULT = 100;
export const PAGE_DAILY_CAP_MIN = 1;
export const PAGE_DAILY_CAP_MAX = 100_000;

/**
 * - `off`: the agent is not public; its page answers 404.
 * - `view_only`: the page shows, and nobody can use the agent from it yet.
 * - `on`: anyone with the link can use it.
 * - `paused`: the page shows, with a sentence where the panel would be.
 */
export function publicPageStateOf(isPublic: boolean, pageKey: PageKeySwitch | null): PublicPageState {
  if (!isPublic) return "off";
  if (!pageKey || pageKey.revokedAt) return "view_only";
  return pageKey.enabled ? "on" : "paused";
}

/** A page key may be used only while its agent's page is on. */
export function pageKeyUsable(isPublic: boolean, pageKey: PageKeySwitch | null): boolean {
  return publicPageStateOf(isPublic, pageKey) === "on";
}
