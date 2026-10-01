import { Bot, Coins, Cpu, GitBranch, GraduationCap } from "lucide-react";

/**
 * What WheelsAI builds: four product types, each deployable on Nosana GPUs
 * and each monetizable on the marketplace.
 */
const productTypes = [
  {
    icon: Bot,
    title: "AI Agents",
    description:
      "Import from GitHub or start from a template in Mastra, ElizaOS, LangChain, AutoGen, CrewAI or your own stack. Give agents tools, knowledge and memory.",
    monetize: "Sell per request, by monthly subscription, or token-gated.",
  },
  {
    icon: GitBranch,
    title: "AI Workflows",
    description:
      "Chain agents into multi-step pipelines with branches, loops and parallel steps, then run them on a schedule or on demand.",
    monetize: "Package a workflow as a product and charge for every run.",
  },
  {
    icon: Cpu,
    title: "Small Language Models",
    description:
      "Serve open models such as Llama, Qwen, Mistral, Phi and Gemma on decentralized GPUs from RTX 3060 to H100, billed per second, behind an OpenAI-compatible API.",
    monetize: "Offer your model endpoint to others and earn on every request.",
  },
  {
    icon: GraduationCap,
    title: "Fine-Tuning",
    description:
      "Fine-tune a small model on your own data with LoRA or QLoRA, then deploy the tuned model on the same GPUs in one click.",
    monetize: "Turn your data advantage into a model others pay to use.",
  },
];

export function ProductTypes() {
  return (
    <section id="products" className="bg-navy-950 py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-16 text-center">
          <h2 className="text-3xl font-bold text-white sm:text-4xl">
            One Platform for <span className="gradient-text-navy">Every AI Product</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-navy-200/60">
            Agents, workflows, small language models and fine-tuned models: build each one,
            deploy it on decentralized GPU, and monetize it on the same marketplace.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {productTypes.map((p) => (
            <div key={p.title} className="glow-card-navy flex flex-col">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-navy-500/50 bg-navy-700">
                <p.icon className="h-6 w-6 text-navy-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-white">{p.title}</h3>
              <p className="flex-1 text-sm leading-relaxed text-navy-200/60">{p.description}</p>
              <div className="mt-5 flex items-start gap-2 border-t border-navy-600/40 pt-4">
                <Coins className="mt-0.5 h-4 w-4 shrink-0 text-[#a855f7]" />
                <p className="text-sm text-navy-200/80">{p.monetize}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
