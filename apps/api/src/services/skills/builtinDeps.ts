/**
 * Dependencies the built-in skills need from the outside world. Every IO
 * surface is injectable so the skills are unit-testable without a network,
 * a bucket, a database or a sandbox.
 */

import type { SkillsConfigState } from "../../config/skills.js";
import type { UrlGuardDeps } from "../../lib/ssrfGuard.js";
import type { RetrieveContextDeps } from "../agentRetrieval.js";
import type { AgentFileLock } from "./agentFileLock.js";
import type { AgentFileStore } from "./agentFileStore.js";
import type { SandboxRunner } from "./sandboxRunner.js";

export interface BuiltinSkillDeps {
  getConfig(): SkillsConfigState;
  /** Underlying fetch for the SSRF-guarded client; tests inject a fake. */
  fetchImpl?: typeof fetch;
  guardDeps?: UrlGuardDeps;
  /** The shared object store, or null when storage is not configured. */
  getFileStore(): AgentFileStore | null;
  /**
   * Serialises writers to one agent's files. Production wires the Redis lock
   * (all replicas share it); left out, writers are serialised in-process,
   * which is only correct for a single process.
   */
  fileLock?: AgentFileLock;
  /** The configured sandbox runner, or null when code execution is off. */
  getSandbox(): SandboxRunner | null;
  /** Knowledge retrieval (the same path the playground grounds with). */
  knowledge: RetrieveContextDeps;
}
