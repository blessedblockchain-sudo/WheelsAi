"use client";

import { useEffect, useRef } from "react";

import { liveChatChannelList } from "@/lib/chat-channels";
import {
  Hammer,
  Rocket,
  Store,
  Workflow,
  Database,
  GitBranch,
  Globe,
  Cpu,
  Zap,
  ShoppingBag,
  Coins,
  BarChart3,
} from "lucide-react";

const pillars = [
  {
    label: "BUILD",
    icon: Hammer,
    color: "text-navy-400",
    features: [
      {
        icon: Workflow,
        title: "Build Your Way",
        description:
          "Visual drag-and-drop builder or bring your own code for agents, and multi-step workflows that chain them. No framework lock-in — ever.",
      },
      {
        icon: Database,
        title: "GitHub Import & 6+ Frameworks",
        description:
          "Import existing agents from GitHub. Supports Mastra, ElizaOS, LangChain, AutoGen, CrewAI, and custom builds.",
      },
      {
        icon: GitBranch,
        title: "Free Models & Fine-Tuning",
        description:
          "Prototype with free LLMs, no API key required. Fine-tune a small language model on your own data when you need one that is yours.",
      },
    ],
  },
  {
    label: "DEPLOY",
    icon: Rocket,
    color: "text-[#00d4ff]",
    features: [
      {
        icon: Globe,
        title: "Chat Channels + API",
        description:
          `${liveChatChannelList(" and ")} chat (Web is a widget you paste into your own site) plus an OpenAI-compatible API — one deploy covers them all.`,
      },
      {
        icon: Cpu,
        title: "Auto-Scaling Compute",
        description:
          "We handle the infrastructure. Instant deployment, zero cold starts, no DevOps required.",
      },
      {
        icon: Zap,
        title: "OpenAI-Compatible API",
        description:
          "Drop-in replacement for any OpenAI client. Streaming, function calls, and tool use built in.",
      },
    ],
  },
  {
    label: "MONETIZE",
    icon: Store,
    color: "text-[#a855f7]",
    features: [
      {
        icon: ShoppingBag,
        title: "Marketplace for Every Product",
        description:
          "List agents, workflows and models for free. Choose free, per-request or subscription pricing. Community-driven discovery.",
      },
      {
        icon: Coins,
        title: "Four Pricing Models",
        description:
          "Free, per-request, monthly, or tokenized — you set the price, and every sale is backed by on-chain receipts.",
      },
      {
        icon: BarChart3,
        title: "Agent Tokens",
        description:
          "Launch a bonding-curve token for your agent. pump.fun-style graduation to full liquidity on Solana.",
      },
    ],
  },
];

export function FeaturesGrid() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cards = el.querySelectorAll<HTMLElement>(".feature-card");

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("opacity-100", "translate-y-0");
            entry.target.classList.remove("opacity-0", "translate-y-8");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, []);

  return (
    <section id="features" className="relative bg-navy-950 py-24">
      <div className="absolute inset-0 grid-bg-navy" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            One Platform.{" "}
            <span className="gradient-text-navy">No Fragmentation.</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Everything you need — frameworks, compute, channels, marketplace — unified.
          </p>
        </div>

        <div ref={ref} className="grid gap-10 lg:grid-cols-3">
          {pillars.map((pillar, pi) => (
            <div key={pillar.label}>
              {/* Pillar header */}
              <div className="flex items-center gap-2 mb-6">
                <pillar.icon className={`h-5 w-5 ${pillar.color}`} />
                <span className={`text-sm font-bold tracking-widest ${pillar.color}`}>
                  {pillar.label}
                </span>
              </div>

              {/* Feature cards */}
              <div className="space-y-4">
                {pillar.features.map((feature, fi) => (
                  <div
                    key={feature.title}
                    className="feature-card glow-card-navy opacity-0 translate-y-8 transition-all duration-700"
                    style={{ transitionDelay: `${(pi * 3 + fi) * 100}ms` }}
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-navy-700 border border-navy-600/50 mb-4">
                      <feature.icon className="h-5 w-5 text-navy-400" />
                    </div>
                    <h3 className="text-base font-semibold text-white mb-2">
                      {feature.title}
                    </h3>
                    <p className="text-sm text-navy-200/50 leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
