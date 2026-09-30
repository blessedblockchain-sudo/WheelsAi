"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authApi, getErrorMessage } from "@/lib/api";

type State =
  | { kind: "working" }
  | { kind: "done"; bonusCents: number }
  | { kind: "failed"; message: string };

function VerifyEmail() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>({ kind: "working" });
  const ran = useRef(false);

  useEffect(() => {
    // Tokens are single-use: never submit twice (React strict mode runs
    // effects twice in development).
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setState({ kind: "failed", message: "This link is missing its token." });
      return;
    }
    authApi
      .confirmEmail(token)
      .then((res) => setState({ kind: "done", bonusCents: res.bonusGrantedCents }))
      .catch((err) =>
        setState({ kind: "failed", message: getErrorMessage(err, "We could not verify this link.") }),
      );
  }, [token]);

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Verify your email</CardTitle>
        <CardDescription>Confirming the address on your WheelsAI account</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4 text-center">
        {state.kind === "working" && (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-label="Verifying" />
        )}
        {state.kind === "done" && (
          <>
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
            <p className="text-sm text-foreground">
              Your email is verified.
              {state.bonusCents > 0 && (
                <>
                  {" "}
                  <span className="font-mono tabular-nums font-semibold">
                    ${(state.bonusCents / 100).toFixed(2)}
                  </span>{" "}
                  in free credits was added to your account.
                </>
              )}
            </p>
            <Link href="/dashboard" className={buttonVariants()}>
              Go to your dashboard
            </Link>
          </>
        )}
        {state.kind === "failed" && (
          <>
            <XCircle className="h-10 w-10 text-danger" aria-hidden />
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-sm text-muted-foreground">
              Sign in and use <span className="text-foreground">Resend verification email</span> on your
              dashboard to get a fresh link.
            </p>
            <Link href="/login?next=/dashboard" className={buttonVariants({ variant: "outline" })}>
              Sign in
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
