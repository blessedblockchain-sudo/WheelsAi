import { z } from "zod";

import { createLogger } from "../../utils/logger.js";

import { makeMemoryAgentFileLock, type FileLockLease } from "./agentFileLock.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import {
  agentFilePrefix,
  sanitizeAgentFilePath,
  StoredFileTooLargeError,
  type AgentFileStore,
} from "./agentFileStore.js";
import type { SkillDefinition, SkillResult, ToolContext } from "./types.js";

/**
 * `file_read` / `file_write`: per-agent text file storage on the shared
 * object store. Scope (org + agent) comes from the trusted ToolContext; the
 * model only chooses a sanitised relative path. Limits come from
 * config/skills.ts (defaults: 1 MiB per file, 50 files per agent).
 */

/** Characters returned per read; longer files are paged with `offset`. */
const READ_PAGE_CHARS = 6_000;

const UNCONFIGURED = "file storage is temporarily unavailable";

const logger = createLogger("file-skills");

const limitMessage = (count: number, limit: number) =>
  `this agent already holds ${count} files; the limit is ${limit}. Overwrite an existing file instead.`;

const LOCK_UNAVAILABLE = "file storage cannot coordinate writes right now; nothing was written";

const BUSY =
  "this agent's file storage is busy with other writes; nothing was written - try again";

const UNCERTAIN =
  "the write did not finish in time and may not have been saved; read the file back before relying on it";

const FILE_REQUIRES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DATASETS_BUCKET"];

const writeInput = z.object({
  path: z.unknown(),
  content: z.string(),
});

