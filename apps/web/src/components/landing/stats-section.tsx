"use client";

import { useEffect, useRef, useState } from "react";
import { Store, Coins, Globe, Box } from "lucide-react";

interface StatItemProps {
  icon: React.ElementType;
  end?: number;
  suffix?: string;
  label: string;
  staticText?: string;
  delay: number;
}

function StatItem({ icon: Icon, end, suffix = "", label, staticText, delay }: StatItemProps) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (staticText || end === undefined) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true;
          setTimeout(() => {
            const duration = 2000;
            const start = performance.now();
            const step = (now: number) => {
              const progress = Math.min((now - start) / duration, 1);
              const eased = 1 - Math.pow(1 - progress, 3);
              setCount(Math.round(eased * end * 10) / 10);
              if (progress < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }, delay);
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end, delay, staticText]);

  const displayValue = staticText
    ? staticText
    : end !== undefined && end >= 100
      ? Math.floor(count).toLocaleString()
      : Math.floor(count).toString();

  return (
    <div ref={ref} className="glow-card-navy text-center py-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-navy-700 border border-navy-500/50 mx-auto mb-4">
        <Icon className="h-6 w-6 text-navy-400" />
      </div>
      <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">
        {displayValue}{!staticText && suffix}
      </div>
      <div className="mt-2 text-sm text-navy-200/50">{label}</div>
    </div>
  );
}

const stats: StatItemProps[] = [
  { icon: Globe, end: 10, suffix: "+", label: "Deploy Channels", delay: 0 },
  { icon: Coins, end: 90, suffix: "%", label: "Revenue Share", delay: 150 },
  { icon: Box, end: 6, suffix: "+", label: "Frameworks", delay: 300 },
  { icon: Store, end: 500, suffix: "+", label: "Agents Built", delay: 450 },
];

export function StatsSection() {
  return (
    <section className="bg-navy-900 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Built for{" "}
            <span className="gradient-text-navy">Creators</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Everything you need to build a business around your AI agents.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <StatItem key={stat.label} {...stat} />
          ))}
        </div>
      </div>
    </section>
  );
}
