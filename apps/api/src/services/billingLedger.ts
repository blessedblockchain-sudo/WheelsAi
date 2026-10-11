/**
 * What the Billing page reads: the balance, what is held and why, what was
 * spent this month by kind, the credit ledger a page at a time, and the
 * ledger as a file.
 *
 * NO INVENTED NUMBER. Every figure here is the sum of rows that exist: no
 * fixed share, no estimate, no fallback figure. Cents are summed as BigInt
 * and turned into dollars only at the end.
 *
 *   available   credit_balances.balanceCents. Every hold is a real decrement
 *               of it, so the balance IS what is available.
 *   held        what is still set aside, found at each of its five sources
 *               (a model deployment, an agent on its own GPU, a fine-tuning
 *               run, a job in escrow, Try it messages a publisher pays for).
 *   spent       this UTC month, net, by the headings of
 *               @wheelsai/shared/ledger: minus the sum of the ledger's rows
 *               of a heading's types (a charge counts in full, what came back
 *               counts against it). Jobs are read from the settled escrow:
 *               accepting a job writes no ledger row.
 *   GPU hours   this month's gpuSeconds summed over the ledger, over 3600.
 *
 * "This month" is the UTC calendar month.
 *
 * Every sentence a customer reads is written here. Pure: the reads and the
 * clock are passed in (services/buildBillingLedgerDeps.ts binds them).
 */

import {
  SPEND_GROUPS,
  SPEND_GROUP_LABELS,
  isLedgerFilter,
  ledgerTypeInfo,
  ledgerTypeKey,
  ledgerTypesOfFilter,
  ledgerTypesOfSpendGroup,
  type LedgerFilter,
  type LedgerKind,
  type SpendGroup,
} from "@wheelsai/shared/ledger";

import { toCsv } from "./analyticsExport.js";

// ============================================
// Sentences
// ============================================

export const BILLING_LEDGER_SENTENCES = {
  invalid_request: "That list could not be read. Reload the page and try again.",
  invalid_range: "Choose a start date and an end date, with the start first.",
  range_too_large:
    "That range holds more rows than one file can carry. Choose a shorter range.",
  billing_unavailable: "Billing could not be read. Try again in a moment.",
  unauthenticated: "Sign in to see your billing.",
} as const;
export type BillingLedgerRefusalCode = keyof typeof BILLING_LEDGER_SENTENCES;

export const HOLD_KINDS = [
  "deployment",
  "agent_deployment",
  "fine_tuning",
  "job",
  "try_it",
] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** Why each kind of hold is held, and when it comes back. */
export const HOLD_NOTES: Record<HoldKind, string> = {
  deployment: "Held while this deployment runs. It comes back when the deployment stops.",
  agent_deployment: "Held while this agent runs on its own GPU. It comes back when it stops.",
  fine_tuning:
    "Held for this fine-tuning run. What the run does not use comes back when it ends.",
  job: "Held until you accept the work, or the job is refunded.",
  try_it: "Held for a few minutes while a Try it message you pay for is answered.",
};

/** What a hold is called when the thing it stands behind has no name. */
const HOLD_FALLBACK_NAMES: Record<HoldKind, string> = {
  deployment: "Deployment",
  agent_deployment: "Agent",
  fine_tuning: "Fine-tuning run",
  job: "Job",
  try_it: "Try it messages",
};

/** The one entry that stands for every held Try it message. */
export const TRY_IT_HOLD_ID = "try_it";
export const TRY_IT_HOLD_NAME = "Try it messages";

export const TRANSACTIONS_DEFAULT_LIMIT = 50;
export const TRANSACTIONS_MAX_LIMIT = 200;
/** The most rows one exported file carries. */
export const EXPORT_MAX_ROWS = 100_000;

// ============================================
// The reads (bound in buildBillingLedgerDeps.ts)
// ============================================

/** One thing that holds credits, as its source row has it. */
export interface HeldRow {
  id: string;
  name: string | null;
  amountCents: bigint;
  since: Date;
}

/** One row of credit_transactions. */
export interface LedgerRow {
  id: string;
  amountCents: bigint;
  /** As stored: older rows wrote it in capitals. */
  type: string;
  description: string | null;
  balanceAfter: bigint;
  createdAt: Date;
}

/** A half-open span of time: `from` included, `to` not. */
export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * EVERY READ TAKES THE ORGANIZATION and answers with that organization's
 * rows only.
 */
