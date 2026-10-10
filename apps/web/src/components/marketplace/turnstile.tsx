"use client";

import { useEffect, useRef, useState } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      cData: string;
      callback(token: string): void;
      "error-callback"(): void;
      "expired-callback"(): void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoading: Promise<void> | null = null;

/** Cloudflare's script, asked for once, and only by a page that shows a check. */
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptLoading) return scriptLoading;
  const attempt = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  scriptLoading = attempt;
  // A failed load is not remembered: the next mount asks again.
  attempt.catch(() => {
    if (scriptLoading === attempt) scriptLoading = null;
  });
  return attempt;
}

/**
 * The human check an anonymous visitor passes before a Try it chat. Mounted
 * only when the server said the gate is `turnstile`, so a signed-in visitor
 * (and a server with no Turnstile keys) never loads the third-party script.
 *
 * `action` and `cData` are what the server verifies the token against: a
 * token solved for one listing does not open another.
 */
export function Turnstile({
  siteKey,
  action,
  cData,
  onToken,
}: {
  siteKey: string;
  action: string;
  cData: string;
  onToken: (token: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    setProblem(null);
    loadTurnstile()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId = window.turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          cData,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => setProblem("The check could not be completed. Reload the page, or sign in instead."),
          "expired-callback": () => setProblem("The check expired. Complete it again to start."),
        });
      })
      .catch(() => {
        if (!cancelled) setProblem("The check could not be loaded. Sign in to try this agent instead.");
      });
    return () => {
      cancelled = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, action, cData]);

  return (
    <div>
      <div ref={container} />
      {problem && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
