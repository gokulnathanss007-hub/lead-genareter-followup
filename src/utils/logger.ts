// ── Structured server logger (pino) ──────────────────────────────────────────
// Use this in src/server.ts and src/clickup.ts.
// For Trigger.dev task files use `logger` from "@trigger.dev/sdk" instead —
// that routes logs to the Trigger.dev dashboard run viewer.

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Human-readable output in dev; plain JSON in production (easier to ingest).
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});
