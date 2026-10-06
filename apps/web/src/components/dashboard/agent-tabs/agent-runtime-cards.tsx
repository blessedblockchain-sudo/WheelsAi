"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import {
  agentsApi,
  getErrorMessage,
  type AgentChatUsage,
  type AgentEntrypoint,
  type AgentUsagePeriod,
} from "@/lib/api";
import type { AgentTabProps } from "./types";

const ENTRYPOINTS: Array<{ id: AgentEntrypoint; label: string; detail: string }> = [
  {
    id: "chat",
    label: "Prompt, model and tools",
    detail: "The agent answers with its system prompt on its model, using its tools and knowledge base.",
  },
  {
    id: "graph",
    label: "Its graph",
    detail:
      "The agent answers by running the graph saved in the builder. Each chat is one run, kept with its trace.",
  },
];

/**
 * What answers when the agent is chatted with, in the playground and on /v1.
 * Switching to the graph is refused by the API until a graph is saved.
 */
export function EntrypointCard({ agent, agentId, loadAgent }: AgentTabProps) {
  const [saving, setSaving] = useState<AgentEntrypoint | null>(null);
  const current: AgentEntrypoint = agent.entrypoint ?? "chat";

  const choose = async (entrypoint: AgentEntrypoint) => {
    if (entrypoint === current || saving) return;
    setSaving(entrypoint);
    try {
      await agentsApi.update(agentId, { entrypoint });
      await loadAgent();
      toast.success(entrypoint === "graph" ? "This agent now answers through its graph" : "This agent now answers with its prompt");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not change what answers"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Answers with</CardTitle>
        <CardDescription>
          The same choice serves the playground and the API. Build or edit the graph in the{" "}
          <Link href={`/dashboard/agents/${agentId}/builder`} className="text-primary-600 hover:underline">
            graph builder
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="What answers a chat">
          {ENTRYPOINTS.map((option) => {
            const selected = option.id === current;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving !== null}
                onClick={() => choose(option.id)}
                className={`rounded-lg border p-4 text-left transition-colors disabled:opacity-60 ${
                  selected ? "border-primary-500 bg-muted" : "hover:bg-muted"
                }`}
              >
                <p className="text-sm font-medium text-foreground">
                  {option.label}
                  {selected && <span className="ml-2 text-xs text-muted-foreground">current</span>}
                  {saving === option.id && <span className="ml-2 text-xs text-muted-foreground">saving…</span>}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{option.detail}</p>
              </button>
            );
          })}
        </div>
        {current === "graph" && (
          <p className="mt-3 text-sm text-muted-foreground">
            A graph agent does not accept caller-defined functions (<code>tools</code>), and its responses carry no
            token usage: a run spans several model calls and none of them reports for the whole.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const PERIODS: Array<{ id: AgentUsagePeriod; label: string }> = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

const SOURCE_LABELS: Record<string, string> = { api: "API (/v1)", playground: "Playground", widget: "Widget" };

function ms(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s` : `${value} ms`;
}

/** Requests, errors, tokens and latency of the agent's chats, measured. */
export function UsageCard({ agentId }: Pick<AgentTabProps, "agentId">) {
  const [period, setPeriod] = useState<AgentUsagePeriod>("24h");
  const [usage, setUsage] = useState<AgentChatUsage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsage((await agentsApi.usage(agentId, period)).usage);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [agentId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = usage?.total;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Traffic</CardTitle>
          <CardDescription>Every chat this agent was asked for, in the playground and through the API.</CardDescription>
        </div>
        <div className="flex gap-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={p.id === period ? "default" : "outline"}
              aria-pressed={p.id === period}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading && !usage ? (
          <div className="grid gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : error ? (
          <ErrorState title="Couldn't load this agent's traffic" error={error} onRetry={load} />
        ) : !total || total.requests === 0 ? (
          <EmptyState
            icon={Activity}
            title="No chats in this period"
            description="Requests, tokens and latency appear here once the agent is called from the playground or the API."
          />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Requests"
                value={total.requests.toLocaleString("en-US")}
                hint={`${total.streamed.toLocaleString("en-US")} streamed`}
              />
              <Stat
                label="Error rate"
                value={`${(total.errorRate * 100).toFixed(1)}%`}
                hint={`${total.errors.toLocaleString("en-US")} chats produced no answer`}
              />
              <Stat
                label="Latency (median)"
                value={total.p50LatencyMs === null ? ms(total.avgLatencyMs) : `≤ ${ms(total.p50LatencyMs)}`}
                hint={
                  total.p50LatencyMs === null
                    ? "average of answered chats"
                    : `p95 ${total.p95LatencyMs === null ? "over 2 min" : `≤ ${ms(total.p95LatencyMs)}`} · average ${ms(total.avgLatencyMs)}`
                }
              />
              <Stat
                label="Tokens"
                value={(total.inputTokens + total.outputTokens).toLocaleString("en-US")}
                hint={
                  total.usageUnreported > 0
                    ? `${total.usageUnreported.toLocaleString("en-US")} answered chats reported no usage and are not counted`
                    : `${total.inputTokens.toLocaleString("en-US")} in · ${total.outputTokens.toLocaleString("en-US")} out`
                }
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Requests</th>
                    <th className="py-2 pr-4 font-medium">Errors</th>
                    <th className="py-2 pr-4 font-medium">Tool calls</th>
                    <th className="py-2 font-medium">Average latency</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(usage?.bySource ?? {}).map(([source, row]) => (
                    <tr key={source} className="border-b last:border-0">
                      <td className="py-2 pr-4 text-foreground">{SOURCE_LABELS[source] ?? source}</td>
                      <td className="py-2 pr-4 font-mono tabular-nums">{row.requests.toLocaleString("en-US")}</td>
                      <td className="py-2 pr-4 font-mono tabular-nums">{row.errors.toLocaleString("en-US")}</td>
                      <td className="py-2 pr-4 font-mono tabular-nums">{row.toolCalls.toLocaleString("en-US")}</td>
                      <td className="py-2 font-mono tabular-nums">{ms(row.avgLatencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
