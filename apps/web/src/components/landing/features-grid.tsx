"use client";

import { useEffect, useRef } from "react";
import {
  Bot,
  Workflow,
  Cpu,
  Store,
  GraduationCap,
  Database,
  GitBranch,
  BarChart3,
} from "lucide-react";

const features = [
  {
    icon: Bot,
    title: "AI Agent Deployment",
    description:
      "Deploy autonomous AI agents with one click. Supports LLM-powered agents, chatbots, and custom workflows.",
  },
  {
    icon: Workflow,
    title: "Visual Agent Builder",
    description:
      "Drag-and-drop agent builder with a visual graph editor. No coding required for simple agents.",
  },
  {
    icon: Cpu,
    title: "Model Hub",
    description:
      "Access 100+ pre-trained models. Llama, Mistral, GPT-J, and more — ready to deploy in seconds.",
  },
  {
    icon: Store,
    title: "Agent Marketplace",
    description:
      "Browse and deploy community-built agents. Monetize your own agents on the marketplace.",
  },
  {
    icon: GraduationCap,
    title: "Fine-Tuning",
    description:
      "Fine-tune models on your data with LoRA and QLoRA. GPU-accelerated training at a fraction of the cost.",
  },
  {
    icon: Database,
    title: "Knowledge Base & RAG",
    description:
      "Upload documents and build vector stores. Retrieval-augmented generation out of the box.",
  },
  {
    icon: GitBranch,
    title: "Multi-Agent Orchestration",
    description:
      "Chain multiple agents together. Build complex workflows with branching, loops, and parallel execution.",
  },
  {
    icon: BarChart3,
    title: "Analytics & Monitoring",
    description:
      "Real-time dashboards for token usage, latency, errors, and cost. Set alerts and usage limits.",
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
            Everything You Need to{" "}
            <span className="gradient-text-navy">Ship AI</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            A complete platform for building, deploying, and scaling AI agents on
            decentralized infrastructure.
          </p>
        </div>

        <div ref={ref} className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature, i) => (
            <div
              key={feature.title}
              className="feature-card glow-card-navy opacity-0 translate-y-8 transition-all duration-700"
              style={{ transitionDelay: `${i * 100}ms` }}
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
    </section>
  );
}
