import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { readSpentToday, spendDay } from "../services/apiKeySpend.js";
import { listApiKeys, type ApiKeyListDb } from "../services/auth.js";

// What each key spent today: the read of the day's spend windows for many
// keys (services/apiKeySpend.ts) and the key list that carries it
// (listApiKeys, services/auth.ts: GET /api/auth/keys).

const NOW = new Date("2026-10-13T15:30:00Z");
const TODAY = spendDay(NOW);
const YESTERDAY = spendDay(new Date("2026-10-12T15:30:00Z"));

const ORG = "org_buyer";
const OTHER_ORG = "org_other";

interface KeyRow {
  id: string;
  orgId: string;
  keyHash: string;
  keyPrefix: string;
  name: string | null;
  scopes: string[];
  maxJobPriceCents: bigint | null;
  maxUsePriceCents: bigint | null;
  dailySpendCapCents: bigint | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

function key(id: string, over: Partial<KeyRow> = {}): KeyRow {
  return {
    id,
    orgId: ORG,
    keyHash: `hash-of-${id}`,
    keyPrefix: `wheels_live_${id}`,
    name: id,
    scopes: ["*"],
    maxJobPriceCents: null,
    maxUsePriceCents: null,
    dailySpendCapCents: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

/** The two tables, answered by the `where` and `select` each query is sent with. */
function makeDb(keys: KeyRow[], windows: Array<{ apiKeyId: string; day: Date; spentCents: bigint }>) {
  const calls = { keys: 0, windows: 0 };
  const asked: Array<{ apiKeyId: { in: string[] }; day: Date }> = [];
  const db: ApiKeyListDb = {
    apiKey: {
      async findMany({ where, select }) {
        calls.keys += 1;
        return keys
          .filter((row) => row.orgId === where.orgId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => {
            // Only the columns that were asked for come back.
            const out: Record<string, unknown> = {};
            for (const column of Object.keys(select)) out[column] = row[column as keyof KeyRow];
            return out as never;
          });
      },
    },
    apiKeySpendWindow: {
      async findMany({ where }) {
        calls.windows += 1;
        asked.push(where);
        return windows
          .filter((w) => where.apiKeyId.in.includes(w.apiKeyId) && w.day.getTime() === where.day.getTime())
          .map((w) => ({ apiKeyId: w.apiKeyId, spentCents: w.spentCents }));
      },
    },
  };
  return { db, calls, asked };
}

test("readSpentToday: the UTC day's window of each key, in one query, and nothing for a key with no window", async () => {
  const { db, calls, asked } = makeDb(
    [],
    [
      { apiKeyId: "a", day: TODAY, spentCents: 120n },
      { apiKeyId: "a", day: YESTERDAY, spentCents: 9_999n },
      { apiKeyId: "b", day: YESTERDAY, spentCents: 500n },
      { apiKeyId: "z", day: TODAY, spentCents: 7n },
    ],
  );
  const spent = await readSpentToday(db, ["a", "b", "c"], NOW);
  assert.deepEqual([...spent], [["a", 120n]]);
  assert.equal(calls.windows, 1);
  assert.deepEqual(asked, [{ apiKeyId: { in: ["a", "b", "c"] }, day: TODAY }]);
});

test("readSpentToday: the day turns at midnight UTC", async () => {
  const { db } = makeDb([], [{ apiKeyId: "a", day: TODAY, spentCents: 120n }]);
  assert.equal((await readSpentToday(db, ["a"], new Date("2026-10-13T23:59:59Z"))).get("a"), 120n);
  assert.equal((await readSpentToday(db, ["a"], new Date("2026-10-14T00:00:00Z"))).get("a"), undefined);
});

test("readSpentToday: no key, no query", async () => {
  const { db, calls } = makeDb([], []);
  assert.equal((await readSpentToday(db, [], NOW)).size, 0);
  assert.equal(calls.windows, 0);
});

test("listApiKeys: each key carries what it spent today, 0 with no window, from one query for all the keys", async () => {
  const { db, calls } = makeDb(
    [
      key("spender", {
        scopes: ["agents:use"],
        maxUsePriceCents: 10n,
        dailySpendCapCents: 500n,
        createdAt: new Date("2026-10-03T00:00:00Z"),
      }),
      // A key that can spend and has not today.
      key("idle", {
        scopes: ["agents:use"],
        maxUsePriceCents: 10n,
        dailySpendCapCents: 500n,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      }),
      // A key with no caps cannot spend, and carries the field all the same.
      key("no-caps", { createdAt: new Date("2026-10-01T00:00:00Z") }),
      // A key that has expired still shows what it spent before it did.
      key("expired", {
        scopes: ["agents:use"],
        maxUsePriceCents: 10n,
        dailySpendCapCents: 500n,
        expiresAt: new Date("2026-10-13T12:00:00Z"),
        createdAt: new Date("2026-09-30T00:00:00Z"),
      }),
      key("theirs", { orgId: OTHER_ORG }),
    ],
    [
      { apiKeyId: "spender", day: TODAY, spentCents: 120n },
      { apiKeyId: "spender", day: YESTERDAY, spentCents: 480n },
      { apiKeyId: "idle", day: YESTERDAY, spentCents: 55n },
      { apiKeyId: "expired", day: TODAY, spentCents: 30n },
      { apiKeyId: "theirs", day: TODAY, spentCents: 4_444n },
    ],
  );
  const keys = await listApiKeys(ORG, { db, now: NOW });
  assert.deepEqual(
    keys.map((k) => [k.id, k.spentTodayCents]),
    [
      ["spender", 120],
      ["idle", 0],
      ["no-caps", 0],
      ["expired", 30],
    ],
  );
  assert.deepEqual(calls, { keys: 1, windows: 1 });
  // The caps are numbers beside it, as they were.
  assert.equal(keys[0]!.dailySpendCapCents, 500);
  assert.equal(keys[0]!.maxUsePriceCents, 10);
  assert.equal(keys[2]!.dailySpendCapCents, null);
  assert.equal(typeof keys[0]!.spentTodayCents, "number");
});

test("listApiKeys: never the key or its hash, and nothing of another organization's keys", async () => {
  const { db } = makeDb(
    [key("mine"), key("theirs", { orgId: OTHER_ORG })],
    [{ apiKeyId: "theirs", day: TODAY, spentCents: 4_444n }],
  );
  const keys = await listApiKeys(ORG, { db, now: NOW });
  assert.deepEqual(Object.keys(keys[0]!).sort(), [
    "createdAt",
    "dailySpendCapCents",
    "expiresAt",
    "id",
    "keyPrefix",
    "lastUsedAt",
    "maxJobPriceCents",
    "maxUsePriceCents",
    "name",
    "scopes",
    "spentTodayCents",
  ]);
  const text = JSON.stringify(keys);
  for (const never of ["hash-of-", "keyHash", "theirs", "4444", OTHER_ORG]) {
    assert.equal(text.includes(never), false, `the list carries ${never}`);
  }
});

test("listApiKeys: an organization with no key asks for no window", async () => {
  const { db, calls } = makeDb([], []);
  assert.deepEqual(await listApiKeys(ORG, { db, now: NOW }), []);
  assert.deepEqual(calls, { keys: 1, windows: 0 });
});

test("listApiKeys: when the day's windows cannot be read the keys are still listed, with the spend not known", async () => {
  const { db, calls } = makeDb(
    [key("spender", { scopes: ["agents:use"], maxUsePriceCents: 10n, dailySpendCapCents: 500n })],
    [{ apiKeyId: "spender", day: TODAY, spentCents: 120n }],
  );
  db.apiKeySpendWindow.findMany = async () => {
    calls.windows += 1;
    throw new Error("the spend windows are not there");
  };
  const keys = await listApiKeys(ORG, { db, now: NOW });
  // The key is answered (creating a key reads this list after the key is
  // written), and null says not known where a 0 would say nothing was spent.
  assert.deepEqual(
    keys.map((k) => [k.id, k.spentTodayCents, k.dailySpendCapCents]),
    [["spender", null, 500]],
  );
  assert.deepEqual(calls, { keys: 1, windows: 1 });
});
