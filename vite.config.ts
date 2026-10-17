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
      "typescript/no-unnecessary-condition": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      // Turned on by #227 (C13, remove module mocks).
      "anti-slop/no-module-mocking": "off",
      // Not part of the style guide.
      "anti-slop-effect/prefer-effect-match": "off",
    },
    overrides: [
      {
        // The Worker entry and MCP protocol module decode raw external input,
        // the error logger accepts any thrown value, and tests build
        // deliberately invalid request bodies.
        files: ["src/index.ts", "src/mcp/protocol.ts", "src/lib/errors.ts", "test/**"],
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