export interface BillingLedgerStore {
  /** credit_balances.balanceCents; 0 when the organization has no row. */
  balanceCents(orgId: string): Promise<bigint>;
  /** Model deployments whose reservation is above zero and not released. */
  deploymentHolds(orgId: string): Promise<HeldRow[]>;
  /** The same, for the deployments of the organization's agents. */
  agentDeploymentHolds(orgId: string): Promise<HeldRow[]>;
  /** Fine-tuning jobs with a reservation above zero and not settled. */
  fineTuningHolds(orgId: string): Promise<HeldRow[]>;
  /** Jobs this organization hired whose escrow is still pending. */
  jobHolds(orgId: string): Promise<HeldRow[]>;
  /** Try it charges still held that this organization pays for, as one sum. */
  tryItHold(orgId: string): Promise<{ amountCents: bigint; since: Date | null }>;
  /** The ledger's rows in the range, summed by stored type. */
  ledgerTotalsByType(
    args: { orgId: string } & TimeRange,
  ): Promise<Array<{ type: string; amountCents: bigint; gpuSeconds: bigint }>>;
  /** grossAmountCents of the jobs this buyer's escrow settled in the range. */
  settledJobCents(args: { orgId: string } & TimeRange): Promise<bigint>;
  /** usage_records whose period starts in the range, summed. */
  usageCounts(
    args: { orgId: string } & TimeRange,
  ): Promise<{ requests: number; inputTokens: bigint; outputTokens: bigint }>;
  /**
   * Ledger rows, newest first (createdAt then id, both descending), strictly
   * after `before` in that order. `types` null is every type.
   */
  listLedger(args: {
    orgId: string;
    types: string[] | null;
    before: { createdAt: Date; id: string } | null;
    take: number;
  }): Promise<LedgerRow[]>;
  /** Ledger rows in the range, oldest first (createdAt then id). */
  ledgerInRange(args: { orgId: string; take: number } & TimeRange): Promise<LedgerRow[]>;
}

export interface BillingLedgerDeps {
  store: BillingLedgerStore;
  now: () => Date;
}

// ============================================
// Small things
// ============================================

/** Whole cents as dollars. The only place a BigInt of cents becomes a number. */
export function centsToDollars(cents: bigint): number {
  return Number(cents) / 100;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The UTC day of a moment, "YYYY-MM-DD". */
export function utcDay(at: Date): string {
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** The UTC calendar month a moment falls in. */
export function utcMonthOf(at: Date): { month: string } & TimeRange {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return {
    month: `${pad(year, 4)}-${pad(month + 1)}`,
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 1)),
  };
}

// ============================================
// Held
// ============================================

export interface HoldView {
  kind: HoldKind;
  id: string;
  name: string;
  amount: number;
  since: string;
  note: string;
}

interface Hold {
  kind: HoldKind;
  id: string;
  name: string;
  amountCents: bigint;
  since: Date;
}

