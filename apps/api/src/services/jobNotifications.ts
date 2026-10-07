/**
 * Telling the two sides of a job what happened to it.
 *
 *   job.funded      the publisher: a job was hired and paid into escrow
 *   job.submitted   the buyer: the deliverable is ready; review it before
 *                   the window closes, after which it completes by itself
 *   job.completed   both
 *   job.rejected    both
 *   job.failed      both
 *   job.expired     both
 *   job.cancelled   both
 *
 * Each goes out as a webhook to the organization's subscribed endpoints.
 * In the app the job itself is the notice: a submitted job sits in the
 * buyer's list with its review deadline, and GET /api/jobs/summary counts
 * the ones waiting. job.submitted is also emailed to the buyer's owner,
 * but only when an email provider is configured; when none is, nothing
 * pretends an email went out.
 *
 * A payload carries ids, status, price and deadlines. It never carries the
 * buyer's input, the deliverable, or the offering's instructions.
 *
 * A notification never fails the transition it reports: everything is
 * caught and logged.
 */

export type JobEvent =
  | "job.funded"
  | "job.submitted"
  | "job.completed"
  | "job.rejected"
  | "job.failed"
  | "job.expired"
  | "job.cancelled";

export interface JobForNotice {
  id: string;
  offeringId: string;
  buyerId: string;
  publisherId: string;
  status: string;
  priceCents: bigint;
  deadlineAt: Date | null;
  reviewDeadlineAt: Date | null;
  title: string;
}

export interface JobNotifierDeps {
  loadJob(jobId: string): Promise<JobForNotice | null>;
  sendWebhook(orgId: string, event: JobEvent, data: Record<string, unknown>, jobId: string): Promise<unknown>;
  emailConfigured(): boolean;
  /** The address of the organization's owner, or null when there is none. */
  ownerEmail(orgId: string): Promise<string | null>;
  sendEmail(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
  /** The dashboard's base URL, for the link in the email. */
  webUrl: string | null;
  onError(what: string, err: unknown): void;
}

function recipients(event: JobEvent, job: JobForNotice): string[] {
  if (event === "job.funded") return [job.publisherId];
  if (event === "job.submitted") return [job.buyerId];
  return [job.buyerId, job.publisherId];
}

export function jobEventPayload(job: JobForNotice): Record<string, unknown> {
  return {
    jobId: job.id,
    offeringId: job.offeringId,
    status: job.status,
    priceCents: Number(job.priceCents),
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    reviewDeadlineAt: job.reviewDeadlineAt?.toISOString() ?? null,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function deliverableReadyEmail(
  to: string,
  job: JobForNotice,
  webUrl: string | null,
): { to: string; subject: string; text: string; html: string } {
  const until = job.reviewDeadlineAt
    ? `${job.reviewDeadlineAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "the end of the review window";
  const link = webUrl ? `${webUrl.replace(/\/$/, "")}/dashboard/jobs/${job.id}` : null;
  const body = `The deliverable for "${job.title}" is ready. Review it and accept or reject it by ${until}. If you do neither, the job completes by itself then and the payment is released to the publisher.`;
  return {
    to,
    subject: `Deliverable ready: ${job.title}`,
    text: link ? `${body}\n\n${link}` : body,
    html: `<p>${escapeHtml(body)}</p>${link ? `<p><a href="${escapeHtml(link)}">Review the deliverable</a></p>` : ""}`,
  };
}

/** Returns the notifier. It resolves whatever happens. */
export function createJobNotifier(deps: JobNotifierDeps): (event: JobEvent, jobId: string) => Promise<void> {
  return async (event, jobId) => {
    let job: JobForNotice | null;
    try {
      job = await deps.loadJob(jobId);
    } catch (err) {
      deps.onError("load", err);
      return;
    }
    if (!job) return;
    const payload = jobEventPayload(job);
    await Promise.all(
      recipients(event, job).map((orgId) =>
        deps.sendWebhook(orgId, event, payload, job.id).catch((err: unknown) => deps.onError("webhook", err)),
      ),
    );
    if (event !== "job.submitted" || !deps.emailConfigured()) return;
    try {
      const to = await deps.ownerEmail(job.buyerId);
      if (to) await deps.sendEmail(deliverableReadyEmail(to, job, deps.webUrl));
    } catch (err) {
      deps.onError("email", err);
    }
  };
}
