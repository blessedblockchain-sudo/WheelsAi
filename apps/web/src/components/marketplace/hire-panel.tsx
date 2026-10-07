"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, Eye, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { SchemaForm } from "@/components/marketplace/schema-form";
import { useSession } from "@/hooks/use-session";
import {
  ApiError,
  apiErrorCode,
  billingApi,
  getErrorMessage,
  offeringsApi,
  schemaIssuesOf,
  type PublicOffering,
} from "@/lib/api";
import { formatCents, formatDuration, newIdempotencyKey, termsChangedMessage, termsOf } from "@/lib/jobs";
import { buildInput, initialValues, issuesByField, type FormValues } from "@/lib/schema-form";

/** What a refused hire means for the person looking at the button. */
function refusal(error: unknown): { message: string; action?: { label: string; href: string } } {
  const code = apiErrorCode(error);
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 402 || code === "insufficient_credits") {
    return {
      message: getErrorMessage(error, "You don't have enough credits for this job."),
      action: { label: "Add credits", href: "/dashboard/billing" },
    };
  }
  if (code === "insufficient_role") {
    return { message: "Only an owner or admin of your organization can hire. Ask one of them to hire this for you." };
  }
  if (code === "own_offering") {
    return {
      message: "This is your own offering. Use its test run instead.",
      action: { label: "My offerings", href: "/dashboard/marketplace/offerings" },
    };
  }
  if (code === "jobs_not_configured") {
    return { message: "Hiring is temporarily unavailable. Nothing was charged. Try again later." };
  }
  return { message: getErrorMessage(error, "The offering could not be hired. Nothing was charged.") };
}

/**
 * Hire an offering: the input form drawn from its schema, what it costs,
 * what escrow means, and one confirmation before any money moves.
 *
 * The hire carries the terms this panel is showing. If the publisher edited
 * the offering in the meantime the server refuses it; the panel says what
 * changed and asks the page for the offering as it is now (`onTermsChanged`),
 * so the next confirmation is for the real price.
 */
export function HirePanel({ offering, onTermsChanged }: { offering: PublicOffering; onTermsChanged?: () => void }) {
  const router = useRouter();
  const { authed, loading: sessionLoading } = useSession();
  const [values, setValues] = useState<FormValues>(() => initialValues(offering.inputSchema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<ReturnType<typeof refusal> | null>(null);
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [input, setInput] = useState<Record<string, unknown>>({});
  // One key per attempt the buyer confirms: a double click, or a retry
  // after a dropped response, is the same job and is charged once.
  const attemptKey = useRef<string>(newIdempotencyKey());

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    billingApi
      .getBalance()
      .then(({ balance }) => {
        if (!cancelled) setBalanceCents(Math.round(balance.available * 100));
      })
      .catch(() => {
        // The balance is a courtesy; the hire itself reports a shortfall.
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  function review() {
    const built = buildInput(offering.inputSchema, values);
    setErrors(built.errors);
    setNotice(null);
    if (Object.keys(built.errors).length > 0) return;
    setInput(built.input);
    setConfirming(true);
  }

  async function hire() {
    try {
      const { job } = await offeringsApi.hire(offering.id, input, attemptKey.current, termsOf(offering));
      toast.success(`${formatCents(offering.priceCents)} is in escrow. The job is on its way.`);
      router.push(`/dashboard/jobs/${job.id}`);
    } catch (error) {
      // Nothing was charged: the next attempt is a new one.
      attemptKey.current = newIdempotencyKey();
      setConfirming(false);
      if (apiErrorCode(error) === "offering_terms_changed") {
        setNotice({ message: termsChangedMessage(termsOf(offering), error instanceof ApiError ? error.data : null) });
        onTermsChanged?.();
        return;
      }
      const issues = schemaIssuesOf(error);
      if (issues.length > 0) {
        setErrors(issuesByField(offering.inputSchema, issues));
        setNotice({ message: "The publisher's input rules refused this. Nothing was charged." });
        return;
      }
      setNotice(refusal(error));
    }
  }

  const short = balanceCents !== null && balanceCents < offering.priceCents;

  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-semibold text-foreground">Hire this offering</h2>
        <p className="text-2xl font-bold text-foreground">{formatCents(offering.priceCents)}</p>
      </div>

      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
        <li className="flex gap-2">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            The price is taken from your credits and <strong className="text-foreground">held in escrow</strong>. The
            publisher is paid only when you accept the result.
          </span>
        </li>
        <li className="flex gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            Delivered within <strong className="text-foreground">{formatDuration(offering.slaSeconds)}</strong>. If it
            is not, the job expires and you are refunded in full.
          </span>
        </li>
        <li className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            You have <strong className="text-foreground">{offering.reviewWindowHours} hours</strong> to accept or reject
            the result. If you do nothing, it is accepted when that time is up.
          </span>
        </li>
        <li className="flex gap-2">
          <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            Refunded in full if you reject it, if it fails the publisher&apos;s checks, or if you cancel before it
            starts.
          </span>
        </li>
        <li className="flex gap-2">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            {offering.publisher.name} runs this on their own {offering.productKind} and{" "}
            <strong className="text-foreground">sees what you send</strong>. Don&apos;t include secrets.
          </span>
        </li>
      </ul>

      {offering.sampleInputs.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Start from an example:</span>
          {offering.sampleInputs.map((sample, index) => (
            <Button
              key={index}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setValues(initialValues(offering.inputSchema, sample));
                setErrors({});
              }}
            >
              Use sample{offering.sampleInputs.length > 1 ? ` ${index + 1}` : ""}
            </Button>
          ))}
        </div>
      )}

      <form
        className="mt-5 space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
      >
        <SchemaForm
          schema={offering.inputSchema}
          values={values}
          onChange={setValues}
          errors={errors}
          idPrefix={`hire-${offering.slug}`}
        />

        {notice && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {notice.message}
            {notice.action && (
              <>
                {" "}
                <Link href={notice.action.href} className="font-medium underline underline-offset-2">
                  {notice.action.label}
                </Link>
              </>
            )}
          </div>
        )}

        {sessionLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : authed ? (
          <div className="space-y-2">
            <Button type="submit" className="w-full">
              Review and hire for {formatCents(offering.priceCents)}
            </Button>
            {balanceCents !== null && (
              <p className="text-center text-xs text-muted-foreground">
                Your balance: {formatCents(balanceCents)}
                {short && (
                  <>
                    {" · "}
                    <Link href="/dashboard/billing" className="font-medium text-primary underline underline-offset-2">
                      Add credits
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Link
              href={`/login?next=${encodeURIComponent(`/marketplace/offerings/${offering.slug}`)}`}
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign in to hire
            </Link>
            <p className="text-center text-xs text-muted-foreground">
              New here?{" "}
              <Link href="/register" className="font-medium text-primary underline underline-offset-2">
                Create an account
              </Link>
            </p>
          </div>
        )}
      </form>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Hire "${offering.title}" for ${formatCents(offering.priceCents)}?`}
        description={`${formatCents(offering.priceCents)} leaves your credits now and is held in escrow. ${offering.publisher.name} is paid when you accept the result, or ${offering.reviewWindowHours} hours after it is delivered if you do nothing. You are refunded if it is late, fails its checks, or you reject it.`}
        confirmLabel={`Pay ${formatCents(offering.priceCents)} into escrow`}
        onConfirm={hire}
      />
    </div>
  );
}
