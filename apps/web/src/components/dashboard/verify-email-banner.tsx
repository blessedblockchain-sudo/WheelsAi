"use client";

import { useEffect, useState } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authApi, getErrorMessage } from "@/lib/api";

/**
 * Shown to signed-in users whose email is not verified yet. Verifying is
 * what adds the $5 signup credits, so the banner says so and offers to
 * resend the link.
 */
export function VerifyEmailBanner() {
  const [email, setEmail] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then(({ user }) => {
        if (!cancelled && user.email && user.emailVerified === false) setEmail(user.email);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!email) return null;

  async function resend() {
    setSending(true);
    try {
      const res = await authApi.requestEmailVerification();
      if (res.alreadyVerified) {
        setEmail(null);
        return;
      }
      setSent(true);
      toast.success(`Verification link sent to ${email}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not send the verification email"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-3 border-b border-border bg-primary/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-8"
    >
      <div className="flex items-start gap-3">
        <MailWarning className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <p className="text-sm text-foreground">
          Verify <span className="font-medium">{email}</span> to add your{" "}
          <span className="font-mono tabular-nums font-semibold">$5.00</span> in free credits.
          {sent && <span className="text-muted-foreground"> Check your inbox for the link.</span>}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={resend} isLoading={sending} disabled={sent}>
        {sent ? "Link sent" : "Resend verification email"}
      </Button>
    </div>
  );
}
