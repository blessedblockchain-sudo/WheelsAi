import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WheelsAI, WheelsAIError, seg } from "../src/index.js";
import { API_KEY, BASE_URL, jsonResponse, recordingFetch } from "./helpers.js";

describe("authentication header", () => {
  it("sends an API key as Authorization: Bearer and never as X-API-Key", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await wheels.agents.list();
    assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(calls[0]?.headers.has("x-api-key"), false);
  });

  it("sends a session token as Authorization: Bearer", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "jwt.session.token", fetch });
    await wheels.agents.list();
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer jwt.session.token");
  });

  it("prefers the session token when both are set", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "jwt.session.token", apiKey: API_KEY, fetch });
    await wheels.agents.list();
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer jwt.session.token");
  });

  it("treats empty strings as no credential", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "", apiKey: "", fetch });
    await wheels.agents.list();
    assert.equal(calls[0]?.headers.has("authorization"), false);
  });

  it("setApiKey and setToken take effect on later requests", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, fetch });
    wheels.setApiKey(API_KEY);
    await wheels.agents.list();
    wheels.setToken("jwt.session.token");
    await wheels.agents.list();
    wheels.setToken(undefined);
    await wheels.agents.list();
    assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer jwt.session.token");
    assert.equal(calls[2]?.headers.get("authorization"), `Bearer ${API_KEY}`);
  });
});

describe("request building", () => {
  it("strips trailing slashes from the base URL", async () => {
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: `${BASE_URL}//`, fetch }).agents.list();
    assert.equal(calls[0]?.url.href, `${BASE_URL}/api/agents`);
  });

  it("omits undefined query values and encodes the rest", async () => {
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: BASE_URL, fetch }).marketplace.search({ query: "a b&c", limit: 5, category: undefined });
    assert.equal(calls[0]?.url.search, "?query=a+b%26c&limit=5");
  });

  it("percent-encodes path segments", async () => {
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: BASE_URL, fetch }).agents.get("../admin?x=1");
    assert.equal(calls[0]?.url.pathname, "/api/agents/..%2Fadmin%3Fx%3D1");
  });

  it("refuses path segments that encoding cannot protect: empty, '.' and '..'", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, fetch });
    for (const bad of ["", ".", ".."]) {
      assert.throws(() => seg(bad), WheelsAIError, JSON.stringify(bad));
      assert.throws(() => wheels.agents.get(bad), /cannot be used in a request path/);
      assert.throws(() => wheels.agents.getDeployment("a", bad), WheelsAIError);
    }
    assert.equal(calls.length, 0, "nothing was requested");
    assert.equal(seg("..a"), "..a");
    assert.equal(seg(7), "7");
  });

  it("sends a JSON content type only when there is a body", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, fetch });
    await wheels.agents.list();
    await wheels.auth.login("a@b.co", "pw");
    assert.equal(calls[0]?.headers.has("content-type"), false);
    assert.equal(calls[1]?.headers.get("content-type"), "application/json");
  });

  it("returns undefined for 204 responses", async () => {
    const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
    const result = await new WheelsAI({ baseUrl: BASE_URL, fetch }).versioning.delete("a", "1.0.0");
    assert.equal(result, undefined);
  });
});

