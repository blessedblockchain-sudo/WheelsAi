import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEDGER_FILTERS,
  LEDGER_TYPES,
  SPEND_GROUPS,
  SPEND_GROUP_LABELS,
  ledgerTypeInfo,
  ledgerTypesOfFilter,
  ledgerTypesOfSpendGroup,
} from "@wheelsai/shared/ledger";

// @wheelsai/shared/ledger says what every row of credit_transactions is
// called and where it counts. This test reads the API's own source and
// fails when the API writes a type that table does not know: such a row
// would be listed as "other" and counted under no heading.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "tests" || entry.name === ".scratch" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({
  name: path.relative(SRC, file),
  text: readFileSync(file, "utf8"),
}));

/** `const NAME = "value"` anywhere in the source, by name. */
const STRING_CONSTANTS = new Map<string, string>();
for (const { text } of FILES) {
  for (const match of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*"([^"]*)"/g)) {
    STRING_CONSTANTS.set(match[1]!, match[2]!);
  }
}

/** The text from an opening brace to the brace that closes it. */
function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unbalanced braces");
}

/** The expression after `type:` at the top level of a `data: { ... }` block. */
function typeExpression(data: string): string | null {
  let depth = 0;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 1 && data.startsWith("type:", i) && !/[\w.]/.test(data[i - 1] ?? "")) {
      let end = i + 5;
      let inner = 0;
      for (; end < data.length; end++) {
        const c = data[end];
        if (c === "{" || c === "(" || c === "[") inner++;
        else if (c === "}" || c === ")" || c === "]") {
          if (inner === 0) break;
          inner--;
        } else if (c === "," && inner === 0) break;
      }
      return data.slice(i + 5, end).trim();
    }
  }
  return null;
}

interface Write {
  where: string;
  expression: string;
  types: string[];
  /** Names in the expression this test could not turn into a type. */
  unresolved: string[];
}

/** Every `creditTransaction.create(...)` and `createMany(...)` of the source. */
function findWrites(): Write[] {
  const writes: Write[] = [];
  for (const { name, text } of FILES) {
    for (const match of text.matchAll(/creditTransaction\s*\.\s*(?:create|createMany|upsert)\s*\(/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      const where = `${name}:${line}`;
      const open = text.indexOf("{", match.index);
      const call = braced(text, open);
      const dataAt = call.search(/\bdata\s*:/);
      assert.ok(dataAt >= 0, `${where}: a ledger write with no data block`);
      const data = braced(call, call.indexOf("{", dataAt));
      const expression = typeExpression(data);
      assert.ok(expression, `${where}: a ledger write with no type`);

      const types = [...expression.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      const unresolved: string[] = [];
      for (const [constant] of expression.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
        const value = STRING_CONSTANTS.get(constant);
        if (value === undefined) unresolved.push(constant);
        else types.push(value);
      }
      // A type passed in by the caller: its values are the string union the
      // parameter is declared with, in the same file.
      for (const [, property] of expression.matchAll(/\b[a-z]\w*\.(\w+)\b/g)) {
        const declared = new RegExp(`\\b${property}\\??\\s*:\\s*(\\w+)\\s*;`).exec(text)?.[1];
        const union = declared
          ? new RegExp(`\\btype\\s+${declared}\\s*=([^;]+);`).exec(text)?.[1]
          : undefined;
        const values = union ? [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
        if (values.length === 0) unresolved.push(`${property} (no string union found for it)`);
        else types.push(...values);
      }
      writes.push({ where, expression, types, unresolved });
    }
  }
  return writes;
}

const WRITES = findWrites();

test("the search finds the ledger's writers", () => {
  // If this drops, the search has gone blind, not the API quiet.
  assert.ok(WRITES.length >= 20, `only ${WRITES.length} writes found`);
  const files = new Set(WRITES.map((w) => w.where.split(":")[0]));
  for (const file of [
    "services/creditGrant.ts",
    "services/gpuBilling.ts",
    "services/trainingBilling.ts",
    "services/deploymentCreditGate.ts",
    "services/inferenceCreditHold.ts",
    "services/jobEscrow.ts",
    "services/marketplaceMetering.ts",
    "services/marketplaceSubscriptions.ts",
    "services/trialFunding.ts",
    "services/stripe/stripeWebhook.ts",
  ]) {
    assert.ok(files.has(file), file);
  }
});

test("every write's type can be read from the source", () => {
  for (const write of WRITES) {
    assert.deepEqual(
      write.unresolved,
      [],
      `${write.where}: "type: ${write.expression}" could not be read. Write the type as a string or a constant.`,
    );
    assert.ok(write.types.length > 0, `${write.where}: "type: ${write.expression}" names no type`);
  }
});

test("every type the API writes to credit_transactions has an entry in LEDGER_TYPES", () => {
  const missing: string[] = [];
  for (const write of WRITES) {
    for (const type of write.types) {
      if (!Object.hasOwn(LEDGER_TYPES, type)) missing.push(`${type} (${write.where})`);
    }
  }
  assert.deepEqual(missing, [], "add these to packages/shared/src/ledger.ts");

  // What the search must have seen, so a silent miss cannot pass.
  const written = new Set(WRITES.flatMap((w) => w.types));
  for (const type of [
    "purchase", "bonus", "payout_credit", "refund",
    "gpu_usage", "deployment_reservation", "deployment_reservation_release",
    "usage", "usage_release",
    "training_reservation", "training_reservation_release", "training_usage",
    "marketplace_usage", "marketplace_refund", "marketplace_subscription",
    "marketplace_job", "marketplace_job_refund",
    "trial_usage", "trial_usage_refund",
  ]) {
    assert.ok(written.has(type), `${type}: no write found`);
  }
});

test("every constant that holds a ledger type's name has an entry in LEDGER_TYPES", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const { name, text } of FILES) {
    // One name: FOO_LEDGER_TYPE = "foo".
    for (const match of text.matchAll(/\bconst\s+(\w*LEDGER_TYPE)\s*(?::\s*[^=]+)?=\s*"([^"]*)"/g)) {
      seen++;
      if (!Object.hasOwn(LEDGER_TYPES, match[2]!)) missing.push(`${match[1]} = "${match[2]}" (${name})`);
    }
    // A list of them: FOO_LEDGER_TYPES = [ "a", B_LEDGER_TYPE ].
    for (const match of text.matchAll(/\bconst\s+(\w*LEDGER_TYPES)\s*(?::\s*[^=]+)?=\s*\[([^\]]*)\]/g)) {
      for (const literal of match[2]!.matchAll(/"([^"]+)"/g)) {
        seen++;
        if (!Object.hasOwn(LEDGER_TYPES, literal[1]!)) missing.push(`${match[1]}: "${literal[1]}" (${name})`);
      }
    }
    // A union a caller chooses from: type FooLedgerType = "a" | "b".
    for (const match of text.matchAll(/\btype\s+(\w*LedgerType)\s*=([^;]+);/g)) {
      for (const literal of match[2]!.matchAll(/"([^"]+)"/g)) {
        seen++;
        if (!Object.hasOwn(LEDGER_TYPES, literal[1]!)) missing.push(`${match[1]}: "${literal[1]}" (${name})`);
      }
    }
  }
  assert.ok(seen >= 6, `only ${seen} constants found`);
  assert.deepEqual(missing, [], "add these to packages/shared/src/ledger.ts");
});

