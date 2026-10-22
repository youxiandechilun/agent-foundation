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
      "extensions/browser-bridge/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
    // Wire payloads in src should be typed or `unknown`; remaining uses are tracked debt.
    files: ["src/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  {
    // Tests poke at loosely shaped fixtures and responses.
    files: ["test/**/*.ts", "examples/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
