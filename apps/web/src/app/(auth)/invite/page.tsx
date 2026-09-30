"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Users, XCircle } from "lucide-react";
import { toast } from "sonner";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, authApi, enterpriseApi, getErrorMessage } from "@/lib/api";

function AcceptInvite() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setError("This invite link is missing its token.");
      return;
    }
    (async () => {
      try {
        await authApi.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          const here = `/invite?token=${encodeURIComponent(token)}`;
          router.replace(`/login?next=${encodeURIComponent(here)}`);
          return;
        }
        setError(getErrorMessage(err, "Could not check your session."));
        return;
      }
      try {
        const res = await enterpriseApi.acceptInvite(token);
        await authApi.switchOrg(res.data.orgId);
        toast.success(`You joined the team as ${res.data.role}.`);
        window.location.assign("/dashboard");
      } catch (err) {
        setError(getErrorMessage(err, "This invite could not be accepted."));
      }
    })();
  }, [token, router]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <XCircle className="h-10 w-10 text-danger" aria-hidden />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
          Go to your dashboard
        </Link>
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-label="Joining team" />
    </div>
  );
}

export default function InvitePage() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <Users className="mx-auto mb-2 h-8 w-8 text-primary" aria-hidden />
        <CardTitle className="text-2xl">Join a team</CardTitle>
        <CardDescription>Accepting your invitation</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={null}>
          <AcceptInvite />
        </Suspense>
      </CardContent>
    </Card>
  );
}
