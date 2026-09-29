import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: {
        crypto: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        Response: "readonly",
      },
    },
    rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^_" }] },
  },
];
