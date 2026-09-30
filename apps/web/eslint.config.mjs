import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

/**
 * Flat ESLint config for the web app.
 *
 * Composed from the plugins directly rather than `FlatCompat` over
 * `next/core-web-vitals`. Two reasons:
 *
 *   1. The legacy shareable config declares `parser: './parser.js'`, which
 *      resolves `next/dist/compiled/babel/eslint-parser` relative to
 *      eslint-config-next. npm hoists eslint-config-next to the workspace
 *      root while `next` stays in apps/web/node_modules, so that require
 *      fails and ESLint dies before linting a single file.
 *   2. `next lint` is deprecated and removed in Next.js 16; the lint script
 *      now calls the ESLint CLI, which only reads this file.
 *
 * TS/TSX is parsed by @typescript-eslint/parser (no type-aware rules here —
 * `tsc --noEmit` in the typecheck job covers that ground).
 */
const config = [
  {
    ignores: [".next/**", ".netlify/**", "node_modules/**", "out/**", "next-env.d.ts"],
  },
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
      // TypeScript handles undefined variable checks far better than ESLint's
      // no-undef rule, which doesn't understand TS type positions or DOM globals.
      "no-undef": "off",
    },
  },
  {
    // Playwright fixtures take a callback named `use` — the same identifier as
    // React's `use` hook, so rules-of-hooks flags every fixture as an illegal
    // hook call. None of this directory is React.
    files: ["e2e/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default config;