describe("errors", () => {
  const failing = (status: number, body: unknown) =>
    new WheelsAI({ baseUrl: BASE_URL, fetch: recordingFetch(() => jsonResponse(body, status)).fetch });

  it("uses the API's message and keeps its error code", async () => {
    const wheels = failing(402, { error: "insufficient_credits", message: "Add credits and retry." });
    await assert.rejects(wheels.agents.list(), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 402);
      assert.equal(err.message, "Add credits and retry.");
      assert.equal(err.code, "insufficient_credits");
      assert.deepEqual(err.data, { error: "insufficient_credits", message: "Add credits and retry." });
      return true;
    });
  });

  it("reads the message and code out of an OpenAI-shaped /v1 error", async () => {
    const body = {
      error: {
        message: "No agent with that slug exists in this organization.",
        type: "invalid_request_error",
        param: null,
        code: "agent_not_found",
      },
    };
    const wheels = failing(404, body);
    await assert.rejects(
      wheels.agents.chatCompletion("nope", { messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof WheelsAIError);
        assert.equal(err.status, 404);
        assert.equal(err.message, "No agent with that slug exists in this organization.");
        assert.equal(err.code, "agent_not_found");
        assert.deepEqual(err.data, body);
        return true;
      },
    );
  });

  it("falls back to the error field (graph and versioning routes)", async () => {
    const wheels = failing(404, { success: false, error: "Agent not found or access denied" });
    await assert.rejects(wheels.agents.getGraph("x"), { message: "Agent not found or access denied", status: 404 });
  });

  it("spells out zod validation details", async () => {
    const wheels = failing(400, {
      error: "validation_failed",
      details: { formErrors: [], fieldErrors: { email: ["Invalid email"], password: ["Too short", "Too simple"] } },
    });
    await assert.rejects(wheels.auth.register("x", "y"), {
      message: "validation_failed: email: Invalid email; password: Too short, Too simple",
      code: "validation_failed",
    });
  });

  it("uses the status text for non-JSON error bodies", async () => {
    const { fetch } = recordingFetch(
      () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    await assert.rejects(new WheelsAI({ baseUrl: BASE_URL, fetch }).agents.list(), {
      status: 502,
      message: "Bad Gateway",
    });
  });

  it("reports network failures as status 0 with the target URL", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4000") });
    };
    await assert.rejects(new WheelsAI({ baseUrl: "http://127.0.0.1:4000", fetch }).agents.list(), {
      status: 0,
      message: "Could not reach http://127.0.0.1:4000: connect ECONNREFUSED 127.0.0.1:4000",
    });
  });

  it("aborts a request after timeoutMs", async () => {
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout's timer is unref'd; a real socket keeps the loop alive, so fake that.
        const keepAlive = setInterval(() => {}, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(init.signal?.reason);
        });
      });
    await assert.rejects(new WheelsAI({ baseUrl: BASE_URL, fetch, timeoutMs: 20 }).agents.list(), {
      status: 0,
      message: `Request to ${BASE_URL} timed out after 20ms`,
    });
  });

  it("lets one call outlast the client's timeout", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        seen.push(init?.signal);
        const answer = setTimeout(() => resolve(jsonResponse({ content: "late" })), 60);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(answer);
          reject(init.signal?.reason);
        });
      });
    const wheels = new WheelsAI({ baseUrl: BASE_URL, fetch, timeoutMs: 20 });
    const body = { messages: [{ role: "user" as const, content: "hi" }] };
    await assert.rejects(wheels.agents.playgroundChat("a", body), { status: 0, message: `Request to ${BASE_URL} timed out after 20ms` });
    assert.deepEqual(await wheels.agents.playgroundChat("a", body, { timeoutMs: 5_000 }), { content: "late" });
    assert.deepEqual(await wheels.inference.chatCompletion("slug", { messages: [] }, { timeoutMs: 0 }), { content: "late" });
    assert.equal(seen[2], undefined, "timeoutMs 0 sends no abort signal");
  });

  it("never puts a credential it cannot send into the error", async () => {
    const { fetch, calls } = recordingFetch();
    for (const bad of ["wheels_live_SECRET\nX", "wheels_live_SECRET\u0000", "wheels_live_SE CRET"]) {
      for (const config of [{ apiKey: bad }, { token: bad }]) {
        await assert.rejects(new WheelsAI({ baseUrl: BASE_URL, fetch, ...config }).agents.list(), (err: unknown) => {
          assert.ok(err instanceof WheelsAIError);
          assert.equal(err.status, 0);
          assert.match(err.message, /whitespace or control characters/);
          assert.doesNotMatch(err.message, /SECRET|SE CRET/);
          return true;
        });
      }
    }
    assert.equal(calls.length, 0, "nothing was sent");
  });

  it("rejects a successful response that is not JSON", async () => {
    const { fetch } = recordingFetch(() => new Response("ok", { status: 200 }));
    await assert.rejects(new WheelsAI({ baseUrl: BASE_URL, fetch }).agents.list(), {
      status: 200,
      message: "The API returned a response that is not valid JSON",
    });
  });
});
