import Link from "next/link";
import { Cpu } from "lucide-react";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "#pricing" },
      { label: "Explore Agents", href: "/marketplace" },
      { label: "Marketplace", href: "/marketplace" },
      { label: "Templates", href: "/dashboard/templates" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "API Reference", href: "/docs/api" },
      { label: "SDKs & CLI", href: "/docs/sdk" },
      { label: "Changelog", href: "/changelog" },
      { label: "Status", href: "/status" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Blog", href: "/blog" },
      { label: "Careers", href: "/careers" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "Discord", href: "#" },
      { label: "Twitter", href: "#" },
      { label: "GitHub", href: "#" },
      { label: "Telegram", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-navy-900 border-t border-navy-600/30 pt-16 pb-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand column */}
          <div className="lg:col-span-1">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-400">
                <Cpu className="h-5 w-5 text-white" />
              </div>
              <span className="text-xl font-bold text-white">WheelsAI</span>
            </Link>
            <p className="text-sm text-navy-200/50 leading-relaxed">
              Build, deploy, and monetize AI agents — no fragmentation.
              One platform for every framework.
            </p>
          </div>

          {/* Link columns */}
          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold text-white mb-4">
                {col.title}
              </h4>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      prefetch={false}
                      className="text-sm text-navy-200/50 hover:text-white transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-16 pt-8 border-t border-navy-600/30 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-navy-200/40">
            &copy; {new Date().getFullYear()} WheelsAI. All rights reserved.
          </p>
          <p className="text-sm text-navy-200/40">
            Built on <span className="text-navy-300">Solana</span>.
          </p>
        </div>
      </div>
    </footer>
  );
}
