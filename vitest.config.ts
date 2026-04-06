import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Use JSON pino output in tests — avoids pino-pretty mixing with vitest reporter
    env: { NODE_ENV: "test" },
  },
});
