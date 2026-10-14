import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Workflows and scheduler",
  description:
    "WheelsAI workflows and scheduler API: define multi-step workflows with branches and loops, start and cancel runs, read per-step results, sell a workflow per run and with plans, run a workflow you pay for, and schedule any of the nine task types.",
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
  { id: "openai", title: "OpenAI-compatible endpoint" },
  { id: "sell", title: "Sell a workflow" },
  { id: "list-workflow", title: "Put it on sale", sub: true },
  { id: "sellable", title: "What keeps it on sale", sub: true },
  { id: "paid-runs", title: "A paid run", sub: true },
  { id: "use-paid", title: "Use a workflow you pay for" },
  { id: "w-page", title: "Read its page", sub: true },
  { id: "w-access", title: "Where you stand", sub: true },
  { id: "w-run", title: "Run it", sub: true },
  { id: "w-v1", title: "Run it through /v1", sub: true },
  { id: "w-errors", title: "Refusals", sub: true },
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
        The endpoints of your own workflows and of the scheduler accept an API key or a session and are scoped to your
        organization: an id that belongs to another organization answers <code>404</code>. Their request bodies are
        strict, so an unknown field is a <code>400</code>, not a setting that is silently ignored. A workflow another
        organization sells is the one exception: you reach it by the slug of its listing, as{" "}
        <a href="#use-paid">Use a workflow you pay for</a> describes, and its page and its API page can be read by
        anyone. The <Link href="/docs/guides/workflows">workflows guide</Link> covers the same ground from the dashboard.
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
          { ep: <code>PUT /api/orchestrations/&#123;id&#125;</code>, what: <>Replace settings and steps together. Send <code>expectedUpdatedAt</code> (the <code>updatedAt</code> you loaded) to get <code>409 stale_definition</code> instead of overwriting someone else&apos;s change. A workflow on sale is not changed into one that could not be sold: <a href="#sellable">what keeps it on sale</a>.</> },
          { ep: <code>PATCH /api/orchestrations/&#123;id&#125;</code>, what: <>Only <code>name</code>, <code>description</code> and <code>isEnabled</code>. A workflow on sale is not disabled.</> },
          { ep: <code>DELETE /api/orchestrations/&#123;id&#125;</code>, what: <><code>204</code>. Queued and running runs are cancelled; steps, run history and schedules go with it. A workflow on sale, or one people have paid for, is not deleted.</> },
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
          Answers <code>202</code> as soon as the run is queued. It runs in the background; poll the run until its status leaves{" "}
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
            { status: "501", error: <code>workflow_runner_disabled</code>, when: "Workflow runs are temporarily unavailable. No run is created." },
            { status: "503", error: <code>workflow_queue_unavailable</code>, when: "The run could not be queued. The run is recorded as failed; nothing was called." },
          ]}
        />
        <p>
          The stored definition is checked again before the run starts. If the workflow can no longer run, for example
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
          <code>status</code>, <code>limit</code> and <code>offset</code> filter and page it. A run a buyer paid for, of
          a workflow you sell, has <code>triggeredBy</code> <code>paid</code> and a <code>triggeredById</code> of{" "}
          <code>null</code>; see <a href="#paid-runs">a paid run</a>.
        </p>
      </Endpoint>

      <Endpoint id="cancel-run" method="POST" path="/api/orchestrations/{id}/executions/{runId}/cancel" auth="API key or session" title="Cancel a run">
        <ul>
          <li>
            <code>200</code>: the run was still queued and is now <code>cancelled</code>. Nothing was called.
          </li>
          <li>
            <code>202</code>: the run is running. <code>cancelRequestedAt</code> is set; the run stops before the next
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

      <Endpoint
        id="openai"
        method="POST"
        path="/v1/workflows/{slug}/chat/completions"
        auth="API key or session"
        title="OpenAI-compatible endpoint"
        as="h2"
      >
        <p>
          A workflow also answers as an OpenAI chat completion, so anything that speaks to OpenAI can run it: one request
          starts one run, waits for it, and returns the run&apos;s output as the assistant message. The same thing is
          reachable on the <Link href="/docs/api/inference#base-url">unified base URL</Link>,{" "}
          <code>POST /v1/chat/completions</code> with <code>&quot;model&quot;: &quot;workflow/&lt;slug&gt;&quot;</code>, and{" "}
          <code>GET /v1/models</code> lists every enabled workflow with <code>wheelsai.kind: &quot;workflow&quot;</code>.
        </p>
        <p>
          Every workflow has a <code>slug</code>, derived from its name when it is created and unique in your organization.
          Renaming the workflow does not change it. Each workflow read (<code>GET /api/orchestrations</code> and{" "}
          <code>GET /api/orchestrations/&#123;id&#125;</code>) returns <code>slug</code>, <code>apiEndpoint</code> (this
          URL), <code>openaiBaseUrl</code> (<code>…/v1/workflows/&lt;slug&gt;</code>, the base URL for an OpenAI client) and{" "}
          <code>openaiModel</code> (<code>workflow/&lt;slug&gt;</code>). The two URLs are <code>null</code> when they
          cannot be determined. The dashboard shows all three on the workflow&apos;s <strong>API</strong> tab.
        </p>
        <CodeBlock
          language="ts"
          code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1\`,
  apiKey: process.env.WHEELSAI_API_KEY,
  timeout: 11 * 60 * 1000, // longer than the workflow's time limit
  maxRetries: 0,            // a repeat is a new run
});

const reply = await client.chat.completions.create({
  model: "workflow/weekly-release-pipeline",
  messages: [{ role: "user", content: "Changes merged this week: ..." }],
});
console.log(reply.choices[0].message.content);`}
        />
        <Fields
          title="Request"
          fields={[
            {
              name: "messages",
              type: "array",
              required: true,
              description: (
                <>
                  The last <code>user</code> message is the run&apos;s input: it becomes <code>input.prompt</code> (up to
                  20,000 characters) and the whole conversation is available to steps as <code>input.messages</code>. If
                  the workflow has an input schema and the last user message is a JSON object, that object is the run
                  input instead, checked against the schema. The run input is at most 64 KB.
                </>
              ),
            },
            { name: "model", type: "string", description: <>Ignored on this path. On the unified base it is <code>workflow/&lt;slug&gt;</code> and required.</> },
            { name: "stream", type: "boolean", description: "See Streaming below." },
            { name: "stream_options.include_usage", type: "boolean", description: "Adds one usage chunk before the end of a stream, when usage is known." },
            { name: "tools, tool_choice", type: "", description: <>Refused with <code>400</code> (<code>param: &quot;tools&quot;</code>): a workflow cannot hand a function call back to the caller.</> },
          ]}
        />
        <p>
          Sampling parameters such as <code>temperature</code> and <code>max_tokens</code> are accepted and not applied:
          each step runs on the settings of its own agent or deployment.
        </p>
        <Fields
          title="Response"
          fields={[
            { name: "model", type: "string", description: <><code>workflow/&lt;slug&gt;</code>.</> },
            {
              name: "choices[0].message.content",
              type: "string",
              description: (
                <>
                  The run&apos;s output. If the steps&apos; output mappings publish exactly one string, that string; if they
                  publish anything else, the mapped output as JSON; if nothing is mapped, the output of the last step in
                  plan order that succeeded. <code>finish_reason</code> is <code>stop</code>.
                </>
              ),
            },
            {
              name: "usage",
              type: "object",
              description: "Tokens summed over the run's steps. Left out when any step's model call reported none (a graph agent, or a provider that sent no count), or when no step reported any: a partial sum is never shown as the total.",
            },
            {
              name: "wheelsai.workflow",
              type: "object",
              description: (
                <>
                  <code>slug</code>, <code>executionId</code> (read the run with{" "}
                  <a href="#get-run">GET …/executions/&#123;runId&#125;</a>), <code>status</code>, <code>durationMs</code>{" "}
                  and <code>steps</code>: each step&apos;s <code>name</code>, <code>type</code>, <code>status</code>,{" "}
                  <code>durationMs</code> and <code>error</code>.
                </>
              ),
            },
          ]}
        />
        <h4>What a request costs, and what happens to its run</h4>
        <ul>
          <li>
            The request counts as one API call on your plan. Each step is billed by its own rules, exactly as when the
            dashboard or the scheduler starts the same workflow: a per-request marketplace agent is charged per step, a
            free model counts against the free-model limits, a model deployment is billed as on <code>/v1</code>. The run
            appears in the workflow&apos;s run history with <code>triggeredBy: &quot;api&quot;</code>.
          </li>
          <li>
            The request waits for the run for the workflow&apos;s own time limit (<code>timeout</code>, 10 minutes by
            default) plus 30 seconds for the queue. A run that reaches its time limit is stopped and the
            request answers <code>504 workflow_timeout</code>. If the wait itself runs out because the run was still
            queued, the run is cancelled before it starts.
          </li>
          <li>
            If you disconnect before the answer, the run is cancelled the same way as <a href="#cancel-run">Cancel a run</a>:
            a queued run never starts, a running one has its call in flight aborted. Steps that already finished stay
            billed. Set your client&apos;s timeout above the workflow&apos;s time limit, or it will cancel runs that were
            about to finish.
          </li>
          <li>
            A failed, timed-out or cancelled run answers with <code>x-should-retry: false</code>, which the OpenAI SDKs
            honour: sending the request again starts, and bills, a whole new run.
          </li>
        </ul>
        <h4>Streaming</h4>
        <p>
          A workflow produces its answer at the end, not token by token. With <code>stream: true</code> the response opens
          as soon as the run is queued, with a first chunk that carries <code>wheelsai.workflow.executionId</code> and{" "}
          <code>status: &quot;running&quot;</code>; a <code>: keep-alive</code> comment is sent every 15 seconds while the
          run works; then the answer arrives as content chunks, a chunk with <code>finish_reason: &quot;stop&quot;</code>{" "}
          and the final <code>wheelsai.workflow</code>, an optional usage chunk, and <code>[DONE]</code>. A run that fails
          after the stream opened ends with one <code>&#123; &quot;error&quot;: … &#125;</code> event and no{" "}
          <code>[DONE]</code>. Use streaming for long workflows behind proxies that cut idle connections.
        </p>
        <DocTable
          caption="Errors (OpenAI shape: error.code)"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error.code" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>validation_failed</code>, when: <>No user message, or the input does not match the input schema (<code>details</code> lists each problem). No run is created.</> },
            { status: "400", error: <code>unsupported_parameter</code>, when: <><code>tools</code> or <code>tool_choice</code> was sent.</> },
            { status: "400", error: <code>messages_too_large</code>, when: "The prompt is over 20,000 characters or the run input over 64 KB." },
            { status: "400", error: <code>workflow_disabled</code>, when: "The workflow is disabled." },
            { status: "403", error: <code>insufficient_scope</code>, when: <>The API key has scopes and none of them is <code>workflows:invoke</code> or <code>*</code>. A key without scopes has full access.</> },
            { status: "404", error: <code>workflow_not_found</code>, when: "No workflow with that slug in your organization." },
            { status: "409", error: <code>workflow_cancelled</code>, when: "Someone cancelled the run while the request waited." },
            { status: "429", error: <code>workflow_run_limit</code>, when: "Your organization already has the allowed number of runs queued or running. Nothing was started; safe to retry." },
            { status: "501", error: <code>workflow_runner_disabled</code>, when: "Workflow runs are temporarily unavailable. Nothing was started; retry later." },
            { status: "502", error: <code>workflow_failed</code>, when: <>The run failed. <code>error.executionId</code>, <code>error.failedStep</code> and <code>error.workflow</code> (the steps) say where.</> },
            { status: "503", error: <code>service_unavailable</code>, when: "The run could not be queued. Nothing was called; safe to retry." },
            { status: "504", error: <code>workflow_timeout</code>, when: <>The run reached the workflow&apos;s time limit, or did not start in time and was cancelled. <code>error.executionId</code> names it.</> },
          ]}
        />
      </Endpoint>

      <h2 id="sell">Sell a workflow</h2>
      <p>
        A workflow of yours can be put on sale. People of other organizations run it from its page or from their code,
        and pay for each run from their WheelsAI credits or start one of your plans: a number of runs for 30 days. The
        run happens in your organization, as your workflow, and they never see its steps, its agents, its models or its
        settings. In the dashboard this is the <strong>Sell</strong> card on the workflow&apos;s <strong>API</strong>{" "}
        tab; the <Link href="/docs/guides/marketplace#sell-workflow">marketplace guide</Link> walks through it.
      </p>

      <Endpoint id="list-workflow" method="POST" path="/api/marketplace/listings" auth="API key or session" title="Put a workflow on sale">
        <p>
          A workflow is listed by the route that lists an agent, with <code>orchestrationId</code> in place of{" "}
          <code>agentId</code>. Send one of the two: a request with both, or with neither, answers <code>400</code>{" "}
          <code>validation_failed</code>, &quot;Send agentId or orchestrationId, one of them.&quot;
        </p>
        <Fields
          fields={[
            { name: "orchestrationId", type: "uuid", required: true, description: "One of your workflows. A workflow has one listing." },
            { name: "title", type: "string", required: true, description: "3 to 100 characters, with a letter or a digit among them: the listing's slug is made from it." },
            { name: "shortDescription", type: "string", required: true, description: "10 to 280 characters. The one line under the title on the workflow's page." },
            { name: "category", type: "enum", required: true, description: <>One of the <Link href="/docs/api/marketplace#search">marketplace categories</Link>.</> },
            { name: "pricingModel", type: "enum", required: true, description: <><code>per_request</code>. A workflow is sold per run.</> },
            { name: "pricePerRequestCents", type: "integer", required: true, description: "The price of one run: 5 to 100,000." },
            { name: "sells", type: "enum", description: <><code>use</code>, or left out.</> },
            { name: "publish", type: "true", description: "Puts it on sale in the same request." },
            { name: "longDescription, readme, iconUrl, screenshots", type: "", description: <>As on <Link href="/docs/api/marketplace#create-listing">an agent&apos;s listing</Link>.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "orchestrationId": "'"$WORKFLOW_ID"'",
    "title": "Weekly Release Notes",
    "shortDescription": "Turns a week of merged changes into release notes.",
    "category": "coding",
    "pricingModel": "per_request",
    "pricePerRequestCents": 25,
    "publish": true
  }'`}
        />
        <p>
          Answers <code>201</code> with <code>&#123; listing &#125;</code>. Its <code>productKind</code> is{" "}
          <code>workflow</code>, its <code>agentId</code> is <code>null</code> and its <code>unit</code> is{" "}
          <code>run</code>; it carries <code>orchestrationId</code>, which only your own reads of a listing say. Its{" "}
          <code>slug</code> is the name buyers know the workflow by: its page is <code>/w/&#123;slug&#125;</code> and its
          model on <code>/v1</code> is <code>w/&#123;slug&#125;</code>. Your own <code>workflow/&lt;slug&gt;</code> stays
          yours: it runs as you and counts as an API call of yours.
        </p>
        <ul>
          <li>
            <code>400</code> <code>validation_failed</code> with <code>message</code> (the first problem) and{" "}
            <code>fields</code> (each field and its sentence): <code>sells</code> set to <code>copies</code>, &quot;A
            workflow is sold by use. Copies of a workflow are not sold.&quot;; a <code>pricingModel</code> other than{" "}
            <code>per_request</code>, &quot;A workflow is sold per run. Add plans for buyers who want a number of uses
            for 30 days.&quot;; <code>pricePerRequestCents</code> left out or from 1 to 4, &quot;The price per run
            must be at least $0.05.&quot;; <code>allowedTools</code> with anything in it, &quot;A workflow listing has no tools
            to allow.&quot;; a <code>title</code> with no letter or digit, &quot;Give the listing a title with letters
            or numbers.&quot;
          </li>
          <li>
            <code>404</code> <code>workflow_not_found</code>: no workflow with that id in your organization.
          </li>
          <li>
            <code>409</code> <code>workflow_not_sellable</code>: the workflow cannot be on sale as it is. The message
            says why, in the words of <a href="#sellable">the table below</a>.
          </li>
          <li>
            <code>409</code> <code>listing_exists</code>: &quot;This workflow already has a listing.&quot; Edit that one.{" "}
            <code>409</code> <code>listing_name_taken</code>: another listing took the name at the same moment; try again.
          </li>
        </ul>
        <p>
          The rest works as it does for <Link href="/docs/api/marketplace#manage-listing">an agent&apos;s listing</Link>.{" "}
          <code>PATCH /api/marketplace/listings/&#123;id&#125;</code> changes its words, its category and its price per
          run, with the refusals above; it takes neither <code>agentId</code> nor <code>orchestrationId</code>, because a
          listing keeps what it sells. <code>POST /api/marketplace/listings/&#123;id&#125;/publish</code> puts it on sale,
          and <code>POST /api/marketplace/listings/&#123;id&#125;/archive</code> stops selling it: it leaves the
          marketplace, and buyers on a plan keep it until the 30 days they paid for end. Until then they run it at{" "}
          <code>POST /api/w/&#123;slug&#125;/run</code> and as model <code>w/&#123;slug&#125;</code>, and its page and its
          API page stay up for them until the last of those plans ends.{" "}
          <code>GET /api/marketplace/my-listings</code> carries <code>productKind</code> and{" "}
          <code>orchestrationId</code> on each listing.
        </p>
        <p>
          Plans are set with <Link href="/docs/api/marketplace#plans"><code>PUT /api/marketplace/listings/&#123;id&#125;/plans</code></Link>,
          as for an agent sold per use: up to four, each a price for 30 days and a number of uses, where one run is one
          use. A workflow has no free trial: an entry of kind <code>trial</code> is refused on its field with &quot;A
          free trial can be offered on an agent only.&quot; A workflow&apos;s listing has no token and no copies.
        </p>
      </Endpoint>

      <h3 id="sellable">What keeps it on sale</h3>
      <p>
        A workflow can be on sale only while each of these holds. It is asked when the listing is created, changed or
        published, before a buyer starts using it, starts a plan or moves to a bigger one, and before every paid run.
      </p>
      <DocTable
        caption="What a workflow on sale must be"
        columns={[
          { key: "rule", label: "It must" },
          { key: "said", label: "What is said when it does not" },
        ]}
        rows={[
          { rule: "Be enabled.", said: "This workflow is disabled. Enable it before selling it." },
          { rule: "Have a step.", said: "This workflow has no steps yet." },
          { rule: "Use only agents you built, in its steps and as fallbacks.", said: "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built." },
          { rule: <>Have a time limit (<code>timeout</code>) of 600,000 or less.</>, said: "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less." },
          { rule: "Have every agent its steps name still in your organization.", said: "This workflow has a step whose agent no longer exists. Choose another agent for that step." },
        ]}
      />
      <ul>
        <li>
          While its listing is published, or anyone is still on a plan for it, a change that would break one of these
          is not saved. Disabling it answers <code>409</code> <code>workflow_on_sale</code>, &quot;This workflow is
          on sale. Stop selling it first.&quot; A change of its steps or its time limit answers <code>409</code>{" "}
          <code>workflow_on_sale</code>, &quot;This workflow is on sale, so this change cannot be saved.&quot; followed by
          the sentence of what would be wrong. Once the listing is no longer published and only a running plan holds it,
          the same code says &quot;People are still on a plan for this workflow. It can be changed once their 30 days
          end.&quot;
        </li>
        <li>
          Deleting a workflow whose listing is published answers <code>409</code> <code>workflow_on_sale</code> and
          cancels nothing. Deleting one that anybody has ever started to use answers <code>409</code>{" "}
          <code>workflow_has_buyers</code>, &quot;People have paid for this workflow, so it cannot be deleted. Stop
          selling it instead: it leaves the marketplace, and buyers on a plan keep it until the 30 days they paid for
          end.&quot; A listing nobody started on is deleted with the workflow, plans and all.
        </li>
        <li>
          A workflow can still stop being able to run while it is on sale: a model step&apos;s deployment is stopped,
          or a step agent&apos;s model has no deployment that can serve it. Then every start and every run is refused
          and nobody is charged. A plan that comes due is not charged while it cannot run. If it runs again within 3
          days after the plan&apos;s 30 days ended, the plan is charged then and its new 30 days count from the day it
          was due; after those days it ends, uncharged. The days already paid for keep counting. That holds while its
          listing is published; once it is not, every plan on it ends at the end of its 30 days, uncharged, whatever the
          workflow can do. Before a stop,{" "}
          <Link href="/docs/api/deployments#dependents"><code>GET /api/deployments/&#123;deploymentId&#125;/dependents</code></Link>{" "}
          names the workflows on sale that need the deployment, under <code>workflows</code>.
        </li>
      </ul>

      <h3 id="paid-runs">A paid run</h3>
      <ul>
        <li>
          It runs in your organization and appears in the workflow&apos;s runs with <code>triggeredBy</code>{" "}
          <code>paid</code> and what the buyer sent as its <code>input</code>. Its <code>triggeredById</code> is{" "}
          <code>null</code>: nothing in it names the buyer.
        </li>
        <li>
          In a paid run your steps cannot move money, change your saved files or call a web address with the HTTP
          request tool.
        </li>
        <li>
          A paid run is stopped after 10 minutes at the latest, by the workflow&apos;s own time limit.{" "}
          <code>GET /api/capabilities</code> says the same number as <code>paidUse.paidWorkflowMaxRunMs</code>, in
          milliseconds. At most 3 paid
          runs of one workflow go at once, shared by everyone who uses it: one more is refused, and its buyer pays
          nothing for it. Paid runs are not counted toward your organization&apos;s own limit of runs (
          <code>workflow_run_limit</code>), and your own runs take none of their places.
        </li>
        <li>
          The buyer is charged when the run starts. When the answer is delivered you are credited 90% of the price, and
          WheelsAI keeps 10%; when the steps ran on WheelsAI&apos;s models, the cost of the model comes out of your share.
          A plan&apos;s 30 days are shared the same way, and a run on a plan takes one of its uses.
        </li>
        <li>
          A run that fails, takes too long, is cancelled, completes with nothing to say, or whose answer is not
          delivered, is refunded to the buyer in full, or its use is given back to the plan, and you are credited
          nothing for it. Steps that ran before a run failed or was cancelled are your cost.
        </li>
        <li>
          The answer is the run&apos;s output, read as the <a href="#openai">OpenAI-compatible endpoint</a> reads it. An
          answer that repeats eight consecutive words of the instructions of one of its step agents is withheld and
          refunded.
        </li>
      </ul>

      <h2 id="use-paid">Use a workflow you pay for</h2>
      <p>
        A workflow someone sells is named by the slug of its listing: its page is <code>/w/&#123;slug&#125;</code>, you
        run it at <code>POST /api/w/&#123;slug&#125;/run</code> or as model <code>w/&#123;slug&#125;</code> on{" "}
        <code>/v1/chat/completions</code>, and its API page, <code>/w/&#123;slug&#125;/api</code>, shows these calls
        filled in. Its page, its API page and the answers of a run say nothing of its steps, its agents, its models
        or the organization that sells it.
      </p>
      <ul>
        <li>
          Start first, as for an agent: agree to the price per run or start a plan with{" "}
          <Link href="/docs/api/marketplace#use"><code>POST /api/marketplace/listings/&#123;id&#125;/use</code></Link>, where{" "}
          <code>id</code> is the <code>listingId</code> of its page. That needs an owner or admin, or a key granted{" "}
          <code>marketplace:install</code> by name. A workflow that cannot run right now is not started: <code>409</code>{" "}
          <code>not_offered</code>, &quot;This workflow cannot be started right now. Nothing was charged. Try again
          later.&quot; A workflow has no free trial.
        </li>
        <li>
          To run it, a key needs the <code>agents:use</code> scope and both spend caps (see{" "}
          <Link href="/docs/api/jobs#keys">API keys that can spend</Link>); a session works too. A paid run is not
          counted among your organization&apos;s own API calls.
        </li>
        <li>
          One run is one use. It is charged when it starts and refunded if no answer is delivered; on a plan it takes
          one use, given back if no answer is delivered. A charge whose request was cut off before its run ended is
          given back within about 20 minutes.
        </li>
        <li>
          The answer arrives whole, after the run ended and its answer was checked. Every answer says what it cost in{" "}
          <code>billing</code> and in the <Link href="/docs/api/agents#paid-headers">usage headers</Link>, the same as
          an agent&apos;s; plans and their counts are told as in <Link href="/docs/api/agents#paid-plans">plans</Link>,
          and the <Link href="/docs/api/agents#paid-limits">limits</Link> are an agent&apos;s: 10 runs a minute, and 200
          a day with no plan, in place of which a plan has its count.
        </li>
        <li>
          The owner of the workflow gets a copy of what you send and what it answers: it appears in their workflow&apos;s
          runs.
        </li>
      </ul>

      <Endpoint id="w-page" method="GET" path="/api/w/{slug}" auth="Public" title="Read a workflow's page">
        <p>
          What its page shows before anyone pays. No sign-in. A slug that names no workflow on sale, the slug of an
          agent&apos;s listing and a listing that is not on sale all answer <code>404</code>{" "}
          <code>&#123; &quot;error&quot;: &quot;workflow_not_found&quot; &#125;</code>, except a listing taken off sale
          while somebody&apos;s plan on it still runs: it answers as before, with no plans on offer, until the last of
          those plans ends. The same holds for its API page.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "kind": "workflow",
  "listingId": "5d2f9c1e-...",
  "slug": "weekly-release-notes",
  "title": "Weekly Release Notes",
  "description": "Turns a week of merged changes into release notes.",
  "pricingModel": "per_request",
  "unit": "run",
  "priceCents": 25,
  "plans": [
    { "id": "7c1e4b02-...", "name": "Team", "priceCents": 2900, "includedUses": 200, "extraUsePriceCents": null }
  ],
  "trial": null,
  "keepsCopy": true,
  "maxRunMinutes": 10,
  "input": {
    "schema": {
      "type": "object",
      "properties": { "prompt": { "type": "string", "minLength": 1, "maxLength": 20000 } },
      "required": ["prompt"]
    },
    "maxInputBytes": 65536,
    "maxPromptChars": 20000
  }
}`}
        />
        <ul>
          <li>
            <code>title</code> and <code>description</code> are the listing&apos;s, and <code>priceCents</code> is the
            price of one run. <code>plans</code> is the plans on offer, in the order they are shown.
          </li>
          <li>
            <code>input.schema</code> is the workflow&apos;s form, as a JSON Schema whose properties are its fields. A
            workflow whose form has no fields takes one text field, <code>prompt</code>, as in the example.{" "}
            <code>maxInputBytes</code> is the most a run takes, as JSON, and <code>maxPromptChars</code> the longest{" "}
            <code>prompt</code>.
          </li>
          <li>
            <code>GET /api/w/&#123;slug&#125;/api</code>, open to anyone too, is what its API page draws: the addresses,
            the model id, the price, the plans, the limits (<code>maxActiveRuns</code> among them), the usage headers and
            a list of refusals. That list is the one the page explains; the full list is{" "}
            <a href="#w-errors">below</a>.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="w-access" method="GET" path="/api/w/{slug}/access" auth="API key or session" title="Where you stand with a workflow">
        <p>
          The answer of <Link href="/docs/api/agents#paid-access">an agent&apos;s access read</Link>, for the workflow.
          It is a read: it costs nothing and takes no use. A key needs no scope for it.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "access": "listing_pricing",
  "listingId": "5d2f9c1e-...",
  "terms": {
    "pricingModel": "per_request",
    "pricePerRequestCents": 25,
    "monthlyPriceCents": null,
    "unit": "run",
    "keepsCopy": true
  },
  "plans": [
    { "id": "7c1e4b02-...", "name": "Team", "priceCents": 2900, "includedUses": 200, "extraUsePriceCents": null }
  ],
  "plan": null,
  "trial": null,
  "trialAvailable": false,
  "trialNeedsCredits": false,
  "trialEnded": false,
  "accepted": { "pricingModel": "per_request", "pricePerRequestCents": 25, "monthlyPriceCents": null },
  "subscription": null,
  "balanceCents": 475,
  "canAccept": true,
  "startBlocked": null,
  "paused": false
}`}
        />
        <ul>
          <li>
            <code>access</code> is <code>none</code>, <code>subscribed</code>, <code>listing_pricing</code>,{" "}
            <code>pricing_changed</code>, <code>subscription_lapsed</code>, <code>plan_ended</code> or{" "}
            <code>not_offered</code>, as for an agent, or <code>own_workflow</code> when the workflow is your
            organization&apos;s own.
          </li>
          <li>
            A workflow has no free trial and no pause: <code>trial</code> is <code>null</code>, the three fields of a
            trial are <code>false</code>, <code>startBlocked</code> is <code>null</code> and <code>paused</code> is{" "}
            <code>false</code>. Whether it can run now is told by a run, or by a start.
          </li>
          <li>
            <code>404</code> <code>workflow_not_found</code>.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="w-run" method="POST" path="/api/w/{slug}/run" auth="Session, or an API key with agents:use" title="Run a workflow you pay for">
        <Fields
          fields={[
            { name: "input", type: "object", required: true, description: <>One answer for each field of its form, by the field&apos;s name. For a form with no fields, <code>&#123; &quot;prompt&quot;: &quot;...&quot; &#125;</code>.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -i $WHEELSAI_API_URL/api/w/weekly-release-notes/run \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": {"field_name": "Your answer"}
  }'`}
        />
        <p>
          The body is <code>input</code> and nothing else: any other field, <code>stream</code> among them, answers{" "}
          <code>400</code> <code>invalid_request</code>. The answer is always one JSON body, sent when the run has ended:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "output": { "format": "text", "text": "Release notes: ..." },
  "billing": { "chargedCents": 25, "balanceCents": 450, "access": "listing_pricing" }
}`}
        />
        <p>
          <code>billing</code> is an agent&apos;s, with <code>plan</code> when you are on one. Answers that do not fit
          the form answer <code>400</code> <code>input_invalid</code> with <code>details</code>, and nothing is charged.
        </p>
      </Endpoint>

      <Endpoint id="w-v1" method="POST" path="/v1/chat/completions" auth="API key with agents:use, or session" title="Run a workflow you pay for through /v1">
        <p>
          Set <code>model</code> to <code>w/&lt;slug&gt;</code> and use any OpenAI client. A key needs{" "}
          <code>agents:use</code> and both caps. The messages are read as the{" "}
          <a href="#openai">OpenAI-compatible endpoint</a> of a workflow reads them: the last user message is the run&apos;s
          input. <code>tools</code>, <code>tool_choice</code>, and a system or tool message are refused with{" "}
          <code>400</code> <code>unsupported_parameter</code> before anything is charged. Sampling settings are accepted
          and not applied.
        </p>
        <CodeBlock
          language="bash"
          code={`curl -i $WHEELSAI_API_URL/v1/chat/completions \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "w/weekly-release-notes",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
        />
        <CodeBlock
          language="javascript"
          code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1\`,
  apiKey: process.env.WHEELSAI_API_KEY,
  timeout: 11 * 60 * 1000, // a run can take up to 10 minutes
  maxRetries: 0,            // a repeat is a new run, charged again
});

const reply = await client.chat.completions.create({
  model: "w/weekly-release-notes",
  messages: [{ role: "user", content: "Changes merged this week: ..." }],
});
console.log(reply.choices[0].message.content);`}
        />
        <ul>
          <li>
            The answer is OpenAI&apos;s shape plus <code>wheelsai: &#123; workflow: &#123; slug &#125;, billing &#125;</code>{" "}
            and nothing else, and it has no <code>usage</code>. Its <code>model</code> is <code>w/&lt;slug&gt;</code>.
          </li>
          <li>
            A stream opens only once the answer is whole and checked. Its first chunk has <code>choices: []</code> and
            the <code>wheelsai</code> object; then come the content chunks, a finish chunk and <code>data: [DONE]</code>.
          </li>
          <li>
            Errors are OpenAI-shaped, with <code>reason</code> set to the code of <a href="#w-errors">the table
            below</a> whenever <code>/v1</code> names it otherwise. Errors that repeating cannot fix carry{" "}
            <code>x-should-retry: false</code>.
          </li>
          <li>
            <Link href="/docs/api/inference#list-models"><code>GET /v1/models</code></Link> also lists, for each workflow
            of another organization that yours has started and pays for, on a plan that is running or at the price per
            run it agreed to,{" "}
            <code>&#123; id: &quot;w/&lt;slug&gt;&quot;, object: &quot;model&quot;, created, owned_by: &quot;wheelsai&quot;, wheelsai: &#123; kind: &quot;paid_workflow&quot; &#125; &#125;</code>.
            A workflow that cannot run at the moment, or a plan whose uses are gone, stays listed, and a run answers
            with its refusal.
          </li>
        </ul>
        <Callout title="Wait for the run">
          <p>
            Neither address sends anything while the run goes, and a run can take up to 10 minutes. Give your client a
            read timeout of at least 10 minutes, and make sure no proxy on the way cuts a quiet connection sooner. A
            connection that is cut cancels the run, and what was charged is given back.
          </p>
        </Callout>
      </Endpoint>

      <h3 id="w-errors">Refusals</h3>
      <p>
        <code>POST /api/w/&#123;slug&#125;/run</code> and <code>/api/w/&#123;slug&#125;/access</code> answer{" "}
        <code>&#123; error, message &#125;</code>, with the fields of an <Link href="/docs/api/agents#paid-errors">agent&apos;s
        refusals</Link> where they belong; <code>/v1</code> answers the code and the status of the third column. Show{" "}
        <code>message</code> as it comes. Where a charge was taken before the refusal, <code>refundedCents</code> says what
        was given back.
      </p>
      <DocTable
        caption="Refusals of a workflow you pay for"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error" },
          { key: "v1", label: "On /v1" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <code>invalid_request</code>, v1: <><code>400</code> <code>validation_failed</code></>, when: <>The body is not <code>&#123; input &#125;</code> alone; on <code>/v1</code>, no user message. Nothing was charged.</> },
          { status: <code>400</code>, code: <code>input_invalid</code>, v1: <><code>400</code> <code>validation_failed</code></>, when: <>The input does not fit the form. On the run address <code>details</code> lists what to change. Nothing was charged.</> },
          { status: <code>401</code>, code: "", v1: <code>401</code>, when: "Not signed in." },
          { status: <code>402</code>, code: <code>insufficient_credits</code>, v1: <><code>402</code> <code>marketplace_payment_required</code></>, when: <>Not enough credits for this run. <code>priceCents</code> and <code>balanceCents</code> say how much. Nothing was charged.</> },
          { status: <code>402</code>, code: <code>subscription_lapsed</code>, v1: <><code>402</code> <code>marketplace_payment_required</code></>, when: <>The code of an agent sold by the month; a workflow does not answer it. A plan whose renewal could not be paid ends once its days of grace are over, and then <code>plan_ended</code> applies.</> },
          { status: <code>402</code>, code: <code>plan_ended</code>, v1: <><code>402</code> <code>marketplace_payment_required</code></>, when: <>Your plan is over and you have not agreed to the price per run. <code>terms</code> and <code>plans</code> say what is on offer.</> },
          { status: <code>403</code>, code: <code>missing_scope</code>, v1: <><code>403</code> <code>insufficient_scope</code></>, when: <>A key without <code>agents:use</code>.</> },
          { status: <code>403</code>, code: <code>use_not_started</code>, v1: <><code>403</code> <code>use_not_started</code></>, when: <>You have not started using this workflow. <code>terms</code> says what it asks.</> },
          { status: <code>403</code>, code: <code>api_key_use_price_cap_exceeded</code>, v1: <><code>403</code> <code>api_key_use_price_cap_exceeded</code></>, when: "The price of one run is over the most one use of the key may cost." },
          { status: <code>403</code>, code: <code>api_key_daily_cap_exceeded</code>, v1: <><code>403</code> <code>api_key_daily_cap_exceeded</code></>, when: "The key's allowance for the day is used." },
          { status: <code>403</code>, code: <code>api_key_spend_caps_missing</code>, v1: <><code>403</code> <code>api_key_spend_caps_missing</code></>, when: "The key has no spend caps." },
          { status: <code>403</code>, code: <code>not_a_member</code>, v1: <><code>403</code> <code>not_a_member</code></>, when: "You are no longer a member of the organization that pays." },
          { status: <code>404</code>, code: <code>workflow_not_found</code>, v1: <><code>404</code> <code>workflow_not_found</code></>, when: "No workflow on sale by that slug." },
          { status: <code>409</code>, code: <code>own_workflow</code>, v1: <><code>409</code> <code>own_agent</code></>, when: "The workflow is your organization's own." },
          { status: <code>409</code>, code: <code>pricing_changed</code>, v1: <><code>409</code> <code>pricing_changed</code></>, when: <>The price went up since you agreed. <code>terms</code> says what it is now. Nothing is charged until you accept it.</> },
          { status: <code>409</code>, code: <code>not_offered</code>, v1: <><code>409</code> <code>not_for_sale</code></>, when: "The workflow is no longer offered." },
          { status: <code>409</code>, code: <code>not_for_sale</code>, v1: <><code>409</code> <code>not_for_sale</code></>, when: "Use of the workflow is not on sale, and you never started." },
          { status: <code>413</code>, code: <code>input_too_large</code>, v1: <><code>400</code> <code>validation_failed</code></>, when: <>A <code>prompt</code> over 20,000 characters or an input over 65,536 bytes; on the run address, also a body over 131,072 bytes. Nothing was charged.</> },
          { status: <code>429</code>, code: <code>rate_limited</code>, v1: <><code>429</code> <code>rate_limit_exceeded</code></>, when: <>Your limit for this workflow, with <code>retryAfterSeconds</code>. Nothing was charged.</> },
          { status: <code>429</code>, code: <code>plan_used_up</code>, v1: <><code>429</code> <code>plan_used_up</code></>, when: "Every use of your plan is gone and it stops until it renews. Nothing was charged." },
          { status: <code>429</code>, code: <code>too_many_refunds</code>, v1: <><code>429</code> <code>rate_limit_exceeded</code></>, when: "Several of your runs could not be delivered today. Try again tomorrow." },
          { status: <code>429</code>, code: <code>workflow_busy</code>, v1: <><code>429</code> <code>rate_limit_exceeded</code></>, when: <>Every paid run the workflow can hold is going: 3 at once, shared by everyone who uses it. Try again in a minute. When this is found after the charge, the charge was refunded or the use given back, and <code>/v1</code> adds <code>x-should-retry: false</code>.</> },
          { status: <code>499</code>, code: <code>client_closed_request</code>, v1: <><code>499</code> <code>client_closed_request</code></>, when: "You closed the connection before the answer arrived. The run was cancelled and the charge refunded." },
          { status: <code>502</code>, code: <code>run_failed</code>, v1: <><code>502</code> <code>workflow_failed</code></>, when: "The workflow could not finish this run. The charge was refunded, or the use given back." },
          { status: <code>502</code>, code: <code>answer_withheld</code>, v1: <><code>502</code> <code>answer_withheld</code></>, when: "The answer could not be shown. The charge was refunded, or the use given back." },
          { status: <code>503</code>, code: <code>workflow_unavailable</code>, v1: <><code>503</code> <code>service_unavailable</code></>, when: "The workflow cannot run right now, or the service is restarting. Nothing was charged, or what was taken was given back." },
          { status: <code>503</code>, code: <code>rate_limiter_unavailable</code>, v1: <><code>503</code> <code>service_unavailable</code></>, when: "The limit check is not available right now. Try again shortly." },
          { status: <code>504</code>, code: <code>run_timed_out</code>, v1: <><code>504</code> <code>workflow_timeout</code></>, when: "The workflow took too long and was stopped. The charge was refunded, or the use given back." },
        ]}
      />

      <h2 id="scheduler">Scheduler</h2>
      <p>
        A scheduled task has a type, a payload for that type, and a schedule: <code>cron</code> (five fields, read in the
        task&apos;s time zone), <code>interval</code> (at least 60 seconds) or <code>once</code>.
      </p>

      <Endpoint id="task-types" method="GET" path="/api/scheduler/task-types" auth="API key or session" title="Task types">
        <p>
          Lists every task type with its payload fields, whether it needs an agent or a workflow, and whether it is
          available. A type or option that is temporarily unavailable is listed with <code>available: false</code> and a{" "}
          <code>reason</code>, and is refused when a task that needs it is saved. <code>schedulerEnabled</code> is{" "}
          <code>false</code> while scheduling is paused.
        </p>
        <DocTable
          caption="Task types and their payloads"
          columns={[
            { key: "type", label: "taskType" },
            { key: "needs", label: "Needs" },
            { key: "payload", label: "payload" },
          ]}
          rows={[
            { type: <code>agent_run</code>, needs: "agentId", payload: <><code>prompt</code>, <code>stampTime?</code> (<code>true</code> puts the run&apos;s date and time, in the task&apos;s time zone, ahead of the prompt; left out, it is off), <code>deliver?</code> (<code>&#123; alertChannelId &#125;</code>: send the finished result to one of your alert channels; the result is always saved on the run as well). Sends the prompt to the agent and records the reply. <code>inference</code> is an older name for the same thing, with the same fields. An agent&apos;s own schedule is a task of this type; see <Link href="/docs/api/agents#schedule-and-runs">schedule and runs</Link>.</> },
            { type: <code>workflow_run</code>, needs: "orchestrationId", payload: <><code>prompt?</code>, <code>input?</code>. Starts a run of the workflow; the execution follows the run&apos;s outcome. Not retried.</> },
            { type: <code>webhook</code>, needs: "nothing", payload: <><code>url</code>, <code>body?</code>, <code>headers?</code>. POSTs JSON that also carries <code>taskId</code>, <code>executionId</code> and <code>attempt</code>.</> },
            { type: <code>data_sync</code>, needs: "a knowledge base, or an agent that has one", payload: <><code>sources</code> (1 to 10 <code>&#123; url, title? &#125;</code>), <code>knowledgeBaseId?</code>, <code>maxBytes?</code>. Adds new content, replaces changed content, leaves unchanged content alone.</> },
            { type: <code>health_check</code>, needs: "depends on the target", payload: <><code>target</code> (<code>agent</code>, <code>deployment</code>, <code>url</code> or <code>monitor</code>) with <code>deploymentId</code>, <code>url</code> or <code>monitorId</code>; <code>expectedStatus</code>, <code>expectedBody?</code>, <code>timeoutSeconds</code>, <code>onDown</code>. Fails unless the target is up. <code>onDown: &quot;restart_deployment&quot;</code> restarts a deployment that failed or that the platform stopped, never one you stopped yourself, and at most 5 times a day with a growing wait (5, 10, 20, 40 minutes) between tries; a skipped restart is reported with its reason in the run&apos;s <code>remediation</code>.</> },
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
        that a retry cannot fix (an unavailable feature, a refused URL, a bad payload), timeouts and cancels are not retried. A
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
          { event: <code>scheduled_task.completed</code>, when: "A scheduled task finishes with a result, whether its schedule or a person started it. Its data carries the first 2,000 characters of the answer." },
          { event: <code>report.generated</code>, when: <>A report task that asks for it with <code>deliver.webhookEvent</code> finishes.</> },
        ]}
      />

      <h2 id="errors">Errors</h2>
      <p>
        These endpoints follow the <Link href="/docs/api#errors">common error rules</Link>: <code>400 validation_failed</code>{" "}
        with <code>details</code> for a malformed request, <code>404</code> for anything not in your organization, and a
        scrubbed <code>500</code> for the unexpected. A capability that is temporarily unavailable answers <code>501</code>{" "}
        or is listed as unavailable; nothing reports a success that did not happen.
      </p>
    </DocPage>
  );
}
