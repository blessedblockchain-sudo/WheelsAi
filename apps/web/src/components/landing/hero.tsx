"use client";

import Link from "next/link";
import { ArrowRight, Layers } from "lucide-react";

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-navy-950">
      {/* Grid overlay */}
      <div className="absolute inset-0 grid-bg-navy" />

      {/* Radial glow behind headline */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-navy-400/10 rounded-full blur-[120px] pointer-events-none" />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 text-center pt-24 pb-20">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-navy-600 bg-navy-900/80 px-4 py-1.5 text-sm text-navy-200/80 mb-8 backdrop-blur-sm">
          <Layers className="h-4 w-4 text-navy-400" />
          Agents · Workflows · Small Language Models
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-7xl font-bold tracking-tight text-white leading-tight">
          Build Agents,
          <br />
          Workflows &amp; Models.
          <br className="hidden sm:block" />
          Deploy Everywhere.{" "}
          <span className="gradient-text-navy">Monetize Instantly.</span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-lg sm:text-xl leading-relaxed text-navy-200/60">
          One platform for every AI product. Build agents in any framework, chain
          them into workflows, serve small language models and fine-tune them on
          your own data. Deploy on decentralized per-second GPU, then set your price
          for each one.
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
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">6</div>
            <div className="text-sm text-navy-200/60 mt-1">Frameworks</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">21</div>
            <div className="text-sm text-navy-200/60 mt-1">Models</div>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold text-white text-glow-blue">4</div>
            <div className="text-sm text-navy-200/60 mt-1">Pricing Models</div>
          </div>
        </div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-navy-950 to-transparent pointer-events-none" />
    </section>
  );
}
