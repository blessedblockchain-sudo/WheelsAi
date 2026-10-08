import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable, Founder } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Web chat widget and Try it",
  description:
    "Put a WheelsAI agent on your own site as a chat widget: the key, the allowed sites, the snippet, the Content-Security-Policy lines, limits, what visitors' chats can and cannot do, and saved conversations. Also how Try it works on marketplace listings.",
};

const toc = [
  { id: "what", title: "What the widget is" },
  { id: "create", title: "1. Create a key" },
  { id: "origins", title: "2. Allow your sites" },
  { id: "embed", title: "3. Paste the snippet" },
  { id: "csp", title: "Content-Security-Policy" },
  { id: "script", title: "Controlling it from your page" },
  { id: "limits", title: "Limits" },
  { id: "tools", title: "What a visitor's chat can do" },
  { id: "transcripts", title: "Saved conversations" },
  { id: "branding", title: "Powered by WheelsAI" },
  { id: "errors", title: "What visitors see when it refuses" },
  { id: "api", title: "API" },
  { id: "try-it", title: "Try it on marketplace listings" },
];

export default function WebChatWidgetGuidePage() {
  return (
    <DocPage
      href="/docs/guides/web-chat-widget"
      title="Web chat widget and Try it"
      lead="Web is a chat channel like Discord, Telegram and Slack: a widget you paste into your own site that talks to one of your agents. Try it is the same public chat on a marketplace listing, free and limited, before someone installs or hires the agent."
      toc={toc}
    >
      <h2 id="what">What the widget is</h2>
      <p>
        One script tag. It adds a chat button to the corner of your page; visitors open it and talk to your agent, and the
        answer streams in as it is written. The script has no dependencies, draws inside a shadow root so your styles and
        its styles do not touch, works with a keyboard and a screen reader, follows the visitor&apos;s light or dark
        setting and fills the screen on a phone.
      </p>
      <p>
        The widget is driven by a <strong>web chat key</strong>. A key belongs to one agent, lists the sites that may use
        it, and carries its own limits and look. The key is public by design: it is printed in the snippet.
      </p>

      <h2 id="create">1. Create a key</h2>
      <p>
        In the dashboard open <Link href="/dashboard/integrations?tab=channels">Channels, then Website chat</Link>, choose{" "}
        <strong>New key</strong>, pick the agent and give the key a name. Owners and admins can create, edit, rotate and
        revoke keys; every member can see them. An agent can have up to 20 live keys, for example one per site.
      </p>
      <p>
        <strong>Preview here</strong> opens the real widget on the dashboard page. The dashboard&apos;s own address is
        always allowed, so you can try a key before any site is listed. Messages sent in the preview are real: they count
        toward the key&apos;s limits and your plan.
      </p>

      <h2 id="origins">2. Allow your sites</h2>
      <p>
        List the origins that may use the key, one a line. An origin is a scheme and a host, with a port if it is not the
        default, and nothing after it:
      </p>
      <DocTable
        caption="Allowed sites"
        columns={[
          { key: "entry", label: "Entry" },
          { key: "meaning", label: "What it allows" },
        ]}
        rows={[
          { entry: <code>https://www.example.com</code>, meaning: "Exactly that site." },
          {
            entry: <code>https://*.example.com</code>,
            meaning: (
              <>
                Every subdomain, such as <code>https://shop.example.com</code>. Not the bare{" "}
                <code>https://example.com</code>: add that as its own line.
              </>
            ),
          },
          { entry: <code>http://localhost:5173</code>, meaning: "A local development server. Plain http is accepted for localhost only." },
        ]}
      />
      <p>
        Paths, query strings, <code>http://</code> on a public host and anything that is not a web origin are refused with{" "}
        <code>400 invalid_origin</code>, naming the entry. A key can list up to 20 origins. With none listed, only the
        dashboard preview works.
      </p>
      <Callout variant="warning" title="The list is enforced by browsers, not by secrecy">
        <p>
          A browser tells the API which site a request comes from, and the API refuses a site that is not listed. A script
          outside a browser can send any origin it likes. So the allowed sites keep your widget off other people&apos;s
          pages; what bounds usage is the limits below, which WheelsAI counts itself and which refuse when they cannot be
          counted. Do not treat the key as a secret, and rotate it if it is being misused.
        </p>
      </Callout>

      <h2 id="embed">3. Paste the snippet</h2>
      <p>
        Copy the snippet shown on the key and paste it before <code>&lt;/body&gt;</code> on every page that should have
        the chat. It looks like this, with your key and the two WheelsAI addresses filled in:
      </p>
      <CodeBlock
        language="html"
        code={`<script src="https://<app address>/widget.js"
        data-wheelsai-key="wpk_..."
        data-api="https://<api address>" async></script>`}
      />
      <p>
        The dashboard always shows the exact snippet for your key, so copy it from there rather than writing the addresses by
        hand. If the snippet is temporarily unavailable, the dashboard says so in its place.
      </p>
      <p>
        <strong>Rotate</strong> gives the key a new value: every page carrying the old snippet stops showing a working
        chat until you paste the new one. <strong>Revoke</strong> is permanent. The switch on each key pauses it without
        changing the snippet.
      </p>

      <h2 id="csp">Content-Security-Policy</h2>
      <p>If your site sends a Content-Security-Policy, it needs two entries:</p>
      <CodeBlock
        language="text"
        code={`script-src  https://<app address>;
connect-src https://<api address>;`}
      />
      <p>
        No <code>style-src &apos;unsafe-inline&apos;</code> is needed: the widget builds its stylesheet in script
        (constructable stylesheets). In a browser without them it falls back to a <code>&lt;style&gt;</code> element and
        carries the <code>nonce</code> of its own script tag, so give the tag your nonce if you use one.
      </p>

      <h2 id="script">Controlling it from your page</h2>
      <p>
        Once loaded, the script exposes <code>window.WheelsAI</code>:
      </p>
      <DocTable
        caption="window.WheelsAI"
        columns={[
          { key: "call", label: "Call" },
          { key: "does", label: "What it does" },
        ]}
        rows={[
          { call: <code>WheelsAI.open()</code>, does: "Opens the chat panel." },
          { call: <code>WheelsAI.close()</code>, does: "Closes it and returns focus to the chat button." },
          { call: <code>WheelsAI.toggle()</code>, does: "Opens or closes." },
          { call: <code>WheelsAI.reset()</code>, does: "Forgets this tab's conversation and starts a new one." },
          { call: <code>WheelsAI.destroy()</code>, does: "Removes the widget from the page." },
        ]}
      />
      <p>
        The conversation is kept in the page&apos;s <code>sessionStorage</code> for the browser tab, so it survives moving
        between pages of your site and is gone when the tab closes. The script loads once: a second copy on the same page
        does nothing and says so in the console.
      </p>

      <h2 id="limits">Limits</h2>
      <p>Every message to a widget is counted against all of these before the agent runs:</p>
      <DocTable
        caption="Widget limits"
        columns={[
          { key: "limit", label: "Limit" },
          { key: "default", label: "Default" },
          { key: "change", label: "Who sets it" },
        ]}
        rows={[
          {
            limit: "Messages a minute, per visitor network",
            default: "10",
            change: "The platform. You can add a second limit per key (1 to 60); a visitor is held to both, so yours only matters when it is the lower one.",
          },
          { limit: "Messages a day, per visitor network", default: "200", change: "The platform" },
          { limit: "Messages a minute, per key", default: "60", change: "The platform" },
          { limit: "Messages a day, per key", default: "1,000", change: "You, per key (1 to 100,000)" },
          { limit: "One message", default: "4,000 characters", change: "The platform" },
          { limit: "The conversation sent with a message", default: "20 turns, 16,000 characters", change: "The platform" },
        ]}
      />
      <p>
        <Founder>confirm the default widget limits above (WIDGET_* in the API configuration)</Founder>
      </p>
      <ul>
        <li>
          <strong>Visitors are counted by network</strong>, not by browser: an IPv4 address, or the /64 of an IPv6 address.
          Days are UTC.
        </li>
        <li>
          <strong>The limits fail closed.</strong> If the counter store cannot be reached, the widget answers{" "}
          <code>503</code> and no agent runs. It never runs uncounted.
        </li>
        <li>
          <strong>Your plan and model still apply.</strong> Each message is one API call on{" "}
          <Link href="/docs/guides/plans-and-billing#api-calls">your plan</Link>, an agent on a free model shares your
          organization&apos;s free-model limits, and an agent on a paid route spends your credits as it does anywhere else.
          A visitor is told only that the chat is unavailable, never why.
        </li>
        <li>
          <strong>An answer is bounded:</strong> at most 1,024 output tokens and three rounds of tool use per message.
        </li>
      </ul>

      <h2 id="tools">What a visitor&apos;s chat can do</h2>
      <p>
        A widget visitor is anonymous, so the agent runs with a reduced set of tools. A tool is withheld, not just refused
        after the fact, when it does any of these:
      </p>
      <ul>
        <li>moves money;</li>
        <li>writes state (for example <code>file_write</code>);</li>
        <li>reads saved private state (for example <code>file_read</code>);</li>
        <li>sends a request out to an address (for example <code>http_request</code>).</li>
      </ul>
      <p>
        Tools that only compute or look things up stay available: the calculator, web search, and knowledge search over
        the agent&apos;s own knowledge base. Knowledge search means a visitor can ask about anything in that knowledge
        base, so attach only material you are happy to publish. Visitors can also try to talk an agent into revealing its
        instructions; do not put secrets in a system prompt.
      </p>
      <p>
        A visitor can send only their own and the agent&apos;s earlier turns. A request that names a model, a system
        message or a tool result is refused with <code>400</code>.
      </p>

      <h2 id="transcripts">Saved conversations</h2>
      <p>
        Off by default: a widget chat is processed and not stored. Turn on <strong>Save conversations</strong> on a key
        and each delivered exchange is stored in your organization, with the site it came from. The widget then tells the
        visitor, under the message box, that the conversation is saved by the site owner. You are the one deciding to
        keep visitors&apos; messages, so say so in your own privacy notice. See also our{" "}
        <Link href="/privacy#widget">privacy policy</Link>.
      </p>

      <h2 id="branding">Powered by WheelsAI</h2>
      <p>
        The widget shows a small &quot;Powered by WheelsAI&quot; line. Hiding it is part of white-labelling, which the
        Enterprise plan includes; on other plans the setting answers <code>403 plan_limit_reached</code>. The plan is
        checked each time the widget loads, so the line returns if the plan changes.
      </p>

      <h2 id="errors">What visitors see when it refuses</h2>
      <DocTable
        caption="Refusals"
        columns={[
          { key: "status", label: "Answer" },
          { key: "when", label: "When" },
          { key: "shown", label: "In the widget" },
        ]}
        rows={[
          { status: <code>403 origin_not_allowed</code>, when: "The page's site is not on the key's list.", shown: "This chat is not set up for this site." },
          { status: <code>404 widget_key_not_found</code>, when: "The key is wrong, paused, rotated or revoked. The four are indistinguishable.", shown: "This chat is no longer available." },
          { status: <><code>429 rate_limited</code> with <code>Retry-After</code></>, when: "A limit above was reached. scope says which: ip, key or agent.", shown: "A countdown, then the visitor can send again." },
          { status: <code>503 rate_limiter_unavailable</code>, when: "The limits cannot be counted.", shown: "This chat is temporarily unavailable." },
          { status: <code>503 agent_unavailable</code>, when: "Your plan quota, credits, licence or model configuration stops the agent.", shown: "This chat is temporarily unavailable." },
          { status: <code>502 model_error</code>, when: "The model failed. The provider's own message is never passed on.", shown: "The agent could not answer just now." },
        ]}
      />
      <p>
        A streamed answer that fails part-way is not shown as if it were complete: the widget discards it and offers to
        try again.
      </p>

      <h2 id="api">API</h2>
      <p>
        Keys are managed under <code>/api/channels/web/keys</code> with a session or an API key:
      </p>
      <CodeBlock
        language="bash"
        code={`# Create a key for an agent
curl -s -X POST "$WHEELSAI_API_URL/api/channels/web/keys" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agentId": "<agent id>", "name": "Main site",
       "allowedOrigins": ["https://www.example.com"],
       "appearance": {"title": "Ask us", "primaryColor": "#2563eb"}}' | jq '.key.snippet'

# List keys with today's usage
curl -s "$WHEELSAI_API_URL/api/channels/web/keys" -H "Authorization: Bearer $WHEELSAI_API_KEY"

# Change, rotate, revoke
curl -s -X PATCH  "$WHEELSAI_API_URL/api/channels/web/keys/<id>" -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" -d '{"dailyMessageCap": 500, "enabled": true}'
curl -s -X POST   "$WHEELSAI_API_URL/api/channels/web/keys/<id>/rotate" -H "Authorization: Bearer $WHEELSAI_API_KEY"
curl -s -X DELETE "$WHEELSAI_API_URL/api/channels/web/keys/<id>" -H "Authorization: Bearer $WHEELSAI_API_KEY"`}
      />
      <p>
        <code>usageToday</code> on a key is the same counter the chat spends from; it is <code>null</code>, not zero, when
        the counter cannot be read. The widget itself calls two public routes, which you can also call from your own
        front end if you would rather build your own chat window:
      </p>
      <CodeBlock
        language="bash"
        code={`# The widget's look and limits. The Origin must be on the key's list.
curl -s "$WHEELSAI_API_URL/api/widget/wpk_.../config" -H "Origin: https://www.example.com"

# One message. Streams server-sent events unless "stream" is false.
curl -sN -X POST "$WHEELSAI_API_URL/api/widget/wpk_.../chat" \\
  -H "Origin: https://www.example.com" -H "Content-Type: application/json" \\
  -d '{"messages": [{"role": "user", "content": "What are your opening hours?"}]}'`}
      />
      <p>
        These two routes answer any origin at the CORS layer and never accept cookies; the key&apos;s allowed sites are
        what decide. The stream carries only answer text, the names of tools used and whether each worked, and a finish
        marker.
      </p>

      <h2 id="try-it">Try it on marketplace listings</h2>
      <p>
        Every published <Link href="/docs/guides/marketplace">marketplace listing</Link> has a <strong>Try it</strong>{" "}
        tab: a free chat with the listed agent, so a buyer can see how it answers before installing or hiring it. It is
        the same public chat as the widget, with the same reduced tools and the same fail-closed limits, and nobody is
        charged for it by default.
      </p>
      <ul>
        <li>
          <strong>It runs on a free model that WheelsAI provides</strong>, never on the publisher&apos;s provider keys.
          When that is not the model the installed agent is set up with, the tab says so: the preview&apos;s answers can
          differ from the installed agent&apos;s.
        </li>
        <li>
          <strong>Who can start one.</strong> Anyone signed in. A visitor who is not signed in must pass a human check
          (Cloudflare Turnstile); when the check is unavailable, the tab asks them to sign in. Try it never runs for
          anonymous visitors without the check.
        </li>
        <li>
          <strong>Limits.</strong> 10 messages a preview session (a session lasts 15 minutes and is tied to the
          visitor&apos;s network), 30 messages an hour per network, 100 a day per signed-in organization, and 50 free
          messages a day per listing. When the listing&apos;s day is used up the tab says when it starts again.{" "}
          <Founder>confirm the default Try it limits (TRIAL_* in the API configuration)</Founder>
        </li>
        <li>
          <strong>Publishers can pay for more.</strong> Under <Link href="/dashboard/marketplace">My listings</Link>,{" "}
          <strong>Try it settings</strong> sets how many extra messages a day you fund from your credits once the free
          ones run out. A funded message is charged when its answer is delivered and returned if it is not. If funded
          messages are temporarily unavailable, the setting answers <code>501 trial_funding_not_configured</code> and
          listings keep the free daily messages.
        </li>
        <li>
          <strong>Graph agents.</strong> Try it previews agents that answer with a single model. For an agent that answers
          through a graph of steps, the Try it tab shows a note instead and the API answers <code>501</code>.
        </li>
      </ul>
      <CodeBlock
        language="bash"
        code={`# What the tab shows: whether it can be tried, who may start, the model, the limits
curl -s "$WHEELSAI_API_URL/api/marketplace/listings/<slug>/try"

# Start a session (signed in), then chat
curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings/<slug>/try/session" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" -H "Content-Type: application/json" -d '{}'
curl -sN -X POST "$WHEELSAI_API_URL/api/marketplace/listings/<slug>/try/chat" \\
  -H "Content-Type: application/json" \\
  -d '{"sessionToken": "<from the session>", "messages": [{"role": "user", "content": "Hello"}]}'`}
      />
    </DocPage>
  );
}
