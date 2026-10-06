import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Workflows and scheduler",
  description:
    "WheelsAI workflows and scheduler API: define multi-step workflows with branches and loops, start and cancel runs, read per-step results, and schedule any of the nine task types.",
};

const toc = [
  { id: "workflows", title: "Workflows" },
  { id: "definition", title: "The workflow definition", sub: true },
  { id: "references", title: "References and templates", sub: true },
  { id: "plan-workflow", title: "Check a definition", sub: true },
  { id: "workflow-endpoints", title: "Create, read, change, delete", sub: true },
  { id: "runs", title: "Runs" },
  { id: "execute-workflow", title: "Start a run", sub: true },
  { id: "get-run", title: "Read a run", sub: true },
  { id: "cancel-run", title: "Cancel a run", sub: true },
  { id: "scheduler", title: "Scheduler" },
  { id: "task-types", title: "Task types", sub: true },
  { id: "create-task", title: "Create a task", sub: true },
  { id: "task-endpoints", title: "Other task endpoints", sub: true },
  { id: "events", title: "Webhook events" },
  { id: "errors", title: "Errors" },
];

export default function WorkflowsApiPage() {
  return (
    <DocPage
      href="/docs/api/workflows"
      title="Workflows and scheduler"
      lead="A workflow chains agents, model deployments and knowledge-base searches into steps with dependencies, branches and loops. A run executes in the background; the scheduler starts runs, and eight other kinds of task, on a cron expression, at an interval, or once."
      toc={toc}
    >
      <p>
        Every endpoint here accepts an API key or a session and is scoped to your organization: an id that belongs to
        another organization answers <code>404</code>. Request bodies are strict, so an unknown field is a{" "}
        <code>400</code>, not a setting that is silently ignored. The <Link href="/docs/guides/workflows">workflows guide</Link>{" "}
        covers the same ground from the dashboard.
      </p>

      <h2 id="workflows">Workflows</h2>

      <h3 id="definition">The workflow definition</h3>
      <p>
        Create, replace and plan take the same body. Steps are identified by <code>name</code>; a step lists the names it
        waits for in <code>dependsOn</code>.
      </p>
      <Fields
        title="Workflow"
        fields={[
          { name: "name", type: "string", required: true, description: "1 to 80 characters, unique in your organization." },
          { name: "description", type: "string | null", description: "Up to 500 characters." },
          {
            name: "executionMode",
            type: "string",
            required: true,
            description: (
              <>
                <code>parallel</code> runs a step as soon as its dependencies finish, independent steps together.{" "}
                <code>sequential</code>, <code>conditional</code> and <code>pipeline</code> run one step at a time in
                dependency order; in <code>pipeline</code> a step with no prompt receives the previous step&apos;s output.
              </>
            ),
          },
          { name: "maxConcurrency", type: "integer", description: "1 to 10, default 5. Steps (and for-each items) running at once." },
          { name: "timeout", type: "integer (ms)", description: "10,000 to 3,600,000, default 600,000. A run past it is stopped and marked failed." },
          { name: "retryPolicy", type: "object", description: <><code>maxRetries</code> (0 to 5) and <code>backoffMs</code> (0 to 60,000) for steps that set no retries of their own.</> },
          { name: "inputSchema", type: "JSON Schema", description: "A run whose input does not match is refused before anything is called." },
          { name: "outputSchema", type: "JSON Schema", description: "A run whose final output does not match is marked failed." },
          { name: "layout", type: "object | null", description: <>Canvas state for the dashboard editor: <code>positions</code> by step name and a <code>viewport</code>. The engine never reads it.</> },
          { name: "steps", type: "Step[]", required: true, description: "1 to 25 steps." },
        ]}
      />
      <p>
        The schemas support <code>type</code>, <code>enum</code>, <code>const</code>, <code>properties</code>,{" "}
        <code>required</code>, <code>additionalProperties</code>, <code>items</code>, <code>minItems</code>,{" "}
        <code>maxItems</code>, <code>minLength</code>, <code>maxLength</code>, <code>minimum</code> and{" "}
        <code>maximum</code>. A schema that uses any other keyword is refused when the workflow is saved, rather than
        accepted and not enforced.
      </p>
      <Fields
        title="Step"
        fields={[
          { name: "name", type: "string", required: true, description: <>1 to 64 characters, unique in the workflow, without <code>.</code> <code>&#123;</code> <code>&#125;</code> or <code>|</code>.</> },
          { name: "stepType", type: "string", description: <><code>agent</code> (default), <code>model</code> or <code>retrieval</code>.</> },
          { name: "agentId", type: "uuid", description: "Required for an agent step." },
          { name: "deploymentId", type: "uuid", description: <>Required for a model step; <code>modelId</code> optionally names the model.</> },
          { name: "knowledgeBaseId", type: "uuid", description: "Required for a retrieval step." },
          { name: "promptTemplate", type: "string", description: "The prompt (or, for retrieval, the search query), with variables. Up to 20,000 characters." },
          { name: "outputFormat", type: "string", description: <><code>text</code> (default) or <code>json</code>. With <code>json</code> the reply is parsed, a code fence is stripped, and the step fails if it is not valid JSON.</> },
          { name: "dependsOn", type: "string[]", description: "Names of the steps this one waits for. It runs if at least one of them succeeded." },
          { name: "condition", type: "object | null", description: <><code>&#123; left, op, right &#125;</code>. The step is skipped when it does not hold.</> },
          { name: "loop", type: "object | null", description: <><code>&#123; forEach, maxItems? &#125;</code> or <code>&#123; until, maxIterations, onExhausted? &#125;</code>.</> },
          { name: "onError", type: "string", description: <><code>fail</code> (default), <code>continue</code> or <code>fallback</code> (needs <code>fallbackAgentId</code>).</> },
          { name: "maxRetries", type: "integer", description: "0 to 5." },
          { name: "timeoutMs", type: "integer | null", description: "1,000 to 900,000. A step past it is aborted, not retried." },
          { name: "inputMapping", type: "object", description: "Declarative mapping of references into the step's input; a prompt template takes precedence over a mapped prompt." },
          { name: "outputMapping", type: "object", description: <>References published into the run&apos;s <code>output</code> once the step has finished, for example <code>&#123; &quot;answer&quot;: &quot;$.steps.reply.output&quot; &#125;</code>. With no output mapping anywhere, the run&apos;s <code>output</code> is <code>&#123;&#125;</code> and each step&apos;s output is read from <code>stepResults</code>.</> },
        ]}
      />
      <DocTable
        caption="Conditions, branches and loops"
        columns={[
          { key: "what", label: "Feature" },
          { key: "how", label: "How it behaves" },
        ]}
        rows={[
          {
            what: "Condition operators",
            how: (
              <>
                <code>equals</code>, <code>not_equals</code> (strict, so <code>5</code> is not <code>&quot;5&quot;</code>),{" "}
                <code>contains</code>, <code>not_contains</code>, <code>exists</code>, <code>not_exists</code>,{" "}
                <code>gt</code>, <code>gte</code>, <code>lt</code>, <code>lte</code>.
              </>
            ),
          },
          {
            what: "Branches",
            how: "A step whose condition does not hold is recorded as skipped. A step all of whose dependencies were skipped or failed is skipped too (\"branch not taken\" or \"dependency failed\"); a join runs when at least one of its dependencies succeeded.",
          },
          {
            what: "For-each loop",
            how: (
              <>
                <code>forEach</code> is a reference to a JSON array, a JSON array in a string, or text with one item per
                line. The step runs once per item with <code>&#123;&#123;item&#125;&#125;</code> and{" "}
                <code>&#123;&#123;index&#125;&#125;</code>, up to <code>maxConcurrency</code> at a time, and its output is
                the array of results. More than <code>maxItems</code> (at most 50) fails the step before anything is called.
              </>
            ),
          },
          {
            what: "Until loop",
            how: (
              <>
                The step is repeated, with <code>&#123;&#123;iteration&#125;&#125;</code> counting from 1, until the{" "}
                <code>until</code> condition holds or <code>maxIterations</code> (at most 10) is reached; then it fails, or
                keeps its last output when <code>onExhausted</code> is <code>continue</code>.
              </>
            ),
          },
        ]}
      />

      <h3 id="references">References and templates</h3>
      <p>
        Steps are wired with data, never code. A string that starts with <code>$.</code> in a condition, a loop source or a
        mapping is a reference; a prompt template holds the same references inside <code>&#123;&#123; &#125;&#125;</code>,
        without the <code>$.</code>. Nothing else between the braces is evaluated.
      </p>
      <DocTable
        caption="References"
        columns={[
          { key: "ref", label: "Reference" },
          { key: "in", label: "In a template" },
          { key: "what", label: "Value" },
        ]}
        rows={[
          { ref: <code>$.input.topic</code>, in: <code>&#123;&#123;input.topic&#125;&#125;</code>, what: <>A field of the run input. The run&apos;s <code>prompt</code> is <code>input.prompt</code>.</> },
          { ref: <code>$.steps.research.output</code>, in: <code>&#123;&#123;steps.research.output&#125;&#125;</code>, what: "Another step's output." },
          { ref: <code>$.steps.classify.output.category</code>, in: <code>&#123;&#123;steps.classify.output.category&#125;&#125;</code>, what: "A field of a JSON step's output." },
          { ref: <code>$.previous.output</code>, in: <code>&#123;&#123;previous.output&#125;&#125;</code>, what: "The step before this one in the run order." },
          { ref: <><code>$.item</code>, <code>$.index</code></>, in: <><code>&#123;&#123;item&#125;&#125;</code>, <code>&#123;&#123;index&#125;&#125;</code></>, what: "The current item of a for-each loop." },
          { ref: <code>$.iteration</code>, in: <code>&#123;&#123;iteration&#125;&#125;</code>, what: "The current pass of an until loop." },
        ]}
      />
      <p>
        An object or array renders as JSON in a template; <code>&#123;&#123;steps.a.output | json&#125;&#125;</code> renders
        any value as a JSON literal. In <code>parallel</code> mode a step may only read steps it depends on, directly or
        through others; in the other modes, any step earlier in the run order. A reference that breaks this rule is refused
        when the workflow is saved, with the step and the fix named.
      </p>

      <Endpoint id="plan-workflow" method="POST" path="/api/orchestrations/plan" auth="API key or session" title="Check a definition without saving it">
        <p>
          Takes a workflow definition and answers <code>200</code> with the plan, or <code>400</code>{" "}
          <code>invalid_workflow</code> naming the step and field at fault: a cycle, an unknown dependency or reference, an
          agent, deployment or knowledge base that is not in your organization, an incomplete fallback or loop.
        </p>
        <CodeBlock
          language="json"
          title="200"
          code={`{
  "levels": [["classify"], ["billing", "technical"], ["reply"]],
  "order": ["classify", "billing", "technical", "reply"],
  "concurrency": 5,
  "warnings": []
}`}
        />
        <p>
          <code>warnings</code> lists what will run but may surprise you, for example a fallback agent on a step whose{" "}
          <code>onError</code> is not <code>fallback</code>, which is never used.
        </p>
      </Endpoint>

      <h3 id="workflow-endpoints">Create, read, change, delete</h3>
      <DocTable
        caption="Workflow endpoints"
        columns={[
          { key: "ep", label: "Endpoint" },
          { key: "what", label: "What it does" },
        ]}
        rows={[
          { ep: <code>POST /api/orchestrations</code>, what: <>Create from a definition. <code>201</code> with the workflow and its steps.</> },
          { ep: <code>GET /api/orchestrations</code>, what: <>List; <code>isEnabled</code>, <code>limit</code> (1 to 100), <code>offset</code>. Each row carries step, run and schedule counts and its last run.</> },
          { ep: <code>GET /api/orchestrations/&#123;id&#125;</code>, what: "One workflow with its steps, its latest 10 runs and its schedules." },
          { ep: <code>PUT /api/orchestrations/&#123;id&#125;</code>, what: <>Replace settings and steps together. Send <code>expectedUpdatedAt</code> (the <code>updatedAt</code> you loaded) to get <code>409 stale_definition</code> instead of overwriting someone else&apos;s change.</> },
          { ep: <code>PATCH /api/orchestrations/&#123;id&#125;</code>, what: <>Only <code>name</code>, <code>description</code> and <code>isEnabled</code>.</> },
          { ep: <code>DELETE /api/orchestrations/&#123;id&#125;</code>, what: <><code>204</code>. Queued and running runs are cancelled; steps, run history and schedules go with it.</> },
          { ep: <code>GET /api/orchestrations/stats</code>, what: "Counts of workflows, enabled workflows, runs, and runs queued or running now." },
        ]}
      />
      <CodeBlock
        language="bash"
        title="A workflow with a branch, a loop and two parallel steps"
        code={`curl -s -X POST "$WHEELSAI_API_URL/api/orchestrations" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Support triage",
    "executionMode": "parallel",
    "steps": [
      { "name": "classify", "agentId": "'$AGENT'", "outputFormat": "json",
        "promptTemplate": "Classify this message. Reply with JSON {\\"category\\": \\"billing\\" or \\"technical\\", \\"questions\\": [..]}.\\n\\n{{input.prompt}}" },
      { "name": "billing", "agentId": "'$AGENT'", "dependsOn": ["classify"],
        "condition": { "left": "$.steps.classify.output.category", "op": "equals", "right": "billing" },
        "promptTemplate": "Answer this billing question: {{input.prompt}}" },
      { "name": "technical", "agentId": "'$AGENT'", "dependsOn": ["classify"],
        "condition": { "left": "$.steps.classify.output.category", "op": "equals", "right": "technical" },
        "promptTemplate": "Answer this technical question: {{input.prompt}}" },
      { "name": "answers", "agentId": "'$AGENT'", "dependsOn": ["classify"],
        "loop": { "forEach": "$.steps.classify.output.questions", "maxItems": 5 },
        "promptTemplate": "Answer in one sentence: {{item}}" },
      { "name": "reply", "agentId": "'$AGENT'", "dependsOn": ["billing", "technical", "answers"],
        "promptTemplate": "Write the reply.\\nBilling: {{steps.billing.output}}\\nTechnical: {{steps.technical.output}}\\nAnswers: {{steps.answers.output}}" }
    ]
  }'`}
      />

      <h2 id="runs">Runs</h2>

      <Endpoint id="execute-workflow" method="POST" path="/api/orchestrations/{id}/execute" auth="API key or session" title="Start a run">
        <Fields
          fields={[
            { name: "prompt", type: "string", description: <>Up to 20,000 characters. Becomes <code>input.prompt</code>.</> },
            { name: "input", type: "object", description: "Up to 64 KB. Checked against the workflow's input schema." },
          ]}
        />
        <p>
          Answers <code>202</code> as soon as the run is queued. A worker executes it; poll the run until its status leaves{" "}
          <code>queued</code> and <code>running</code>.
        </p>
        <CodeBlock
          language="json"
          title="202"
          code={`{
  "execution": {
    "id": "6f1c0b0e-...",
    "status": "queued",
    "triggeredBy": "api",
    "triggeredById": "<api key id>",
    "createdAt": "2026-10-07T09:30:00.000Z"
  }
}`}
        />
        <p>
          <code>triggeredBy</code> is <code>manual</code> for a session, <code>api</code> for an API key,{" "}
          <code>schedule</code> for the scheduler. It comes from how the request authenticated; sending it in the body is a{" "}
          <code>400</code>.
        </p>
        <DocTable
          caption="Refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>input_schema_mismatch</code>, when: <>The input does not match the input schema; <code>details</code> lists each problem. No run is created.</> },
            { status: "409", error: <code>workflow_disabled</code>, when: "The workflow is disabled." },
            { status: "429", error: <code>workflow_run_limit</code>, when: <>Your organization already has the allowed number of runs queued or running; <code>limit</code> says how many.</> },
            { status: "501", error: <code>workflow_runner_disabled</code>, when: "This server runs no workflow worker." },
            { status: "503", error: <code>workflow_queue_unavailable</code>, when: "The run could not be queued. The run is recorded as failed; nothing was called." },
          ]}
        />
        <p>
          The worker checks the stored definition again before it runs it. If the workflow can no longer run, for example
          because an agent it uses was deleted, the run ends <code>failed</code> with that reason and no step is called.
        </p>
      </Endpoint>

      <Endpoint id="get-run" method="GET" path="/api/orchestrations/{id}/executions/{runId}" auth="API key or session" title="Read a run">
        <p>
          Answers the run with its <code>status</code> (<code>queued</code>, <code>running</code>, <code>completed</code>,{" "}
          <code>failed</code> or <code>cancelled</code>), <code>progress</code>, <code>input</code>, <code>output</code>,{" "}
          <code>error</code> and one <code>stepResults</code> entry per step, per loop item and per loop pass.
        </p>
        <Fields
          title="stepResults entry"
          fields={[
            { name: "stepName, stepType", type: "string", description: "Which step, and its type." },
            { name: "agentId, resourceId", type: "uuid | null", description: "The agent, or the deployment or knowledge base, the step used." },
            { name: "status", type: "string", description: <><code>success</code>, <code>failed</code> or <code>skipped</code>.</> },
            { name: "iteration", type: "integer | null", description: "The item index of a for-each loop (from 0) or the pass of an until loop (from 1)." },
            { name: "input", type: "object", description: <>What the step was sent: the rendered <code>prompt</code>, loop <code>item</code> and <code>index</code>, and <code>missingRefs</code> when a reference read as empty.</> },
            { name: "output", type: "object", description: <><code>content</code> (text), <code>value</code> (the parsed value of a JSON or retrieval step) and <code>truncated</code> when the stored copy was cut at 100,000 characters.</> },
            { name: "error, attempt, durationMs", type: "", description: "Why it failed or was skipped, how many attempts it took, and how long." },
          ]}
        />
        <p>
          <code>GET /api/orchestrations/&#123;id&#125;/executions</code> lists runs without their step results;{" "}
          <code>status</code>, <code>limit</code> and <code>offset</code> filter and page it.
        </p>
      </Endpoint>

      <Endpoint id="cancel-run" method="POST" path="/api/orchestrations/{id}/executions/{runId}/cancel" auth="API key or session" title="Cancel a run">
        <ul>
          <li>
            <code>200</code>: the run was still queued and is now <code>cancelled</code>. Nothing was called.
          </li>
          <li>
            <code>202</code>: the run is running. <code>cancelRequestedAt</code> is set; the worker stops before the next
            step, aborts the call in flight and ends the run as <code>cancelled</code> within a few seconds.
          </li>
          <li>
            <code>409 execution_finished</code>: the run had already ended; <code>status</code> says how.
          </li>
        </ul>
        <Callout>
          <p>
            Cancelling aborts the request to the model, but a provider may still bill the tokens it had generated. Steps
            that finished before the cancel stay billed and stay in the run&apos;s results.
          </p>
        </Callout>
      </Endpoint>

      <h2 id="scheduler">Scheduler</h2>
      <p>
        A scheduled task has a type, a payload for that type, and a schedule: <code>cron</code> (five fields, read in the
        task&apos;s time zone), <code>interval</code> (at least 60 seconds) or <code>once</code>.
      </p>

      <Endpoint id="task-types" method="GET" path="/api/scheduler/task-types" auth="API key or session" title="Task types">
        <p>
          Lists every task type with its payload fields, whether it needs an agent or a workflow, and whether it can run on
          this server. A type or option that cannot run is listed with <code>available: false</code> and a{" "}
          <code>reason</code>, and is refused when a task that needs it is saved. <code>schedulerEnabled</code> is{" "}
          <code>false</code> when no worker fires schedules here.
        </p>
        <DocTable
          caption="Task types and their payloads"
          columns={[
            { key: "type", label: "taskType" },
            { key: "needs", label: "Needs" },
            { key: "payload", label: "payload" },
          ]}
          rows={[
            { type: <code>agent_run</code>, needs: "agentId", payload: <><code>prompt</code>. Sends it to the agent and records the reply. <code>inference</code> is an older name for the same thing.</> },
            { type: <code>workflow_run</code>, needs: "orchestrationId", payload: <><code>prompt?</code>, <code>input?</code>. Starts a run of the workflow; the execution follows the run&apos;s outcome. Not retried.</> },
            { type: <code>webhook</code>, needs: "nothing", payload: <><code>url</code>, <code>body?</code>, <code>headers?</code>. POSTs JSON that also carries <code>taskId</code>, <code>executionId</code> and <code>attempt</code>.</> },
            { type: <code>data_sync</code>, needs: "a knowledge base, or an agent that has one", payload: <><code>sources</code> (1 to 10 <code>&#123; url, title? &#125;</code>), <code>knowledgeBaseId?</code>, <code>maxBytes?</code>. Adds new content, replaces changed content, leaves unchanged content alone.</> },
            { type: <code>health_check</code>, needs: "depends on the target", payload: <><code>target</code> (<code>agent</code>, <code>deployment</code>, <code>url</code> or <code>monitor</code>) with <code>deploymentId</code>, <code>url</code> or <code>monitorId</code>; <code>expectedStatus</code>, <code>expectedBody?</code>, <code>timeoutSeconds</code>, <code>onDown</code>. Fails unless the target is up.</> },
            { type: <code>report</code>, needs: "agentId for an agent report or a summary", payload: <><code>periodDays</code>, <code>scope</code> (<code>org</code> or <code>agent</code>), <code>summarize?</code>, <code>deliver?</code> (<code>webhookEvent</code>, <code>alertChannelId</code>).</> },
            { type: <code>cleanup</code>, needs: "optionally agentId, to limit it to one agent", payload: <>At least one of <code>archiveConversationsOlderThanDays</code> (1 or more), <code>deleteArchivedOlderThanDays</code> (7 or more), <code>memoryDecay</code>, <code>pruneRunHistoryOlderThanDays</code> (7 or more); <code>dryRun</code> only counts.</> },
            { type: <code>custom</code>, needs: "agentId", payload: <><code>input</code>. Runs the graph drawn for that agent in the visual builder.</> },
          ]}
        />
      </Endpoint>

      <Endpoint id="create-task" method="POST" path="/api/scheduler" auth="API key or session" title="Create a task">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "1 to 80 characters, unique in your organization." },
            { name: "taskType", type: "string", required: true, description: "One of the task types above." },
            { name: "agentId, orchestrationId", type: "uuid", description: "As the task type requires." },
            { name: "scheduleType", type: "string", required: true, description: <><code>cron</code>, <code>interval</code> or <code>once</code>.</> },
            { name: "cronExpression", type: "string", description: <>Five fields, for example <code>0 9 * * 1-5</code>.</> },
            { name: "intervalSeconds", type: "integer", description: "60 or more." },
            { name: "scheduledAt", type: "string", description: <>An ISO instant, or a local time such as <code>2026-11-02T09:00</code> read in <code>timezone</code>. Must be in the future.</> },
            { name: "timezone", type: "string", description: <>An IANA name such as <code>Europe/Berlin</code>, or <code>UTC</code> (default). Abbreviations and offsets are refused.</> },
            { name: "payload", type: "object", description: "The task type's payload." },
            { name: "timeout", type: "integer (ms)", description: "5,000 to 3,600,000, default 300,000. The call is aborted when it passes." },
            { name: "maxRetries", type: "integer", description: "0 to 5; default 3 for types that are retried. Must be 0 for health_check and workflow_run." },
          ]}
        />
        <CodeBlock
          language="bash"
          title="Run a workflow every weekday at 09:00 Berlin time"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/scheduler" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Morning triage",
    "taskType": "workflow_run",
    "orchestrationId": "'$WORKFLOW'",
    "scheduleType": "cron",
    "cronExpression": "0 9 * * 1-5",
    "timezone": "Europe/Berlin",
    "payload": { "prompt": "Summarize the overnight tickets" }
  }'`}
        />
        <p>
          Answers <code>201</code> with the task and its <code>nextRunAt</code>. Refusals: <code>400 validation_failed</code>{" "}
          (payload problems are keyed like <code>payload.url</code>), <code>400 invalid_schedule</code> with a{" "}
          <code>reason</code> (<code>invalid_cron</code>, <code>invalid_timezone</code>, <code>invalid_scheduled_at</code>,{" "}
          <code>scheduled_at_in_past</code>, <code>interval_too_short</code>, <code>no_next_run</code>), <code>400 invalid_task</code> naming the{" "}
          <code>field</code> that points at something not in your organization, and <code>409 name_taken</code>.
        </p>
      </Endpoint>

      <h3 id="task-endpoints">Other task endpoints</h3>
      <DocTable
        caption="Scheduler endpoints"
        columns={[
          { key: "ep", label: "Endpoint" },
          { key: "what", label: "What it does" },
        ]}
        rows={[
          { ep: <code>GET /api/scheduler</code>, what: <>List; <code>agentId</code>, <code>orchestrationId</code>, <code>taskType</code>, <code>status</code>, <code>isEnabled</code>, <code>limit</code>, <code>offset</code>.</> },
          { ep: <code>GET /api/scheduler/&#123;id&#125;</code>, what: "One task with its last 10 executions." },
          { ep: <code>PATCH /api/scheduler/&#123;id&#125;</code>, what: "Change any create field. The merged task is validated like a new one; the next run is recomputed when the schedule or time zone changes." },
          { ep: <code>DELETE /api/scheduler/&#123;id&#125;</code>, what: <><code>204</code>.</> },
          { ep: <code>POST /api/scheduler/&#123;id&#125;/toggle</code>, what: <>Body <code>&#123; isEnabled &#125;</code>: pause or resume.</> },
          { ep: <code>POST /api/scheduler/&#123;id&#125;/trigger</code>, what: <>Run it now. <code>201</code> with the finished execution and its <code>output</code>; <code>202</code> with a <code>running</code> execution and its <code>orchestrationExecutionId</code> for a workflow run; <code>409 already_running</code> if one is in flight. A manual trigger is not retried.</> },
          { ep: <code>GET /api/scheduler/&#123;id&#125;/executions</code>, what: <>Executions, newest first, each with <code>status</code>, <code>attempt</code>, <code>output</code>, <code>error</code> and <code>triggeredBy</code>.</> },
          { ep: <code>POST /api/scheduler/&#123;id&#125;/executions/&#123;executionId&#125;/cancel</code>, what: <>Cancel a running execution; the call in flight is aborted within a few seconds. <code>409 not_cancellable</code> if it already finished.</> },
          { ep: <code>GET /api/scheduler/stats</code>, what: <>Counts, today&apos;s success rate, upcoming runs, and <code>schedulerEnabled</code>.</> },
        ]}
      />
      <p>
        A failed attempt of a retried type is run again after a short, growing wait, one execution row per attempt. Failures
        that a retry cannot fix (nothing configured, a refused URL, a bad payload), timeouts and cancels are not retried. A
        recurring schedule that can no longer be parsed is stopped with status <code>failed</code> and the reason, instead of
        firing at a guessed time.
      </p>

      <h2 id="events">Webhook events</h2>
      <p>
        Subscribe a <Link href="/docs/api/webhooks">webhook</Link> to these to be told when background work ends. They are
        signed and delivered like every other event.
      </p>
      <DocTable
        caption="Workflow and scheduler events"
        columns={[
          { key: "event", label: "Event" },
          { key: "when", label: "Sent when" },
        ]}
        rows={[
          { event: <code>workflow.completed</code>, when: "A workflow run completes." },
          { event: <code>workflow.failed</code>, when: "A workflow run fails or times out, however it was started. A cancelled run sends nothing." },
          { event: <code>scheduled_task.failed</code>, when: "A scheduled task fails, once per firing, after its last attempt. (A scheduled workflow run that fails sends workflow.failed.)" },
          { event: <code>report.generated</code>, when: <>A report task that asks for it with <code>deliver.webhookEvent</code> finishes.</> },
        ]}
      />

      <h2 id="errors">Errors</h2>
      <p>
        These endpoints follow the <Link href="/docs/api#errors">common error rules</Link>: <code>400 validation_failed</code>{" "}
        with <code>details</code> for a malformed request, <code>404</code> for anything not in your organization, and a
        scrubbed <code>500</code> for the unexpected. A capability this server does not have answers <code>501</code> or is
        listed as unavailable with its reason; nothing reports success it did not have.
      </p>
    </DocPage>
  );
}
