"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface UsePollingOptions<T> {
  fetcher: () => Promise<T>;
  interval: number; // ms
  enabled?: boolean;
  onError?: (error: Error) => void;
}

export function usePolling<T>({ fetcher, interval, enabled = true, onError }: UsePollingOptions<T>) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      onError?.(e);
    } finally {
      setIsLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    if (!enabled) return;

    refresh(); // Initial fetch
    const id = setInterval(refresh, interval);

    return () => clearInterval(id);
  }, [refresh, interval, enabled]);

  return { data, isLoading, error, refresh };
}
