/**
 * The credit ledger in a customer's words: what each kind of row is called,
 * which way it reads, and which heading of "what you spent" it belongs
 * under. One table, read by the API (the labels it answers with, the
 * month's spending, the export) and by the web (how a row is drawn).
 *
 * Self-contained on purpose (no imports), like payouts.ts and revenue.ts:
 * the web app and the API both use it, and it must run in a browser.
 *
 * Every type the API writes to credit_transactions has an entry here. A
 * test in apps/api reads the API's source and fails when one is missing.
 */

/**
 * How a row reads to the customer.
 *   added       credits arriving: bought, granted, or earnings taken as credits
 *   spent       credits used
 *   returned    a charge, or the unused part of one, coming back
 *   held        set aside for something that is running or awaited
 *   released    a hold coming back
 *   taken_back  credits removed again (a card payment that was refunded)
 *   other       a type this table does not know
 */
export type LedgerKind =
  | "added"
  | "spent"
  | "returned"
  | "held"
  | "released"
  | "taken_back"
  | "other";

/** The headings of "what you spent this month", in the order they are shown. */
export const SPEND_GROUPS = [
  "gpu",
  "inference",
  "fine_tuning",
  "paid_use",
  "subscriptions",
  "jobs",
  "try_it",
] as const;
export type SpendGroup = (typeof SPEND_GROUPS)[number];

export const SPEND_GROUP_LABELS: Record<SpendGroup, string> = {
  gpu: "GPU time",
  inference: "Inference",
  fine_tuning: "Fine-tuning",
  paid_use: "Paid use of listings",
  subscriptions: "Subscriptions",
  jobs: "Jobs",
  try_it: "Try it messages you paid for",
};

export interface LedgerTypeInfo {
  kind: LedgerKind;
  /** What the row is called, in a list and in the export. */
  label: string;
  /**
   * The heading its amount counts under, when the month's spending is the
   * sum of the ledger's own rows: a charge counts in full and what came back
   * of it counts against it. Absent for a row that is not spending.
   *
   * Jobs are not here: a job's payment is HELD in escrow when it is hired
   * and is spent only when the work is accepted, which writes no ledger row.
   * What was spent on jobs is read from the settled job itself.
   */
  spendGroup?: Exclude<SpendGroup, "jobs">;
}

export const LEDGER_TYPES: Record<string, LedgerTypeInfo> = {
  // Credits arriving.
  purchase: { kind: "added", label: "Credits added" },
  bonus: { kind: "added", label: "Bonus credits" },
  payout_credit: { kind: "added", label: "Earnings taken as credits" },
  // A card payment that was refunded: the credits it bought are removed.
  refund: { kind: "taken_back", label: "Card refund" },

  // A running deployment: GPU time, and the hold that stands behind it.
  gpu_usage: { kind: "spent", label: "GPU time", spendGroup: "gpu" },
  deployment_reservation: { kind: "held", label: "Held for a deployment" },
  deployment_reservation_release: { kind: "released", label: "Deployment hold released" },

  // Inference charged per request: the charge, then its unused part back.
  usage: { kind: "spent", label: "Inference", spendGroup: "inference" },
  usage_release: { kind: "returned", label: "Inference, unused part returned", spendGroup: "inference" },

  // Fine-tuning: the hold for the run, the hold back, then what the run used.
  training_reservation: { kind: "held", label: "Held for fine-tuning" },
  training_reservation_release: { kind: "released", label: "Fine-tuning hold released" },
  training_usage: { kind: "spent", label: "Fine-tuning", spendGroup: "fine_tuning" },

  // The marketplace, as a buyer.
  marketplace_usage: { kind: "spent", label: "Paid use", spendGroup: "paid_use" },
  marketplace_refund: { kind: "returned", label: "Paid use refunded", spendGroup: "paid_use" },
  marketplace_subscription: { kind: "spent", label: "Subscription", spendGroup: "subscriptions" },
  marketplace_job: { kind: "held", label: "Held for a job" },
  marketplace_job_refund: { kind: "released", label: "Job refunded" },

  // Try it messages a publisher pays for on their own listing.
  trial_usage: { kind: "spent", label: "Try it message you paid for", spendGroup: "try_it" },
  trial_usage_refund: { kind: "returned", label: "Try it message refunded", spendGroup: "try_it" },

  // A request paid for with an on-chain transfer (x402) that was not
  // answered: what was paid comes back as credits.
  x402_refund: { kind: "added", label: "Paid request returned as credits" },

  // Older rows, and the type an operator's correction would carry.
  signup_bonus: { kind: "added", label: "Bonus credits" },
  adjustment: { kind: "other", label: "Adjustment" },
};

/** A type as the ledger stores it, tidied: older rows wrote it in capitals. */
export function ledgerTypeKey(type: unknown): string {
  return typeof type === "string" ? type.trim().toLowerCase() : "";
}

/**
 * What a row of this type is. A type the table does not know is "other"
 * with its own name made readable, never an error and never nothing.
 */
export function ledgerTypeInfo(type: unknown): LedgerTypeInfo {
  const key = ledgerTypeKey(type);
  const known = Object.prototype.hasOwnProperty.call(LEDGER_TYPES, key) ? LEDGER_TYPES[key] : undefined;
  if (known) return known;
  const words = key.replace(/_/g, " ").trim();
  return {
    kind: "other",
    label: words ? words.charAt(0).toUpperCase() + words.slice(1) : "Credit change",
  };
}

/** The filters a list of rows can be asked for, and the kinds each covers. */
export const LEDGER_FILTERS = {
  added: ["added", "taken_back"],
  spent: ["spent", "returned"],
  held: ["held", "released"],
} as const satisfies Record<string, readonly LedgerKind[]>;
export type LedgerFilter = keyof typeof LEDGER_FILTERS;

export function isLedgerFilter(value: unknown): value is LedgerFilter {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEDGER_FILTERS, value);
}

/** Every stored type a filter covers, for a query. */
export function ledgerTypesOfFilter(filter: LedgerFilter): string[] {
  const kinds: readonly LedgerKind[] = LEDGER_FILTERS[filter];
  return Object.entries(LEDGER_TYPES)
    .filter(([, info]) => kinds.includes(info.kind))
    .map(([type]) => type);
}

/** Every stored type whose amount counts under a heading of the month's spending. */
export function ledgerTypesOfSpendGroup(group: Exclude<SpendGroup, "jobs">): string[] {
  return Object.entries(LEDGER_TYPES)
    .filter(([, info]) => info.spendGroup === group)
    .map(([type]) => type);
}
