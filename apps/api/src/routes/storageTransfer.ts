/**
 * GET | PUT /api/storage/t/<token>
 *
 * How bytes reach and leave the LOCAL object store (development only). The
 * s3 driver hands out presigned URLs and never touches these routes; with it,
 * or with no storage at all, both answer 404 storage_transfer_unavailable.
 *
 * No session: the token is the whole authorisation, exactly like a presigned
 * URL. It names one operation on one key, expires, and for a PUT carries the
 * largest body allowed (services/objectStore.ts: signTransferToken). An
 * upload is counted while it streams and cut off at the limit, so an
 * oversize body never lands under its key.
 *
 * The body parser is replaced inside this plugin only: whatever Content-Type
 * the uploader sends, the body is handed over as a stream and not buffered.
 */

import type { Readable } from "node:stream";
import type { FastifyPluginAsync } from "fastify";

import {
  LocalObjectStore,
  ObjectNotFoundError,
  ObjectTooLargeError,
  getObjectStore,
  verifyTransferToken,
  type ObjectStore,
  type TransferOp,
  type TransferTokenPayload,
} from "../services/objectStore.js";

export interface StorageTransferDeps {
  getStore: () => ObjectStore | null;
  /** Verifies transfer tokens; the same secret issueTransferUrl signs with. */
  getSecret: () => string;
  now: () => number;
}

export function buildStorageTransferDeps(): StorageTransferDeps {
  return {
    getStore: () => getObjectStore(),
    getSecret: () => {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("JWT_SECRET is required to verify storage transfer tokens");
      return secret;
    },
    now: Date.now,
  };
}

type Admission =
  | { ok: true; store: LocalObjectStore; payload: TransferTokenPayload }
  | { ok: false; status: number; body: { error: string; message: string } };

export function createStorageTransferRoutes(deps: StorageTransferDeps): FastifyPluginAsync {
  function admit(token: string, op: TransferOp): Admission {
    const store = deps.getStore();
    if (!(store instanceof LocalObjectStore)) {
      return {
        ok: false,
        status: 404,
        body: { error: "storage_transfer_unavailable", message: "Not found" },
      };
    }
    const verdict = verifyTransferToken(token, deps.getSecret(), { op, nowMs: deps.now() });
    if (!verdict.ok) {
      // One answer for forged, expired and wrong-operation tokens: a caller
      // probing with a bad token learns nothing about which part was wrong.
      return {
        ok: false,
        status: 401,
        body: {
          error: "invalid_transfer_token",
          message: "This transfer link is invalid or has expired.",
        },
      };
    }
    return { ok: true, store, payload: verdict.payload };
  }

  return async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    // A wildcard and not ":token": a token is longer than Fastify's limit on
    // a named parameter (maxParamLength, 100), which would answer 404.
    app.get("/t/*", async (request, reply) => {
      const token = (request.params as { "*": string })["*"];
      const admission = admit(token, "get");
      if (!admission.ok) return reply.status(admission.status).send(admission.body);

      const { store, payload } = admission;
      const head = await store.head(payload.key);
      if (!head) {
        return reply.status(404).send({ error: "object_not_found", message: "Object not found" });
      }
      try {
        const stream = await store.getStream(payload.key);
        return reply
          .header("Content-Type", "application/octet-stream")
          .header("Content-Length", head.size)
          .send(stream);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          return reply.status(404).send({ error: "object_not_found", message: "Object not found" });
        }
        throw err;
      }
    });

    app.put("/t/*", async (request, reply) => {
      const token = (request.params as { "*": string })["*"];
      const admission = admit(token, "put");
      if (!admission.ok) return reply.status(admission.status).send(admission.body);

      const { store, payload } = admission;
      const maxBytes = payload.max ?? 0;
      const tooLarge = () =>
        reply
          // The rest of an oversize body is not read; closing the connection
          // is what stops the client sending it.
          .header("Connection", "close")
          .status(413)
          .send({
            error: "object_too_large",
            message: `Upload is larger than the ${maxBytes} bytes this link allows.`,
            maxBytes,
          });

      // An honest client is refused before it sends a byte. A lying or absent
      // Content-Length is caught by the count below.
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

      const body = request.body as Readable | undefined;
      if (!body || typeof body.pipe !== "function") {
        return reply
          .status(400)
          .send({ error: "empty_upload", message: "The upload has no body." });
      }
      try {
        const { size } = await store.putStream(payload.key, body, maxBytes);
        return reply.status(200).send({ stored: true, size });
      } catch (err) {
        if (err instanceof ObjectTooLargeError) return tooLarge();
        throw err;
      }
    });
  };
}

export function createStorageTransferRoutesProduction(): FastifyPluginAsync {
  return createStorageTransferRoutes(buildStorageTransferDeps());
}
