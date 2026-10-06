import { z } from "zod";

import type { BuiltinSkillDeps } from "./builtinDeps.js";
import { clipText } from "./httpLimits.js";
import { MAX_SANDBOX_CODE_BYTES, SandboxError, type SandboxResult } from "./sandboxRunner.js";
import type { SkillDefinition } from "./types.js";

const UNCONFIGURED = "code execution sandbox is not configured";

const inputSchema = z.object({
  language: z.string().trim().min(1).max(16).default("python"),
  code: z.string().min(1).max(MAX_SANDBOX_CODE_BYTES),
  stdin: z.string().max(64 * 1024).optional(),
});

/** What the model sees for one run: exit status first, then both streams. */
export function formatSandboxResult(result: SandboxResult): string {
  const lines: string[] = [];
  if (result.timedOut) {
    lines.push("execution timed out and was killed");
  } else {
    lines.push(`exit code: ${result.exitCode}`);
  }
  lines.push("stdout:", result.stdout.length > 0 ? result.stdout : "(empty)");
  if (result.stderr.length > 0) lines.push("stderr:", result.stderr);
  if (result.truncated) lines.push("...[output truncated at the size limit]");
  return lines.join("\n");
}

/**
 * Runs code in an EXTERNAL sandbox (services/skills/sandboxRunner.ts). This
 * skill never evaluates anything itself: with no runner configured it is
 * unavailable, full stop.
 */
export function createCodeInterpreterSkill(deps: BuiltinSkillDeps): SkillDefinition {
  const unavailableReason = () => {
    const state = deps.getConfig();
    return state.error
      ? `code execution is misconfigured on this server (${state.error})`
      : UNCONFIGURED;
  };

  return {
    key: "code_interpreter",
    version: "1.0.0",
    name: "Code Interpreter",
    description:
      "Run a short program in an isolated sandbox (Python or JavaScript) and return its exit code, stdout and stderr. No network access; nothing persists between runs.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "javascript"], default: "python" },
        code: { type: "string", description: "Source code to run" },
        stdin: { type: "string", description: "Optional text fed to the program's stdin" },
      },
      required: ["code"],
    },
    moneyMoving: false,
    requires: ["SANDBOX_RUNNER_URL"],
    availability: () =>
      deps.getSandbox()
        ? { available: true }
        : { available: false, reason: unavailableReason() },

    async execute(input, ctx) {
      const sandbox = deps.getSandbox();
      if (!sandbox) return { status: "unavailable", reason: unavailableReason() };

      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return { status: "error", message: "code must be a non-empty string" };
      }
      const { language, code, stdin } = parsed.data;

      try {
        const result = await sandbox.run(language, code, sandbox.limits, {
          stdin,
          signal: ctx.signal,
        });
        return {
          status: "ok",
          output: clipText(formatSandboxResult(result), 20_000),
          data: result,
        };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        if (err instanceof SandboxError) return { status: "error", message: err.message };
        return {
          status: "error",
          message: err instanceof Error ? err.message : "code execution failed",
        };
      }
    },
  };
}
