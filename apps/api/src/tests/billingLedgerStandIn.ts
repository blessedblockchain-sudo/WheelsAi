// An in-memory database for the Billing page's reads. It evaluates the
// `where`, `orderBy` and `take` each query is sent with, so a test of the
// store proves the query itself: a row the query does not ask for is not
// answered, whoever it belongs to.

import type { BillingLedgerDb } from "../services/buildBillingLedgerDeps.js";

type Row = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const OPERATORS = new Set(["equals", "gt", "gte", "lt", "lte", "in", "not"]);

function comparable(value: unknown): number | bigint | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    return value;
  }
  throw new Error(`stand-in: cannot compare ${String(value)}`);
}

function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return comparable(a) === comparable(b);
}

function matchField(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition)) return same(value, condition);
  const keys = Object.keys(condition);
  if (keys.length > 0 && keys.every((key) => OPERATORS.has(key))) {
    return keys.every((key) => {
      const operand = condition[key];
      if (key === "equals") return same(value, operand);
      if (key === "not") return !same(value, operand);
      if (key === "in") return (operand as unknown[]).some((item) => same(value, item));
      // SQL: a comparison with NULL is never true.
      if (value === null || value === undefined) return false;
      const left = comparable(value);
      const right = comparable(operand);
      if (key === "gt") return left > right;
      if (key === "gte") return left >= right;
      if (key === "lt") return left < right;
      return left <= right;
    });
  }
  // A relation: the related row must match.
  return isPlainObject(value) && matches(value, condition);
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Array<Record<string, unknown>>).some((w) => matches(row, w));
    if (key === "AND") return (condition as Array<Record<string, unknown>>).every((w) => matches(row, w));
    return matchField(row[key], condition);
  });
}

function sorted(rows: Row[], orderBy: Array<Record<string, "asc" | "desc">> | undefined): Row[] {
  if (!orderBy) return [...rows];
  return [...rows].sort((a, b) => {
    for (const order of orderBy) {
      const [field, direction] = Object.entries(order)[0]!;
      const left = comparable(a[field]);
      const right = comparable(b[field]);
      if (left === right) continue;
      const less = left < right;
      return direction === "asc" ? (less ? -1 : 1) : less ? 1 : -1;
    }
    return 0;
  });
}

function sumOf(rows: Row[], field: string): bigint | number | null {
  const values = rows.map((row) => row[field]).filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return null;
  return typeof values[0] === "bigint"
    ? (values as bigint[]).reduce((a, b) => a + b, 0n)
    : (values as number[]).reduce((a, b) => a + b, 0);
}

export interface StandInTables {
  creditBalance: Row[];
  creditTransaction: Row[];
  deployment: Row[];
  agentDeployment: Row[];
  trainingJob: Row[];
  marketplaceRevenue: Row[];
  trialCharge: Row[];
  usageRecord: Row[];
}

type AnyArgs = {
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, "asc" | "desc">>;
  take?: number;
  by?: string[];
  _sum?: Record<string, true>;
  _min?: Record<string, true>;
};

export function makeBillingDb(seed: Partial<StandInTables> = {}) {
  const tables: StandInTables = {
    creditBalance: [],
    creditTransaction: [],
    deployment: [],
    agentDeployment: [],
    trainingJob: [],
    marketplaceRevenue: [],
    trialCharge: [],
    usageRecord: [],
    ...seed,
  };
  /** Every query the store sent, for tests that pin the scoping. */
  const calls: Array<{ table: keyof StandInTables; op: string; args: AnyArgs }> = [];
  let failWith: Error | null = null;

  function table(name: keyof StandInTables) {
    const run = (op: string, args: AnyArgs) => {
      calls.push({ table: name, op, args });
      if (failWith) throw failWith;
      return tables[name].filter((row) => matches(row, args.where));
    };
    return {
      async findUnique(args: AnyArgs) {
        return run("findUnique", args)[0] ?? null;
      },
      async findMany(args: AnyArgs) {
        const rows = sorted(run("findMany", args), args.orderBy);
        return args.take === undefined ? rows : rows.slice(0, args.take);
      },
      async aggregate(args: AnyArgs) {
        const rows = run("aggregate", args);
        const out: Record<string, Record<string, unknown>> = {};
        if (args._sum) {
          out._sum = Object.fromEntries(Object.keys(args._sum).map((f) => [f, sumOf(rows, f)]));
        }
        if (args._min) {
          out._min = Object.fromEntries(
            Object.keys(args._min).map((f) => [f, sorted(rows, [{ [f]: "asc" }])[0]?.[f] ?? null]),
          );
        }
        return out;
      },
      async groupBy(args: AnyArgs) {
        const rows = run("groupBy", args);
        const field = args.by![0]!;
        const groups = new Map<unknown, Row[]>();
        for (const row of rows) groups.set(row[field], [...(groups.get(row[field]) ?? []), row]);
        return [...groups.entries()].map(([value, members]) => ({
          [field]: value,
          _sum: Object.fromEntries(
            Object.keys(args._sum ?? {}).map((f) => [f, sumOf(members, f)]),
          ),
        }));
      },
    };
  }

  const db = {
    creditBalance: table("creditBalance"),
    creditTransaction: table("creditTransaction"),
    deployment: table("deployment"),
    agentDeployment: table("agentDeployment"),
    trainingJob: table("trainingJob"),
    marketplaceRevenue: table("marketplaceRevenue"),
    trialCharge: table("trialCharge"),
    usageRecord: table("usageRecord"),
  } as unknown as BillingLedgerDb;

  return {
    db,
    tables,
    calls,
    /** Every query from now on throws this (null: none does). */
    fail(error: Error | null) {
      failWith = error;
    },
  };
}

/** A uuid whose order is the order of `n`. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const ORG = uuid(900_001);
export const OTHER_ORG = uuid(900_002);

let nextId = 1;

/** A credit_transactions row. */
export function ledgerRow(input: {
  orgId?: string;
  id?: string;
  type: string;
  amountCents: bigint;
  createdAt: Date;
  balanceAfter?: bigint;
  description?: string | null;
  gpuSeconds?: bigint | null;
}): Row {
  return {
    id: input.id ?? uuid(nextId++),
    orgId: input.orgId ?? ORG,
    type: input.type,
    amountCents: input.amountCents,
    balanceAfter: input.balanceAfter ?? 0n,
    description: input.description === undefined ? null : input.description,
    referenceId: null,
    gpuSeconds: input.gpuSeconds ?? null,
    createdAt: input.createdAt,
  };
}
