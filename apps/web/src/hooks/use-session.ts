"use client";

import { useEffect, useState } from "react";
import { authApi } from "@/lib/api";

/**
 * Lightweight session probe for PUBLIC pages (marketplace, receipts)
 * that render differently for signed-in users. Asks /api/auth/me once
 * per mount; the httpOnly cookie rides along automatically.
 *
 * `authed === null` while the probe is in flight — render the
 * logged-out state's layout without interactive commitment (e.g. keep
 * space, avoid flashing "Sign in").
 */
export function useSession(): { authed: boolean | null; loading: boolean } {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then(() => {
        if (!cancelled) setAuthed(true);
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { authed, loading: authed === null };
}
