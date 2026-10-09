"use client";

import { DeliveryPicker } from "@/components/dashboard/delivery-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface DeliveryCardProps {
  /** The chosen place, or null for "Only here". */
  channelId: string | null;
  /** A place was chosen. With a schedule it is saved at once; with none it goes with the first save. */
  onChange: (channelId: string | null) => void;
  /** The server's sentence about the place, when a save refused it. */
  error?: string;
  saving: boolean;
  /** false until the agent has a schedule: the choice waits for the schedule to be saved. */
  hasSchedule: boolean;
}

/** Where a self-running agent's results go, beside its own page. */
export function DeliveryCard({ channelId, onChange, error, saving, hasSchedule }: DeliveryCardProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">Results</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <DeliveryPicker value={channelId} onChange={onChange} error={error} disabled={saving} />
        {!hasSchedule && (
          <p className="text-sm text-muted-foreground">Your choice is saved with the schedule.</p>
        )}
      </CardContent>
    </Card>
  );
}
