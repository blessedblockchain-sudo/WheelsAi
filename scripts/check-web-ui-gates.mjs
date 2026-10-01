#!/usr/bin/env node
/**
 * Web UI gates (redesign verification). Fails CI when either regression
 * comes back into apps/web/src:
 *
 *   1. Native browser dialogs: alert(), confirm("..."), prompt("..."),
 *      window.alert/confirm/prompt(). They ignore the theme and block the
 *      page; use ConfirmDialog / useConfirm() and toasts instead.
 *   2. Light-only colour classes on dashboard surfaces: a gray text or
 *      light background class with no dark: variant on the same line
 *      renders navy-on-navy (or white boxes) in the default dark theme.
 *      Use the semantic tokens (text-foreground, text-muted-foreground,
 *      bg-card, bg-muted, border) instead.
 *
 * Landing and marketing pages are dark-only navy by design and are not
 * checked by rule 2. Deliberate exceptions are listed in ALLOW with a
 * reason, so each one is a reviewed decision.
 *
 * Usage: node scripts/check-web-ui-gates.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "apps/web/src");

const NATIVE_DIALOG = [
  /(^|[^.\w$])alert\(/,
  /window\.(alert|confirm|prompt)\(/,
  /(^|[^.\w$])(confirm|prompt)\(\s*["'`]/,
];

// Class tokens without a variant prefix (so `after:bg-white`,
// `dark:text-gray-600` and `bg-white/10` do not count).
const LIGHT_ONLY =
  /(^|[\s"'`{])(text-gray-(?:600|700|800|900)|bg-white|bg-gray-(?:50|100)|border-gray-(?:100|200|300))(?=[\s"'`}])/;

// Dark-only navy surfaces by design.
const RULE2_SKIP = [/^components\/landing\//, /^components\/marketing\//, /^app\/\(marketing\)\//];

const ALLOW = [
  {
    file: "app/(dashboard)/dashboard/settings/security/page.tsx",
    token: "bg-white",
    reason: "the 2FA QR code needs a white quiet zone to scan in either theme",
  },
  {
    file: "components/ui/switch.tsx",
    token: "bg-white",
    reason: "the switch thumb sits on a coloured track in both themes",
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}

const problems = [];
for (const path of walk(SRC)) {
  const rel = relative(SRC, path).split("\\").join("/");
  if (rel === "components/ui/confirm-dialog.tsx") continue;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (NATIVE_DIALOG.some((re) => re.test(line))) {
      problems.push(`${rel}:${i + 1}: native browser dialog; use ConfirmDialog/useConfirm() or a toast`);
    }
    if (RULE2_SKIP.some((re) => re.test(rel))) return;
    const m = LIGHT_ONLY.exec(line);
    if (m && !line.includes("dark:")) {
      const token = m[2];
      if (ALLOW.some((a) => a.file === rel && a.token === token)) return;
      problems.push(`${rel}:${i + 1}: light-only class "${token}" with no dark: variant; use a semantic token`);
    }
  });
}

if (problems.length > 0) {
  console.error(`Web UI gates failed (${problems.length}):\n` + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log("Web UI gates passed: no native dialogs, no light-only colour classes.");
