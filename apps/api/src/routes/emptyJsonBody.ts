/**
 * Lets a route plugin accept `Content-Type: application/json` with no
 * body.
 *
 * Fastify refuses that pair (FST_ERR_CTP_EMPTY_JSON_BODY, a 400) while it
 * parses the body, before authentication and before the handler. Actions
 * that take no input ("run now", "cancel") are exactly the requests a
 * client sends that way: a fetch wrapper that always sets the header,
 * `curl -X POST -H 'Content-Type: application/json'`. They are not
 * malformed, so they must reach the handler. An empty body is read as no
 * body; a route that requires one still refuses it through its own
 * schema.
 *
 * Anything else goes through Fastify's own JSON parser, so the
 * prototype-poisoning checks and the body limit are unchanged. Register
 * inside the plugin: the parser is scoped to that plugin's routes.
 */

import type { FastifyInstance } from "fastify";

export function acceptEmptyJsonBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (body === "") {
      done(null, undefined);
      return;
    }
    parseJson(request, body as string, done);
  });
}
