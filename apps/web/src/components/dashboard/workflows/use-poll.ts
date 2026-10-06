"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads a value and keeps reloading it while `shouldContinue` says the
 * value is still changing (a queued or running run), then stops.
 *
 * Unlike lib/use-polling, whether to poll is decided by the data: a
 * finished run is fetched once and never again. A reload that fails keeps
 * the last good value on screen and reports the error beside it.
 */
export function usePoll<T>({
  key,
  load,
  shouldContinue,
  intervalMs = 2000,
}: {
  /** Changing the key drops the current value and starts over. Null loads nothing. */
  key: string | null;
  load: () => Promise<T>;
  shouldContinue: (value: T) => boolean;
  intervalMs?: number;
}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  // Bumped by refresh() to restart polling after it had stopped.
  const [generation, setGeneration] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;
  const continueRef = useRef(shouldContinue);
  continueRef.current = shouldContinue;

  // The last value loaded for the current key, and which key that was.
  const latest = useRef<{ key: string; value: T } | null>(null);

  useEffect(() => {
    if (key === null) {
      latest.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A refresh() of the same key keeps the value on screen while it reloads.
    const fresh = latest.current?.key !== key;
    if (fresh) {
      latest.current = null;
      setData(null);
      setError(null);
    }

    const tick = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      let again: boolean;
      try {
        const value = await loadRef.current();
        if (cancelled) return;
        latest.current = { key, value };
        setData(value);
        setError(null);
        again = continueRef.current(value);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        // Keep trying only while the last good value was still changing.
        // A first load that fails is the caller's error state to show.
        again = latest.current !== null && continueRef.current(latest.current.value);
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
      if (!cancelled && again) timer = setTimeout(() => tick(false), intervalMs);
    };

    tick(fresh);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `generation` restarts the loop on refresh().
  }, [key, intervalMs, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  return { data, error, loading, refresh };
}
