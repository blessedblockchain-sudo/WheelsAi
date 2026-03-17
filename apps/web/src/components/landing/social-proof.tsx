import { Layers, Coins, Globe, Zap } from "lucide-react";

const stats = [
  { icon: Layers, label: "All-in-One Platform", sublabel: "Build, deploy & monetize" },
  { icon: Coins, label: "90% Revenue Share", sublabel: "Creators keep earnings" },
  { icon: Globe, label: "10+ Channels", sublabel: "Discord, Telegram, Slack..." },
  { icon: Zap, label: "SOL Native", sublabel: "Payments on Solana" },
];

export function SocialProof() {
  return (
    <section className="relative bg-navy-900 border-y border-navy-600/30 py-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {stats.map((stat) => (
            <div key={stat.label} className="flex items-center gap-3 justify-center">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-800 border border-navy-600/50">
                <stat.icon className="h-5 w-5 text-navy-400" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">{stat.label}</div>
                <div className="text-xs text-navy-200/50">{stat.sublabel}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
