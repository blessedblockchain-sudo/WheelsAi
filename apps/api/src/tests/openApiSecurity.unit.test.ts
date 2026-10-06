import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The OpenAPI document advertised an `X-API-Key` header. Authentication
// never read it: an API key is sent as `Authorization: Bearer <key>`, like a
// session token (middleware/auth.ts). A client generated from the document
// sent a header the API ignored and got a 401.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the OpenAPI document declares only the credential the API reads", () => {
  const index = read("../index.ts");
  const schemes = index.slice(index.indexOf("securitySchemes: {"), index.indexOf("await app.register(swaggerUi"));
  assert.match(schemes, /bearerAuth: \{\s*type: "http",\s*scheme: "bearer"/);
  assert.doesNotMatch(schemes, /type: "apiKey"/);
  assert.doesNotMatch(index, /name: "X-API-Key"/);
  // A JWT-only label would say an API key is not accepted.
  assert.doesNotMatch(schemes, /bearerFormat: "JWT"/);
  assert.match(schemes, /API key \(wheels_/);
});

test("authentication reads the Authorization header and no X-API-Key header", () => {
  const auth = read("../middleware/auth.ts");
  assert.match(auth, /request\.headers\.authorization/);
  assert.doesNotMatch(auth, /x-api-key/i);
});

test("no route declares a security scheme the document does not define", () => {
  for (const file of ["openaiV1.ts", "agentCompletions.ts", "workflowCompletions.ts", "inference.ts"]) {
    const source = read(`../routes/${file}`);
    for (const [, scheme] of source.matchAll(/security: \[\{ (\w+): \[\] \}\]/g)) {
      assert.equal(scheme, "bearerAuth", file);
    }
  }
});
