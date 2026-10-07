import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Skill } from "@/lib/api";

/**
 * Whether a skill (agent tool) can run right now, in words a user can read.
 *
 * An unavailable skill is never hidden: the agent can still be configured
 * with it, and it answers "unavailable: <reason>" when the model calls it.
 * This label says so up front instead of letting it look ready.
 */
export function SkillStatusBadge({ skill }: { skill: Pick<Skill, "available"> }) {
  return skill.available ? (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      Unavailable
    </Badge>
  );
}

export function SkillUnavailableNote({
  skill,
}: {
  skill: Pick<Skill, "available" | "unavailableReason">;
}) {
  if (skill.available) return null;
  return (
    <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-500">
      Unavailable: {skill.unavailableReason ?? "not available right now"}
    </p>
  );
}

/**
 * A tool the registry has but THIS agent has not enabled. A graph node naming
 * it is always refused at run time, so the fix is offered right where the
 * tool is chosen instead of being left for the run to report.
 */
export function SkillNotEnabledNote({
  skill,
  onEnable,
  enabling,
}: {
  skill: Pick<Skill, "name">;
  onEnable: () => void;
  enabling: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs">
      <span className="text-yellow-600 dark:text-yellow-500">
        {skill.name} is not enabled on this agent, so a run will refuse this node.
      </span>
      <button
        type="button"
        onClick={onEnable}
        disabled={enabling}
        className="shrink-0 rounded-md border px-2 py-1 font-medium hover:bg-accent disabled:opacity-50"
      >
        {enabling ? "Enabling..." : "Enable on this agent"}
      </button>
    </div>
  );
}
