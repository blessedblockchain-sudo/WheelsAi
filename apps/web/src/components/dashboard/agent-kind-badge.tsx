import { CalendarClock, ClipboardList, MessageSquare, type LucideIcon } from "lucide-react";
import {
  AGENT_KIND_BADGES,
  DEFAULT_AGENT_KIND,
  isAgentKind,
  type AgentKind,
} from "@wheelsai/shared/agent-kind";

import { cn } from "@/lib/utils";

const KIND_STYLE: Record<AgentKind, { icon: LucideIcon; tone: string }> = {
  conversation: { icon: MessageSquare, tone: "bg-primary/10 text-primary" },
  task: { icon: ClipboardList, tone: "bg-sky-500/10 text-sky-500" },
  scheduled: { icon: CalendarClock, tone: "bg-violet-500/10 text-violet-500" },
};

export interface AgentKindBadgeProps {
  /** How the agent is used. A missing or unknown kind reads as a conversation. */
  kind: string | null | undefined;
  className?: string;
}

/**
 * A small badge for how an agent is used: Chat, Task or Runs on its own.
 * Self-contained, so a list, a card and the agent's own page can all use it.
 */
export function AgentKindBadge({ kind, className }: AgentKindBadgeProps) {
  const resolved: AgentKind = isAgentKind(kind) ? kind : DEFAULT_AGENT_KIND;
  const { icon: Icon, tone } = KIND_STYLE[resolved];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        tone,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">Kind: </span>
      {AGENT_KIND_BADGES[resolved]}
    </span>
  );
}
