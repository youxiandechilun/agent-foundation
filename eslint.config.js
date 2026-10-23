import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Type-aware rules stay off: tsc already checks types, and lint should stay fast.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "releases/**",
      "verification/**",
      ".agent-data*/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["extensions/browser-bridge/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "chrome",
          "document",
          "FormData",
          "URL",
          "WebSocket",
          "AbortController",
          "setTimeout",
          "clearTimeout",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["src/**/*.mjs", "src/**/*.cjs"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "process",
          "Buffer",
          "console",
          "URL",
          "URLSearchParams",
          "TextDecoder",
          "TextEncoder",
          "AbortController",
          "AbortSignal",
          "fetch",
          "Headers",
          "Request",
          "Response",
          "performance",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "setImmediate",
          "clearImmediate",
          "queueMicrotask",
          "structuredClone",
          "global",
          "require",
          "module",
          "exports",
          "__dirname",
          "__filename",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts"],
    rules: {
      // Validators deliberately reject control characters in paths, names and hosts.
      "no-control-regex": "off",
      // `catch {}` marks a deliberately ignored, expected failure.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTernary: true, allowShortCircuit: true },
      ],
      // Unused bindings are compile errors (noUnusedLocals/Parameters); `_name` marks intent.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // External payloads must be decoded from unknown at their boundary.
    files: ["src/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    // Tests poke at loosely shaped fixtures and responses.
    files: ["test/**/*.ts", "examples/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
