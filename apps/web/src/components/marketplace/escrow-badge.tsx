import { Lock, RotateCcw, Unlock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { EscrowState } from "@/lib/api";
import { ESCROW, formatCents } from "@/lib/jobs";

const ICON = { held: Lock, released: Unlock, refunded: RotateCcw } as const;

/** Where a job's money is right now. `amountCents` is shown when given. */
export function EscrowBadge({ state, amountCents }: { state: EscrowState; amountCents?: number }) {
  const Icon = ICON[state];
  const { label, tone } = ESCROW[state];
  return (
    <Badge variant={tone} className="gap-1 whitespace-nowrap">
      <Icon className="h-3 w-3" aria-hidden />
      {amountCents !== undefined ? `${formatCents(amountCents)} · ` : ""}
      {label}
    </Badge>
  );
}
