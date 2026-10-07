"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * The tag an owner pastes into their site, exactly as the server wrote it.
 * When the server does not know its public addresses there is no snippet,
 * and the reason is shown instead of a guessed one.
 */
export function EmbedSnippet({ snippet, unavailableReason }: { snippet: string | null; unavailableReason: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!snippet) {
    return (
      <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        {unavailableReason ?? "The snippet is not available."}
      </p>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the snippet and copy it by hand.");
    }
  }

  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 text-xs text-foreground">
        <code>{snippet}</code>
      </pre>
      <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copy the snippet">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="ml-2">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
