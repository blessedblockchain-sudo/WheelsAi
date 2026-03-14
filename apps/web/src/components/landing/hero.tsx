"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

function AnimatedCounter({ end, label, suffix = "" }: { end: number; label: string; suffix?: string }) {
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
          const duration = 2000;
          const start = performance.now();
          const step = (now: number) => {
            const progress = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setCount(Math.floor(eased * end));
            if (progress < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end]);

  return (
    <div ref={ref} className="text-center">
      <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">
        {count.toLocaleString()}{suffix}
      </div>
      <div className="text-sm text-navy-200/60 mt-1">{label}</div>
    </div>
  );
}

const matrixChars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";

function MatrixColumn({ index, total }: { index: number; total: number }) {
  const chars = Array.from({ length: 20 }, () =>
    matrixChars[Math.floor(Math.random() * matrixChars.length)]
  ).join("\n");
  const delay = Math.random() * 10;
  const duration = 8 + Math.random() * 8;
  const left = (index / total) * 100;

  return (
    <div
      className={`absolute top-0 font-mono text-xs text-[#00ff00]/15 whitespace-pre leading-5 pointer-events-none ${
        index % 3 === 0 ? "" : "hidden sm:block"
      }`}
      style={{
        left: `${left}%`,
        animation: `matrix-fall ${duration}s linear ${delay}s infinite`,
      }}
    >
      {chars}
    </div>
  );
}

export function Hero() {
  const columnCount = 25;

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-navy-950">
      {/* Matrix rain background */}
      <div className="absolute inset-0 overflow-hidden opacity-60">
        {Array.from({ length: columnCount }, (_, i) => (
          <MatrixColumn key={i} index={i} total={columnCount} />
        ))}
      </div>

      {/* Grid overlay */}
      <div className="absolute inset-0 grid-bg-navy" />

      {/* Radial glow behind headline */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-navy-400/10 rounded-full blur-[120px] pointer-events-none" />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 text-center pt-24 pb-20">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-navy-600 bg-navy-900/80 px-4 py-1.5 text-sm text-navy-200/80 mb-8 backdrop-blur-sm">
          <Sparkles className="h-4 w-4 text-navy-400" />
          Powered by Nosana Network
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-7xl font-bold tracking-tight text-white leading-tight">
          Deploy AI Agents on{" "}
          <br className="hidden sm:block" />
          <span className="gradient-text-navy">Decentralized GPUs</span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-lg sm:text-xl leading-relaxed text-navy-200/60">
          Build, fine-tune, and deploy AI agents on decentralized GPUs.
          Powered by the Nosana Network on Solana.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/register" prefetch={false} className="btn-glow-navy text-base px-8 py-3 h-auto">
            Start Deploying Free
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
          <Link
            href="/docs"
            prefetch={false}
            className="inline-flex items-center justify-center h-12 px-8 py-3 font-semibold text-navy-200 bg-transparent border border-navy-600 rounded-lg transition-all duration-300 hover:bg-navy-800 hover:border-navy-400"
          >
            Read the Docs
          </Link>
        </div>

        {/* Feature highlights */}
        <div className="mt-16 grid grid-cols-3 gap-8 max-w-lg mx-auto">
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">5</div>
            <div className="text-sm text-navy-200/60 mt-1">GPU Tiers</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">SOL</div>
            <div className="text-sm text-navy-200/60 mt-1">Native Payments</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">24/7</div>
            <div className="text-sm text-navy-200/60 mt-1">Auto-Scaling</div>
          </div>
        </div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-navy-950 to-transparent pointer-events-none" />
    </section>
  );
}
