"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  /** Shown in the header bar, e.g. "bash", "ts", "json". */
  language?: string;
  /** Optional file name or caption shown instead of the language. */
  title?: string;
  className?: string;
}

/**
 * A read-only code sample with a copy button. The block is always dark (in
 * both themes) so samples look the same everywhere; the scroll region is
 * focusable so long lines can be scrolled from the keyboard.
 */
export function CodeBlock({ code, language, title, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const label = title ?? language;

  return (
    <div className={cn("mt-4 overflow-hidden rounded-lg border border-border bg-[#0a0f1c] text-left", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-1.5">
        <span className="font-mono text-xs text-slate-400">{label ?? ""}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={copied ? "Copied" : `Copy ${label ?? "code"} to clipboard`}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre
        tabIndex={0}
        aria-label={label ? `${label} code sample` : "Code sample"}
        className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