test("every spend group's types are spent or returned, and no type counts under two headings", () => {
  const counted = new Map<string, string>();
  for (const group of SPEND_GROUPS) {
    assert.ok(SPEND_GROUP_LABELS[group], `${group}: a label`);
    if (group === "jobs") continue;
    const types = ledgerTypesOfSpendGroup(group);
    assert.ok(types.length > 0, `${group}: no ledger type counts under it`);
    assert.ok(
      types.some((type) => LEDGER_TYPES[type]!.kind === "spent"),
      `${group}: nothing is ever spent under it`,
    );
    for (const type of types) {
      const { kind } = LEDGER_TYPES[type]!;
      assert.ok(kind === "spent" || kind === "returned", `${group}: ${type} is "${kind}"`);
      assert.equal(counted.get(type), undefined, `${type} counts under two headings`);
      counted.set(type, group);
    }
  }
  // And the other way: everything spent or returned counts under a heading,
  // so the month's total leaves no spending out. A hold never does.
  for (const [type, info] of Object.entries(LEDGER_TYPES)) {
    if (info.kind === "spent" || info.kind === "returned") {
      assert.ok(info.spendGroup, `${type} is ${info.kind} and counts under no heading`);
    } else {
      assert.equal(info.spendGroup, undefined, `${type} is ${info.kind} and must not count as spending`);
    }
    assert.ok(info.label.trim(), `${type}: a label`);
    assert.equal(type, type.toLowerCase(), `${type}: keys are lower case`);
  }
  // Jobs are spent when the work is accepted, which writes no ledger row.
  assert.ok(!Object.values(LEDGER_TYPES).some((info) => (info.spendGroup as string | undefined) === "jobs"));
});

test("the filters cover every kind but other, each type under one filter at most", () => {
  const kinds = Object.values(LEDGER_FILTERS).flat();
  assert.deepEqual([...kinds].sort(), ["added", "held", "released", "returned", "spent", "taken_back"]);
  const seen = new Set<string>();
  for (const filter of Object.keys(LEDGER_FILTERS) as Array<keyof typeof LEDGER_FILTERS>) {
    for (const type of ledgerTypesOfFilter(filter)) {
      assert.ok(!seen.has(type), `${type} is under two filters`);
      seen.add(type);
    }
  }
  for (const [type, info] of Object.entries(LEDGER_TYPES)) {
    assert.equal(seen.has(type), info.kind !== "other", type);
  }
});

test("a type the table does not know is other, with a readable name, never an error", () => {
  assert.deepEqual(ledgerTypeInfo("PURCHASE"), LEDGER_TYPES.purchase);
  assert.deepEqual(ledgerTypeInfo("mystery_fee"), { kind: "other", label: "Mystery fee" });
  assert.deepEqual(ledgerTypeInfo(""), { kind: "other", label: "Credit change" });
  assert.deepEqual(ledgerTypeInfo(null), { kind: "other", label: "Credit change" });
  // A name every object has is not a type.
  assert.equal(ledgerTypeInfo("constructor").kind, "other");
  assert.equal(ledgerTypeInfo("toString").kind, "other");
});
