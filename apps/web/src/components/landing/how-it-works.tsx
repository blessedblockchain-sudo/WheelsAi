"use client";

import { useEffect, useRef } from "react";
import { Wallet, Settings, Rocket } from "lucide-react";

const steps = [
  {
    icon: Wallet,
    step: "01",
    title: "Connect",
    description:
      "Connect your Solana wallet or sign up with email. Fund your account with SOL or USDC.",
  },
  {
    icon: Settings,
    step: "02",
    title: "Configure",
    description:
      "Choose a model, build your agent with the visual builder or SDK, and configure parameters.",
  },
  {
    icon: Rocket,
    step: "03",
    title: "Deploy",
    description:
      "One-click deploy to decentralized GPUs. Get an API endpoint in seconds with auto-scaling.",
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
            Go from Zero to{" "}
            <span className="gradient-text-navy">Production</span> in Minutes
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Three simple steps to deploy your first AI agent.
          </p>
        </div>

        <div ref={ref} className="grid gap-8 md:grid-cols-3">
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
                <div className="hidden md:block absolute top-1/2 -right-4 w-8 border-t border-dashed border-navy-600/50" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
