/**
 * test-webhook.ts
 *
 * Simulates WhatsApp messages against the local Express webhook.
 *
 * Usage:
 *   npx tsx src/test-webhook.ts
 *
 * By default targets the JSON endpoint:
 *   POST http://localhost:3000/webhook  (src/webhook-handler.ts)
 *
 * Set WEBHOOK_MODE=twilio to target the Twilio-format endpoint instead:
 *   POST http://localhost:3000/webhook/whatsapp  (src/server.ts)
 *
 * Environment:
 *   WEBHOOK_BASE_URL  — override base URL (default: http://localhost:3000)
 *   WEBHOOK_MODE      — "json" (default) | "twilio"
 */

import axios, { type AxiosResponse } from "axios";
import type { WhatsAppWebhookBody } from "./webhook-handler.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL    = process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
const MODE        = (process.env.WEBHOOK_MODE ?? "json") as "json" | "twilio";

/** POST /webhook — expects JSON { phone, name, message } */
const JSON_ENDPOINT   = `${BASE_URL}/webhook`;
/** POST /webhook/whatsapp — expects URL-encoded Twilio fields */
const TWILIO_ENDPOINT = `${BASE_URL}/webhook/whatsapp`;

// ── Response types ────────────────────────────────────────────────────────────

/** Shape returned by the JSON webhook (/webhook) */
interface JsonWebhookResponse {
  taskId: string;
  reply:  string;
  status: string;
}

/** Shape returned by the Twilio webhook (/webhook/whatsapp) — empty TwiML */
interface TwilioWebhookResponse {
  raw: string; // "<Response></Response>"
}

type WebhookResponse = JsonWebhookResponse | TwilioWebhookResponse;

// ── Test case definitions ─────────────────────────────────────────────────────

interface TestCase {
  /** Human-readable label shown in console output */
  label: string;
  /** Payload sent to the webhook */
  payload: WhatsAppWebhookBody;
  /** Expected status in the response (informational — not a hard assertion) */
  expectedStatus?: string;
}

/**
 * All test cases run in sequence against the same phone number so the lead
 * progresses through the full lifecycle: NEW → CONTACTED → BOOKED → COMPLETED.
 */
