import { createLogger } from "../utils/logger.js";

const logger = createLogger("github-import");

const GITHUB_API = "https://api.github.com";

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
  branch: string;
  detectedFiles: string[];
}

export class GitHubRepoNotFoundError extends Error {
  constructor(readonly owner: string, readonly repo: string) {
    super(`GitHub repo not found or not accessible: ${owner}/${repo}`);
  }
}

/**
 * Parses a GitHub repo URL.
 *
 * The pattern is ANCHORED to the github.com host. Unanchored, it matched
 * anywhere in the string, so `https://evil.example/github.com/o/r` parsed
 * as a valid repo — a parser that accepts a hostile host is a bad place
 * to start building request URLs from.
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo {
  const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = cleaned.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^\s]+))?$/,
  );
  if (!match) {
    throw new Error("Invalid GitHub URL. Expected: https://github.com/owner/repo");
  }
  return { owner: match[1]!, repo: match[2]!, branch: match[3] };
}

export interface DetectFrameworkOptions {
  /**
   * Installation access token for the calling ORG's GitHub App install.
   *
   * Never a platform-wide token: the previous implementation attached
   * `env.GITHUB_TOKEN` to every user's import, which made the endpoint a
   * confused deputy — any authenticated user could probe (and read
   * dependency files from) every private repo the platform PAT could
   * see. Scope now comes from GitHub itself: an installation token only
   * reaches that installation's repositories.
   */
  token?: string;
  /** Branch to inspect; defaults to the repo's default branch. */
  ref?: string;
  fetchImpl?: typeof fetch;
}

function githubHeaders(token?: string, accept = "application/vnd.github+json") {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "WheelsAI",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Reads one file's raw text through the authenticated contents API. */
async function readRepoFile(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  opts: DetectFrameworkOptions,
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  // The contents API honours the Authorization header; raw.githubusercontent
  // does not, which is why private repos always fell through to "custom"
  // no matter what token was configured.
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await doFetch(url, {
      headers: githubHeaders(opts.token, "application/vnd.github.raw"),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function frameworkFromManifest(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("@mastra/core") || lower.includes("mastra")) return "mastra";
  if (lower.includes("@elizaos/") || lower.includes("elizaos")) return "elizaos";
  if (lower.includes("langchain")) return "langchain";
  if (lower.includes("crewai")) return "crewai";
  if (lower.includes("autogen") || lower.includes("pyautogen")) return "autogen";
  return null;
}

export async function detectFramework(
  owner: string,
  repo: string,
  opts: DetectFrameworkOptions = {},
): Promise<DetectedAgentConfig> {
  const doFetch = opts.fetchImpl ?? fetch;
  // encodeURIComponent on both segments: they come from a user-supplied
  // URL and are interpolated into an API path, where a stray `?` or `..`
  // would change which endpoint we call.
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const repoRes = await doFetch(base, { headers: githubHeaders(opts.token) });
  if (!repoRes.ok) {
    // 404 covers both "no such repo" and "private and you cannot see it";
    // GitHub deliberately does not distinguish, and neither do we.
    throw new GitHubRepoNotFoundError(owner, repo);
  }
  const repoData = (await repoRes.json()) as {
    name?: string;
    description?: string;
    default_branch?: string;
  };

  const ref = opts.ref ?? repoData.default_branch ?? "main";

  const treeRes = await doFetch(
    `${base}/git/trees/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(opts.token) },
  );
  if (!treeRes.ok) throw new Error("Could not read repo file tree");
  const treeData = (await treeRes.json()) as { tree?: Array<{ path?: string }> };
  const files = (treeData.tree ?? [])
    .map((f) => f.path)
    .filter((p): p is string => typeof p === "string");

  let framework = "custom";
  const detectedFiles: string[] = [];

  for (const manifest of ["package.json", "requirements.txt", "pyproject.toml"]) {
    if (!files.includes(manifest)) continue;
    detectedFiles.push(manifest);
    if (framework !== "custom") continue;
    const text = await readRepoFile(owner, repo, manifest, ref, opts);
    if (text) {
      framework = frameworkFromManifest(text) ?? framework;
    }
  }

  for (const f of ["Dockerfile", "docker-compose.yml", ".env.example", "README.md"]) {
    if (files.includes(f)) detectedFiles.push(f);
  }

  logger.info(
    { owner, repo, ref, framework, detectedFiles, authenticated: Boolean(opts.token) },
    "Detected agent framework from GitHub repo",
  );

  return {
    framework,
    name: repoData.name || repo,
    description: repoData.description || "",
    sourceUrl: `https://github.com/${owner}/${repo}`,
    branch: ref,
    detectedFiles,
  };
}
