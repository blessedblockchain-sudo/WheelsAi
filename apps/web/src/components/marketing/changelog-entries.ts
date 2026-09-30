/**
 * Public changelog, curated from the repository's commit history (commit
 * bodies since 2026-08-01). Plain language, user-facing; internal-only
 * commits (docs, lint, audits, ops) are left out. Newest first.
 */

export type ChangeKind = "New" | "Improved" | "Fixed" | "Security";

export interface ChangeItem {
  kind: ChangeKind;
  title: string;
  body: string;
}

export interface ChangelogDay {
  date: string; // YYYY-MM-DD
  items: ChangeItem[];
}

export const CHANGELOG: ChangelogDay[] = [
  {
    date: "2026-09-30",
    items: [
      {
        kind: "New",
        title: "Token-gated marketplace listings",
        body: "Listings can now use the Tokenized pricing model. A tokenized listing is free until its agent token launches; after that, installing and running it require a wallet linked to someone in the buyer's organization to hold at least one token. Listings explain what buyers need, and a refused agent now says why it cannot run.",
      },
      {
        kind: "New",
        title: "Monthly subscriptions to marketplace agents",
        body: "Installing a monthly listing charges the first 30-day period from your credits, and each following period renews automatically. An unpaid renewal gets a 3-day grace period before the install is suspended. You can cancel at the end of the paid period, resume, or manage renewals from your installed agents.",
      },
      {
        kind: "New",
        title: "Starter, Pro and Enterprise plans",
        body: "Starter includes up to 3 agents and 1,000 API calls a month. Pro ($49/month, with a 14-day trial) includes unlimited agents, 100,000 API calls a month, higher free-model limits, custom domains, advanced analytics and priority marketplace placement. Enterprise is set up with the team. Limits answer with a clear error and an upgrade link.",
      },
      {
        kind: "New",
        title: "Card payments with Stripe",
        body: "Buy credit packs with Stripe Checkout, start Pro, and manage your payment method and invoices in Stripe's billing portal. Credits are granted only when Stripe confirms the payment, exactly once, and refunds take back the credits they paid for.",
      },
      {
        kind: "New",
        title: "Billing page shows your plan and usage",
        body: "See your plan, trial and renewal dates, and this month's agents and API calls against your limits. A new Contact sales page covers Enterprise.",
      },
      {
        kind: "New",
        title: "Email verification, password reset, and $5 on verification",
        body: "New accounts verify their email address, and verifying adds $5 of credits to your organization, once. Forgot your password? Reset it by email. Changing your email now asks for your current password.",
      },
      {
        kind: "New",
        title: "Team invites and organization switching",
        body: "Invite teammates by email as admins or members. An invite link works once, only for the invited address. If you belong to several organizations, switch between them from the sidebar.",
      },
      {
        kind: "Fixed",
        title: "Telegram channels connect",
        body: "Adding or re-enabling a Telegram channel now registers the bot's webhook with Telegram, and incoming updates are verified with Telegram's secret token, so messages reach your agent. Disabling or removing the channel unregisters it.",
      },
      {
        kind: "Improved",
        title: "Safer wallet sign-in",
        body: "Wallet sign-in messages now follow Sign-In With Solana: they name the site, the purpose, the chain and an expiry, and each message can be used only once.",
      },
      {
        kind: "Fixed",
        title: "Predictable billing for /v1 inference",
        body: "max_tokens is now capped at 8,192 and defaults to 4,096. The worst-case cost of a request is held before it runs and settled to actual usage afterwards, so balances can no longer go negative, and a request that never reaches a GPU is not charged.",
      },
      {
        kind: "Fixed",
        title: "Free models work again",
        body: "Our free-model provider retired the models the free catalog pointed to. The catalog now uses live models (GPT-OSS 120B, GPT-OSS 20B and Qwen3.8 27B), and existing agents keep working without changes.",
      },
      {
        kind: "Fixed",
        title: "Model deployments on new installations",
        body: "The deployable model catalog is loaded into the database automatically when the API starts, so deploying a model no longer fails with \"Model not found\" on a fresh setup.",
      },
      {
        kind: "Security",
        title: "Agent secrets encrypted and never shown again",
        body: "Environment variables on agents (provider keys, bot tokens) are encrypted at rest, and the API only ever returns their names. Marketplace installs no longer copy the publisher's variables.",
      },
      {
        kind: "Security",
        title: "Payout and sign-in hardening",
        body: "Two simultaneous payout requests can no longer both reserve the same balance, and payouts can only be requested by a signed-in owner or admin. Rate limits now hold across all servers, and repeated failed sign-ins lock an account for 15 minutes.",
      },
      {
        kind: "Improved",
        title: "Refined navy design",
        body: "A new dark theme with one blue accent, a readable light theme, and error messages that show what the server actually said instead of a generic code.",
      },
    ],
  },
  {
    date: "2026-09-02",
    items: [
      {
        kind: "New",
        title: "New website",
        body: "A new landing page telling the Build, Deploy and Monetize story, with the frameworks, pricing and marketplace in one place.",
      },
    ],
  },
  {
    date: "2026-08-11",
    items: [
      {
        kind: "New",
        title: "Per-request billing for marketplace agents",
        body: "Paid marketplace agents are now charged per request: the price is taken before the agent runs, refunded automatically if the run fails, and never charged twice. This applies to playground chat, scheduled tasks, workflows, test runs and graph runs. Chat answers show what the request cost and how much went to the creator. Uninstalling an agent ends its licence.",
      },
      {
        kind: "New",
        title: "Import from private GitHub repositories",
        body: "Install the WheelsAI GitHub App to import agents from private repositories your organization grants it. Branch URLs are honoured, and pushes to a connected repository record a new agent version with the commit.",
      },
    ],
  },
  {
    date: "2026-08-09",
    items: [
      {
        kind: "New",
        title: "Install into Slack",
        body: "Connect a Slack workspace to a deployed agent's Slack channel with an install flow, instead of pasting credentials by hand.",
      },
      {
        kind: "Fixed",
        title: "Deployment credit holds are returned",
        body: "The one-hour credit reservation taken when a deployment starts is now returned when the deployment fails or is stopped, and both show up in your ledger.",
      },
      {
        kind: "Fixed",
        title: "Clearer errors, and graph templates that run",
        body: "Invalid requests now answer 400 with the field at fault instead of a server error, error responses never include internal details, and the built-in visual-builder templates run out of the box.",
      },
    ],
  },
  {
    date: "2026-08-08",
    items: [
      {
        kind: "New",
        title: "Knowledge bases for agents",
        body: "Bind an agent to a knowledge base and its answers are grounded in your documents, with the sources returned alongside each answer. Semantic search uses vector embeddings, and answers say when a simpler keyword match was used instead.",
      },
      {
        kind: "New",
        title: "Multi-agent workflows and runnable graphs",
        body: "Orchestrations now actually run multi-agent workflows, and the visual builder has a working Run button with a step-by-step trace of each run.",
      },
      {
        kind: "New",
        title: "Creator payouts",
        body: "Marketplace creators can be paid out their earnings, processed exactly once by a dedicated payout worker.",
      },
      {
        kind: "Security",
        title: "Outbound request and access-control hardening",
        body: "Every request WheelsAI makes to a URL you supply (agent HTTP tools, webhooks, integrations) is checked against private and internal networks, including after DNS resolution and on redirects. Access checks across organizations were tightened throughout.",
      },
    ],
  },
  {
    date: "2026-08-07",
    items: [
      {
        kind: "New",
        title: "Pay with a Solana wallet",
        body: "Top up credits with USDC from your wallet on the billing page. Credits arrive only after the transaction is confirmed on-chain, and never twice.",
      },
    ],
  },
  {
    date: "2026-08-02",
    items: [
      {
        kind: "New",
        title: "Build, Deploy, Monetize dashboard",
        body: "The dashboard is organized around the three things you do on WheelsAI, with Build first.",
      },
      {
        kind: "New",
        title: "Scheduled tasks, monitoring and alerts that run",
        body: "Scheduled agent tasks now execute on time. Uptime monitors are probed on their interval and alert rules are evaluated, with notifications to your alert channels.",
      },
      {
        kind: "New",
        title: "Webhooks for agents, deployments, training and alerts",
        body: "Subscribe to agent, deployment, fine-tuning and alert events. Deployment events fire when the platform observes a deployment start running, fail or stop.",
      },
      {
        kind: "New",
        title: "Marketplace installs",
        body: "Buyers can install marketplace agents into their organization, and featured sections are curated.",
      },
      {
        kind: "Improved",
        title: "Analytics history and a test runner that runs real agents",
        body: "Usage history is recorded for analytics charts, and test suites now run against your actual agents.",
      },
      {
        kind: "Security",
        title: "Two-factor authentication enforced at sign-in",
        body: "If you enable two-factor authentication, every sign-in method now asks for your code.",
      },
    ],
  },
];
