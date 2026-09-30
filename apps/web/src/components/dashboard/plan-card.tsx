"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { billingApi, getErrorMessage, type PlanInfo } from "@/lib/api";

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">
          {used.toLocaleString("en-US")}
          {limit !== null ? ` / ${limit.toLocaleString("en-US")}` : " (unlimited)"}
        </span>
      </div>
      {limit !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={`h-full rounded-full ${pct >= 90 ? "bg-danger" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

/**
 * The org's plan: what it includes, this month's usage against it, and
 * the way up (Pro checkout with a trial) or to manage it (Stripe portal).
 * `autoUpgrade` starts Pro checkout straight away (the pricing page's
 * "Start Pro Trial" lands here after sign-up).
 */
export function PlanCard({ autoUpgrade = false }: { autoUpgrade?: boolean }) {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const [busy, setBusy] = useState<"upgrade" | "portal" | null>(null);
  const autoStarted = useRef(false);

  useEffect(() => {
    billingApi
      .getPlan()
      .then(setInfo)
      .catch((err) => toast.error(getErrorMessage(err, "Could not load your plan")));
  }, []);

  async function upgrade() {
    setBusy("upgrade");
    try {
      const { checkoutUrl } = await billingApi.startProCheckout();
      window.location.href = checkoutUrl;
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not start Pro checkout"));
      setBusy(null);
    }
  }

  async function manage() {
    setBusy("portal");
    try {
      const { url } = await billingApi.openBillingPortal();
      window.location.href = url;
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not open billing management"));
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!autoUpgrade || autoStarted.current || !info) return;
    autoStarted.current = true;
    if (info.plan === "starter" && info.proSubscriptionAvailable) void upgrade();
  }, [autoUpgrade, info]);

  if (!info) return null;
  const { limits } = info;
  const trialing = info.status === "trialing" && info.trialEndsAt;

  return (
    <Card className="mb-8">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {limits.name} plan
            {trialing && <Badge variant="secondary">Trial until {formatDate(info.trialEndsAt)}</Badge>}
            {info.cancelAtPeriodEnd && info.currentPeriodEnd && (
              <Badge variant="warning">Ends {formatDate(info.currentPeriodEnd)}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {limits.priceMonthlyUsd === 0
              ? "Free"
              : limits.priceMonthlyUsd === null
                ? "Custom pricing"
                : `$${limits.priceMonthlyUsd}/month`}
            {info.plan !== "starter" && info.currentPeriodEnd && !info.cancelAtPeriodEnd
              ? ` · renews ${formatDate(info.currentPeriodEnd)}`
              : ""}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          {info.hasBillingAccount && (
            <Button variant="outline" size="sm" onClick={manage} isLoading={busy === "portal"}>
              Manage billing
            </Button>
          )}
          {info.plan === "starter" &&
            (info.proSubscriptionAvailable ? (
              <Button size="sm" onClick={upgrade} isLoading={busy === "upgrade"}>
                <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
                {info.trialAvailable ? "Start 14-day Pro trial" : "Upgrade to Pro"}
              </Button>
            ) : (
              <span className="self-center text-xs text-muted-foreground">
                Pro checkout is not enabled on this server yet
              </span>
            ))}
          {info.plan === "pro" && (
            <Link href="/contact?topic=enterprise" className="self-center text-sm text-primary hover:underline">
              Talk to us about Enterprise
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <UsageBar label="Agents" used={info.usage.agents} limit={limits.maxAgents} />
        <UsageBar label="API calls this month" used={info.usage.apiCallsThisMonth} limit={limits.monthlyApiCalls} />
      </CardContent>
    </Card>
  );
}
