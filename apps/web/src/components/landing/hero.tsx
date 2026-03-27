"use client";

import Link from "next/link";
import { ArrowRight, Layers } from "lucide-react";

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
          <Layers className="h-4 w-4 text-navy-400" />
          Solve AI Agent Fragmentation
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-7xl font-bold tracking-tight text-white leading-tight">
          Build AI Agents.
          <br className="hidden sm:block" />
          Deploy Everywhere.{" "}
          <span className="gradient-text-navy">Monetize Instantly.</span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-lg sm:text-xl leading-relaxed text-navy-200/60">
          Frameworks fragmented. Hosting scattered. Monetization impossible.
          WheelsAI eliminates all of it — pick your framework, import from GitHub,
          deploy to 10+ channels, and earn 90% revenue.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/register" prefetch={false} className="btn-glow-navy text-base px-8 py-3 h-auto">
            Start Building Free
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
          <Link
            href="/marketplace"
            prefetch={false}
            className="inline-flex items-center justify-center h-12 px-8 py-3 font-semibold text-navy-200 bg-transparent border border-navy-600 rounded-lg transition-all duration-300 hover:bg-navy-800 hover:border-navy-400"
          >
            Explore Marketplace
          </Link>
        </div>

        {/* Feature highlights */}
        <div className="mt-16 grid grid-cols-3 gap-8 max-w-lg mx-auto">
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">6+</div>
            <div className="text-sm text-navy-200/60 mt-1">Frameworks</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">10+</div>
            <div className="text-sm text-navy-200/60 mt-1">Deploy Channels</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">90%</div>
            <div className="text-sm text-navy-200/60 mt-1">Revenue Share</div>
          </div>
        </div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-navy-950 to-transparent pointer-events-none" />
    </section>
  );
}
