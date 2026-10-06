/**
 * data_sync: keep a knowledge base in step with a list of URLs.
 *
 * Per source:
 *   1. GET it through the SSRF guard (every redirect hop re-checked).
 *   2. Refuse what cannot be ingested honestly: a non-2xx answer, a
 *      content type that is not text, a body over the size limit. An
 *      oversize body FAILS; it is never cut and stored as if complete.
 *   3. Reduce HTML to text and hash the result.
 *   4. Same hash as the stored document for that URL: leave it alone
 *      (no re-chunking, no embedding calls). Different or new: store the
 *      new document, then remove the old one, in that order, so a failed
 *      ingest never leaves the knowledge base without the source.
 *
 * Sources are independent: one failing does not stop the others. The
 * task as a whole fails when any source failed, and its output still
 * lists what happened to every source.
 *
 * Pure: fetch, DNS, the knowledge base and hashing are injected.
 */

import { safeFetch, SsrfBlockedError, type UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { htmlToText } from "../htmlToText.js";
import type { DataSyncPayload } from "../scheduledTaskTypes.js";
import { readBodyCapped } from "../skills/httpLimits.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { isAbort, permanentFailure, TaskError } from "./taskError.js";

export const DATA_SYNC_DEFAULT_MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface DataSyncDeps {
  /** The agent's knowledge base, or null (no agent in this org, or none set). */
  loadAgentKnowledgeBaseId: (agentId: string, orgId: string) => Promise<string | null>;
  /** Org-scoped; null when the knowledge base is not this organization's. */
  loadKnowledgeBase: (id: string, orgId: string) => Promise<{ id: string } | null>;
  /** The document previously synced from this URL into this knowledge base. */
  findDocumentBySource: (
    knowledgeBaseId: string,
    sourceUrl: string,
  ) => Promise<{ id: string; contentHash: string | null } | null>;
  addDocument: (
    knowledgeBaseId: string,
    orgId: string,
    doc: {
      title: string;
      content: string;
      sourceUrl: string;
      mimeType: string;
      metadata: Record<string, unknown>;
    },
  ) => Promise<{ id: string; chunkCount: number }>;
  deleteDocument: (documentId: string, knowledgeBaseId: string, orgId: string) => Promise<void>;
  /** Whether new chunks are embedded (semantic) or searchable by keyword only. */
  embeddingMode: () => "semantic" | "keyword";
  hash: (text: string) => string;
  fetchFn: typeof fetch;
  guardDeps?: UrlGuardDeps;
}

export interface DataSyncSourceResult {
  url: string;
  status: "added" | "updated" | "unchanged" | "failed";
  documentId: string | null;
  chunks: number | null;
  bytes: number | null;
  error?: string;
}

type ContentKind = "html" | "text";

function contentKind(contentType: string | null): ContentKind | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json")) {
    return "text";
  }
  return null;
}

function titleFor(source: { url: string; title?: string }, html: string | null): string {
  if (source.title) return source.title;
  const match = html ? /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html) : null;
  const fromPage = match ? htmlToText(match[1]!).replace(/\s+/g, " ").trim() : "";
  return (fromPage || source.url).slice(0, 200);
}

