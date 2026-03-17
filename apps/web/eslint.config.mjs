import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals"),
  {
    rules: {
      // TypeScript handles undefined variable checks far better than ESLint's
      // no-undef rule, which doesn't understand TS type positions or DOM globals.
      "no-undef": "off",
    },
  },
];

export default config;
