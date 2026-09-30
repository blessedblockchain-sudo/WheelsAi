"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AgentDeployment } from "@/lib/api";
import type { AgentTabProps } from "./types";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

export function DeploymentsTab({ agent }: AgentTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deployment History</CardTitle>
      </CardHeader>
      <CardContent>
        {agent.deployments?.length > 0 ? (
          <div className="space-y-4">
            {agent.deployments.map((deployment: AgentDeployment) => (
              <div
                key={deployment.id}
                className="flex items-center justify-between rounded-lg border p-4"
              >
                <div className="flex items-center gap-4">
                  <Badge variant={statusColors[deployment.status]}>
                    {deployment.status}
                  </Badge>
                  <div>
                    <p className="font-medium">{deployment.id.slice(0, 8)}...</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(deployment.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                {deployment.endpoint && (
                  <code className="rounded bg-muted px-2 py-1 text-sm">
                    {deployment.endpoint}
                  </code>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-muted-foreground">No deployments yet</p>
        )}
      </CardContent>
    </Card>
  );
}
