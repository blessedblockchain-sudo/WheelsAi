"use client";

import { ExternalLink } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { AgentTabProps } from "./types";

export function CodeTab({ agent }: AgentTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent Code</CardTitle>
        <CardDescription>
          Source type: {agent.sourceType}
          {agent.sourceUrl && ` - ${agent.sourceUrl}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {agent.sourceCode ? (
          <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
            {agent.sourceCode}
          </pre>
        ) : agent.sourceUrl ? (
          <a
            href={agent.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-primary-600 hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            View source
          </a>
        ) : (
          <p className="text-gray-500">No source code available</p>
        )}
      </CardContent>
    </Card>
  );
}
