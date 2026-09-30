"use client";

import Link from "next/link";
import { useSession } from "@/hooks/use-session";

/**
 * Right side of the public marketplace headers: Sign in / Get Started
 * for visitors, a Dashboard link for signed-in users (INT-M1's
 * auth-aware headers). While the session probe is in flight nothing
 * interactive renders — avoids the "Sign in" flash for signed-in users.
 */
export function MarketplaceAuthNav() {
  const { authed, loading } = useSession();

  if (loading) {
    return <div className="h-9 w-44" aria-hidden />;
  }

  if (authed) {
    return (
      <div className="flex items-center gap-4">
        <Link href="/dashboard" className="btn-primary">
          Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <Link
        href="/login"
        className="text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        Sign in
      </Link>
      <Link href="/register" className="btn-primary">
        Get Started
      </Link>
    </div>
  );
}
