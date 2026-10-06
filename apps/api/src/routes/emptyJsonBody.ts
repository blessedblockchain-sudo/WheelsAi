/**
 * Lets the API accept `Content-Type: application/json` with no body.
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
 * prototype-poisoning checks and the body limit are unchanged.
 *
 * Registered ONCE, on the root instance before the route plugins
 * (index.ts), so every route inherits it. Fastify refuses a second custom
 * parser for a content type that already has one, so a plugin that needs
 * the raw bytes (signature-verified webhooks) calls replaceJsonBodyParser
 * to swap it out in its own scope.
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

/**
 * For a plugin with its own JSON parser. Removing first is what lets the
 * plugin register under a root that already carries acceptEmptyJsonBody;
 * the removal, like the parser added after it, stays inside the plugin.
 */
export function replaceJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
}
