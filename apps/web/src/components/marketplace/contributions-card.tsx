"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Users, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { collaborationApi, getErrorMessage, type MyContribution } from "@/lib/api";

function formatShare(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
}

/**
 * Agents other people publish that you hold a revenue share in: accept or
 * decline invitations, and see what each share has earned. Earnings are
 * paid into your organization and included in the payout balance above.
 */
export function ContributionsCard() {
  const [contributions, setContributions] = useState<MyContribution[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { contributions } = await collaborationApi.myContributions();
      setContributions(contributions);
    } catch (error) {
      setContributions([]);
      toast.error(getErrorMessage(error, "Failed to load your contributions"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(c: MyContribution, action: "accept" | "decline") {
    setBusyId(c.id);
    try {
      if (action === "accept") {
        await collaborationApi.accept(c.agentId, c.id);
        toast.success(`You now earn ${formatShare(c.revenueShareBps)} of ${c.agentName}'s creator revenue.`);
      } else {
        await collaborationApi.decline(c.agentId, c.id);
        toast.success("Invitation declined");
      }
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, `Could not ${action} the invitation`));
    } finally {
      setBusyId(null);
    }
  }

  if (contributions === null || contributions.length === 0) return null;

  const totalEarned = contributions.reduce((sum, c) => sum + c.earnedCents, 0);

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Your contributions
        </CardTitle>
        <CardDescription>
          Revenue shares in agents other people publish. You have earned{" "}
          <span className="font-mono tabular-nums text-foreground">${(totalEarned / 100).toFixed(2)}</span>, paid
          into your organization and included in your payout balance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {contributions.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{c.agentName}</span>
                  <Badge variant="secondary" className="text-xs">
                    {c.role}
                  </Badge>
                  {!c.acceptedAt && (
                    <Badge variant="warning" className="text-xs">
                      Invitation
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatShare(c.revenueShareBps)} of creator revenue
                  {c.acceptedAt && (
                    <>
                      {" "}&middot; earned{" "}
                      <span className="font-mono tabular-nums">${(c.earnedCents / 100).toFixed(2)}</span>
                    </>
                  )}
                </p>
              </div>
              {!c.acceptedAt && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => respond(c, "accept")} disabled={busyId === c.id}>
                    <Check className="mr-1 h-4 w-4" />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => respond(c, "decline")}
                    disabled={busyId === c.id}
                  >
                    <X className="mr-1 h-4 w-4" />
                    Decline
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
