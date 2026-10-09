"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle, Copy, SearchX, Star, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { EscrowBadge } from "@/components/marketplace/escrow-badge";
import { JobStatusTimeline } from "@/components/marketplace/job-status-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Label } from "@/components/ui/label";
import { ResultView } from "@/components/ui/result-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiErrorCode, getErrorMessage, jobsApi, type Job } from "@/lib/api";
import { JOB_STATUS, PRODUCT_KIND_LABEL, formatCents, isFinished } from "@/lib/jobs";
import { JOBS_TAB_PARAM, JOBS_TAB_RECEIVED } from "@/lib/nav";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Placeholder shaped like the two-column job page. */
function JobSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3" aria-busy="true">
      <span className="sr-only">Loading job</span>
      <div className="space-y-6 lg:col-span-2">
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
      <div className="space-y-6">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </div>
  );
}

function StarPicker({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Rating" className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
          disabled={disabled}
          // Clicking the chosen star again clears the rating.
          onClick={() => onChange(value === star ? 0 : star)}
          className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Star className={`h-6 w-6 ${star <= value ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"}`} />
        </button>
      ))}
    </div>
  );
}

/** Why an action on a job was refused, in the reader's terms. */
function refusalMessage(error: unknown, fallback: string): string {
  const code = apiErrorCode(error);
  if (code === "insufficient_role") return "Only an owner or admin of your organization can do this: it moves money.";
  if (code === "review_window_closed") return "The review window has closed, so this job was accepted automatically.";
  if (code === "job_already_started") return "This job has already started, so it can no longer be cancelled.";
  if (code === "settlement_unavailable") return "The payment could not be released right now. The escrow is still held; try again shortly.";
  return getErrorMessage(error, fallback);
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirmAction = useConfirm();
  const [job, setJob] = useState<Job | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsLoading(true);
      try {
        const res = await jobsApi.get(id);
        setJob(res.job);
        setLoadError(null);
      } catch (error) {
        if (!quiet) setLoadError(error);
      } finally {
        if (!quiet) setIsLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  // A job you received belongs under Listings. A link without ?tab=received
  // (an email, a notification) gets it added so the menu marks the right item.
  const received = job !== null && job.role !== "buyer";
  useEffect(() => {
    if (!received) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(JOBS_TAB_PARAM) === JOBS_TAB_RECEIVED) return;
    params.set(JOBS_TAB_PARAM, JOBS_TAB_RECEIVED);
    router.replace(`/dashboard/jobs/${id}?${params.toString()}`, { scroll: false });
  }, [received, id, router]);

  // A queued or running job moves by itself; keep the page current.
  const moving = job?.status === "funded" || job?.status === "running";
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [moving, load]);

  /** Runs one action; a refusal is shown and the job re-read, since a 409 means it moved. */
  async function act(run: () => Promise<{ job: Job }>, done: string, fallback: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await run();
      setJob(res.job);
      toast.success(done);
      return true;
    } catch (error) {
      toast.error(refusalMessage(error, fallback));
      if (error instanceof ApiError && error.status === 409) void load(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!job) return;
    const ok = await confirmAction({
      title: `Accept this result and release ${formatCents(job.priceCents)}?`,
      description: "The payment leaves escrow and goes to the publisher. This cannot be undone.",
      confirmLabel: "Accept and release payment",
    });
    if (!ok) return;
    await act(
      () => jobsApi.accept(job.id, { ...(rating > 0 && { rating }), ...(review.trim() && { review: review.trim() }) }),
      "Accepted. The publisher has been paid.",
      "The job could not be accepted",
    );
  }

  async function reject() {
    if (!job) return;
    const done = await act(
      () => jobsApi.reject(job.id, reason.trim()),
      `Rejected. ${formatCents(job.priceCents)} is back in your credits.`,
      "The job could not be rejected",
    );
    if (done) {
      setRejecting(false);
      setReason("");
    }
  }

  async function cancel() {
    if (!job) return;
    const ok = await confirmAction({
      title: "Cancel this job?",
      description: `It has not started yet. ${formatCents(job.priceCents)} goes back to your credits in full.`,
      confirmLabel: "Cancel job and refund",
      cancelLabel: "Keep it",
      destructive: true,
    });
    if (!ok) return;
    await act(() => jobsApi.cancel(job.id), "Cancelled and refunded.", "The job could not be cancelled");
  }

  async function rate() {
    if (!job || rating === 0) return;
    await act(() => jobsApi.rate(job.id, rating, review.trim() || undefined), "Thanks. Your rating is recorded.", "The rating could not be saved");
  }

  const missing = loadError instanceof ApiError && (loadError.status === 404 || loadError.status === 400);
  const isBuyer = job?.role === "buyer";
  const checks = job ? (job.role === "buyer" ? job.checks.map((c) => ({ ...c, details: "" })) : job.checkResults) : [];

  return (
    <div className="flex flex-col">
      <Header
        title={job ? job.offering.title : "Job"}
        description={
          job
            ? isBuyer
              ? "A job you hired"
              : `A job ${job.role === "publisher" ? job.buyer.name : "a buyer"} hired from your offering`
            : undefined
        }
        action={{ label: "All jobs", href: isBuyer || !job ? "/dashboard/jobs" : "/dashboard/jobs?tab=received" }}
      />

      <div className="p-8">
        {isLoading ? (
          <JobSkeleton />
        ) : missing ? (
          <EmptyState
            icon={SearchX}
            title="Job not found"
            description="It does not exist, or it is neither bought nor sold by this organization."
            actionLabel="Back to jobs"
            actionHref="/dashboard/jobs"
          />
        ) : loadError !== null || !job ? (
          <ErrorState title="Couldn't load this job" error={loadError} onRetry={() => void load()} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6 lg:col-span-2">
              {/* Buyer: what to do with a delivered result */}
              {isBuyer && job.status === "submitted" && (
                <Card className="border-primary/40">
                  <CardHeader>
                    <CardTitle className="text-base">Your result is ready. Review it.</CardTitle>
                    <CardDescription>
                      Accept it to pay the publisher, or reject it for a full refund.
                      {job.reviewDeadlineAt &&
                        ` If you do neither by ${formatWhen(job.reviewDeadlineAt)}, it is accepted for you.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-sm font-medium text-foreground">Rate it (optional)</p>
                      <StarPicker value={rating} onChange={setRating} disabled={busy} />
                    </div>
                    <div>
                      <Label htmlFor="job-review">A note for the publisher&apos;s track record (optional)</Label>
                      <Textarea
                        id="job-review"
                        className="mt-1"
                        rows={2}
                        maxLength={2000}
                        value={review}
                        onChange={(e) => setReview(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button onClick={accept} isLoading={busy}>
                        Accept and release {formatCents(job.priceCents)}
                      </Button>
                      <Button variant="outline" onClick={() => setRejecting(true)} disabled={busy}>
                        Reject and refund
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {isBuyer && job.status === "funded" && (
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <p className="text-sm text-muted-foreground">
                      This job is queued and has not started. You can still cancel it for a full refund.
                    </p>
                    <Button variant="outline" onClick={cancel} isLoading={busy}>
                      Cancel job
                    </Button>
                  </CardContent>
                </Card>
              )}

              {isBuyer && job.status === "completed" && job.rating === null && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Rate this job</CardTitle>
                    <CardDescription>Once, within 30 days of completion. It counts toward the publisher&apos;s rating.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <StarPicker value={rating} onChange={setRating} disabled={busy} />
                    <Label htmlFor="job-rate-review" className="sr-only">
                      Review
                    </Label>
                    <Textarea
                      id="job-rate-review"
                      rows={2}
                      maxLength={2000}
                      value={review}
                      onChange={(e) => setReview(e.target.value)}
                      placeholder="What was good or missing (optional)"
                      disabled={busy}
                    />
                    <Button onClick={rate} disabled={rating === 0} isLoading={busy}>
                      Submit rating
                    </Button>
                  </CardContent>
                </Card>
              )}

              {(job.failureReason || job.rejectionReason) && (
                <Card>
                  <CardContent className="py-4 text-sm">
                    <p className="font-medium text-foreground">
                      {job.status === "rejected" ? "The buyer's reason for rejecting" : "What happened"}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-muted-foreground">
                      {job.rejectionReason ?? job.failureReason}
                    </p>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Deliverable</CardTitle>
                  {job.output && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(job.output!.text);
                        toast.success("Copied to clipboard");
                      }}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                  )}
                </CardHeader>
                <CardContent>
                  {job.output ? (
                    <ResultView
                      className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-foreground"
                      text={
                        job.output.format === "json" && job.output.value !== undefined
                          ? JSON.stringify(job.output.value, null, 2)
                          : job.output.text
                      }
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {moving
                        ? "Nothing yet. The result appears here as soon as it passes the publisher's checks."
                        : isBuyer
                          ? "Nothing was delivered for this job, and you were refunded."
                          : "This job produced no deliverable."}
                    </p>
                  )}
                </CardContent>
              </Card>

              {checks.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Checks</CardTitle>
                    <CardDescription>
                      {isBuyer
                        ? "What the result was checked against before it could be delivered to you."
                        : "How the deliverable was graded. The details are shown only to you."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm">
                      {checks.map((check, index) => (
                        <li key={index} className="flex gap-2">
                          {check.passed ? (
                            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
                          ) : (
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
                          )}
                          <span className="min-w-0">
                            <span className="text-foreground">{check.label || check.type}</span>
                            {check.details && (
                              <span className="block text-xs text-muted-foreground">{check.details}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{isBuyer ? "What you sent" : "What the buyer sent"}</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs text-foreground">
                    {JSON.stringify(job.input, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={JOB_STATUS[job.status].tone}>{JOB_STATUS[job.status].label}</Badge>
                    {job.escrow && <EscrowBadge state={job.escrow.status} amountCents={job.escrow.amountCents} />}
                  </div>
                  <JobStatusTimeline job={job} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Money</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{isBuyer ? "You paid" : "The buyer paid"}</dt>
                      <dd className="font-medium text-foreground">{formatCents(job.priceCents)}</dd>
                    </div>
                    {job.role === "publisher" && job.platformFeeCents !== null && job.creatorAmountCents !== null && (
                      <>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Platform fee{job.modelCostCents > 0 ? " and model cost" : ""}
                          </dt>
                          <dd className="text-foreground">-{formatCents(job.platformFeeCents)}</dd>
                        </div>
                        {job.modelCostCents > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Includes {formatCents(job.modelCostCents)} for this job&apos;s use of the platform&apos;s
                            model keys.
                          </p>
                        )}
                        <div className="flex justify-between gap-4 border-t pt-2">
                          <dt className="text-muted-foreground">
                            {job.escrow?.status === "released"
                              ? "You earned"
                              : job.escrow?.status === "refunded"
                                ? "You would have earned"
                                : "You earn on acceptance"}
                          </dt>
                          <dd
                            className={`font-semibold ${job.escrow?.status === "refunded" ? "text-muted-foreground line-through" : "text-foreground"}`}
                          >
                            {formatCents(job.creatorAmountCents)}
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {job.escrow?.status === "held"
                      ? isBuyer
                        ? "Held in escrow. The publisher is paid only when you accept, or when the review window closes."
                        : "Held in escrow. It becomes yours when the buyer accepts, or when the review window closes."
                      : job.escrow?.status === "released"
                        ? isBuyer
                          ? "Released to the publisher."
                          : "Released to you. It is in your payout balance."
                        : isBuyer
                          ? "Refunded to your credits in full."
                          : "Refunded to the buyer. Nothing was earned or charged."}
                  </p>
                  {job.role === "publisher" && job.escrow?.status === "released" && (
                    <Link
                      href="/dashboard/marketplace/revenue"
                      className="mt-2 inline-block text-xs font-medium text-primary underline underline-offset-2"
                    >
                      Earnings
                    </Link>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Offering</dt>
                      <dd className="min-w-0 truncate text-right">
                        <Link
                          href={
                            isBuyer
                              ? `/marketplace/offerings/${job.offering.slug}`
                              : `/dashboard/marketplace/offerings/${job.offering.id}`
                          }
                          className="font-medium text-primary underline underline-offset-2"
                        >
                          {job.offering.title}
                        </Link>
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Runs on</dt>
                      <dd className="text-foreground">{PRODUCT_KIND_LABEL[job.offering.productKind]}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Hired</dt>
                      <dd className="text-foreground">{formatWhen(job.createdAt)}</dd>
                    </div>
                    {job.role === "publisher" && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Buyer</dt>
                        <dd className="text-foreground">{job.buyer.name}</dd>
                      </div>
                    )}
                    {job.rating !== null && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Rating</dt>
                        <dd className="text-foreground">{job.rating} of 5</dd>
                      </div>
                    )}
                    {isFinished(job.status) && job.review && (
                      <div>
                        <dt className="text-muted-foreground">Review</dt>
                        <dd className="mt-1 whitespace-pre-line text-foreground">{job.review}</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Job ID</dt>
                      <dd className="truncate font-mono text-xs text-muted-foreground">{job.id}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>

      <Dialog open={rejecting} onOpenChange={(open) => !busy && setRejecting(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this result?</DialogTitle>
            <DialogDescription>
              {job ? `${formatCents(job.priceCents)} is refunded to your credits in full. ` : ""}
              Your reason is shown to the publisher, and the rejection counts against their record.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="reject-reason">What was wrong with it?</Label>
            <Textarea
              id="reject-reason"
              className="mt-1"
              rows={4}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. It ignores the audience I asked for."
              disabled={busy}
            />
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button variant="outline" onClick={() => setRejecting(false)} disabled={busy}>
              Keep reviewing
            </Button>
            <Button variant="destructive" onClick={reject} disabled={reason.trim().length < 3} isLoading={busy}>
              Reject and refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
