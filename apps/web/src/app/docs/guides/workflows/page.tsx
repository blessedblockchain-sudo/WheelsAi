import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Workflows and schedules",
  description:
    "Build a WheelsAI workflow on the canvas: steps, dependencies, branches, loops and parallel steps. Run it, watch it step by step, cancel it, and put it or any other task on a schedule.",
};

const toc = [
  { id: "build", title: "Build a workflow" },
  { id: "steps", title: "Step types", sub: true },
  { id: "prompts", title: "Prompts and variables", sub: true },
  { id: "branches", title: "Branches", sub: true },
  { id: "loops", title: "Loops", sub: true },
  { id: "parallel", title: "Parallel steps", sub: true },
  { id: "validation", title: "What is checked before you save", sub: true },
  { id: "run", title: "Run and watch" },
  { id: "schedule", title: "Schedule" },
  { id: "task-types", title: "Task types", sub: true },
  { id: "billing", title: "Billing and limits" },
];

export default function WorkflowsGuidePage() {
  return (
    <DocPage
      href="/docs/guides/workflows"
      title="Workflows and schedules"
      lead="A workflow runs several steps for one request: research then summarize, classify then branch, one step per item of a list. You draw it on a canvas, run it on demand or through the API, and schedule it."
      toc={toc}
    >
      <h2 id="build">Build a workflow</h2>
      <p>
        Open <strong>Workflows</strong> in the dashboard and choose <strong>New workflow</strong>. The editor is a canvas
        with a side panel:
      </p>
      <ul>
        <li>
          <strong>Add step</strong> puts a step on the canvas. Select it to choose what it runs and to write its prompt.
        </li>
        <li>
          Drag from the handle on a step&apos;s right edge onto another step to make the second step wait for the first.
          Click an arrow to remove it. The panel&apos;s <strong>Waits for</strong> list does the same without a pointer.
        </li>
        <li>
          With no step selected, the panel shows the workflow&apos;s own settings: how steps run, how many at once, the
          run time limit, default retries, and input and output schemas.
        </li>
        <li>
          <strong>Arrange</strong> lays the steps out by run order. Positions are saved with the workflow.
        </li>
      </ul>

      <h3 id="steps">Step types</h3>
      <DocTable
        caption="What a step can run"
        columns={[
          { key: "type", label: "Type" },
          { key: "runs", label: "Runs" },
          { key: "output", label: "Output" },
        ]}
        rows={[
          { type: "Agent", runs: "One of your agents, with its model, system prompt, tools and knowledge.", output: "The agent's reply, as text or parsed JSON." },
          { type: "Model", runs: "One of your model deployments on Nosana, directly, with no agent around it.", output: "The model's reply, as text or parsed JSON." },
          { type: "Retrieval", runs: "A search of one of your knowledge bases; the prompt is the search query.", output: <>The passages found, their joined <code>text</code>, and whether the search was semantic or keyword.</> },
        ]}
      />
      <Callout>
        <p>
          If a step type is temporarily unavailable, the editor tells you before you save. A run that reaches such a step
          fails with the same message; it is never reported as done.
        </p>
      </Callout>

      <h3 id="prompts">Prompts and variables</h3>
      <p>
        A step&apos;s prompt is a template. The chips under the prompt box insert variables, which are replaced when the
        step runs:
      </p>
      <CodeBlock
        language="text"
        code={`Write a reply to this customer.

Their message: {{input.prompt}}
What we found: {{steps.research.output}}
Category: {{steps.classify.output.category}}`}
      />
      <p>
        <code>input</code> is what the run was started with; the prompt typed in the Run dialog is{" "}
        <code>input.prompt</code>. To read a field of a step&apos;s output, such as <code>category</code> above, set that
        step&apos;s output format to JSON and ask it, in its prompt, to reply with JSON. The step then fails if the reply
        is not valid JSON, so a later step never branches on a guess.
      </p>
      <p>
        A step with an empty prompt receives the run prompt, or in a pipeline workflow the previous step&apos;s output.
      </p>

      <h3 id="branches">Branches</h3>
      <p>
        Turn on <strong>Run only if</strong> for a step and choose what to test, a comparison, and a value. When the rule
        does not hold the step is skipped, and so is every step that waits only for skipped steps. A step that waits for
        several steps runs when at least one of them succeeded, which is how two branches join again.
      </p>

      <h3 id="loops">Loops</h3>
      <ul>
        <li>
          <strong>Once for each item of a list</strong>: point the loop at a list (a JSON array from a JSON step, or text
          with one item per line). The step runs once per item, with the item and its index available as variables, and
          its output is the list of results. A list longer than the limit you set (at most 50) fails the step before
          anything is called.
        </li>
        <li>
          <strong>Repeat until a condition holds</strong>: the step runs again, up to 10 times, until the condition you
          give is true, for example until its own JSON output has <code>done</code> equal to true.
        </li>
      </ul>
      <p>
        A workflow&apos;s dependencies cannot form a circle; the editor refuses that arrow and points you to a step&apos;s
        Loop setting instead.
      </p>

      <h3 id="parallel">Parallel steps</h3>
      <p>
        In a <strong>Parallel</strong> workflow, steps that do not wait for each other run at the same time, up to the
        workflow&apos;s &quot;steps at once&quot; setting. The validation bar shows the stages: steps joined by a plus sign
        run together. In parallel mode a step can only read the output of steps it waits for, directly or through others,
        because nothing else is guaranteed to have finished.
      </p>

      <h3 id="validation">What is checked before you save</h3>
      <p>
        The bar above the canvas checks the workflow as you edit: first what the form itself can tell (a missing agent, a
        number out of range), then the plan WheelsAI makes of the workflow. It names the step and field at fault, and
        clicking a problem selects that step. When everything is in order it shows the order the steps will run in, and
        any warnings. Saving runs the same check, so a workflow cannot be saved in a state that would not run.
      </p>

      <h2 id="run">Run and watch</h2>
      <p>
        <strong>Run</strong> asks for a prompt and, optionally, more input as JSON. The run is queued and executes in the
        background; the page follows it live. Each step shows its status, the exact prompt it was sent, its output, its
        error if it failed, how many attempts it took and how long. A loop shows one entry per item or pass.
      </p>
      <p>
        A run&apos;s own final output is what its steps publish into it with an output mapping (under{" "}
        <strong>Advanced mappings</strong> in the step panel), for example the last step&apos;s reply as{" "}
        <code>answer</code>. A scheduled run stores that output on the task&apos;s execution.
      </p>
      <p>
        <strong>Cancel run</strong> stops a queued run at once. A running run stops before its next step and the call in
        flight is aborted, usually within a few seconds; steps that already finished stay in the results.
      </p>
      <p>
        To start runs from your own code, see <Link href="/docs/api/workflows#execute-workflow">Start a run</Link> in the
        API reference: the call answers at once and you poll the run.
      </p>
      <p>
        A workflow also answers as an OpenAI chat completion: one request runs it and returns its output as the
        assistant message. The <strong>API</strong> tab of a workflow shows its endpoint, the base URL for an OpenAI
        client, its model id (<code>workflow/&lt;slug&gt;</code>) and code to copy. See{" "}
        <Link href="/docs/api/workflows#openai">OpenAI-compatible endpoint</Link> for what a request costs and what
        happens to its run if you disconnect.
      </p>

      <h2 id="schedule">Schedule</h2>
      <p>
        <strong>Schedule</strong> on a workflow, or <strong>New task</strong> on the <strong>Scheduler</strong> page,
        creates a scheduled task. A schedule is one of:
      </p>
      <ul>
        <li>
          <strong>Cron</strong>: five fields, minute hour day-of-month month weekday, read in the task&apos;s time zone.{" "}
          <code>0 9 * * 1-5</code> is 09:00 on weekdays.
        </li>
        <li>
          <strong>Interval</strong>: every so many minutes, hours or days. The shortest interval is one minute.
        </li>
        <li>
          <strong>Once</strong>: a date and time in the task&apos;s time zone, in the future.
        </li>
      </ul>
      <p>
        If scheduling is temporarily paused, the Scheduler page says so at the top: tasks can still be saved and run by
        hand, and none fires on its own until scheduling resumes.
      </p>

      <h3 id="task-types">Task types</h3>
      <DocTable
        caption="What a scheduled task can do"
        columns={[
          { key: "type", label: "Task type" },
          { key: "does", label: "What it does" },
        ]}
        rows={[
          { type: "Agent run", does: "Sends a prompt to an agent and records the reply." },
          { type: "Workflow run", does: "Starts a run of a workflow. The task's execution links to the run and takes its outcome." },
          { type: "Webhook", does: "POSTs JSON to a public URL. The body carries ids so your receiver can drop duplicates." },
          { type: "Data sync", does: "Fetches up to ten web pages or text documents into a knowledge base: new content is added, changed content replaces the old document, unchanged content is left alone." },
          { type: "Health check", does: "Probes an agent runtime, a model deployment, a URL or an uptime monitor's target. The task fails unless the target is up, and can record the result on a monitor." },
          { type: "Report", does: "Builds a usage report (requests, cost by model, runs, conversations, marketplace revenue) for the organization or one agent, and can deliver it to your webhooks or an alert channel." },
          { type: "Cleanup", does: "Archives conversations idle for at least a day, deletes ones archived for at least a week, decays stale memories and prunes old run history, limited to your organization and, if you pick one, to one agent. A dry run only counts." },
          { type: "Custom (agent graph)", does: "Runs the graph you drew for an agent in the visual builder." },
        ]}
      />
      <p>
        The form shows the fields of the type you pick. A type, or an option of a type, that is temporarily unavailable
        is still listed, marked unavailable, and cannot be saved until it is back. Delivering a report to an email channel
        is offered when email delivery is available.
      </p>
      <p>
        Each task keeps its executions with their output and error; open one from the <strong>Executions</strong> tab. A
        task that fails is retried up to its retry count for types where a retry can help. Subscribe a{" "}
        <Link href="/docs/api/webhooks">webhook</Link> to <code>scheduled_task.failed</code>,{" "}
        <code>workflow.completed</code> and <code>workflow.failed</code> to be told when background work ends.
      </p>

      <h2 id="billing">Billing and limits</h2>
      <ul>
        <li>
          Every agent and model step is billed like the same call made directly. A loop bills once per item or pass, and
          every retry is another call.
        </li>
        <li>
          Steps and scheduled runs on free models count against the same free-model request limits as the playground.
          Over the limit, the step fails with that reason and no model is called.
        </li>
        <li>
          An organization can have a limited number of workflow runs queued or running at once (5 by default). The next
          start is refused with <code>429</code> until one finishes.
        </li>
        <li>A workflow has at most 25 steps; a run stops at its time limit (10 minutes by default, one hour at most).</li>
      </ul>
    </DocPage>
  );
}
