/**
 * Nosana's paginated list bodies, read without the SDK (import-free, so the
 * read-only access check can use it too).
 *
 * GET /deployments, /deployments/{id}/jobs, /events and /tasks answer
 *   { <key>: [...], pagination: { cursor_next, cursor_prev, total_items } }
 * (OpenAPI spec; live responses of 2026-10-07). `limit` must be 10, 20, 50 or
 * 100 (anything else is a 400) and the default order is newest first by
 * created_at. The next page is asked for with `cursor=<cursor_next>` until
 * cursor_next is null. A bare array (the shape before pagination) is still
 * read, as one complete page.
 */

/** The largest page Nosana serves. */
export const NOSANA_PAGE_LIMIT = 100;

/** Pages a full list read follows before it gives up rather than loop. */
export const NOSANA_MAX_LIST_PAGES = 50;

export type NosanaPageSize = 10 | 20 | 50 | 100;

export interface NosanaPage {
  items: unknown[];
  /** Null on the last page. */
  cursorNext: string | null;
  /** pagination.total_items; null when the body does not say (a bare array). */
  totalItems: number | null;
}

/** One page of a list body under `key`; null when the body is neither shape. */
export function readNosanaPage(body: unknown, key: string): NosanaPage | null {
  if (Array.isArray(body)) return { items: body, cursorNext: null, totalItems: body.length };
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const items = record[key];
  if (!Array.isArray(items)) return null;
  const pagination =
    typeof record.pagination === "object" && record.pagination !== null
      ? (record.pagination as Record<string, unknown>)
      : {};
  const next = pagination.cursor_next;
  const total = pagination.total_items;
  return {
    items,
    cursorNext: typeof next === "string" && next !== "" ? next : null,
    totalItems: typeof total === "number" && Number.isFinite(total) ? total : null,
  };
}

export class NosanaPaginationError extends Error {
  constructor(
    message: string,
    readonly reason: "unreadable" | "page_cap" | "cursor_repeated",
  ) {
    super(message);
    this.name = "NosanaPaginationError";
  }
}

/**
 * Reads a list page by page, following cursor_next. `fetchPage` asks for one
 * page (no cursor = the first). Throws NosanaPaginationError when a body is
 * not a list, when a cursor repeats, or when more than `maxPages` pages would
 * be needed: an incomplete list is never returned as if it were whole.
 */
export async function collectNosanaPages(
  fetchPage: (cursor: string | null) => Promise<unknown>,
  key: string,
  maxPages: number = NOSANA_MAX_LIST_PAGES,
): Promise<{ items: unknown[]; totalItems: number | null; pages: number }> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let totalItems: number | null = null;
  let cursor: string | null = null;
  for (let pages = 1; ; pages += 1) {
    const page = readNosanaPage(await fetchPage(cursor), key);
    if (!page) throw new NosanaPaginationError(`the ${key} list is not a list`, "unreadable");
    items.push(...page.items);
    totalItems ??= page.totalItems;
    if (page.cursorNext === null) return { items, totalItems, pages };
    if (seen.has(page.cursorNext)) {
      throw new NosanaPaginationError(`the ${key} list repeated a page cursor`, "cursor_repeated");
    }
    if (pages >= maxPages) {
      throw new NosanaPaginationError(
        `the ${key} list has more than ${maxPages} pages of ${NOSANA_PAGE_LIMIT}; not read`,
        "page_cap",
      );
    }
    seen.add(page.cursorNext);
    cursor = page.cursorNext;
  }
}
