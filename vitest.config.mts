import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/integration/**",
      "test/performance/**",
      "test/web/**",
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: [
        "packages/language-core/src/**/*.ts",
        "packages/language-server/src/protocol.ts",
        "packages/language-server/src/server.ts",
        "packages/vscode-client/src/external-validation-policy.ts",
        "packages/vscode-client/src/external-validator.ts",
      ],
      exclude: ["packages/language-core/src/generated/**"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage/report",
      thresholds: {
        perFile: true,
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});

export default config;
