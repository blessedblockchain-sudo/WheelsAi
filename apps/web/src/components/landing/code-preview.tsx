import { Check, Terminal } from "lucide-react";

const bullets = [
  "OpenAI-compatible API endpoints",
  "Auto-scaling with zero cold starts",
  "Built-in load balancing & failover",
  "Real-time streaming responses",
  "SOL & USDC payment support",
  "99.9% uptime SLA",
];

const terminalLines = [
  { text: "$ wheelsai deploy --model llama-3.1-70b", color: "text-white" },
  { text: "", color: "" },
  { text: "🔍  Selecting optimal GPU node...", color: "text-navy-300" },
  { text: "✓  Node selected: RTX 4090 (us-east-1)", color: "text-[#00ff00]" },
  { text: "📦  Pulling model weights...", color: "text-navy-300" },
  { text: "✓  Model loaded (4-bit quantized, 35GB)", color: "text-[#00ff00]" },
  { text: "🚀  Deploying to Nosana network...", color: "text-navy-300" },
  { text: "", color: "" },
  { text: "✓  Agent deployed successfully!", color: "text-[#00ff00]" },
  { text: "   Endpoint: https://api.wheelsai.com/v1/chat", color: "text-navy-400" },
  { text: "   Latency:  47ms avg", color: "text-navy-400" },
  { text: "   Cost:     $0.0002/1K tokens", color: "text-navy-400" },
  { text: "", color: "" },
  { text: "█", color: "text-navy-400 animate-blink" },
];

export function CodePreview() {
  return (
    <section className="bg-navy-950 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 items-center">
          {/* Left: marketing bullets */}
          <div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6">
              Deploy in{" "}
              <span className="gradient-text-navy">Seconds</span>,{" "}
              Scale Forever
            </h2>
            <p className="text-lg text-navy-200/60 mb-8">
              Our CLI and dashboard make deployment effortless. Connect your
              wallet, choose a model, and you&apos;re live.
            </p>
            <ul className="space-y-4">
              {bullets.map((bullet) => (
                <li key={bullet} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#00ff00]/10 border border-[#00ff00]/30">
                    <Check className="h-3.5 w-3.5 text-[#00ff00]" />
                  </div>
                  <span className="text-sm text-navy-200/70">{bullet}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right: terminal mockup */}
          <div className="relative">
            <div className="rounded-xl border border-navy-600/50 bg-navy-900 overflow-hidden shadow-glow-navy">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-navy-800 border-b border-navy-600/50">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/60" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                  <div className="w-3 h-3 rounded-full bg-green-500/60" />
                </div>
                <div className="flex items-center gap-1.5 ml-3 text-xs text-navy-200/40">
                  <Terminal className="h-3.5 w-3.5" />
                  <span>terminal</span>
                </div>
              </div>
              {/* Terminal body */}
              <div className="p-4 font-mono text-sm leading-6 overflow-x-auto">
                {terminalLines.map((line, i) => (
                  <div key={i} className={line.color || "text-transparent"}>
                    {line.text || "\u00A0"}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
