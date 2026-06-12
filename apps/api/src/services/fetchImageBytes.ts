/**
 * Fetch an image by URL into raw bytes for IPFS upload.
 *
 * The launch flow stores an agent's icon as a URL (AgentListing.iconUrl),
 * but pump.fun's IPFS upload (services/pumpfunIpfs.ts) needs the actual
 * image *bytes* + mime + filename. This helper bridges the two: fetch the
 * URL, validate it's a supported image under a size cap, and return the
 * exact { bytes, mime, filename } shape uploadPumpfunMetadata expects.
 *
 * The fetchFn is injected so it's unit-testable with no network, and the
 * fetch is bounded by a size cap + timeout so a hostile/huge URL can't
 * stall or OOM the prepare path.
 */

export interface FetchedImage {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface FetchImageBytesDeps {
  fetchFn: typeof fetch;
}

export interface FetchImageBytesOptions {
  /** Reject images larger than this (default 5 MiB). */
  maxBytes?: number;
  /** Abort the fetch after this many ms (default 10s). */
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

// Supported mime → canonical file extension. This is also the allow-list
// of accepted types (mirrors services/pumpfunIpfs.ts SUPPORTED_IMAGE_MIMES).
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function stripQuery(url: string): string {
  return url.split("?")[0]!.split("#")[0]!;
}

function inferMimeFromUrl(url: string): string | null {
  const m = stripQuery(url).match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return null;
  return EXT_MIME[m[1]!.toLowerCase()] ?? null;
}

function filenameFromUrl(url: string, ext: string): string {
  const base = stripQuery(url).split("/").pop() || "image";
  return /\.[a-zA-Z0-9]+$/.test(base) ? base : `${base}.${ext}`;
}

export async function fetchImageBytes(
  url: string,
  deps: FetchImageBytesDeps,
  options: FetchImageBytesOptions = {},
): Promise<FetchedImage> {
  if (!url || url.trim().length === 0) {
    throw new Error("fetchImageBytes: url is required");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await deps.fetchFn(url, { signal: controller.signal });
  } catch (err) {
    throw new Error(
      `fetchImageBytes: fetch failed for ${url} (${(err as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`fetchImageBytes: ${url} returned ${res.status}`);
  }

  // Prefer the server-declared content-type; fall back to the URL extension
  // (some object stores serve images as application/octet-stream).
  const header = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const mime = MIME_EXT[header] ? header : inferMimeFromUrl(url);
  if (!mime || !MIME_EXT[mime]) {
    throw new Error(
      `fetchImageBytes: unsupported image type for ${url} ` +
        `(content-type='${header || "none"}'; need png/jpeg/gif/webp)`,
    );
  }

  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);
  if (bytes.length === 0) {
    throw new Error(`fetchImageBytes: ${url} returned an empty body`);
  }
  if (bytes.length > maxBytes) {
    throw new Error(
      `fetchImageBytes: ${url} is ${bytes.length}b, exceeds ${maxBytes}b cap`,
    );
  }

  return { bytes, mime, filename: filenameFromUrl(url, MIME_EXT[mime]!) };
}
