"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentTabProps } from "./types";

export function LogsTab({ agent }: AgentTabProps) {
  const latestDeployment = agent.deployments?.[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Logs</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="h-96 overflow-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
          {latestDeployment?.buildLogs || "No logs available"}
        </pre>
      </CardContent>
    </Card>
  );
}
