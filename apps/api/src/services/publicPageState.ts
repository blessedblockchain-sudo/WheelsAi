/**
 * How an agent's public page (/a/<handle>) can be used right now.
 *
 * Two switches decide it, and both are needed: `isPublic` shows the page, and
 * a live page key (a WidgetKey whose `pageOfAgentId` is the agent) lets people
 * use it. Agents that were public before public use existed have no page key,
 * so nobody starts using them unasked.
 *
 * A third fact comes before the key: while a published listing sells use of
 * the agent at a price, the page is `paid`. Its page key is kept paused and
 * is never sent, whatever the key row says, and people use the agent on the
 * signed-in routes that charge them.
 */
export const PUBLIC_PAGE_STATES = ["off", "view_only", "on", "paused", "paid"] as const;
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

/** What one buyer organization may use of one paid agent. The agent's page and GET /api/capabilities show them. */
export const PAID_USE_PER_BUYER_PER_MINUTE = 10;
export const PAID_USE_PER_BUYER_PER_DAY = 200;

/** How many of a self-running agent's latest results its page shows. */
export const PUBLIC_RESULTS_LIMIT = 3;
/** Where the text of one result is cut. */
export const PUBLIC_RESULT_MAX_CHARS = 8_000;

/**
 * - `off`: the agent is not public; its page answers 404.
 * - `view_only`: the page shows, and nobody can use the agent from it yet.
 * - `on`: anyone with the link can use it.
 * - `paused`: the page shows, with a sentence where the panel would be.
 * - `paid`: use of the agent is sold at a price; the page shows the price
 *   and free use is off. Checked before the key, so an enabled key row never
 *   reads as "on" while a price is set.
 */
export function publicPageStateOf(
  isPublic: boolean,
  pageKey: PageKeySwitch | null,
  soldAtAPrice = false,
): PublicPageState {
  if (!isPublic) return "off";
  if (soldAtAPrice) return "paid";
  if (!pageKey || pageKey.revokedAt) return "view_only";
  return pageKey.enabled ? "on" : "paused";
}

/** A page key may be used only while its agent's page is on. */
export function pageKeyUsable(isPublic: boolean, pageKey: PageKeySwitch | null, soldAtAPrice = false): boolean {
  return publicPageStateOf(isPublic, pageKey, soldAtAPrice) === "on";
}
