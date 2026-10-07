"use client";

import Link from "next/link";
import { PlugZap } from "lucide-react";

import type { OrchestrationDetail } from "@/lib/api";
import { workflowSnippets } from "@/lib/public-urls";
import { CopyRow, Snippet } from "@/components/dashboard/agent-tabs/api-tab";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The workflow's OpenAI-compatible API: where it is, how to name it, what a
 * request does to a run, and code that calls it. Everything shown is what
 * the API returned for this workflow.
 */
export function WorkflowApiTab({ workflow }: { workflow: OrchestrationDetail }) {
  const code = workflowSnippets({
    apiEndpoint: workflow.apiEndpoint,
    openaiBaseUrl: workflow.openaiBaseUrl,
    openaiModel: workflow.openaiModel,
    timeoutMs: workflow.timeout,
  });
  const limitSeconds = Math.round(workflow.timeout / 1000);

  return (
    <div className="space-y-6">
      {code && workflow.apiEndpoint && workflow.openaiBaseUrl ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">OpenAI-compatible API</CardTitle>
            <CardDescription>
              Send a chat completion and this workflow runs once: the last user message is the run&apos;s input, and
              the run&apos;s output comes back as the assistant message.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyRow label="Endpoint" value={workflow.apiEndpoint} />
            <CopyRow label="OpenAI base URL" value={workflow.openaiBaseUrl} />
            <CopyRow label="Model id" value={workflow.openaiModel} />
            <p className="text-sm text-muted-foreground">
              Authenticate with an API key as <code>Authorization: Bearer …</code>.{" "}
              <Link href="/dashboard/keys" className="text-primary-600 hover:underline">
                Create or manage API keys
              </Link>
              . The model id also selects this workflow on the unified base URL (the same address ending in{" "}
              <code>/v1</code>), next to your agents and model deployments. Renaming the workflow does not change
              its address.
            </p>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={PlugZap}
          title="Endpoint address unavailable"
          description={`The full endpoint address cannot be shown right now. Your workflow is still served at /v1/workflows/${workflow.slug}/chat/completions on the WheelsAI API, and as model "${workflow.openaiModel}".`}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What one request does</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              It starts one run, listed under Runs like any other, and counts as one API call on your plan. Each
              step is billed by its own rules, exactly as when you run the workflow from here or on a schedule.
            </li>
            <li>
              The request waits for the run. This workflow&apos;s time limit is {limitSeconds} seconds; a run that
              reaches it is stopped and the request answers <code>504</code>. Set your client&apos;s timeout above
              that.
            </li>
            <li>
              If you disconnect before the answer, the run is cancelled: a step in progress is stopped, and steps
              that already finished stay billed.
            </li>
            <li>
              A failed run answers <code>502</code> with the run&apos;s id and the step that failed. Sending the
              request again starts a new run, so turn off automatic retries.
            </li>
            <li>
              <code>usage</code> is the sum over the steps, and is left out when any step&apos;s model call reported
              none. With <code>stream: true</code> the connection stays open while the run works and the answer
              arrives as chunks at the end.
            </li>
            {!workflow.isEnabled && <li>This workflow is disabled: requests answer 400 until you enable it.</li>}
          </ul>
        </CardContent>
      </Card>

      {code && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Call it</CardTitle>
            <CardDescription>
              A workflow with an input schema takes its input as a JSON object in the last user message.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="curl">
              <TabsList aria-label="Code samples">
                <TabsTrigger value="curl">curl</TabsTrigger>
                <TabsTrigger value="node">Node (streaming)</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
              </TabsList>
              <TabsContent value="curl" className="mt-4">
                <Snippet code={code.curl} />
              </TabsContent>
              <TabsContent value="node" className="mt-4">
                <Snippet code={code.node} />
              </TabsContent>
              <TabsContent value="python" className="mt-4">
                <Snippet code={code.python} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
