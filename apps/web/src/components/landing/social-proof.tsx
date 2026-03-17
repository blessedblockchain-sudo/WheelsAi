import { Shield, Clock, Cpu, Users } from "lucide-react";

const trustSignals = [
  { icon: Cpu, label: "2,000+ GPUs", sublabel: "Decentralized network" },
  { icon: Users, label: "500+ Builders", sublabel: "Active community" },
  { icon: Clock, label: "<200ms Latency", sublabel: "Edge-optimized inference" },
  { icon: Shield, label: "SOC 2 Ready", sublabel: "Enterprise security" },
];

export function SocialProof() {
  return (
    <section className="relative bg-navy-900 border-y border-navy-600/30 py-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {trustSignals.map((signal) => (
            <div key={signal.label} className="flex items-center gap-3 justify-center">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-800 border border-navy-600/50">
                <signal.icon className="h-5 w-5 text-navy-400" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">{signal.label}</div>
                <div className="text-xs text-navy-200/50">{signal.sublabel}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
