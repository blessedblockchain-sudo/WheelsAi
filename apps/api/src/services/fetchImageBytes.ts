/**
 * Fetch an image by URL into raw bytes for IPFS upload.
 *
 * The launch flow stores an agent's icon as a URL (AgentListing.iconUrl),
 * but pump.fun's IPFS upload (services/pumpfunIpfs.ts) needs the actual
 * image *bytes* + mime + filename. This helper bridges the two: fetch the
 * URL, validate it's a supported image under a size cap, and return the
 * exact { bytes, mime, filename } shape uploadPumpfunMetadata expects.
 *
 * The fetchFn is injected so it's unit-testable with no network. The wait
 * for the answer is bounded by a timeout, and the body is read a piece at a
 * time and dropped once it is over the size cap, so a huge picture cannot
 * fill the server's memory. (The body's own reading has no time limit.)
 *
 * The link is one a user typed, and the request leaves from inside our
 * network. So before any request: a link that is not http or https is
 * refused everywhere, and outside development a link to this machine or a
 * private network is refused too, at the first address and at every
 * redirect (lib/ssrfGuard.ts, which also resolves the host's name). In
 * development a local link is allowed: the demo's agents use the app's own
 * icon. Either refusal is a LaunchRefusal with the code
 * `picture_link_refused`, which the launch route answers as a 400.
 */

import { SsrfBlockedError, safeFetch } from "../lib/ssrfGuard.js";
import { LaunchRefusal } from "./launchpad/launchRefusal.js";

export interface FetchedImage {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface FetchImageBytesDeps {
  fetchFn: typeof fetch;
  /** Injected for tests; defaults to real DNS. Asked only where local links are refused. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface FetchImageBytesOptions {
  /** Reject images larger than this (default 5 MiB). */
  maxBytes?: number;
  /** Abort the fetch after this many ms (default 10s). */
  timeoutMs?: number;
  /**
   * May the link point at this machine or a private network? Defaults to
   * yes in development and test and to no everywhere else.
   */
  allowLocal?: boolean;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Redirects followed where each one is checked. */
const MAX_REDIRECTS = 3;

/**
 * NODE_ENV as config/env.ts reads it (unset means development), read here
 * directly so this helper does not pull the whole configuration in.
 */
function localLinksAllowedByDefault(): boolean {
  const mode = process.env.NODE_ENV ?? "development";
  return mode === "development" || mode === "test";
}

function refuseLink(why: string, cause?: unknown): LaunchRefusal {
  return new LaunchRefusal(
    "picture_link_refused",
    `The picture's link cannot be used: ${why}.`,
    { cause },
  );
}

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

/**
 * The body, or null when it is larger than `maxBytes`. Read a piece at a
 * time and dropped as soon as it is over: a link a user typed can answer
 * with a body that never ends, and reading it whole first would fill the
 * server's memory before the cap was ever looked at.
 */
async function readUpTo(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > maxBytes ? null : whole;
  }
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    pieces.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.length;
  }
  return bytes;
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
  const allowLocal = options.allowLocal ?? localLinksAllowedByDefault();

  // Refused everywhere, before any request: file:, data: and their kin.
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (err) {
    throw refuseLink("it is not a web address", err);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw refuseLink("it must start with http or https");
  }

  let res: Response;
  if (allowLocal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await deps.fetchFn(url, { signal: controller.signal });
    } catch (err) {
      throw new Error(
        `fetchImageBytes: fetch failed for ${url} (${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }
  } else {
    // The guard checks the address before each request and follows a
    // redirect by hand, so a public link cannot hand us on to a private one.
    try {
      res = await safeFetch(url.trim(), {
        fetchImpl: deps.fetchFn,
        timeoutMs,
        maxRedirects: MAX_REDIRECTS,
        guardDeps: { resolveHost: deps.resolveHost },
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // Never the guard's own detail: it can name an address inside our network.
        throw refuseLink(
          "it must be a public web address, and may not lead to this machine or a private network",
          err,
        );
      }
      throw new Error(
        `fetchImageBytes: fetch failed for ${url} (${(err as Error).message})`,
      );
    }
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

  const bytes = await readUpTo(res, maxBytes);
  if (bytes === null) {
    throw new Error(`fetchImageBytes: ${url} exceeds ${maxBytes}b cap`);
  }
  if (bytes.length === 0) {
    throw new Error(`fetchImageBytes: ${url} returned an empty body`);
  }

  return { bytes, mime, filename: filenameFromUrl(url, MIME_EXT[mime]!) };
}
