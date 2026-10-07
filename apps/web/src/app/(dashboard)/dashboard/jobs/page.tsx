"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Briefcase, Inbox } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { EscrowBadge } from "@/components/marketplace/escrow-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getErrorMessage, jobsApi, type Job, type JobStatus, type JobSummary } from "@/lib/api";
import { JOB_STATUS, PRODUCT_KIND_LABEL, formatCents } from "@/lib/jobs";

const PAGE_SIZE = 20;
type Role = "buyer" | "publisher";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Placeholder shaped like the rows of a job list. */
function JobRowsSkeleton() {
  return (
    <div className="divide-y" aria-busy="true">
      <span className="sr-only">Loading jobs</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** What the row's reader should do next, when there is something to do. */
function nextStep(job: Job): string | null {
  if (job.role === "buyer") {
    if (job.status === "submitted" && job.reviewDeadlineAt) {
      return `Review by ${formatWhen(job.reviewDeadlineAt)}, or it is accepted for you`;
    }
    if ((job.status === "funded" || job.status === "running") && job.deadlineAt) {
      return `Due by ${formatWhen(job.deadlineAt)}`;
    }
    if (job.status === "completed" && job.rating === null) return "You can still rate this job";
    return null;
  }
  if (job.status === "submitted") return "Waiting for the buyer to accept or reject";
  if ((job.status === "funded" || job.status === "running") && job.deadlineAt) {
    return `Must be delivered by ${formatWhen(job.deadlineAt)}`;
  }
  return null;
}

function JobList({ role }: { role: Role }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<JobStatus | "">("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsLoading(true);
      try {
        const res = await jobsApi.list({ role, status: status || undefined, page, limit: PAGE_SIZE });
        setJobs(res.jobs);
        setTotal(res.pagination.total);
        setLoadError(null);
      } catch (error) {
        // A failed background refresh keeps what is on screen.
        if (!quiet) {
          setLoadError(error);
          toast.error(getErrorMessage(error, "Failed to load jobs"));
        }
      } finally {
        if (!quiet) setIsLoading(false);
      }
    },
    [role, status, page],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Jobs move by themselves (a worker runs them, a deadline passes).
  const moving = jobs.some((job) => job.status === "funded" || job.status === "running");
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void load(true), 4000);
    return () => clearInterval(timer);
  }, [moving, load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {isLoading ? <Skeleton className="h-4 w-20" /> : `${total} ${total === 1 ? "job" : "jobs"}`}
          </div>
          <div className="w-52">
            <Select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as JobStatus | "");
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {(Object.keys(JOB_STATUS) as JobStatus[]).map((key) => (
                <option key={key} value={key}>
                  {JOB_STATUS[key].label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {isLoading ? (
          <JobRowsSkeleton />
        ) : loadError !== null ? (
          <ErrorState title="Couldn't load jobs" error={loadError} onRetry={() => void load()} />
        ) : jobs.length === 0 && status ? (
          <EmptyState
            icon={Inbox}
            title={`No ${JOB_STATUS[status].label.toLowerCase()} jobs`}
            description="No job has this status right now."
            actionLabel="Show all statuses"
            onAction={() => setStatus("")}
          />
        ) : jobs.length === 0 ? (
          role === "buyer" ? (
            <EmptyState
              icon={Briefcase}
              title="You haven't hired anything yet"
              description="Hire an agent, a workflow or a model for one task at a fixed price. Your payment stays in escrow until you accept the result."
              actionLabel="Browse offerings"
              actionHref="/marketplace?view=tasks"
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No jobs received yet"
              description="When someone hires one of your offerings, the job appears here with its input, its deliverable and what you earn."
              actionLabel="Your offerings"
              actionHref="/dashboard/marketplace/offerings"
            />
          )
        ) : (
          <ul className="divide-y">
            {jobs.map((job) => {
              const hint = nextStep(job);
              return (
                <li key={job.id}>
                  <Link
                    href={`/dashboard/jobs/${job.id}`}
                    className="flex flex-wrap items-center justify-between gap-4 py-4 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{job.offering.title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {PRODUCT_KIND_LABEL[job.offering.productKind]} · {formatCents(job.priceCents)}
                        {job.role === "publisher" ? ` · hired by ${job.buyer.name}` : ""} · {formatWhen(job.createdAt)}
                      </p>
                      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {job.escrow && <EscrowBadge state={job.escrow.status} />}
                      <Badge variant={JOB_STATUS[job.status].tone}>{JOB_STATUS[job.status].label}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {loadError === null && total > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {pages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function JobsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "received" ? "received" : "hired";
  const [summary, setSummary] = useState<JobSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    jobsApi
      .summary()
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch(() => {
        // The counts on the tabs are a convenience; each list reports its own failure.
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  return (
    <div className="p-8">
      <Tabs value={tab} onValueChange={(value) => router.replace(`/dashboard/jobs${value === "received" ? "?tab=received" : ""}`)}>
        <TabsList aria-label="Jobs">
          <TabsTrigger value="hired">
            Hired by you
            {summary !== null && summary.awaitingReview > 0 && (
              <Badge variant="warning">{summary.awaitingReview} to review</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="received">
            Received
            {summary !== null && summary.toDeliver > 0 && <Badge>{summary.toDeliver} in progress</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="hired">
          <JobList role="buyer" />
        </TabsContent>
        <TabsContent value="received">
          <JobList role="publisher" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function JobsPage() {
  return (
    <div className="flex flex-col">
      <Header
        title="Jobs"
        description="Tasks you hired, and tasks others hired from your offerings"
        action={{ label: "Browse offerings", href: "/marketplace?view=tasks" }}
      />
      <Suspense
        fallback={
          <div className="p-8">
            <Card>
              <CardContent className="pt-6">
                <JobRowsSkeleton />
              </CardContent>
            </Card>
          </div>
        }
      >
        <JobsContent />
      </Suspense>
    </div>
  );
}
