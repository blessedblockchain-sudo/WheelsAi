import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Start a WheelsAI agent from a template: each template has a kind (Chat, Task or Runs on its own), and using one takes a name only, in the dashboard or over the API.",
};

const toc = [
  { id: "browse", title: "Browse templates" },
  { id: "kind", title: "A template has a kind" },
  { id: "use", title: "Create an agent from a template" },
  { id: "api", title: "Templates over the API" },
];

export default function TemplatesGuidePage() {
  return (
    <DocPage
      href="/docs/guides/templates"
      title="Templates"
      lead="Templates are ready-made agents published by the WheelsAI team: a kind, a framework, a system prompt, tools, model settings and, for some, source code or a visual workflow graph. Starting from one is the fastest way to a working agent."
      toc={toc}
    >
      <h2 id="browse">Browse templates</h2>
      <p>
        The <Link href="/templates">template gallery</Link> is public: you can browse it without an account. Each template shows
        its kind, framework, category, difficulty and tags. Signed-in users see the same catalog in the dashboard, under{" "}
        <strong>Agents</strong> on its <strong>Templates</strong> tab, where it can be filtered by kind, category,
        framework and level. The create screen (<strong>Agents</strong>, then <strong>New agent</strong>) lists the
        templates too, as chips under <strong>Start from a template</strong>.
      </p>

      <h2 id="kind">A template has a kind</h2>
      <p>
        Every template is made for one of the three ways an agent is used, and says so with a badge wherever it is
        shown: in the gallery, on the Templates tab and on each chip of the create screen.
      </p>
      <ul>
        <li>
          <strong>Chat</strong>: people talk to it.
        </li>
        <li>
          <strong>Task</strong>: people fill in a short form and get one result back. The template brings its form.
        </li>
        <li>
          <strong>Runs on its own</strong>: it works on a schedule and delivers its results.
        </li>
      </ul>
      <p>
        An agent made from a template takes the template&apos;s kind, so its page opens on the matching tab:{" "}
        <strong>Chat</strong>, <strong>Run</strong> or <strong>Runs</strong>.
      </p>

      <h2 id="use">Create an agent from a template</h2>
      <p>
        On the Templates tab choose <strong>Use Template</strong>, give the new agent a <strong>Name</strong> and
        choose <strong>Create agent</strong>. A name is all it takes; an address of your own is optional, under{" "}
        <strong>Advanced</strong>. WheelsAI creates the agent in your organization
        with the template&apos;s kind, framework, system prompt, tools, model settings and source. If the template
        includes a workflow graph, the agent gets it too, ready to open in the visual builder. The new agent is yours
        to edit like any other.
      </p>
      <p>
        On the create screen, choosing a template&apos;s chip fills in the screen instead, so you can read and change
        what the agent will do before you create it. Choosing the chip again puts back what you had.
      </p>
      <p>
        A template-created agent counts toward your plan&apos;s agent limit (3 on Starter). It answers at once:{" "}
        <Link href="/docs/guides/getting-started#playground">try it</Link> on its first tab.
      </p>

      <h2 id="api">Templates over the API</h2>
      <p>Listing and reading templates needs no authentication:</p>
      <CodeBlock
        language="bash"
        code={`# Published templates, featured first. Filters: category, framework, difficulty,
# agentKind=conversation|task|scheduled, isFeatured=true|false, search;
# paging: limit (default 20), offset.
curl -s "$WHEELSAI_API_URL/api/templates?framework=mastra&limit=10"

# Categories that have at least one published template
curl -s "$WHEELSAI_API_URL/api/templates/categories"

# One template by id or slug
curl -s "$WHEELSAI_API_URL/api/templates/$TEMPLATE_SLUG"`}
      />
      <p>Creating an agent from a template is authenticated, and takes the template&apos;s id:</p>
      <CodeBlock
        language="bash"
        code={`curl -s -X POST "$WHEELSAI_API_URL/api/templates/$TEMPLATE_ID/use" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"My research agent"}'`}
      />
      <p>
        Only a name is needed, and one template can be used as often as you like: each agent gets its own slug, made from
        the name unless you send one. The agent takes the template&apos;s kind (<code>agentKind</code>) and its settings,
        such as a task form, and any field of <Link href="/docs/api/agents#create-agent">create an agent</Link> you send
        replaces the template&apos;s. The response (<code>201</code>) is the one that endpoint gives:{" "}
        <code>&#123; agent: &#123; id, name, slug, framework, agentKind, apiEndpoint, openaiBaseUrl, openaiModel &#125;, message &#125;</code>.
        A template that is not published answers <code>404</code> <code>template_not_found</code>, and over the plan&apos;s
        agent limit the answer is <code>403</code> <code>plan_limit_reached</code>. The template catalog itself is maintained by the WheelsAI team;
        publishing your own agent for others is done through the <Link href="/docs/guides/marketplace">marketplace</Link>.
      </p>
    </DocPage>
  );
}
