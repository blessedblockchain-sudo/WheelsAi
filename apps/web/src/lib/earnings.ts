/**
 * What the Earnings page says of a payout, of the request button and of a row of
 * earnings. Pure: the page draws what these answer and decides nothing itself.
 */

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
  /** Beside the request button when the API's answer carried no payout limits the page can read. */
  limitsUnknown: "Could not read the payout limits. Reload the page to try again.",
  /** Beside the request button when the balance is enough but no method can take a payout now. */
  noMethodNow: "No payout can be requested right now. Try again later.",
  dialogTitle: "Request Payout",
  methodLegend: "How to receive it",
  amountLabel: "Amount (USD)",
  addressLabel: "Solana wallet address",
  addressPlaceholder: "Your Solana wallet address",
  /** The API's sentence for 400 `payout_address_required`, said before the request is sent. */
  addressRequired: "Enter the wallet address to send this payout to.",
  amountUnreadable: "Enter an amount in dollars, like 25.00.",
  /** Under a wallet method that today's limit leaves no room for. */
  walletLimitReached:
    "Today's limit for payouts to a wallet is used. You can request more after midnight UTC.",
  /** When a refusal carries no sentence of the API's. */
  requestFailed: "We could not confirm that the payout was requested. Check your payout history before you try again.",
  submit: "Request payout",
  submitting: "Requesting...",
  dialogCancel: "Cancel",
} as const;

/** Whole cents as "$1,234.50". No float decides a digit. */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  const whole = Math.round(cents);
  const abs = Math.abs(whole);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = String(abs % 100).padStart(2, "0");
  return `${whole < 0 ? "-" : ""}$${dollars}.${rest}`;
}

// ---- The payout limits the API answers with the earnings ----

export type PayoutMethod = "credits" | "crypto_usdc" | "crypto_sol";

/** `payoutLimits` on GET /api/marketplace/revenue. Every amount is whole cents. */
export interface PayoutLimits {
  minimumCents: number;
  /** The most for one payout to a wallet. */
  perPayoutCents: number;
  /** The most a creator can take to a wallet in one UTC day. */
  perDayCents: number;
  usedTodayCents: number;
  /** The largest payout that would be accepted right now. */
  largestNowCents: { credits: number; wallet: number };
  /** The methods offered now. */
  methods: PayoutMethod[];
}

const PAYOUT_METHODS: readonly PayoutMethod[] = ["credits", "crypto_usdc", "crypto_sol"];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  credits: "Platform Credits",
  crypto_usdc: "USDC (Solana)",
  crypto_sol: "SOL",
};

const PAYOUT_METHOD_DESCRIPTIONS: Record<PayoutMethod, string> = {
  credits: "Added to your WheelsAI balance.",
  crypto_usdc: "Sent to your Solana wallet as USDC, usually within a few minutes.",
  crypto_sol: "Sent to your Solana wallet as SOL, at the price when it is sent.",
};

export function isWalletMethod(method: PayoutMethod): boolean {
  return method !== "credits";
}

function wholeCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The limits as the page may use them, or null when the answer does not carry them whole. Nothing
 * is filled in from a number written here: without limits the page offers no request.
 */
export function readPayoutLimits(raw: unknown): PayoutLimits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const largest = (typeof r.largestNowCents === "object" && r.largestNowCents !== null
    ? r.largestNowCents
    : {}) as Record<string, unknown>;
  const minimumCents = wholeCents(r.minimumCents);
  const perPayoutCents = wholeCents(r.perPayoutCents);
  const perDayCents = wholeCents(r.perDayCents);
  const usedTodayCents = wholeCents(r.usedTodayCents);
  const credits = wholeCents(largest.credits);
  const wallet = wholeCents(largest.wallet);
  if (
    minimumCents === null || perPayoutCents === null || perDayCents === null ||
    usedTodayCents === null || credits === null || wallet === null || !Array.isArray(r.methods)
  ) {
    return null;
  }
  const offered = r.methods as unknown[];
  return {
    minimumCents,
    perPayoutCents,
    perDayCents,
    usedTodayCents,
    largestNowCents: { credits, wallet },
    // In the page's own order, each once; a method the page does not know is not offered.
    methods: PAYOUT_METHODS.filter((m) => offered.includes(m)),
  };
}

