#!/usr/bin/env node
// The `wheelsai` executable. It is committed (the compiled CLI in dist/ is not), so npm can
// link it at install time, before anything has been built.
try {
  await import("../dist/index.js");
} catch (error) {
  const missingBuild = error?.code === "ERR_MODULE_NOT_FOUND" && /[\\/]dist[\\/]/.test(String(error.message));
  if (!missingBuild) throw error;
  console.error("wheelsai is not built yet. From the repository root, run:");
  console.error("  npm run build -w @wheelsai/sdk && npm run build -w @wheelsai/cli");
  process.exitCode = 1;
}
