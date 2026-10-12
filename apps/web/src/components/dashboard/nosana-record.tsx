"use client";

import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { NosanaRecord as NosanaRecordData } from "@/lib/api";
import { NOSANA_RECORD_EXPLANATION, NOSANA_RECORD_HEADING, nosanaRecordView } from "@/lib/training";
import { cn } from "@/lib/utils";

/**
 * What Nosana itself knows a training run by: the job's address, the link to
 * Nosana's own page for it, and the deployment id. Renders nothing for a run
 * that never reached Nosana, and nothing for an API that does not send it.
 */
export function NosanaRecord({
  nosana,
  className,
}: {
  nosana: NosanaRecordData | null | undefined;
  className?: string;
}) {
  const record = nosanaRecordView(nosana);
  if (!record) return null;
  const { jobAddress, jobUrl, deploymentId } = record;

  return (
    <div className={cn("text-sm", className)} data-testid="training-nosana">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {NOSANA_RECORD_HEADING}
      </p>
      {jobAddress && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">{NOSANA_RECORD_EXPLANATION}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-muted-foreground">Job address</p>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy the job address"
              onClick={() => {
                // A page not served over https has no clipboard to write to.
                if (!navigator.clipboard) {
                  toast.error("Could not copy");
                  return;
                }
                void navigator.clipboard.writeText(jobAddress).then(
                  () => toast.success("Copied"),
                  () => toast.error("Could not copy"),
                );
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
          </div>
          {/* An address has no place to break, so where it does not fit it is cut into even lines. */}
          <p
            className="break-all font-mono text-xs text-foreground [text-wrap:balance]"
            data-testid="training-nosana-address"
          >
            {jobAddress}
          </p>
        </>
      )}
      {jobUrl && (
        <a
          href={jobUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          data-testid="training-nosana-link"
        >
          View on Nosana
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
      {deploymentId && (
        <p className="mt-2 text-xs text-muted-foreground">
          Deployment <span className="break-all font-mono">{deploymentId}</span>
        </p>
      )}
    </div>
  );
}