/** The largest payout the API would accept right now by this method. */
export function largestNowCents(limits: PayoutLimits, method: PayoutMethod): number {
  return isWalletMethod(method) ? limits.largestNowCents.wallet : limits.largestNowCents.credits;
}

function methodOpen(limits: PayoutLimits, method: PayoutMethod): boolean {
  const largest = largestNowCents(limits, method);
  return largest > 0 && largest >= limits.minimumCents;
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
  /**
   * The API's sentence for the row: why a failed payout did not go through, or that a pending one
   * is waiting to be sent. Null when there is nothing to say.
   */
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
  message?: string | null;
}): PayoutRowView {
  const known = Object.prototype.hasOwnProperty.call(PAYOUT_STATUS, payout.status)
    ? PAYOUT_STATUS[payout.status]
    : undefined;
  const reason = typeof payout.failureReason === "string" ? payout.failureReason.trim() : "";
  const message = typeof payout.message === "string" ? payout.message.trim() : "";
  // A failed payout says why, a pending one may say it is waiting. Any other status says nothing.
  const note =
    payout.status === "failed" ? reason || message : payout.status === "pending" ? message : "";
  return {
    statusLabel: known?.label ?? sentenceCase(payout.status),
    tone: known?.tone ?? "secondary",
    icon: known?.icon ?? "waiting",
    canCancel: payout.cancellable === true,
    note: note || null,
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
 * be read. Not known to be running means no button: a request would be refused. `limits` is
 * readPayoutLimits of the earnings answer; the minimum is the API's and no other.
 */
export function payoutRequest(input: {
  payoutsAvailable: boolean | null | undefined;
  availableCents: number;
  hasPendingPayout: boolean;
  limits: PayoutLimits | null;
}): PayoutRequestView {
  if (input.payoutsAvailable !== true) {
    return {
      offered: false,
      enabled: false,
      buttonLabel: "Request Payout",
      line: input.payoutsAvailable === false ? EARNINGS_WORDS.payoutsOff : EARNINGS_WORDS.payoutsUnknown,
    };
  }
  const limits = input.limits;
  if (!limits) {
    return { offered: false, enabled: false, buttonLabel: "Request Payout", line: EARNINGS_WORDS.limitsUnknown };
  }
  const available = Number.isFinite(input.availableCents) ? input.availableCents : 0;
  const enough = available >= limits.minimumCents;
  const someMethod = limits.methods.some((m) => methodOpen(limits, m));
  return {
    offered: true,
    enabled: enough && someMethod && !input.hasPendingPayout,
    buttonLabel: input.hasPendingPayout ? "Payout Pending" : "Request Payout",
    line: !enough
      ? `The smallest payout is ${formatCents(limits.minimumCents)}. You have ${formatCents(available)} available.`
      : someMethod || input.hasPendingPayout
        ? `You have ${formatCents(available)} available for withdrawal`
        : EARNINGS_WORDS.noMethodNow,
  };
}

// ---- The request dialog ----

/** "41.20" or "$1,000" as whole cents; null for anything else. Digits only, no float. */
export function parseAmountCents(text: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = (m[1] ?? "").replace(/,/g, "");
  const part = m[2] ?? "";
  if (!whole && !part) return null;
  if (whole.length > 11) return null;
  return Number(whole || "0") * 100 + Number(part.padEnd(2, "0") || "0");
}

/** What the amount box starts at: the cents as plain dollars, "41.20". */
export function amountInputValue(cents: number): string {
  return formatCents(cents).replace(/[$,]/g, "");
}

export interface PayoutMethodOption {
  value: PayoutMethod;
  label: string;
  description: string;
  /** False when nothing can be requested this way right now; `description` then says why. */
  enabled: boolean;
  largestCents: number;
}

export interface PayoutDialogView {
  options: PayoutMethodOption[];
  /** The chosen method when it is offered and open, else null. */
  method: PayoutMethod | null;
  /** The address box is drawn. */
  needsAddress: boolean;
  /** Under the amount box: the minimum and the most that can be asked for now. */
  amountHelp: string;
  /** For a wallet method: the limits and what today has used. Null for credits. */
  limitsLine: string | null;
  /** What is wrong with the amount as typed; null when it can be sent. */
  amountError: string | null;
  /** The amount as whole cents; null while it cannot be sent. */
  amountCents: number | null;
  canSubmit: boolean;
  submitLabel: string;
}

/** The method the dialog opens on: the first one offered that can take a payout now. */
export function defaultPayoutMethod(limits: PayoutLimits): PayoutMethod | null {
  return limits.methods.find((m) => methodOpen(limits, m)) ?? limits.methods[0] ?? null;
}

/** What the amount box starts at for a method: the largest allowed right now. */
export function defaultAmountText(limits: PayoutLimits, method: PayoutMethod): string {
  return amountInputValue(largestNowCents(limits, method));
}

function amountProblem(
  limits: PayoutLimits,
  method: PayoutMethod,
  availableCents: number,
  cents: number | null,
): string | null {
  if (cents === null) return EARNINGS_WORDS.amountUnreadable;
  if (cents < limits.minimumCents) return `The smallest payout is ${formatCents(limits.minimumCents)}.`;
  if (cents > availableCents) {
    return `You have ${formatCents(availableCents)} available. Request that amount or less.`;
  }
  if (!isWalletMethod(method)) {
    const most = limits.largestNowCents.credits;
    return cents > most ? `The most you can request now is ${formatCents(most)}.` : null;
  }
  if (cents > limits.perPayoutCents) {
    return `The most for one payout to a wallet is ${formatCents(limits.perPayoutCents)}. Request that amount or less; the rest stays in your earnings.`;
  }
  const most = limits.largestNowCents.wallet;
  if (cents > most) {
    return `${formatCents(most)} is left of today's limit for payouts to a wallet. Request that amount or less.`;
  }
  return null;
}

export function payoutDialog(input: {
  limits: PayoutLimits;
  availableCents: number;
  method: PayoutMethod | null;
  amountText: string;
}): PayoutDialogView {
  const { limits } = input;
  const available = Number.isFinite(input.availableCents) ? input.availableCents : 0;
  const options = limits.methods.map((value): PayoutMethodOption => {
    const enabled = methodOpen(limits, value);
    const dayUsed =
      isWalletMethod(value) && limits.perDayCents - limits.usedTodayCents < limits.minimumCents;
    return {
      value,
      label: PAYOUT_METHOD_LABELS[value],
      description: enabled
        ? PAYOUT_METHOD_DESCRIPTIONS[value]
        : dayUsed && available >= limits.minimumCents
          ? EARNINGS_WORDS.walletLimitReached
          : `The smallest payout is ${formatCents(limits.minimumCents)}.`,
      enabled,
      largestCents: largestNowCents(limits, value),
    };
  });
  const chosen = options.find((o) => o.value === input.method && o.enabled) ?? null;
  const minimum = `The smallest payout is ${formatCents(limits.minimumCents)}.`;
  if (!chosen) {
    return {
      options,
      method: null,
      needsAddress: false,
      amountHelp: minimum,
      limitsLine: null,
      amountError: null,
      amountCents: null,
      canSubmit: false,
      submitLabel: EARNINGS_WORDS.submit,
    };
  }
  const wallet = isWalletMethod(chosen.value);
  const cents = parseAmountCents(input.amountText);
  const amountError = amountProblem(limits, chosen.value, available, cents);
  const ok = amountError === null && cents !== null;
  return {
    options,
    method: chosen.value,
    needsAddress: wallet,
    amountHelp: `${minimum} You can request up to ${formatCents(chosen.largestCents)} now.`,
    limitsLine: wallet
      ? `Up to ${formatCents(limits.perPayoutCents)} a payout and ${formatCents(limits.perDayCents)} a day to a wallet. Used today: ${formatCents(limits.usedTodayCents)}.`
      : null,
    // An empty box is not yet a mistake: the button waits and the help line says what to enter.
    amountError: input.amountText.trim() === "" ? null : amountError,
    amountCents: ok ? cents : null,
    canSubmit: ok,
    submitLabel: ok ? `Request ${formatCents(cents)}` : EARNINGS_WORDS.submit,
  };
}

export type PayoutField = "method" | "amount" | "address" | "form";

/** A refusal as the dialog shows it: the sentence, and the field it is about. */
export interface PayoutRefusal {
  field: PayoutField;
  message: string;
}

export interface PayoutRequestBody {
  payoutMethod: PayoutMethod;
  payoutAddress?: string;
  amountCents: number;
}

/** What pressing the button does: the body to send, or what to say and where. */
export function payoutSubmission(
  view: PayoutDialogView,
  address: string,
): { ok: true; body: PayoutRequestBody } | { ok: false; refusal: PayoutRefusal } {
  if (view.method === null || view.amountCents === null) {
    return {
      ok: false,
      refusal: { field: "amount", message: view.amountError ?? EARNINGS_WORDS.amountUnreadable },
    };
  }
  const to = address.trim();
  if (view.needsAddress && !to) {
    return { ok: false, refusal: { field: "address", message: EARNINGS_WORDS.addressRequired } };
  }
  return {
    ok: true,
    body: view.needsAddress
      ? { payoutMethod: view.method, payoutAddress: to, amountCents: view.amountCents }
      : { payoutMethod: view.method, amountCents: view.amountCents },
  };
}

const REFUSAL_FIELDS: Record<string, PayoutField> = {
  invalid_payload: "amount",
  payout_below_minimum: "amount",
  payout_above_balance: "amount",
  payout_above_limit: "amount",
  payout_method_unavailable: "method",
  payout_daily_limit: "method",
  payout_address_required: "address",
  invalid_payout_address: "address",
};

/** Refusals that change nothing the dialog shows. After any other, the earnings are read again. */
const REFUSALS_THAT_KEEP_THE_DIALOG = new Set([
  "invalid_payload",
  "payout_address_required",
  "invalid_payout_address",
  "payout_check_unavailable",
]);

export const PAYOUT_IN_PROGRESS_CODE = "payout_in_progress";

/**
 * A refusal of POST /api/marketplace/payouts as the dialog shows it. `message` is the API's
 * sentence; a refusal that carries none gets the page's own, never a code or raw text.
 */
export function payoutRefusal(code: string | null, message: string | null | undefined): PayoutRefusal & {
  reload: boolean;
} {
  const field =
    code !== null && Object.prototype.hasOwnProperty.call(REFUSAL_FIELDS, code) ? REFUSAL_FIELDS[code] : undefined;
  // The client falls back to the code when an answer has no sentence: a code is never shown.
  const text = typeof message === "string" ? message.trim() : "";
  const sentence = text === code ? "" : text;
  return {
    field: field ?? "form",
    message: sentence || EARNINGS_WORDS.requestFailed,
    reload: code === null || !REFUSALS_THAT_KEEP_THE_DIALOG.has(code),
  };
}

/** What the page says after a request went through: the API's sentence. */
export function payoutRequestedMessage(message: string | null | undefined, amountCents: number): string {
  const sentence = typeof message === "string" ? message.trim() : "";
  return sentence || `Payout of ${formatCents(amountCents)} requested.`;
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
