export interface DocsNavItem {
  title: string;
  href: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

/** Single source for the docs sidebar and previous/next links. */
export const DOCS_NAV: DocsNavSection[] = [
  {
    title: "Overview",
    items: [{ title: "Introduction", href: "/docs" }],
  },
  {
    title: "Guides",
    items: [
      { title: "Getting started", href: "/docs/guides/getting-started" },
      { title: "Deploy a model", href: "/docs/guides/deploy-a-model" },
      { title: "Custom domains", href: "/docs/guides/custom-domains" },
      { title: "Publish to the marketplace", href: "/docs/guides/marketplace" },
      { title: "Plans and billing", href: "/docs/guides/plans-and-billing" },
      { title: "Templates", href: "/docs/guides/templates" },
      { title: "Workflows and schedules", href: "/docs/guides/workflows" },
    ],
  },
  {
    title: "API reference",
    items: [
      { title: "Overview and authentication", href: "/docs/api" },
      { title: "Chat completions (/v1)", href: "/docs/api/inference" },
      { title: "Agents and playground", href: "/docs/api/agents" },
      { title: "Models and deployments", href: "/docs/api/deployments" },
      { title: "Marketplace", href: "/docs/api/marketplace" },
      { title: "Offerings and jobs", href: "/docs/api/jobs" },
      { title: "Billing and plans", href: "/docs/api/billing" },
      { title: "Workflows and scheduler", href: "/docs/api/workflows" },
      { title: "Webhooks", href: "/docs/api/webhooks" },
    ],
  },
  {
    title: "Tools",
    items: [{ title: "SDK and CLI", href: "/docs/sdk" }],
  },
];

export const DOCS_FLAT: DocsNavItem[] = DOCS_NAV.flatMap((s) => s.items);
