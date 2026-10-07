import assert from "node:assert/strict";
import test from "node:test";

import {
  collectNosanaPages,
  NOSANA_MAX_LIST_PAGES,
  NosanaPaginationError,
  readNosanaPage,
} from "../services/nosanaPagination.js";

// Nosana's paginated list bodies, read without the SDK. Pure: no network.

test("readNosanaPage reads the paginated shape and a bare array; anything else is null", () => {
  assert.deepEqual(
    readNosanaPage({ deployments: [{ id: "a" }], pagination: { cursor_next: "c2", cursor_prev: null, total_items: 19 } }, "deployments"),
    { items: [{ id: "a" }], cursorNext: "c2", totalItems: 19 },
  );
  assert.deepEqual(readNosanaPage({ jobs: [], pagination: { cursor_next: null } }, "jobs"), {
    items: [],
    cursorNext: null,
    totalItems: null,
  });
  assert.deepEqual(readNosanaPage([1, 2], "deployments"), { items: [1, 2], cursorNext: null, totalItems: 2 });
  assert.equal(readNosanaPage({ deployments: "no" }, "deployments"), null);
  assert.equal(readNosanaPage({ jobs: [] }, "deployments"), null, "the wrong key");
  assert.equal(readNosanaPage(null, "deployments"), null);
  assert.equal(readNosanaPage({ events: [], pagination: { cursor_next: "" } }, "events")!.cursorNext, null);
});

test("collectNosanaPages follows cursor_next to the end and keeps the first total_items", async () => {
  const asked: Array<string | null> = [];
  const pages: Record<string, unknown> = {
    first: { deployments: [1, 2], pagination: { cursor_next: "p2", total_items: 5 } },
    p2: { deployments: [3, 4], pagination: { cursor_next: "p3", total_items: 5 } },
    p3: { deployments: [5], pagination: { cursor_next: null, total_items: 5 } },
  };
  const result = await collectNosanaPages(async (cursor) => {
    asked.push(cursor);
    return pages[cursor ?? "first"];
  }, "deployments");
  assert.deepEqual(result, { items: [1, 2, 3, 4, 5], totalItems: 5, pages: 3 });
  assert.deepEqual(asked, [null, "p2", "p3"]);
});

test("collectNosanaPages never returns a partial list: a bad body, a repeated cursor and the page cap throw", async () => {
  await assert.rejects(
    collectNosanaPages(async () => ({ nope: true }), "deployments"),
    (err: unknown) => err instanceof NosanaPaginationError && err.reason === "unreadable",
  );
  await assert.rejects(
    collectNosanaPages(async () => ({ deployments: [1], pagination: { cursor_next: "same" } }), "deployments"),
    (err: unknown) => err instanceof NosanaPaginationError && err.reason === "cursor_repeated",
  );
  let n = 0;
  await assert.rejects(
    collectNosanaPages(async () => ({ deployments: [n], pagination: { cursor_next: `c${(n += 1)}` } }), "deployments"),
    (err: unknown) => err instanceof NosanaPaginationError && err.reason === "page_cap",
  );
  assert.equal(n, NOSANA_MAX_LIST_PAGES, "it stopped at the cap");
});
