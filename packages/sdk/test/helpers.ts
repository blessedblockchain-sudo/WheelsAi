export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  /** The parsed JSON body, or undefined when none was sent. */
  body: unknown;
  rawBody: string | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that records every request and answers with `respond`
 * (default: 200 `{}`). No network is ever touched.
 */
export function recordingFetch(respond: Responder = () => jsonResponse({})) {
  const calls: RecordedCall[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
      headers: new Headers(init?.headers),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      rawBody,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetchFn, calls };
}

export const BASE_URL = "https://api.example.test";
export const API_KEY = "wheels_live_testkey1234567890";