async function collectHolds(
  deps: BillingLedgerDeps,
  orgId: string,
): Promise<{ holds: Hold[]; totalCents: bigint }> {
  const { store } = deps;
  const [deployments, agentDeployments, fineTuning, jobs, tryIt] = await Promise.all([
    store.deploymentHolds(orgId),
    store.agentDeploymentHolds(orgId),
    store.fineTuningHolds(orgId),
    store.jobHolds(orgId),
    store.tryItHold(orgId),
  ]);

  const holds: Hold[] = [];
  const add = (kind: HoldKind, rows: HeldRow[]) => {
    for (const row of rows) {
      // Nothing held is not a hold, whatever the source row says.
      if (row.amountCents <= 0n) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      holds.push({
        kind,
        id: row.id,
        name: name || HOLD_FALLBACK_NAMES[kind],
        amountCents: row.amountCents,
        since: row.since,
      });
    }
  };
  add("deployment", deployments);
  add("agent_deployment", agentDeployments);
  add("fine_tuning", fineTuning);
  add("job", jobs);
  if (tryIt.amountCents > 0n && tryIt.since) {
    holds.push({
      kind: "try_it",
      id: TRY_IT_HOLD_ID,
      name: TRY_IT_HOLD_NAME,
      amountCents: tryIt.amountCents,
      since: tryIt.since,
    });
  }

  // Newest first; the id settles a tie so the order never changes between reads.
  holds.sort(
    (a, b) => b.since.getTime() - a.since.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const totalCents = holds.reduce((sum, hold) => sum + hold.amountCents, 0n);
  return { holds, totalCents };
}

/** GET /holds. */
export async function readHolds(
  deps: BillingLedgerDeps,
  orgId: string,
): Promise<{ holds: HoldView[]; total: number }> {
  const { holds, totalCents } = await collectHolds(deps, orgId);
  return {
    holds: holds.map((hold) => ({
      kind: hold.kind,
      id: hold.id,
      name: hold.name,
      amount: centsToDollars(hold.amountCents),
      since: hold.since.toISOString(),
      note: HOLD_NOTES[hold.kind],
    })),
    total: centsToDollars(totalCents),
  };
}

export interface BalanceView {
  available: number;
  held: number;
  total: number;
  /** The same figure as `held`, kept for older callers. */
  pending: number;
}

/** GET /balance. */
export async function readBalance(
  deps: BillingLedgerDeps,
  orgId: string,
): Promise<{ balance: BalanceView }> {
  const [availableCents, { totalCents: heldCents }] = await Promise.all([
    deps.store.balanceCents(orgId),
    collectHolds(deps, orgId),
  ]);
  const held = centsToDollars(heldCents);
  return {
    balance: {
      available: centsToDollars(availableCents),
      held,
      total: centsToDollars(availableCents + heldCents),
      pending: held,
    },
  };
}

// ============================================
// This month
// ============================================

export interface UsageView {
  month: string;
  currentMonth: number;
  spend: Array<{ group: SpendGroup; label: string; amount: number }>;
  gpuHours: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** GET /usage. */
export async function readUsage(
  deps: BillingLedgerDeps,
  orgId: string,
): Promise<{ usage: UsageView }> {
  const { month, from, to } = utcMonthOf(deps.now());
  const [totals, jobCents, counts] = await Promise.all([
    deps.store.ledgerTotalsByType({ orgId, from, to }),
    deps.store.settledJobCents({ orgId, from, to }),
    deps.store.usageCounts({ orgId, from, to }),
  ]);

  // Older rows stored the type in capitals: fold them onto one key.
  const centsByType = new Map<string, bigint>();
  let gpuSeconds = 0n;
  for (const row of totals) {
    const key = ledgerTypeKey(row.type);
    centsByType.set(key, (centsByType.get(key) ?? 0n) + row.amountCents);
    gpuSeconds += row.gpuSeconds;
  }

  let currentMonthCents = 0n;
  const spend = SPEND_GROUPS.map((group) => {
    let cents: bigint;
    if (group === "jobs") {
      cents = jobCents;
    } else {
      // A charge is stored below zero and what came back above it, so what
      // was spent is minus their sum.
      let sum = 0n;
      for (const type of ledgerTypesOfSpendGroup(group)) sum += centsByType.get(type) ?? 0n;
      cents = -sum;
    }
    currentMonthCents += cents;
    return { group, label: SPEND_GROUP_LABELS[group], amount: centsToDollars(cents) };
  });

  return {
    usage: {
      month,
      currentMonth: centsToDollars(currentMonthCents),
      spend,
      gpuHours: Number(gpuSeconds) / 3600,
      requests: counts.requests,
      inputTokens: Number(counts.inputTokens),
      outputTokens: Number(counts.outputTokens),
    },
  };
}

// ============================================
// The ledger, a page at a time
// ============================================

export interface TransactionView {
  id: string;
  amount: number;
  type: string;
  kind: LedgerKind;
  label: string;
  description: string;
  balanceAfter: number;
  createdAt: string;
}

export function transactionView(row: LedgerRow): TransactionView {
  const info = ledgerTypeInfo(row.type);
  const description = typeof row.description === "string" ? row.description.trim() : "";
  return {
    id: row.id,
    amount: centsToDollars(row.amountCents),
    type: ledgerTypeKey(row.type),
    kind: info.kind,
    label: info.label,
    description: description || info.label,
    balanceAfter: centsToDollars(row.balanceAfter),
    createdAt: row.createdAt.toISOString(),
  };
}

const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;

/** Where a page ended: the row after which the next page starts. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.getTime()}.${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (!CURSOR_SHAPE.test(cursor)) return null;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const msText = text.slice(0, dot);
  const id = text.slice(dot + 1);
  if (!/^\d{1,16}$/.test(msText) || !CURSOR_ID.test(id)) return null;
  const createdAt = new Date(Number(msText));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** A query value that was not sent, or was sent empty. */
const absent = (value: unknown) => value === undefined || value === null || value === "";

function parseLimit(raw: unknown): number | null {
  if (absent(raw)) return TRANSACTIONS_DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= TRANSACTIONS_MAX_LIMIT ? limit : null;
}

/**
 * Every stored spelling of a filter's types: as written today, and in the
 * capitals older rows used.
 */
export function storedTypesOfFilter(filter: LedgerFilter): string[] {
  const types = ledgerTypesOfFilter(filter);
  return [...new Set([...types, ...types.map((type) => type.toUpperCase())])];
}

export type ListTransactionsResult =
  | { ok: true; transactions: TransactionView[]; nextCursor: string | null }
  | { ok: false; code: "invalid_request" };

/** GET /transactions. The query values are passed as they arrived. */
export async function listTransactions(
  deps: BillingLedgerDeps,
  orgId: string,
  query: { limit?: unknown; cursor?: unknown; filter?: unknown },
): Promise<ListTransactionsResult> {
  const limit = parseLimit(query.limit);
  if (limit === null) return { ok: false, code: "invalid_request" };

  let types: string[] | null = null;
  if (!absent(query.filter)) {
    if (!isLedgerFilter(query.filter)) return { ok: false, code: "invalid_request" };
    types = storedTypesOfFilter(query.filter);
  }

  let before: { createdAt: Date; id: string } | null = null;
  if (!absent(query.cursor)) {
    before = typeof query.cursor === "string" ? decodeCursor(query.cursor) : null;
    if (before === null) return { ok: false, code: "invalid_request" };
  }

  // One row more than asked for says whether another page follows.
  const rows = await deps.store.listLedger({ orgId, types, before, take: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    transactions: page.map(transactionView),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

// ============================================
// The ledger as a file
// ============================================

export const EXPORT_COLUMNS = [
  { key: "date", header: "Date (UTC)" },
  { key: "type", header: "Type" },
  { key: "what", header: "What" },
  { key: "description", header: "Description" },
  { key: "amount", header: "Amount (USD)" },
  { key: "balanceAfter", header: "Balance after (USD)" },
] as const;

type ExportLine = {
  date: string;
  type: string;
  what: string;
  description: string;
  amount: number;
  balanceAfter: number;
};

/** "YYYY-MM-DD" as the first moment of that UTC day; null when it is not a day. */
export function parseUtcDay(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // 2026-02-31 would roll over into March: it is not a day.
  return !Number.isNaN(at.getTime()) && utcDay(at) === raw ? at : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExportTransactionsResult =
  | { ok: true; filename: string; csv: string; rows: number }
  | { ok: false; code: "invalid_range" | "range_too_large" };

/** GET /transactions/export. The query values are passed as they arrived. */
export async function exportTransactions(
  deps: BillingLedgerDeps,
  orgId: string,
  query: { from?: unknown; to?: unknown },
): Promise<ExportTransactionsResult> {
  let fromDay: Date;
  let toDay: Date;
  if (absent(query.from) && absent(query.to)) {
    // The current UTC month, up to today.
    const now = deps.now();
    fromDay = utcMonthOf(now).from;
    toDay = parseUtcDay(utcDay(now))!;
  } else {
    const from = parseUtcDay(query.from);
    const to = parseUtcDay(query.to);
    if (!from || !to || to.getTime() < from.getTime()) {
      return { ok: false, code: "invalid_range" };
    }
    fromDay = from;
    toDay = to;
  }

  // `to` is included: the range ends where the day after it starts.
  const rows = await deps.store.ledgerInRange({
    orgId,
    from: fromDay,
    to: new Date(toDay.getTime() + DAY_MS),
    take: EXPORT_MAX_ROWS + 1,
  });
  if (rows.length > EXPORT_MAX_ROWS) return { ok: false, code: "range_too_large" };

  const lines: ExportLine[] = rows.map((row) => ({
    date: row.createdAt.toISOString(),
    type: row.type,
    what: ledgerTypeInfo(row.type).label,
    description: row.description ?? "",
    // Numbers, so a spent amount keeps its own minus sign in a spreadsheet.
    amount: centsToDollars(row.amountCents),
    balanceAfter: centsToDollars(row.balanceAfter),
  }));

  return {
    ok: true,
    filename: `wheelsai-credits-${utcDay(fromDay)}-to-${utcDay(toDay)}.csv`,
    csv: toCsv(lines, [...EXPORT_COLUMNS]),
    rows: rows.length,
  };
}
