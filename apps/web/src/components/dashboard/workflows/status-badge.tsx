import { CheckCircle, Clock, Loader2, MinusCircle, XCircle, Ban } from "lucide-react";

import { cn } from "@/lib/utils";
import { statusTone, TONE_CLASS } from "./format";

const ICONS: Record<string, React.ElementType> = {
  queued: Clock,
  pending: Clock,
  running: Loader2,
  completed: CheckCircle,
  success: CheckCircle,
  failed: XCircle,
  error: XCircle,
  timeout: XCircle,
  cancelled: Ban,
  skipped: MinusCircle,
};

/** A run, step or task state: an icon and the word, never colour alone. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const Icon = ICONS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        TONE_CLASS[statusTone(status)],
        className
      )}
    >
      {Icon && (
        <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} aria-hidden="true" />
      )}
      {status}
    </span>
  );
}
