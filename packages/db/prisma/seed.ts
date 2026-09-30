import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const models = [
  // Llama 3.1 Series
  {
    id: "llama-3.1-8b",
    hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    ollamaModelId: "llama3.1:8b",
    displayName: "Llama 3.1 8B Instruct",
    description:
      "Meta's latest instruction-tuned model. Excellent for general tasks.",
    parameters: BigInt(8_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "general"],
    pricingTier: "small",
  },
  {
    id: "llama-3.1-70b",
    hfId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    ollamaModelId: "llama3.1:70b",
    displayName: "Llama 3.1 70B Instruct",
    description:
      "Larger Llama model with superior reasoning and instruction following.",
    parameters: BigInt(70_000_000_000),
    minGpuTier: "a100",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "reasoning"],
    pricingTier: "large",
  },
  {
    id: "llama-3.2-3b",
    hfId: "meta-llama/Llama-3.2-3B-Instruct",
    ollamaModelId: "llama3.2:3b",
    displayName: "Llama 3.2 3B Instruct",
    description: "Compact Llama model optimized for efficiency.",
    parameters: BigInt(3_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "llama3.2",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
  },

  // Mistral Series
  {
    id: "mistral-7b",
    hfId: "mistralai/Mistral-7B-Instruct-v0.2",
    ollamaModelId: "mistral:7b",
    displayName: "Mistral 7B Instruct",
    description: "Fast and efficient model from Mistral AI.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "apache-2.0",
    tags: ["chat", "instruct", "fast"],
    pricingTier: "small",
  },
  {
    id: "mixtral-8x7b",
    hfId: "mistralai/Mixtral-8x7B-Instruct-v0.1",
    ollamaModelId: "mixtral:8x7b",
    displayName: "Mixtral 8x7B",
    description: "Mixture of Experts model with excellent performance.",
    parameters: BigInt(46_700_000_000),
    minGpuTier: "a100",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["chat", "moe", "high-performance"],
    pricingTier: "large",
  },

  // Code Models
  {
    id: "codellama-7b",
    hfId: "codellama/CodeLlama-7b-Instruct-hf",
    ollamaModelId: "codellama:7b",
    displayName: "Code Llama 7B",
    description: "Fast code generation model for everyday tasks.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 16384,
    license: "llama2",
    tags: ["code", "instruct", "programming"],
    pricingTier: "small",
  },
  {
    id: "codellama-34b",
    hfId: "codellama/CodeLlama-34b-Instruct-hf",
    ollamaModelId: "codellama:34b",
    displayName: "Code Llama 34B",
    description: "Specialized model for code generation and understanding.",
    parameters: BigInt(34_000_000_000),
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 16384,
    license: "llama2",
    tags: ["code", "instruct", "programming"],
    pricingTier: "medium",
  },
  {
    id: "deepseek-coder-6.7b",
    hfId: "deepseek-ai/deepseek-coder-6.7b-instruct",
    ollamaModelId: "deepseek-coder:6.7b",
    displayName: "DeepSeek Coder 6.7B",
    description: "Efficient code generation model from DeepSeek.",
    parameters: BigInt(6_700_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 16384,
    license: "deepseek",
    tags: ["code", "instruct", "programming"],
    pricingTier: "small",
  },
  {
    id: "deepseek-coder-33b",
    hfId: "deepseek-ai/deepseek-coder-33b-instruct",
    ollamaModelId: "deepseek-coder:33b",
    displayName: "DeepSeek Coder 33B",
    description: "Excellent code generation model from DeepSeek.",
    parameters: BigInt(33_000_000_000),
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 16384,
    license: "deepseek",
    tags: ["code", "instruct", "programming"],
    pricingTier: "medium",
  },

  // Qwen Series
  {
    id: "qwen2-7b",
    hfId: "Qwen/Qwen2-7B-Instruct",
    ollamaModelId: "qwen2:7b",
    displayName: "Qwen2 7B Instruct",
    description: "Alibaba's multilingual model with strong performance.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["chat", "multilingual", "long-context"],
    pricingTier: "small",
  },
  {
    id: "qwen2.5-coder-7b",
    hfId: "Qwen/Qwen2.5-Coder-7B-Instruct",
    ollamaModelId: "qwen2.5-coder:7b",
    displayName: "Qwen2.5 Coder 7B",
    description: "Specialized coding model from Alibaba.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["code", "multilingual", "programming"],
    pricingTier: "small",
  },

  // Phi Series (Microsoft)
  {
    id: "phi-3-mini",
    hfId: "microsoft/Phi-3-mini-4k-instruct",
    ollamaModelId: "phi3:mini",
    displayName: "Phi-3 Mini 4K",
    description: "Microsoft's compact but capable model.",
    parameters: BigInt(3_800_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "mit",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
  },
  {
    id: "phi-3-medium",
    hfId: "microsoft/Phi-3-medium-4k-instruct",
    ollamaModelId: "phi3:medium",
    displayName: "Phi-3 Medium 4K",
    description: "Larger Phi-3 model with enhanced capabilities.",
    parameters: BigInt(14_000_000_000),
    minGpuTier: "4070",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 4096,
    license: "mit",
    tags: ["chat", "reasoning", "efficient"],
    pricingTier: "medium",
  },

  // Gemma Series (Google)
  {
    id: "gemma-2b",
    hfId: "google/gemma-2b-it",
    ollamaModelId: "gemma:2b",
    displayName: "Gemma 2B Instruct",
    description: "Google's lightweight open model.",
    parameters: BigInt(2_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
  },
  {
    id: "gemma-7b",
    hfId: "google/gemma-7b-it",
    ollamaModelId: "gemma:7b",
    displayName: "Gemma 7B Instruct",
    description: "Google's capable 7B open model.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "instruct", "general"],
    pricingTier: "small",
  },
  {
    id: "gemma2-9b",
    hfId: "google/gemma-2-9b-it",
    ollamaModelId: "gemma2:9b",
    displayName: "Gemma 2 9B Instruct",
    description: "Google's latest Gemma 2 model with improved performance.",
    parameters: BigInt(9_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "instruct", "reasoning"],
    pricingTier: "small",
  },

  // Specialized Models
  {
    id: "neural-chat-7b",
    hfId: "Intel/neural-chat-7b-v3-1",
    ollamaModelId: "neural-chat:7b",
    displayName: "Neural Chat 7B",
    description: "Intel's optimized chat model.",
    parameters: BigInt(7_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "apache-2.0",
    tags: ["chat", "instruct", "optimized"],
    pricingTier: "small",
  },
  {
    id: "stablelm-2-zephyr",
    hfId: "stabilityai/stablelm-2-zephyr-1_6b",
    ollamaModelId: "stablelm2:1.6b",
    displayName: "StableLM 2 Zephyr 1.6B",
    description: "Stability AI's ultra-compact chat model.",
    parameters: BigInt(1_600_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "stability-ai-community",
    tags: ["chat", "compact", "fast"],
    pricingTier: "small",
  },
  {
    id: "yi-6b",
    hfId: "01-ai/Yi-6B-Chat",
    ollamaModelId: "yi:6b",
    displayName: "Yi 6B Chat",
    description: "01.AI's efficient chat model with strong Chinese support.",
    parameters: BigInt(6_000_000_000),
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "yi",
    tags: ["chat", "multilingual", "chinese"],
    pricingTier: "small",
  },
  {
    id: "yi-34b",
    hfId: "01-ai/Yi-34B-Chat",
    ollamaModelId: "yi:34b",
    displayName: "Yi 34B Chat",
    description: "01.AI's large chat model with excellent capabilities.",
    parameters: BigInt(34_000_000_000),
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 4096,
    license: "yi",
    tags: ["chat", "multilingual", "reasoning"],
    pricingTier: "medium",
  },

  // vLLM-only Large Models
  {
    id: "llama-3.1-405b",
    hfId: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    ollamaModelId: null,
    displayName: "Llama 3.1 405B Instruct",
    description: "Meta's flagship model with unmatched capabilities.",
    parameters: BigInt(405_000_000_000),
    minGpuTier: "h100",
    supportedEngines: ["vllm"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "flagship"],
    pricingTier: "enterprise",
  },
];

const agentTemplates = [
  // 1. Customer Support Bot
  {
    name: "Customer Support Bot",
    slug: "customer-support-bot",
    title: "Customer Support Bot",
    description:
      "A friendly AI agent that handles customer inquiries, resolves complaints, and escalates critical issues to human agents.",
    longDescription:
      "Deploy a production-ready customer support agent powered by Llama 3.3 70B. The bot understands context across multi-turn conversations, searches your knowledge base for accurate answers, and automatically creates support tickets when escalation is needed. Configurable tone, escalation rules, and knowledge sources.",
    category: "customer-support",
    difficulty: "beginner",
    framework: "mastra",
    tags: ["support", "customer-service", "chatbot"],
    systemPrompt:
      "You are a helpful and empathetic customer support agent. Your goal is to resolve customer issues quickly and professionally. Always greet the customer warmly, listen carefully to their problem, search the knowledge base before answering, and escalate to a human agent when an issue cannot be resolved automatically. Keep responses concise and actionable. If a customer is frustrated, acknowledge their feelings before providing a solution.",
    tools: [
      {
        name: "web_search",
        description: "Search knowledge base for answers to customer questions",
      },
      {
        name: "http_request",
        description:
          "Create support tickets and update CRM records via REST API",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.3,
      maxTokens: 4096,
    },
    sourceType: "inline",
    sourceCode: `import { Agent } from "@mastra/core/agent";
import { groq } from "@mastra/groq";

export const customerSupportAgent = new Agent({
  name: "customer-support-bot",
  instructions: \`You are a helpful and empathetic customer support agent.
Resolve issues quickly and escalate when necessary.\`,
  model: groq("openai/gpt-oss-120b"),
  tools: {
    searchKnowledgeBase: {
      description: "Search the knowledge base for relevant articles",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const res = await fetch(\`/api/kb?q=\${encodeURIComponent(query)}\`);
        return res.json();
      },
    },
    createTicket: {
      description: "Create a support ticket for escalation",
      parameters: z.object({
        subject: z.string(),
        description: z.string(),
        priority: z.enum(["low", "medium", "high", "urgent"]),
      }),
      execute: async (params) => {
        const res = await fetch("/api/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        return res.json();
      },
    },
  },
});`,
    env: {},
    isFeatured: true,
    isPublished: true,
    authorName: "WheelsAI",
  },

  // 2. Code Review Assistant
  {
    name: "Code Review Assistant",
    slug: "code-review-assistant",
    title: "Code Review Assistant",
    description:
      "Automated code reviewer that analyzes pull requests for bugs, security vulnerabilities, and adherence to best practices.",
    longDescription:
      "Integrate AI-powered code review into your development workflow. This agent fetches code from GitHub or GitLab, performs multi-dimensional analysis covering correctness, security (OWASP top 10), performance, and style, then posts structured review comments. Supports all major languages and is configurable per team coding standards.",
    category: "coding",
    difficulty: "intermediate",
    framework: "autogen",
    tags: ["code-review", "development", "security"],
    systemPrompt:
      "You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, and performance optimization. When reviewing code: (1) identify bugs and logic errors, (2) flag security issues such as injection flaws, insecure dependencies, and credential exposure, (3) suggest performance improvements, (4) verify adherence to SOLID principles and clean code standards. Always provide specific line-level feedback with actionable suggestions and example fixes. Be constructive and educational, not critical.",
    tools: [
      {
        name: "http_request",
        description:
          "Fetch code diffs and file contents from GitHub/GitLab APIs",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.2,
      maxTokens: 8192,
    },
    sourceType: "inline",
    sourceCode: `import autogen

# Define the code reviewer agent
reviewer = autogen.AssistantAgent(
    name="code_reviewer",
    system_message="""You are an expert code reviewer. Analyze code for:
- Bugs and logic errors
- Security vulnerabilities (OWASP Top 10)
- Performance bottlenecks
- Clean code and SOLID principle violations
Always provide line-specific feedback with example fixes.""",
    llm_config={
        "model": "llama-3.3-70b",
        "base_url": "https://api.groq.com/openai/v1",
        "api_key": os.environ["GROQ_API_KEY"],
        "temperature": 0.2,
        "max_tokens": 8192,
    },
)

# Human proxy that can execute code fetching
user_proxy = autogen.UserProxyAgent(
    name="user_proxy",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=3,
    code_execution_config={
        "work_dir": "workspace",
        "use_docker": False,
    },
)

def review_pull_request(repo: str, pr_number: int):
    diff = fetch_pr_diff(repo, pr_number)
    user_proxy.initiate_chat(
        reviewer,
        message=f"Please review this pull request diff:\\n\\n{diff}",
    )`,
    env: { GROQ_API_KEY: "", GITHUB_TOKEN: "" },
    isFeatured: true,
    isPublished: true,
    authorName: "WheelsAI",
  },

  // 3. Research Summarizer
  {
    name: "Research Summarizer",
    slug: "research-summarizer",
    title: "Research Summarizer",
    description:
      "Transforms lengthy research papers, articles, and documents into concise, structured briefings with key findings and citations.",
    longDescription:
      "Save hours of reading with an AI research assistant that ingests papers from arXiv, PubMed, or any URL and produces structured summaries: abstract, methodology, key findings, limitations, and implications. Supports batch processing of multiple papers and can compare findings across sources.",
    category: "research",
    difficulty: "beginner",
    framework: "langchain",
    tags: ["research", "summarization", "academic"],
    systemPrompt:
      "You are an expert research analyst skilled at synthesizing complex academic and technical content. When given a research paper or article: (1) extract the core thesis or research question, (2) summarize the methodology in plain language, (3) highlight the key findings and their statistical significance, (4) identify limitations and potential biases, (5) explain the practical implications. Format output as a structured briefing with clear sections. Use plain language accessible to a non-specialist audience while preserving technical accuracy.",
    tools: [
      {
        name: "web_search",
        description:
          "Search for research papers on arXiv, PubMed, and academic databases",
      },
      {
        name: "calculator",
        description:
          "Perform statistical calculations and validate numerical claims",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.4,
      maxTokens: 4096,
    },
    sourceType: "inline",
    sourceCode: `from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_community.tools import DuckDuckGoSearchRun

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    temperature=0.4,
    max_tokens=4096,
)

search = DuckDuckGoSearchRun()

summarize_prompt = ChatPromptTemplate.from_messages([
    ("system", """You are an expert research analyst. Produce a structured briefing with:
## Research Question
## Methodology
## Key Findings
## Limitations
## Practical Implications"""),
    ("human", "Summarize this research content:\\n\\n{content}"),
])

summarize_chain = summarize_prompt | llm | StrOutputParser()

def summarize_paper(url_or_query: str) -> str:
    # Fetch or search for the paper content
    content = search.run(url_or_query)
    return summarize_chain.invoke({"content": content})`,
    env: { GROQ_API_KEY: "" },
    isFeatured: false,
    isPublished: true,
    authorName: "WheelsAI",
  },

  // 4. Content Writer
  {
    name: "Content Writer",
    slug: "content-writer",
    title: "Content Writer",
    description:
      "Creates SEO-optimized blog posts, marketing copy, social media content, and email templates tailored to your brand voice.",
    longDescription:
      "Generate high-quality written content at scale. Provide a topic, target audience, tone, and keywords — the agent researches current trends, drafts content, and optimizes for SEO. Supports multiple output formats: long-form blog posts, Twitter/LinkedIn threads, email drip sequences, and product descriptions.",
    category: "creative",
    difficulty: "beginner",
    framework: "mastra",
    tags: ["content", "writing", "marketing", "social-media"],
    systemPrompt:
      "You are a skilled content writer and marketing strategist. You create engaging, original content that resonates with target audiences and drives action. For every piece of content: adapt the tone and style to the specified brand voice, incorporate target keywords naturally for SEO, structure content for maximum readability with clear headings and concise paragraphs, include a compelling hook, provide value in every section, and end with a clear call-to-action. Research current trends before writing to ensure relevance.",
    tools: [
      {
        name: "web_search",
        description:
          "Research trending topics, competitor content, and keyword opportunities",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.7,
      maxTokens: 4096,
    },
    sourceType: "inline",
    sourceCode: `import { Agent } from "@mastra/core/agent";
import { groq } from "@mastra/groq";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const trendResearchTool = createTool({
  id: "trend-research",
  description: "Research trending topics and keywords for content planning",
  inputSchema: z.object({
    topic: z.string(),
    audience: z.string().optional(),
  }),
  execute: async ({ context: { topic, audience } }) => {
    const query = audience ? \`\${topic} for \${audience}\` : topic;
    const res = await fetch(
      \`https://serpapi.com/search?q=\${encodeURIComponent(query)}&api_key=\${process.env.SERP_API_KEY}\`
    );
    return res.json();
  },
});

export const contentWriterAgent = new Agent({
  name: "content-writer",
  instructions: \`You are a skilled content writer and marketing strategist.
Create engaging, SEO-optimized content tailored to the brand voice and target audience.
Always research trends before writing.\`,
  model: groq("openai/gpt-oss-120b"),
  tools: { trendResearchTool },
});`,
    env: { GROQ_API_KEY: "", SERP_API_KEY: "" },
    isFeatured: true,
    isPublished: true,
    authorName: "WheelsAI",
  },

  // 5. Trading Signal Agent
  {
    name: "Trading Signal Agent",
    slug: "trading-signal-agent",
    title: "Trading Signal Agent",
    description:
      "Analyzes real-time market data and on-chain metrics to generate actionable trading signals with risk-adjusted position sizing.",
    longDescription:
      "A quantitative trading assistant that monitors price action, volume, RSI, MACD, and on-chain flows to surface high-probability setups. For each signal the agent provides entry price, take-profit targets, stop-loss levels, and a risk score. Supports crypto spot and perpetual markets. Not financial advice — always do your own research.",
    category: "automation",
    difficulty: "intermediate",
    framework: "elizaos",
    tags: ["trading", "finance", "signals", "crypto"],
    systemPrompt:
      "You are a quantitative trading analyst specializing in cryptocurrency markets. Your role is to analyze market data objectively and generate structured trading signals. For each signal provide: asset and timeframe, signal direction (long/short/neutral), confidence level (1-10), key technical indicators supporting the signal, suggested entry zone, take-profit levels (TP1, TP2, TP3), stop-loss level, risk/reward ratio, and position sizing recommendation as a percentage of portfolio. Always include risk warnings. Never guarantee profits. Base all analysis strictly on provided data.",
    tools: [
      {
        name: "http_request",
        description:
          "Fetch OHLCV data, order book depth, and on-chain metrics from exchange APIs",
      },
      {
        name: "calculator",
        description:
          "Calculate technical indicators (RSI, MACD, Bollinger Bands) and risk metrics",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.1,
      maxTokens: 4096,
    },
    sourceType: "inline",
    sourceCode: `import { Character, ModelProviderName, Clients } from "@elizaos/core";

export const tradingSignalCharacter: Character = {
  name: "TradingSignalAgent",
  username: "trading_signal_agent",
  modelProvider: ModelProviderName.GROQ,
  clients: [Clients.DIRECT],
  settings: {
    model: "openai/gpt-oss-120b",
    temperature: 0.1,
    maxOutputTokens: 4096,
    secrets: {
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    },
  },
  system: \`You are a quantitative trading analyst for crypto markets.
Generate structured signals with entry, TP1/TP2/TP3, stop-loss, and risk score.
Base all analysis on the provided market data. Include risk warnings.\`,
  bio: [
    "Quantitative trading analyst specializing in crypto markets",
    "Generates risk-adjusted signals from technical and on-chain data",
    "Never guarantees profits — always DYOR",
  ],
  messageExamples: [
    [
      { user: "{{user1}}", content: { text: "Analyze BTC/USDT on the 4h chart" } },
      {
        user: "TradingSignalAgent",
        content: {
          text: "BTC/USDT 4H Signal\\n\\nDirection: LONG (Confidence: 7/10)\\nEntry Zone: $94,200 - $94,800\\nTP1: $96,500 | TP2: $98,000 | TP3: $101,000\\nStop Loss: $92,400\\nR/R: 2.8:1\\nRisk: 1-2% portfolio\\n\\n⚠️ Not financial advice. DYOR.",
        },
      },
    ],
  ],
  plugins: [],
};`,
    env: { GROQ_API_KEY: "", EXCHANGE_API_KEY: "", EXCHANGE_API_SECRET: "" },
    isFeatured: false,
    isPublished: true,
    authorName: "WheelsAI",
  },

  // 6. Multi-Agent Pipeline
  {
    name: "Multi-Agent Pipeline",
    slug: "multi-agent-pipeline",
    title: "Multi-Agent Pipeline",
    description:
      "A coordinator agent that decomposes complex tasks and delegates them to specialized sub-agents, then synthesizes results into a final deliverable.",
    longDescription:
      "Build sophisticated automation workflows with a hierarchical multi-agent architecture. The coordinator breaks down a high-level goal into discrete subtasks, assigns each to a specialist agent (researcher, writer, analyst, validator), monitors progress, handles failures with retry logic, and assembles the final output. Ideal for complex research reports, due diligence pipelines, and content production workflows.",
    category: "automation",
    difficulty: "advanced",
    framework: "crewai",
    tags: ["multi-agent", "orchestration", "pipeline", "automation"],
    systemPrompt:
      "You are a master coordinator agent responsible for orchestrating complex multi-step workflows. Your responsibilities: (1) analyze the incoming goal and decompose it into discrete, parallelizable subtasks, (2) assign each subtask to the most appropriate specialist agent based on their capabilities, (3) monitor task execution and handle failures with intelligent retry or fallback strategies, (4) validate intermediate outputs before passing them to downstream agents, (5) synthesize all sub-agent outputs into a coherent, high-quality final deliverable. Communicate task status clearly and escalate blockers immediately.",
    tools: [
      {
        name: "http_request",
        description:
          "Call external APIs and webhooks to trigger sub-agent tasks and retrieve results",
      },
      {
        name: "calculator",
        description:
          "Perform calculations for task estimation, resource allocation, and output validation",
      },
      {
        name: "web_search",
        description:
          "Search the web to supplement sub-agent research and fill knowledge gaps",
      },
    ],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.5,
      maxTokens: 8192,
    },
    sourceType: "inline",
    sourceCode: `from crewai import Agent, Task, Crew, Process
from langchain_groq import ChatGroq

llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0.5)

# Specialist agents
researcher = Agent(
    role="Research Specialist",
    goal="Gather comprehensive, accurate information on the assigned topic",
    backstory="Expert at finding and validating information from diverse sources.",
    llm=llm,
    verbose=True,
    allow_delegation=False,
)

analyst = Agent(
    role="Data Analyst",
    goal="Analyze research findings and extract actionable insights",
    backstory="Skilled at identifying patterns, trends, and key takeaways from complex data.",
    llm=llm,
    verbose=True,
    allow_delegation=False,
)

writer = Agent(
    role="Content Writer",
    goal="Synthesize analysis into a clear, well-structured deliverable",
    backstory="Expert technical writer who turns complex findings into readable reports.",
    llm=llm,
    verbose=True,
    allow_delegation=False,
)

coordinator = Agent(
    role="Pipeline Coordinator",
    goal="Orchestrate the workflow and ensure quality at every stage",
    backstory="Experienced project manager who keeps complex pipelines on track.",
    llm=llm,
    verbose=True,
    allow_delegation=True,
)

def run_pipeline(goal: str) -> str:
    research_task = Task(
        description=f"Research the following goal thoroughly: {goal}",
        agent=researcher,
        expected_output="Comprehensive research notes with sources",
    )
    analysis_task = Task(
        description="Analyze the research findings and identify key insights",
        agent=analyst,
        expected_output="Structured analysis with prioritized insights",
        context=[research_task],
    )
    writing_task = Task(
        description="Write a clear, actionable final report based on the analysis",
        agent=writer,
        expected_output="Polished report ready for delivery",
        context=[research_task, analysis_task],
    )

    crew = Crew(
        agents=[researcher, analyst, writer, coordinator],
        tasks=[research_task, analysis_task, writing_task],
        process=Process.sequential,
        verbose=True,
    )
    return crew.kickoff()`,
    env: { GROQ_API_KEY: "" },
    isFeatured: false,
    isPublished: true,
    authorName: "WheelsAI",
  },
];

async function main() {
  console.log("Seeding database...");

  // Upsert models
  for (const model of models) {
    await prisma.model.upsert({
      where: { id: model.id },
      update: model,
      create: model,
    });
    console.log(`  Seeded model: ${model.id}`);
  }

  // Upsert agent templates
  for (const template of agentTemplates) {
    await prisma.agentTemplate.upsert({
      where: { slug: template.slug },
      update: template,
      create: template,
    });
    console.log(`  Seeded template: ${template.slug}`);
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
