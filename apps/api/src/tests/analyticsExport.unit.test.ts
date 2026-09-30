import assert from "node:assert/strict";
import test from "node:test";

import { clampExportDays, DAILY_COLUMNS, EXPORT_MAX_DAYS, toCsv } from "../services/analyticsExport.js";

test("CSV quotes separators and neutralises spreadsheet formulas", () => {
  const csv = toCsv(
    [
      { name: 'Prod, "EU"', note: "=HYPERLINK(\"http://x\")", n: 5, d: null },
      { name: "-2+3", note: "@SUM(A1)", n: -1, d: "ok" },
    ],
    [
      { key: "name", header: "name" },
      { key: "note", header: "note" },
      { key: "n", header: "n" },
      { key: "d", header: "d" },
    ],
  );
  assert.equal(
    csv,
    'name,note,n,d\r\n"Prod, ""EU""","\'=HYPERLINK(""http://x"")",5,\r\n\'-2+3,\'@SUM(A1),-1,ok\r\n',
  );
});

test("the daily export has one row per day with stable headers", () => {
  const csv = toCsv(
    [{ timestamp: "2026-09-30", requests: 12, tokensIn: 100, tokensOut: 250, costCents: 7, errors: 0 }],
    [...DAILY_COLUMNS] as never,
  );
  assert.equal(csv.split("\r\n")[0], "date,requests,tokens_in,tokens_out,cost_cents,errors");
  assert.equal(csv.split("\r\n")[1], "2026-09-30,12,100,250,7,0");
});

test("export periods are bounded", () => {
  assert.equal(clampExportDays("30"), 30);
  assert.equal(clampExportDays("100000"), EXPORT_MAX_DAYS);
  for (const bad of [undefined, "", "0", "-5", "abc"]) assert.equal(clampExportDays(bad), 30, String(bad));
});
