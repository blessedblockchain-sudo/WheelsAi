"use client";

import { useSyncExternalStore } from "react";

import { resultDate } from "@/lib/public-use";

const subscribe = () => () => {};

/**
 * false on the server and on the first paint in the browser, true after.
 * Dates and numbers are written in the visitor's own locale and time zone,
 * which the server does not know, so anything that prints them waits for this.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** A date in the visitor's own time; in UTC, and marked so, until the browser has taken over. */
export function LocalTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  const utc = resultDate(iso, "en-GB", "UTC");
  if (!utc) return null;
  return <time dateTime={iso}>{hydrated ? resultDate(iso) : `${utc} UTC`}</time>;
}
