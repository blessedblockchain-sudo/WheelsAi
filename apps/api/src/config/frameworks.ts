/** Agent frameworks the platform accepts, imports and runs. */
export const AGENT_FRAMEWORKS = ["mastra", "langchain", "autogen", "elizaos", "crewai", "custom"] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];
