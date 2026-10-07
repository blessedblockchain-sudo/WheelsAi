"use client";

import { useEffect, useRef, useState } from "react";
import { Store, Coins, Globe, Box } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { LIVE_CHAT_CHANNELS } from "@/lib/chat-channels";

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

  // A value that arrives after the count-up finished snaps to the new number.
  useEffect(() => {
    if (hasAnimated.current && end !== undefined) setCount(end);
  }, [end]);

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

interface PlatformStats {
  frameworks: number;
  models: number;
  pricingModels: number;
  channels: number;
}

// Shown until /api/public/stats answers (and if it can't); the API reads
// the same product constants, so these only differ when the build is stale.
const FALLBACK_STATS: PlatformStats = {
  frameworks: 6,
  models: 21,
  pricingModels: 4,
  channels: LIVE_CHAT_CHANNELS.length,
};

function usePlatformStats(): PlatformStats {
  const [stats, setStats] = useState<PlatformStats>(FALLBACK_STATS);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/api/public/stats`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Partial<PlatformStats> | null) => {
        if (!data) return;
        setStats((prev) => ({
          frameworks: typeof data.frameworks === "number" ? data.frameworks : prev.frameworks,
          models: typeof data.models === "number" ? data.models : prev.models,
          pricingModels: typeof data.pricingModels === "number" ? data.pricingModels : prev.pricingModels,
          channels: typeof data.channels === "number" ? data.channels : prev.channels,
        }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return stats;
}

export function StatsSection() {
  const live = usePlatformStats();
  const stats: StatItemProps[] = [
    { icon: Box, end: live.frameworks, label: "Frameworks", delay: 0 },
    { icon: Store, end: live.models, label: "Models in Catalog", delay: 150 },
    { icon: Coins, end: live.pricingModels, label: "Pricing Models", delay: 300 },
    { icon: Globe, end: live.channels, label: "Chat Channels", delay: 450 },
  ];

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