const TEST_CASES: TestCase[] = [
  // ── 1. First contact from a new patient ──────────────────────────────────────
  {
    label:          "1. New patient — first message (expect status: new)",
    expectedStatus: "new",
    payload: {
      phone:   "+923001234567",
      name:    "Sara Ali",
      message: "Hello, I have a bad toothache. Can I get help?",
    },
  },

  // ── 2. Return message — same patient ─────────────────────────────────────────
  {
    label:          "2. Returning patient — follow-up (expect status: contacted)",
    expectedStatus: "contacted",
    payload: {
      phone:   "+923001234567",
      name:    "Sara Ali",
      message: "My name is Sara and my tooth has been hurting for 3 days.",
    },
  },

  // ── 3. Patient provides preferred time — AI should confirm booking ────────────
  {
    label:          "3. Booking trigger — all info provided (expect status: booked)",
    expectedStatus: "booked",
    payload: {
      phone:   "+923001234567",
      name:    "Sara Ali",
      message:
        "I prefer to come tomorrow afternoon, around 3 PM. My problem is a cavity on the right molar.",
    },
  },

  // ── 4. Patient sends a completion keyword ─────────────────────────────────────
  {
    label:          "4. Completion keyword — patient says thanks (expect status: completed)",
    expectedStatus: "completed",
    payload: {
      phone:   "+923001234567",
      name:    "Sara Ali",
      message: "Thank you so much, I'll be there!",
    },
  },

  // ── 5. Brand-new, different patient ──────────────────────────────────────────
  {
    label:          "5. Different new patient — second lead (expect status: new)",
    expectedStatus: "new",
    payload: {
      phone:   "+923009876543",
      name:    "",
      message: "Hi, I need to book a dentist appointment urgently.",
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ANSI colour helpers for readable console output */
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  dim:    "\x1b[2m",
};

function hr(char = "─", width = 60): string {
  return char.repeat(width);
}

function printLabel(label: string): void {
  console.log(`\n${c.bold}${c.cyan}${hr()}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${label}${c.reset}`);
  console.log(`${c.bold}${c.cyan}${hr()}${c.reset}`);
}

function printRequest(payload: WhatsAppWebhookBody): void {
  console.log(`${c.dim}REQUEST PAYLOAD:${c.reset}`);
  console.log(JSON.stringify(payload, null, 2));
}

function printJsonResponse(res: AxiosResponse<JsonWebhookResponse>, expected?: string): void {
  const { taskId, reply, status } = res.data;

  console.log(`\n${c.dim}HTTP ${res.status}  |  STATUS: ${statusColour(status, expected)}${c.reset}`);
  console.log(`  ${c.bold}taskId${c.reset} : ${taskId}`);
  console.log(`  ${c.bold}status${c.reset} : ${statusColour(status, expected)}`);
  console.log(`  ${c.bold}reply${c.reset}  : ${c.green}${reply}${c.reset}`);

  if (expected && status !== expected) {
    console.log(
      `\n  ${c.yellow}⚠  Expected status "${expected}", got "${status}"${c.reset}`
    );
  }
}

function printTwilioResponse(res: AxiosResponse<string>): void {
  console.log(`\n${c.dim}HTTP ${res.status}  |  Twilio mode — TwiML response:${c.reset}`);
  console.log(`  ${c.green}${res.data.trim()}${c.reset}`);
  console.log(
    `${c.dim}  (Trigger.dev task was fired; check the Trigger.dev dashboard for run details.)${c.reset}`
  );
}

function printError(err: unknown): void {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? "no response";
    const data   = err.response?.data   ?? err.message;
    console.log(`\n  ${c.red}✗ HTTP ${status}${c.reset}`);
    console.log(`  ${c.red}${JSON.stringify(data, null, 2)}${c.reset}`);
  } else {
    console.log(`\n  ${c.red}✗ ${String(err)}${c.reset}`);
  }
}

function statusColour(status: string, expected?: string): string {
  if (!expected) return `${c.yellow}${status}${c.reset}`;
  return status === expected
    ? `${c.green}${status}${c.reset}`
    : `${c.red}${status}${c.reset}`;
}

/** Build URLSearchParams matching what Twilio actually sends */
function toTwilioParams(payload: WhatsAppWebhookBody, sid: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set("From",       `whatsapp:${payload.phone}`);
  p.set("To",         "whatsapp:+14155238886");   // Twilio sandbox default number
  p.set("Body",       payload.message);
  p.set("MessageSid", sid);
  if (payload.name) p.set("ProfileName", payload.name);
  return p;
}

// ── Core send function ────────────────────────────────────────────────────────

let messageSidCounter = 1;

async function sendMessage(
  testCase: TestCase,
  mode: "json" | "twilio"
): Promise<void> {
  const { label, payload, expectedStatus } = testCase;

  printLabel(label);
  printRequest(payload);
  console.log();

  try {
    if (mode === "twilio") {
      // Twilio mode: URL-encoded form POST → /webhook/whatsapp
      const sid    = `SM${String(messageSidCounter++).padStart(32, "0")}`;
      const params = toTwilioParams(payload, sid);

      const res = await axios.post<string>(TWILIO_ENDPOINT, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: () => true, // capture non-2xx too
      });

      printTwilioResponse(res);
    } else {
      // JSON mode: POST → /webhook
      const res = await axios.post<JsonWebhookResponse>(JSON_ENDPOINT, payload, {
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
      });

      printJsonResponse(res as AxiosResponse<JsonWebhookResponse>, expectedStatus);
    }
  } catch (err) {
    printError(err);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${c.bold}Dental Lead Webhook — Local Integration Test${c.reset}`);
  console.log(`Mode     : ${c.cyan}${MODE}${c.reset}`);
  console.log(
    `Endpoint : ${c.cyan}${MODE === "twilio" ? TWILIO_ENDPOINT : JSON_ENDPOINT}${c.reset}`
  );
  console.log(`Cases    : ${TEST_CASES.length}`);

  // Verify the server is reachable before running tests
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 3000 });
    console.log(`${c.green}✓ Server is reachable at ${BASE_URL}${c.reset}`);
  } catch {
    console.log(
      `\n${c.red}✗ Cannot reach server at ${BASE_URL}/health${c.reset}`
    );
    console.log(
      `  Start the server first:  ${c.dim}npm run dev:server${c.reset}\n`
    );
    process.exit(1);
  }

  // Run each test case sequentially so the lead state builds up correctly
  for (const testCase of TEST_CASES) {
    await sendMessage(testCase, MODE);
    // Brief pause so log timestamps are distinct and rate limiter is not hit
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
  }

  console.log(`\n${c.bold}${c.green}${hr("═")}${c.reset}`);
  console.log(`${c.bold}${c.green}  All test cases sent.${c.reset}`);
  console.log(`${c.bold}${c.green}${hr("═")}${c.reset}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
