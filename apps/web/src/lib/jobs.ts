/**
 * How offerings and jobs are worded and ordered on every page that shows
 * them: money, delivery time, a job's status and the steps it has been
 * through. Pure, so the hire panel, the job pages and the publisher's
 * inbox cannot drift apart.
 */

import type { EscrowState, Job, JobStatus, OfferingProductKind, OfferingStatus, OfferingTerms } from "./api";

export const JOB_MIN_PRICE_CENTS = 50;
export const JOB_MAX_PRICE_CENTS = 100_000;
export const JOB_MIN_SLA_SECONDS = 300;
export const JOB_MAX_SLA_SECONDS = 604_800;

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "5 minutes", "1 hour 30 minutes", "2 days": at most two units. */
export function formatDuration(seconds: number): string {
  const units: Array<[number, string]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(seconds));
  for (const [size, name] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      rest -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

export const PRODUCT_KIND_LABEL: Record<OfferingProductKind, string> = {
  agent: "Agent",
  workflow: "Workflow",
  model: "Model",
};

type Tone = "default" | "secondary" | "success" | "warning" | "destructive";

export const OFFERING_STATUS: Record<OfferingStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "secondary" },
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  archived: { label: "Archived", tone: "secondary" },
};

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  funded: { label: "Queued", tone: "default" },
  running: { label: "Running", tone: "default" },
  submitted: { label: "Ready for review", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  rejected: { label: "Rejected", tone: "destructive" },
  failed: { label: "Failed", tone: "destructive" },
  expired: { label: "Expired", tone: "destructive" },
  cancelled: { label: "Cancelled", tone: "secondary" },
};

export const ESCROW: Record<EscrowState, { label: string; tone: Tone }> = {
  held: { label: "Held in escrow", tone: "warning" },
  released: { label: "Released to publisher", tone: "success" },
  refunded: { label: "Refunded to buyer", tone: "secondary" },
};

/** A job nobody can act on any more. */
export function isFinished(status: JobStatus): boolean {
  return status !== "funded" && status !== "running" && status !== "submitted";
}

export interface TimelineStep {
  key: "funded" | "running" | "submitted" | "ended";
  label: string;
  /** done = it happened; current = it is happening; pending = not yet; failed = it ended here, refunded. */
  state: "done" | "current" | "pending" | "failed";
  at: string | null;
  /** A time still ahead that matters at this step, and what it means. */
  until?: { label: string; at: string };
}

const REFUND_LABEL: Partial<Record<JobStatus, string>> = {
  rejected: "Rejected, refunded",
  failed: "Failed, refunded",
  expired: "Expired, refunded",
  cancelled: "Cancelled, refunded",
};

/**
 * The four steps of a job as it stands: paid into escrow, the product
 * running, the deliverable submitted, and how it ended. A job that was
 * refunded ends at the step it had reached; later steps never happened
 * and are not shown as pending.
 */
export function jobTimeline(
  job: Pick<
    Job,
    "status" | "fundedAt" | "startedAt" | "submittedAt" | "completedAt" | "deadlineAt" | "reviewDeadlineAt"
  >,
): TimelineStep[] {
  const { status } = job;
  const steps: TimelineStep[] = [
    { key: "funded", label: "Paid into escrow", state: "done", at: job.fundedAt },
  ];
  const started = job.startedAt !== null;
  const submitted = job.submittedAt !== null;
  const refund = REFUND_LABEL[status];

  if (started || status === "funded") {
    steps.push({
      key: "running",
      label: "Product running",
      state: status === "running" ? "current" : started ? "done" : "pending",
      at: job.startedAt,
      ...((status === "funded" || status === "running") && job.deadlineAt && { until: { label: "Due by", at: job.deadlineAt } }),
    });
  }
  if (submitted || status === "funded" || status === "running") {
    steps.push({
      key: "submitted",
      label: "Deliverable submitted",
      state: status === "submitted" ? "current" : submitted ? "done" : "pending",
      at: job.submittedAt,
      ...(status === "submitted" &&
        job.reviewDeadlineAt && { until: { label: "Completes by itself on", at: job.reviewDeadlineAt } }),
    });
  }
  if (refund) {
    steps.push({ key: "ended", label: refund, state: "failed", at: job.completedAt });
  } else {
    steps.push({
      key: "ended",
      label: status === "completed" ? "Completed, publisher paid" : "Accepted and paid",
      state: status === "completed" ? "done" : "pending",
      at: status === "completed" ? job.completedAt : null,
    });
  }
  return steps;
}

/** The terms of an offering as it is on screen: what a hire says it agreed to. */
export function termsOf(offering: OfferingTerms): OfferingTerms {
  return { priceCents: offering.priceCents, slaSeconds: offering.slaSeconds, termsVersion: offering.termsVersion };
}

/**
 * What to tell a buyer whose hire was refused because the publisher edited
 * the offering after they opened it (409 offering_terms_changed). `data` is
 * the response body; anything missing from it is left out, never guessed.
 */
