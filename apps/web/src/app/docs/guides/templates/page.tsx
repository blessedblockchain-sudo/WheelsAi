import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Start a WheelsAI agent from a template: browse the public gallery, create an agent from a template in the dashboard or over the API.",
};

const toc = [
  { id: "browse", title: "Browse templates" },
  { id: "use", title: "Create an agent from a template" },
  { id: "api", title: "Templates over the API" },
];

export default function TemplatesGuidePage() {
  return (
    <DocPage
      href="/docs/guides/templates"
      title="Templates"
      lead="Templates are ready-made agents published by the WheelsAI team: a framework, a system prompt, tools, model settings and, for some, source code or a visual workflow graph. Starting from one is the fastest way to a working agent."
      toc={toc}
    >
      <h2 id="browse">Browse templates</h2>
      <p>
        The <Link href="/templates">template gallery</Link> is public: you can browse it without an account. Each template shows
        its framework, category, difficulty and tags. Signed-in users see the same catalog under{" "}
        <strong>Templates</strong> in the dashboard.
      </p>

      <h2 id="use">Create an agent from a template</h2>
      <p>
        Choose <strong>Use template</strong>, then give the new agent a name and slug. WheelsAI creates the agent in your
        organization with the template&apos;s framework, system prompt, tools, model settings and source. If the template
        includes a workflow graph, the agent gets it too, ready to open in the visual builder. The new agent is yours to edit like
        any other.
      </p>
      <p>
        A template-created agent counts toward your plan&apos;s agent limit (3 on Starter). Then open it in the{" "}
        <Link href="/docs/guides/getting-started#playground">playground</Link> to try it.
      </p>

      <h2 id="api">Templates over the API</h2>
      <p>Listing and reading templates needs no authentication:</p>
      <CodeBlock
        language="bash"
        code={`# Published templates, featured first. Filters: category, framework, difficulty,
# isFeatured=true|false, search; paging: limit (default 20), offset.
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
  -d '{"name":"My research agent","slug":"my-research-agent"}'`}
      />
      <p>
        The response is the created agent (<code>201</code>). The template catalog itself is maintained by the WheelsAI team;
        publishing your own agent for others is done through the <Link href="/docs/guides/marketplace">marketplace</Link>.
      </p>
    </DocPage>
  );
}
