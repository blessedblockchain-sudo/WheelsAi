"use client";

import { useEffect, useState } from "react";
import { Settings } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RunwayCard } from "@/components/dashboard/runway-card";
import { PaymentsTable } from "@/components/dashboard/payments-table";
import { treasuryApi } from "@/lib/api";
import { agentHasToken } from "@/lib/agent-page";
import type { AgentTabProps } from "./types";

export type OverviewTabProps = AgentTabProps;

export function OverviewTab({ agent }: OverviewTabProps) {
  // The treasury cards are for an agent that has a token. Whether it has one
  // is read once from its runway: an agent without a treasury has no token.
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => {
    let current = true;
    setHasToken(false);
    treasuryApi
      .runway(agent.slug)
      .then((runway) => {
        if (current) setHasToken(agentHasToken(runway));
      })
      .catch(() => {
        if (current) setHasToken(false);
      });
    return () => {
      current = false;
    };
  }, [agent.slug]);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Model</p>
            <p className="font-medium">{(agent.modelConfig as any)?.externalModel || "WheelsAI's default model"}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Temperature</p>
            <p className="font-medium">{(agent.modelConfig as any)?.temperature || 0.7}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Max Tokens</p>
            <p className="font-medium">{(agent.modelConfig as any)?.maxTokens || 4096}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Source</p>
            <p className="font-medium capitalize">{agent.sourceType}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tools ({(agent.tools as any[])?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {(agent.tools as any[])?.length > 0 ? (
            <div className="space-y-2">
              {(agent.tools as any[]).map((tool: any, index: number) => (
                <div key={index} className="flex items-center gap-2 rounded border p-2">
                  <Settings className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{tool.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No tools configured</p>
          )}
        </CardContent>
      </Card>

      {agent.systemPrompt && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">System Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded bg-muted p-4 text-sm">
              {agent.systemPrompt}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Treasury: runway and auto-pay history, for an agent that has a token. */}
      {hasToken && (
        <>
          <RunwayCard slug={agent.slug} />
          <PaymentsTable slug={agent.slug} cluster="devnet" className="md:col-span-2" />
        </>
      )}
    </div>
  );
}