async function syncSource(
  source: { url: string; title?: string },
  args: {
    knowledgeBaseId: string;
    orgId: string;
    taskId: string;
    maxBytes: number;
    now: Date;
    signal?: AbortSignal;
  },
  deps: DataSyncDeps,
): Promise<DataSyncSourceResult> {
  const failed = (error: string): DataSyncSourceResult => ({
    url: source.url,
    status: "failed",
    documentId: null,
    chunks: null,
    bytes: null,
    error,
  });

  let res: Response;
  try {
    res = await safeFetch(source.url, {
      method: "GET",
      headers: { Accept: "text/html, text/plain, application/json;q=0.9, text/*;q=0.8" },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: 3,
      signal: args.signal,
      fetchImpl: deps.fetchFn,
      guardDeps: deps.guardDeps,
    });
  } catch (err) {
    if (isAbort(err, args.signal)) throw err;
    if (err instanceof SsrfBlockedError) return failed(`source refused: ${err.publicMessage}`);
    return failed(`could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return failed(`source responded ${res.status}`);
  }
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const kind = contentKind(res.headers.get("content-type"));
  if (!kind) {
    await res.body?.cancel().catch(() => {});
    return failed(
      `unsupported content type "${mimeType || "none"}"; data sync ingests HTML, text and JSON`,
    );
  }

  // One byte past the limit is read on purpose: it is how "exactly at the
  // limit" is told apart from "larger".
  const body = await readBodyCapped(res, {
    maxBytes: args.maxBytes + 1,
    timeoutMs: FETCH_TIMEOUT_MS,
    signal: args.signal,
  });
  if (args.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  if (body.truncated || body.bytesRead > args.maxBytes) {
    return failed(`source is larger than the ${args.maxBytes}-byte limit for this task`);
  }

  const content = kind === "html" ? htmlToText(body.text) : body.text.trim();
  if (content === "") return failed("source has no text content");

  const contentHash = deps.hash(content);
  const existing = await deps.findDocumentBySource(args.knowledgeBaseId, source.url);
  if (existing && existing.contentHash === contentHash) {
    return {
      url: source.url,
      status: "unchanged",
      documentId: existing.id,
      chunks: null,
      bytes: body.bytesRead,
    };
  }

  const added = await deps.addDocument(args.knowledgeBaseId, args.orgId, {
    title: titleFor(source, kind === "html" ? body.text : null),
    content,
    sourceUrl: source.url,
    mimeType,
    metadata: {
      contentHash,
      syncedAt: args.now.toISOString(),
      syncTaskId: args.taskId,
    },
  });
  if (existing) {
    await deps.deleteDocument(existing.id, args.knowledgeBaseId, args.orgId);
  }
  return {
    url: source.url,
    status: existing ? "updated" : "added",
    documentId: added.id,
    chunks: added.chunkCount,
    bytes: body.bytesRead,
  };
}

export async function runDataSync(
  task: ScheduledTaskForExecution,
  payload: DataSyncPayload,
  ctx: TaskRunContext,
  deps: DataSyncDeps,
): Promise<TaskResult> {
  const requestedId =
    payload.knowledgeBaseId ??
    (task.agentId ? await deps.loadAgentKnowledgeBaseId(task.agentId, task.orgId) : null);
  if (!requestedId) {
    throw permanentFailure(
      "data sync has no knowledge base: set one on the task, or give its agent a knowledge base",
    );
  }
  const knowledgeBase = await deps.loadKnowledgeBase(requestedId, task.orgId);
  if (!knowledgeBase) {
    throw permanentFailure("knowledge base not found in this organization");
  }

  const maxBytes = payload.maxBytes ?? DATA_SYNC_DEFAULT_MAX_BYTES;
  const sources: DataSyncSourceResult[] = [];
  for (const source of payload.sources) {
    if (ctx.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    try {
      sources.push(
        await syncSource(
          source,
          {
            knowledgeBaseId: knowledgeBase.id,
            orgId: task.orgId,
            taskId: task.id,
            maxBytes,
            now: ctx.now,
            signal: ctx.signal,
          },
          deps,
        ),
      );
    } catch (err) {
      if (isAbort(err, ctx.signal)) throw err;
      sources.push({
        url: source.url,
        status: "failed",
        documentId: null,
        chunks: null,
        bytes: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const output = {
    knowledgeBaseId: knowledgeBase.id,
    embeddingMode: deps.embeddingMode(),
    sources,
  };
  const failures = sources.filter((s) => s.status === "failed");
  if (failures.length > 0) {
    throw new TaskError(
      `${failures.length} of ${sources.length} sources failed: ` +
        failures.map((f) => `${f.url} (${f.error})`).join("; "),
      { output },
    );
  }
  return { output };
}
