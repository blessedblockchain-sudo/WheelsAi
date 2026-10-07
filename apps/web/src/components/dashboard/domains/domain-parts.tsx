"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, CheckCircle, Circle, Copy, Info, Loader2, Lock, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { DnsRecordInstruction, DomainsConfig } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TONE_CLASS, type Tone } from "../workflows/format";
import { planList, type DomainState } from "./domain-model";

const TONE_ICON: Record<Tone, React.ElementType> = {
  success: CheckCircle,
  danger: XCircle,
  warning: AlertTriangle,
  info: Loader2,
  neutral: Circle,
};

/** One observed state: an icon and the words, never colour alone. */
export function StateChip({ state, prefix, className }: { state: DomainState; prefix?: string; className?: string }) {
  const Icon = TONE_ICON[state.tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[state.tone],
        className
      )}
    >
      <Icon className={cn("h-3 w-3", state.tone === "info" && "animate-spin")} aria-hidden="true" />
      {prefix && <span className="sr-only">{prefix}: </span>}
      {state.label}
    </span>
  );
}

/**
 * Shown while custom domains are unavailable. The API's reason is a calm
 * sentence for the customer; the operator's detail is in the server log.
 */
export function NotConfiguredBanner({ config }: { config: DomainsConfig }) {
  if (config.configured) return null;
  return (
    <div role="status" className="flex gap-3 rounded-lg border border-border bg-muted p-4">
      <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1 text-sm">
        <p className="font-medium text-foreground">Custom domains are temporarily unavailable</p>
        <p className="text-muted-foreground">
          For now, domains cannot be added, checked or switched on, and requests to a custom domain are not served.
          Domains you already have are listed below and can be switched off or deleted. Try again later.
        </p>
      </div>
    </div>
  );
}

/** Shown when the organization's plan does not include custom domains. */
export function PlanBanner({ config }: { config: DomainsConfig }) {
  if (config.plan.entitled) return null;
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex gap-3">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="space-y-1 text-sm">
          <p className="font-medium text-foreground">
            Custom domains are included in the {planList(config.plan.includedIn)} plans
          </p>
          <p className="text-muted-foreground">
            Your organization is on {planList([config.plan.plan])}. The plan includes custom domains or it does not;
            there is no per-plan count. Domains you already have stay listed, paused, until the plan includes them.
          </p>
        </div>
      </div>
      <Link href={config.plan.upgradeUrl} className="shrink-0">
        <Button size="sm">Upgrade to Pro</Button>
      </Link>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** DNS records exactly as they are to be published: type, name, value. */
export function DnsRecordTable({ records, caption }: { records: DnsRecordInstruction[]; caption: string }) {
  if (records.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Type</th>
            <th scope="col" className="px-3 py-2 font-medium">Name</th>
            <th scope="col" className="px-3 py-2 font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {records.map((record) => (
            <tr key={`${record.type}-${record.value}`}>
              <td className="px-3 py-2 align-top font-mono text-foreground">{record.type}</td>
              <td className="px-3 py-2 align-top">
                <div className="flex items-start justify-between gap-2">
                  <code className="break-all font-mono text-foreground">{record.name}</code>
                  <CopyButton value={record.name} label={`${record.type} record name`} />
                </div>
              </td>
              <td className="px-3 py-2 align-top">
                <div className="flex items-start justify-between gap-2">
                  <code className="break-all font-mono text-foreground">{record.value}</code>
                  <CopyButton value={record.value} label={`${record.type} record value`} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A label and an observed value; "Not observed" when the server sent none. */
export function ObservedField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-all text-sm", value ? "text-foreground" : "text-muted-foreground", mono && value && "font-mono")}>
        {value || "Not observed"}
      </dd>
    </div>
  );
}
