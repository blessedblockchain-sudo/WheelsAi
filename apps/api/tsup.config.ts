import { defineConfig } from "tsup";

/**
 * Production bundle for the API.
 *
 * Why a bundler and not plain `tsc`: the workspace packages (@wheelsai/db,
 * @wheelsai/shared, @wheelsai/types) publish `./src/index.ts` as their
 * entry point. That is fine under tsx in dev, but plain Node refuses to
 * load it (ERR_UNKNOWN_FILE_EXTENSION ".ts"), so a tsc-emitted dist/index.js
 * crashed at module resolution before reading a single env var.
 *
 * The bundle therefore INLINES every @wheelsai/* import and leaves every
 * other bare specifier (fastify, @prisma/client, bullmq, argon2, ...) as a
 * runtime import resolved from node_modules. Prisma in particular must stay
 * external: @prisma/client loads the generated client and its native query
 * engine from node_modules/.prisma/client at runtime.
 *
 * Type checking is NOT done here (esbuild strips types); `npm run typecheck`
 * (tsc --noEmit) is the gate, and CI's build job depends on it.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  // One file: the lazy `import("./routes/agent-treasury.js")` in index.ts
  // is bundled in place (still evaluated lazily) instead of becoming a chunk.
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Keep `node:` specifiers as written; tsup strips them by default.
  removeNodeProtocol: false,
  // Every bare import is external EXCEPT the workspace packages, which ship
  // TypeScript source and must be compiled into the bundle. This also
  // covers imports made from inside the inlined packages (e.g. the
  // `@prisma/client` import in @wheelsai/db stays external).
  skipNodeModulesBundle: true,
  noExternal: [/^@wheelsai\//],
});
