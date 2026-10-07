import { AlertTriangle } from "lucide-react";

import type { TrainingBlocker } from "@/lib/api";

/**
 * Why a training job cannot start: each blocker in the API's own sentence
 * (GET /api/training/capabilities), shown where the action would be. Every
 * platform-side blocker carries the same calm sentence, so a sentence is shown
 * once; the organization's own blocker (its free failures of the last day,
 * with when the next run can start) is specific. Renders nothing when there
 * is none.
 */
export function TrainingBlockers({
  blockers,
  title = "Fine-tuning cannot start right now",
}: {
  blockers: TrainingBlocker[];
  title?: string;
}) {
  if (blockers.length === 0) return null;
  const unique = blockers.filter(
    (blocker, index) => blockers.findIndex((other) => other.message === blocker.message) === index,
  );
  return (
    <div
      role="status"
      data-testid="training-blockers"
      className="rounded-lg border border-border bg-muted p-4"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-9 text-sm text-muted-foreground">
        {unique.map((blocker) => (
          <li key={blocker.code} data-blocker={blocker.code}>
            {blocker.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 pl-6 text-xs text-muted-foreground">
        Nothing was created and no credits were held. Datasets, past jobs and fine-tuned models are still listed.
      </p>
    </div>
  );
}
