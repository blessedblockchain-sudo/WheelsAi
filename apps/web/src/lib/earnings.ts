/**
 * What the Earnings page says of a payout, of the request button and of a row of
 * earnings. Pure: the page draws what these answer and decides nothing itself.
 */

/** The smallest amount a payout can be requested for, in cents. */
export const MIN_PAYOUT_CENTS = 1000;

/** The API's sentence for a request made while payouts are not running (503 `payouts_unavailable`). */
export const PAYOUTS_UNAVAILABLE_MESSAGE =
  "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.";

export const PAYOUTS_UNAVAILABLE_CODE = "payouts_unavailable";
export const PAYOUT_NOT_CANCELLABLE_CODE = "payout_not_cancellable";

export const EARNINGS_WORDS = {
  cancel: "Cancel",
  cancelTitle: "Cancel this payout?",
  cancelConfirm: "Cancel payout",
  cancelKeep: "Keep payout",
  paidUse: "Paid use",
  /** A request charged on a copy a buyer installed. */
  perRequestOnCopy: "Per request",
  modelCost: "Model cost",
  /** Beside the request button while payouts are not running. */
  payoutsOff: "Payouts are temporarily unavailable. Your earnings are unchanged. Try again later.",
  /** Beside the request button when the page could not find out whether payouts are running. */
  payoutsUnknown: "Could not check whether payouts are running. Reload the page to try again.",
  minimum: "Minimum payout amount is $10.00",
} as const;

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---- A payout in the history ----

export type PayoutTone = "success" | "warning" | "destructive" | "secondary";
export type PayoutIcon = "done" | "failed" | "cancelled" | "waiting";

export interface PayoutRowView {
  statusLabel: string;
  tone: PayoutTone;
  icon: PayoutIcon;
  /** The row offers Cancel. Only the API's own `cancellable` decides it. */
  canCancel: boolean;
  /** Why a failed payout did not go through, as the API wrote it; null when there is nothing to say. */
  note: string | null;
}

const PAYOUT_STATUS: Record<string, { label: string; tone: PayoutTone; icon: PayoutIcon }> = {
  pending: { label: "Pending", tone: "secondary", icon: "waiting" },
  processing: { label: "Processing", tone: "warning", icon: "waiting" },
  completed: { label: "Completed", tone: "success", icon: "done" },
  failed: { label: "Failed", tone: "destructive", icon: "failed" },
  cancelled: { label: "Cancelled", tone: "secondary", icon: "cancelled" },
};

function sentenceCase(raw: string): string {
  const words = raw.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

export function payoutRow(payout: {
  status: string;
  cancellable?: boolean | null;
  failureReason?: string | null;
}): PayoutRowView {
  const known = Object.prototype.hasOwnProperty.call(PAYOUT_STATUS, payout.status)
    ? PAYOUT_STATUS[payout.status]
    : undefined;
  const reason = typeof payout.failureReason === "string" ? payout.failureReason.trim() : "";
  return {
    statusLabel: known?.label ?? sentenceCase(payout.status),
    tone: known?.tone ?? "secondary",
    icon: known?.icon ?? "waiting",
    canCancel: payout.cancellable === true,
    note: payout.status === "failed" && reason ? reason : null,
  };
}

/** What the confirm dialog says before a payout is cancelled. */
export function cancelPayoutDescription(amountCents: number): string {
  return `The ${formatCents(amountCents)} goes back to your earnings.`;
}

export function payoutCancelledMessage(amountCents: number): string {
  return `Payout cancelled. ${formatCents(amountCents)} is back in your earnings.`;
}

// ---- The request button ----

export interface PayoutRequestView {
  /** The button is drawn at all: only while payouts are known to be running. */
  offered: boolean;
  /** The button can be pressed. */
  enabled: boolean;
  buttonLabel: string;
  /** The line beside it: the amount, the minimum, or why there is no button. */
  line: string;
}

/**
 * `payoutsAvailable` is capabilities.payouts.available, or null when the capabilities could not
 * be read. Not known to be running means no button: a request would be refused.
 */
export function payoutRequest(input: {
  payoutsAvailable: boolean | null | undefined;
  availableCents: number;
  hasPendingPayout: boolean;
}): PayoutRequestView {
  if (input.payoutsAvailable !== true) {
    return {
      offered: false,
      enabled: false,
      buttonLabel: "Request Payout",
      line: input.payoutsAvailable === false ? EARNINGS_WORDS.payoutsOff : EARNINGS_WORDS.payoutsUnknown,
    };
  }
  const enough = Number.isFinite(input.availableCents) && input.availableCents >= MIN_PAYOUT_CENTS;
  return {
    offered: true,
    enabled: enough && !input.hasPendingPayout,
    buttonLabel: input.hasPendingPayout ? "Payout Pending" : "Request Payout",
    line: enough
      ? `You have ${formatCents(input.availableCents)} available for withdrawal`
      : EARNINGS_WORDS.minimum,
  };
}

// ---- A row of earnings ----

export interface RevenueRowView {
  label: string;
  /** The row is a job's: the label links to it. */
  jobId: string | null;
  /** What the model cost on this row, in cents; null when the row carries none. */
  modelCostCents: number | null;
}

const REVENUE_TYPE_LABELS: Record<string, string> = {
  // A request charged on a copy, unless the row's licence says it was a use
  // of the creator's own agent (revenueRow).
  per_request: EARNINGS_WORDS.perRequestOnCopy,
  subscription: "Subscription",
  subscription_renewal: "Subscription renewal",
  job: "Job",
};

export function revenueRow(tx: {
  type: string;
  jobId?: string | null;
  modelCostCents?: number | null;
  /** What the row's licence is for; absent or null when the API does not say. */
  licenceKind?: "use" | "copy" | null;
}): RevenueRowView {
  // "Paid use" only when the API says the row's licence is for use of the
  // creator's own agent. A request charged on a buyer's copy, and a row that
  // does not say, keep the name they had.
  const paidUse = tx.type === "per_request" && tx.licenceKind === "use";
  const known = paidUse
    ? EARNINGS_WORDS.paidUse
    : Object.prototype.hasOwnProperty.call(REVENUE_TYPE_LABELS, tx.type)
      ? REVENUE_TYPE_LABELS[tx.type]
      : undefined;
  const cost = tx.modelCostCents;
  return {
    label: tx.jobId ? "Job" : (known ?? sentenceCase(tx.type)),
    jobId: tx.jobId ?? null,
    modelCostCents: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
  };
}