const readInput = z.object({
  path: z.unknown().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

function storeOrUnavailable(
  deps: BuiltinSkillDeps,
  ctx: ToolContext,
): { store: AgentFileStore; prefix: string } | SkillResult {
  const store = deps.getFileStore();
  if (!store) return { status: "unavailable", reason: UNCONFIGURED };
  if (!ctx.agentId || !ctx.orgId) {
    return { status: "unavailable", reason: "no agent context for this run" };
  }
  try {
    return { store, prefix: agentFilePrefix(ctx.orgId, ctx.agentId) };
  } catch {
    return { status: "unavailable", reason: "this agent's storage scope is invalid" };
  }
}

function isResult(v: unknown): v is SkillResult {
  return typeof v === "object" && v !== null && "status" in v;
}

export function createFileWriteSkill(deps: BuiltinSkillDeps): SkillDefinition {
  const fileLock = deps.fileLock ?? makeMemoryAgentFileLock();
  return {
    key: "file_write",
    version: "1.0.0",
    name: "File Write",
    description:
      "Write (create or overwrite) a UTF-8 text file in this agent's private storage. Paths are relative, e.g. notes/todo.txt.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path, e.g. notes/todo.txt" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
    moneyMoving: false,
    writesState: true,
    requires: FILE_REQUIRES,
    availability: () =>
      deps.getFileStore() ? { available: true } : { available: false, reason: UNCONFIGURED },

    async execute(input, ctx) {
      const scope = storeOrUnavailable(deps, ctx);
      if (isResult(scope)) return scope;

      const parsed = writeInput.safeParse(input);
      if (!parsed.success) {
        return { status: "error", message: "path and content (string) are required" };
      }
      const verdict = sanitizeAgentFilePath(parsed.data.path);
      if (!verdict.ok) return { status: "error", message: `invalid path: ${verdict.reason}` };

      const { maxBytes, maxCount } = deps.getConfig().config.agentFiles;
      const bytes = Buffer.byteLength(parsed.data.content, "utf8");
      if (bytes > maxBytes) {
        return {
          status: "error",
          message: `file is ${bytes} bytes; the limit is ${maxBytes} bytes per file`,
        };
      }

      // "Count, then put" is only a limit if nobody else counts in between,
      // so writers to one agent take turns. Nothing is ever deleted to make
      // the count come out right: a write that cannot be proven to fit is
      // refused BEFORE it lands, never taken back afterwards.
      let lease: FileLockLease | null;
      try {
        lease = await fileLock.acquire(scope.prefix);
      } catch (err) {
        logger.error({ err, prefix: scope.prefix }, "agent file lock is unavailable; write refused");
        return { status: "unavailable", reason: LOCK_UNAVAILABLE };
      }
      if (!lease) return { status: "error", message: BUSY };

      let isOverwrite: boolean;
      try {
        const existing = await scope.store.list(scope.prefix);
        isOverwrite = existing.some((f) => f.path === verdict.path);
        if (!isOverwrite && existing.length >= maxCount) {
          return { status: "error", message: limitMessage(existing.length, maxCount) };
        }
        // The listing took so long that our turn is nearly over: the next
        // writer may be about to count without seeing this file.
        if (lease.signal.aborted) return { status: "error", message: BUSY };

        try {
          await scope.store.put(`${scope.prefix}${verdict.path}`, parsed.data.content, lease.signal);
        } catch (err) {
          if (!lease.signal.aborted) throw err;
          // Abandoned mid-upload. The store may or may not have kept it, and
          // saying either would be a guess.
          logger.warn({ err, prefix: scope.prefix }, "agent file write abandoned: lock lease ran out");
          return { status: "error", message: UNCERTAIN };
        }
      } finally {
        await lease.release();
      }

      return {
        status: "ok",
        output: `${isOverwrite ? "Overwrote" : "Created"} ${verdict.path} (${bytes} bytes).`,
        data: { path: verdict.path, bytes, overwritten: isOverwrite },
      };
    },
  };
}

export function createFileReadSkill(deps: BuiltinSkillDeps): SkillDefinition {
  return {
    key: "file_read",
    version: "1.0.0",
    name: "File Read",
    description:
      "Read a text file from this agent's private storage, or list all files when no path is given. Long files are returned in pages; pass offset to continue.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path to read. Omit to list every file.",
        },
        offset: { type: "number", description: "Character offset to continue a long file from", default: 0 },
      },
    },
    moneyMoving: false,
    readsPrivateState: true,
    requires: FILE_REQUIRES,
    availability: () =>
      deps.getFileStore() ? { available: true } : { available: false, reason: UNCONFIGURED },

    async execute(input, ctx) {
      const scope = storeOrUnavailable(deps, ctx);
      if (isResult(scope)) return scope;

      const parsed = readInput.safeParse(input ?? {});
      if (!parsed.success) return { status: "error", message: "offset must be a non-negative integer" };

      const rawPath = parsed.data.path;
      if (rawPath === undefined || rawPath === null || rawPath === "") {
        const files = (await scope.store.list(scope.prefix)).sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        if (files.length === 0) return { status: "ok", output: "No files stored yet." };
        return {
          status: "ok",
          output: `${files.length} file(s):\n${files.map((f) => `${f.path} (${f.size} bytes)`).join("\n")}`,
          data: { files },
        };
      }

      const verdict = sanitizeAgentFilePath(rawPath);
      if (!verdict.ok) return { status: "error", message: `invalid path: ${verdict.reason}` };

      const { maxBytes } = deps.getConfig().config.agentFiles;
      let text: string | null;
      try {
        text = await scope.store.get(`${scope.prefix}${verdict.path}`, maxBytes);
      } catch (err) {
        // Only our own, user-safe message is shown; anything else (a storage
        // error that may name buckets or ARNs) propagates to the registry,
        // which logs it and reports a generic failure.
        if (err instanceof StoredFileTooLargeError) {
          return { status: "error", message: err.message };
        }
        throw err;
      }
      if (text === null) {
        return { status: "error", message: `no such file: ${verdict.path}` };
      }

      const { offset } = parsed.data;
      if (offset > text.length) {
        return {
          status: "error",
          message: `offset ${offset} is past the end of the file (${text.length} characters)`,
        };
      }
      const end = Math.min(text.length, offset + READ_PAGE_CHARS);
      const page = text.slice(offset, end);
      const more =
        end < text.length
          ? `\n...[showing characters ${offset}-${end} of ${text.length}; call again with offset=${end} to continue]`
          : "";
      return { status: "ok", output: `${page}${more}` };
    },
  };
}
