import js from "@eslint/js";
import tseslint from "typescript-eslint";

const runtimeGlobals = {
  AbortController: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  Bun: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  URL: "readonly"
};

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: runtimeGlobals,
      sourceType: "module"
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": "off"
    }
  }
);
