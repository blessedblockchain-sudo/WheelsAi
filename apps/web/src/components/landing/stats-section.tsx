"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu, Gauge, ShieldCheck, PiggyBank } from "lucide-react";

interface StatItemProps {
  icon: React.ElementType;
  end: number;
  suffix: string;
  label: string;
  delay: number;
}

function StatItem({ icon: Icon, end, suffix, label, delay }: StatItemProps) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
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
  }, [end, delay]);

  const displayValue = end >= 100
    ? Math.floor(count).toLocaleString()
    : count.toFixed(1);

  return (
    <div ref={ref} className="glow-card-navy text-center py-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-navy-700 border border-navy-500/50 mx-auto mb-4">
        <Icon className="h-6 w-6 text-navy-400" />
      </div>
      <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">
        {displayValue}{suffix}
      </div>
      <div className="mt-2 text-sm text-navy-200/50">{label}</div>
    </div>
  );
}

const stats = [
  { icon: Cpu, end: 2000, suffix: "+", label: "GPUs Available", delay: 0 },
  { icon: Gauge, end: 50, suffix: "ms", label: "Avg Latency", delay: 150 },
  { icon: ShieldCheck, end: 99.9, suffix: "%", label: "Uptime SLA", delay: 300 },
  { icon: PiggyBank, end: 85, suffix: "%", label: "Cost Savings", delay: 450 },
];

export function StatsSection() {
  return (
    <section className="bg-navy-900 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Built for{" "}
            <span className="gradient-text-navy">Performance</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Enterprise-grade infrastructure at decentralized prices.
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
