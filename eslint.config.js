// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      "worker-configuration.d.ts",
      "coverage/**",
      "eslint.config.js",
      // Plain Node infrastructure scripts and the local-only proof harness are
      // outside the Worker's tsconfig project, so the type-aware rules that
      // apply to src/ cannot resolve them.
      "scripts/**",
      ".e2e-harness/**",
      // Standalone npm packages (@xfeatures/athenaeum-{types,sdk,cli}) with
      // their own tsconfig/build, published independently of the Worker --
      // not part of this project's type-aware lint project.
      "packages/**"
    ]
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Security/correctness-critical: an unawaited promise in a Worker can
      // drop errors silently and let a request return before work finishes.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // Conflicts with tsconfig's noPropertyAccessFromIndexSignature, which
      // we keep on purpose (it catches typos on dynamic property access).
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off"
    }
  }
);
