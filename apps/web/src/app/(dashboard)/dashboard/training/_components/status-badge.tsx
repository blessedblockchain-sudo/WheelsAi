import { Badge } from "@/components/ui/badge";
import { trainingStatusView } from "@/lib/training";

/** A training job's state, worded the same on every page. */
export function TrainingStatusBadge({ status }: { status: string }) {
  const view = trainingStatusView(status);
  return <Badge variant={view.variant}>{view.label}</Badge>;
}
