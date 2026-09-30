import { Box } from "lucide-react";

const frameworks = [
  {
    name: "Mastra",
    description: "TypeScript AI framework",
    color: "text-navy-400",
  },
  {
    name: "LangChain",
    description: "LLM application framework",
    color: "text-[#00d4ff]",
  },
  {
    name: "AutoGen",
    description: "Multi-agent conversations",
    color: "text-[#a855f7]",
  },
  {
    name: "ElizaOS",
    description: "Autonomous AI agents",
    color: "text-navy-200",
  },
  {
    name: "CrewAI",
    description: "AI agent orchestration",
    color: "text-navy-300",
  },
  {
    name: "Custom",
    description: "Bring your own framework",
    color: "text-white",
  },
];

export function Frameworks() {
  return (
    <section id="frameworks" className="bg-navy-900 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Works With Your{" "}
            <span className="gradient-text-navy">Favorite Frameworks</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            First-class support for the most popular AI frameworks, or bring your own.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {frameworks.map((fw) => (
            <div
              key={fw.name}
              className="glow-card-navy flex items-center gap-4 group hover:scale-[1.02] transition-transform duration-300"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-navy-700 border border-navy-600/50">
                <Box className={`h-6 w-6 ${fw.color}`} />
              </div>
              <div>
                <h3 className="font-semibold text-white">{fw.name}</h3>
                <p className="text-sm text-navy-200/50">{fw.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