export function termsChangedMessage(shown: OfferingTerms, data: unknown): string {
  const current = (data as { current?: Partial<OfferingTerms> } | null)?.current ?? {};
  const parts: string[] = [];
  if (typeof current.priceCents === "number" && current.priceCents !== shown.priceCents) {
    parts.push(`The price changed from ${formatCents(shown.priceCents)} to ${formatCents(current.priceCents)}.`);
  }
  if (typeof current.slaSeconds === "number" && current.slaSeconds !== shown.slaSeconds) {
    parts.push(
      `The delivery time changed from ${formatDuration(shown.slaSeconds)} to ${formatDuration(current.slaSeconds)}.`,
    );
  }
  if (parts.length === 0) {
    parts.push("The publisher changed what this offering promises, what it asks for or how the result is checked.");
  }
  return `This offering changed after you opened it, so nothing was charged. ${parts.join(" ")} Review it as it is now, then hire again if it still suits you.`;
}

/** A key for one hire attempt: a double click or a retry is then the same job. */
export function newIdempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-${random}`;
}

// ---- API key scopes (mirrors apps/api/src/config/apiKeyScopes.ts) ----

export interface ScopeOption {
  scope: string;
  label: string;
  description: string;
}

export const ORDINARY_SCOPES: ScopeOption[] = [
  { scope: "agents:invoke", label: "Call agents", description: "Chat with your agents through /v1." },
  { scope: "workflows:invoke", label: "Run workflows", description: "Run your workflows through /v1." },
  { scope: "offerings:write", label: "Manage offerings", description: "Create, edit, publish and test-run offerings." },
  { scope: "jobs:read", label: "Read jobs", description: "List jobs and read their deliverables." },
];

export const SPEND_SCOPES: ScopeOption[] = [
  { scope: "jobs:hire", label: "Hire offerings", description: "Pay for jobs from your credits, inside the caps below." },
  { scope: "jobs:review", label: "Accept and reject", description: "Release a job's escrow to the publisher, or take the refund." },
  { scope: "marketplace:install", label: "Install agents", description: "Install marketplace agents; a monthly one charges at install." },
];

export const MAX_JOB_PRICE_CAP_CENTS = 100_000;
export const MAX_DAILY_SPEND_CAP_CENTS = 10_000_000;

/** What a stored key can do, in words. A key never spends unless a spend scope is listed by name. */
export function describeKeyAccess(scopes: string[] | undefined): { summary: string; spends: string[] } {
  const granted = scopes ?? [];
  const spends = SPEND_SCOPES.filter((option) => granted.includes(option.scope)).map((option) => option.scope);
  const everything = granted.length === 0 || granted.includes("*");
  return { summary: everything ? "All except spending" : "Limited", spends };
}

/** "12.50" -> 1250. null when it is not an amount of whole cents. */
export function dollarsToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/** Why a new key's choices cannot be sent, or null. The server checks the same rules again. */
export function keyGrantProblem(grant: {
  scopes: string[];
  maxJobPrice: string;
  dailySpendCap: string;
}): string | null {
  if (!grant.scopes.includes("jobs:hire")) return null;
  const perJob = dollarsToCents(grant.maxJobPrice);
  const perDay = dollarsToCents(grant.dailySpendCap);
  if (perJob === null || perDay === null) return "A key that can hire needs both spend caps, as dollar amounts.";
  if (perJob < 1 || perJob > MAX_JOB_PRICE_CAP_CENTS) {
    return `The most one job may cost must be between $0.01 and ${formatCents(MAX_JOB_PRICE_CAP_CENTS)}.`;
  }
  if (perDay < 1 || perDay > MAX_DAILY_SPEND_CAP_CENTS) {
    return `The daily cap must be between $0.01 and ${formatCents(MAX_DAILY_SPEND_CAP_CENTS)}.`;
  }
  if (perJob > perDay) return "The most one job may cost cannot be more than the daily cap.";
  return null;
}

// ---- Deliverable checks ----

/** One check, as a sentence a buyer can read. A check's own label wins. */
export function describeCheck(check: {
  type: string;
  label?: string;
  value?: string | number;
  pattern?: string;
}): string {
  if (check.label && check.label.trim()) return check.label;
  switch (check.type) {
    case "contains":
      return `Contains "${check.value}"`;
    case "not_contains":
      return `Does not contain "${check.value}"`;
    case "exact":
      return "Matches an exact expected text";
    case "regex":
      return `Matches the pattern ${check.pattern}`;
    case "json_schema":
      return "Is JSON in the promised shape";
    case "min_length":
      return `Is at least ${check.value} characters long`;
    case "max_length":
      return `Is at most ${check.value} characters long`;
    case "confidentiality":
      return "Does not repeat the publisher's private instructions";
    default:
      return check.type;
  }
}
