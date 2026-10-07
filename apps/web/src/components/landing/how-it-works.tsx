"use client";

import { useEffect, useRef } from "react";
import { Workflow, Rocket, Store, TrendingUp } from "lucide-react";

import { liveChatChannelList } from "@/lib/chat-channels";

const steps = [
  {
    icon: Workflow,
    step: "01",
    title: "Build",
    description:
      "Build agents visually or in code (Mastra, ElizaOS, LangChain, AutoGen, CrewAI or your own), chain them into workflows, or fine-tune a small language model on your data.",
  },
  {
    icon: Rocket,
    step: "02",
    title: "Deploy",
    description:
      `One-click deploy on decentralized per-second GPU behind an OpenAI-compatible API, with ${liveChatChannelList(" and ")} chat for agents. We handle the infrastructure.`,
  },
  {
    icon: Store,
    step: "03",
    title: "Monetize",
    description:
      "List agents, workflows and models on the marketplace for free. Price each one free, per request, monthly or tokenized. Every earning is verifiable on-chain.",
  },
  {
    icon: TrendingUp,
    step: "04",
    title: "Scale",
    description:
      "Track usage and revenue across every product, grow your community with bonding-curve tokens, and scale across channels and GPU markets.",
  },
];

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = el.querySelectorAll<HTMLElement>(".step-card");

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
      { threshold: 0.2 }
    );

    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <section id="how-it-works" className="bg-navy-900 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            From Idea to{" "}
            <span className="gradient-text-navy">Revenue</span> in Minutes
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Stop juggling fragmented tools. Four steps to a live, earning AI product.
          </p>
        </div>

        <div ref={ref} className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <div
              key={s.step}
              className="step-card relative opacity-0 translate-y-8 transition-all duration-700"
              style={{ transitionDelay: `${i * 150}ms` }}
            >
              <div className="glow-card-navy text-center">
                {/* Step number */}
                <div className="text-5xl font-bold text-navy-600/40 mb-4 font-mono">
                  {s.step}
                </div>
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-navy-700 border border-navy-500/50 mx-auto mb-4">
                  <s.icon className="h-6 w-6 text-navy-400" />
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">{s.title}</h3>
                <p className="text-sm text-navy-200/50 leading-relaxed">
                  {s.description}
                </p>
              </div>

              {/* Connector line */}
              {i < steps.length - 1 && (
                <div className="hidden lg:block absolute top-1/2 -right-4 w-8 border-t border-dashed border-navy-600/50" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
