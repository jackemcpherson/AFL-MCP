import { defineConfig } from "vite-plus";

/** Paths that neither Oxlint nor Oxfmt may touch. */
const ignorePatterns = [
  ".claude/**",
  ".wrangler/**",
  "dist/**",
  // Frozen golden MCP contract files. Only the tickets that own them may change them.
  "test/fixtures/golden/**",
  // Vendored upstream plugin, kept byte-identical to its source commit.
  "tools/oxlint/anti-slop/**",
];

export default defineConfig({
  lint: {
    ignorePatterns,
    plugins: ["typescript", "import"],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
    },
    jsPlugins: ["./tools/oxlint/anti-slop/index.ts", "./tools/oxlint/anti-slop/effect/index.ts"],
    rules: {
      "import/no-default-export": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      // Turned on by #221 (C7, effect/Schema).
      "typescript/no-unnecessary-condition": "off",
      "anti-slop/no-chained-type-assertions": "off",
      "anti-slop/no-known-value-widening": "off",
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      // Turned on by #227 (C13, remove module mocks).
      "anti-slop/no-module-mocking": "off",
      // Not part of the style guide.
      "anti-slop-effect/prefer-effect-match": "off",
    },
    overrides: [
      {
        // Worker entry and MCP boundary files receive raw external input.
        files: ["src/index.ts", "src/mcp/**", "test/**"],
        rules: {
          "anti-slop/no-unknown-parameters": "off",
        },
      },
      {
        // Tool configs and the Worker entry must default-export.
        files: ["*.config.ts", "*.config.mts", "src/index.ts"],
        rules: {
          "import/no-default-export": "off",
        },
      },
    ],
  },
  fmt: {
    // rumdl owns Markdown. YAML and TOML keep their hand-written layout.
    ignorePatterns: [...ignorePatterns, "**/*.md", "**/*.yml", "**/*.yaml", "**/*.toml"],
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
  },
});
