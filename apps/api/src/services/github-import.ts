import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const logger = createLogger("github-import");

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  branch?: string;
}

export interface DetectedAgentConfig {
  framework: string;
  name: string;
  description: string;
  sourceUrl: string;
  detectedFiles: string[];
}

export function parseGitHubUrl(url: string): GitHubRepoInfo {
  // Handle: https://github.com/owner/repo, https://github.com/owner/repo/tree/branch, github.com/owner/repo
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/(.+))?/);
  if (!match) throw new Error("Invalid GitHub URL. Expected: https://github.com/owner/repo");
  return { owner: match[1]!, repo: match[2]!, branch: match[3] };
}

export async function detectFramework(owner: string, repo: string): Promise<DetectedAgentConfig> {
  const headers: Record<string, string> = { "Accept": "application/vnd.github.v3+json", "User-Agent": "WheelsAI" };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  // Fetch repo info
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub repo not found: ${owner}/${repo}`);
  const repoData = await repoRes.json();

  // Fetch root tree to find config files
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${repoData.default_branch}`, { headers });
  if (!treeRes.ok) throw new Error("Could not read repo file tree");
  const treeData = await treeRes.json();
  const files = (treeData.tree || []).map((f: any) => f.path as string);

  let framework = "custom";
  const detectedFiles: string[] = [];

  // Try to fetch package.json for JS/TS frameworks
  if (files.includes("package.json")) {
    detectedFiles.push("package.json");
    try {
      const pkgRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${repoData.default_branch}/package.json`, { headers: { "User-Agent": "WheelsAI" } });
      if (pkgRes.ok) {
        const pkgText = await pkgRes.text();
        const lower = pkgText.toLowerCase();
        if (lower.includes("@mastra/core") || lower.includes("mastra")) framework = "mastra";
        else if (lower.includes("@elizaos/") || lower.includes("elizaos")) framework = "elizaos";
        else if (lower.includes("langchain")) framework = "langchain";
        else if (lower.includes("crewai")) framework = "crewai";
        else if (lower.includes("autogen")) framework = "autogen";
      }
    } catch { /* ignore */ }
  }

  // Try requirements.txt for Python frameworks
  if (framework === "custom" && files.includes("requirements.txt")) {
    detectedFiles.push("requirements.txt");
    try {
      const reqRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${repoData.default_branch}/requirements.txt`, { headers: { "User-Agent": "WheelsAI" } });
      if (reqRes.ok) {
        const reqText = await reqRes.text();
        const lower = reqText.toLowerCase();
        if (lower.includes("langchain")) framework = "langchain";
        else if (lower.includes("autogen") || lower.includes("pyautogen")) framework = "autogen";
        else if (lower.includes("crewai")) framework = "crewai";
      }
    } catch { /* ignore */ }
  }

  // Check for common agent config files
  for (const f of ["Dockerfile", "docker-compose.yml", ".env.example", "README.md"]) {
    if (files.includes(f)) detectedFiles.push(f);
  }

  logger.info({ owner, repo, framework, detectedFiles }, "Detected agent framework from GitHub repo");

  return {
    framework,
    name: repoData.name || repo,
    description: repoData.description || "",
    sourceUrl: `https://github.com/${owner}/${repo}`,
    detectedFiles,
  };
}
