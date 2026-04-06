/**
 * test-live-webhook.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end test for the live Render + Twilio dental leads webhook.
 *
 * What it tests:
 *   1. First message from a new patient           → ClickUp status: NEW
 *   2. Return message from the same patient       → status: CONTACTED
 *   3. Patient supplies name + problem + time     → status: BOOKED
 *   4. Patient sends a completion message         → status: COMPLETED
 *   5. Entirely new phone number                  → fresh lead, status: NEW
 *
 * How it works:
 *   • Sends Twilio-format URL-encoded POST to /webhook/whatsapp
 *   • Optionally signs the request with a real Twilio HMAC (needs TWILIO_AUTH_TOKEN)
 *   • Webhook returns 200 + empty TwiML immediately (async Trigger.dev dispatch)
 *   • Script polls ClickUp until the lead status matches (or times out)
 *   • Prints green ✓ / red ✗ per assertion
 *
 * Required env vars:
 *   WEBHOOK_BASE_URL   – e.g. https://my-app.onrender.com
 *   CLICKUP_API_KEY    – for verifying results
 *   CLICKUP_LIST_ID    – for verifying results
 *
 * Optional env vars:
 *   TWILIO_AUTH_TOKEN  – when set, signs requests so Render doesn't reject them
 *   TWILIO_TO          – clinic's Twilio WhatsApp number (default: whatsapp:+14155238886)
 *   POLL_INTERVAL_MS   – ms between ClickUp polls (default: 4000)
 *   POLL_MAX_ATTEMPTS  – max ClickUp polls per step (default: 20 ≈ 80 s)
 *   TEST_PHONE_1       – override first test patient phone (default: whatsapp:+19991110001)
 *   TEST_PHONE_2       – override second test patient phone (default: whatsapp:+19991110002)
 *
 * Run:
 *   WEBHOOK_BASE_URL=https://my-app.onrender.com \
 *   CLICKUP_API_KEY=pk_xxx \
 *   CLICKUP_LIST_ID=901xxxxxxx \
 *   npx tsx src/test-live-webhook.ts
 */

import axios, { type AxiosResponse } from "axios";
import crypto from "crypto";

// ─── ANSI colours ──────────────────────────────────────────────────────────────

const GREEN  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const CYAN   = (s: string) => `\x1b[36m${s}\x1b[0m`;
const BOLD   = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** URL-encoded fields Twilio sends to the webhook. */
interface TwilioWebhookPayload {
  From:       string;   // "whatsapp:+923001234567"
  To:         string;   // clinic's Twilio number
  Body:       string;   // patient's message text
  MessageSid: string;   // unique Twilio message ID
}

/** A single step in a test scenario. */
interface TestStep {
  description:    string;
  payload:        TwilioWebhookPayload;
  expectedStatus: string;
  delayBeforeMs?: number; // optional pause before sending (default 0)
}

/** Result of one test step. */
interface StepResult {
  description:    string;
  webhookHttpCode: number;
  twimlResponse:  string;
  leadStatus:     string | null;
  expectedStatus: string;
  passed:         boolean;
  pollAttempts:   number;
  error?:         string;
}

/** Minimal ClickUp task shape for lead lookup. */
interface ClickUpCustomField {
  id:    string;
  value?: string | number | null;
}
interface ClickUpTaskStatus {
  status: string;
}
interface ClickUpTask {
  id:            string;
  name:          string;
  status:        ClickUpTaskStatus;
  custom_fields: ClickUpCustomField[];
}
interface ClickUpTasksResponse {
  tasks: ClickUpTask[];
}

// ─── Config ────────────────────────────────────────────────────────────────────

const BASE_URL         = (process.env.WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
const WEBHOOK_PATH     = "/webhook/whatsapp";
const WEBHOOK_URL      = `${BASE_URL}${WEBHOOK_PATH}`;
const CLICKUP_API_KEY  = process.env.CLICKUP_API_KEY ?? "";
const CLICKUP_LIST_ID  = process.env.CLICKUP_LIST_ID ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const TWILIO_TO        = process.env.TWILIO_TO ?? "whatsapp:+14155238886";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4_000);
const POLL_MAX         = Number(process.env.POLL_MAX_ATTEMPTS ?? 20);

// ClickUp custom field IDs (copied from src/clickup.ts)
const PHONE_FIELD_ID = "2ecfbffa-e940-48aa-92c3-540db05cbe41";

// ─── Validate config ───────────────────────────────────────────────────────────

function assertConfig(): void {
  const missing: string[] = [];
  if (!BASE_URL)        missing.push("WEBHOOK_BASE_URL");
  if (!CLICKUP_API_KEY) missing.push("CLICKUP_API_KEY");
  if (!CLICKUP_LIST_ID) missing.push("CLICKUP_LIST_ID");

  if (missing.length > 0) {
    console.error(RED(`\n✗ Missing required environment variables: ${missing.join(", ")}`));
    console.error(DIM("  Set them before running:"));
    missing.forEach((v) =>
      console.error(DIM(`    export ${v}=<value>`))
    );
    process.exit(1);
  }

  if (!TWILIO_AUTH_TOKEN) {
    console.warn(
      YELLOW(
        "⚠  TWILIO_AUTH_TOKEN not set — requests will have no X-Twilio-Signature.\n" +
        "   If TWILIO_WEBHOOK_URL is configured on Render, requests will be rejected (403).\n" +
        "   Set TWILIO_AUTH_TOKEN to generate real signatures, or disable validation on Render."
      )
    );
  }
}

// ─── Twilio HMAC signature ─────────────────────────────────────────────────────

/**
 * Generates the X-Twilio-Signature header value.
 * Algorithm: HMAC-SHA1( authToken, url + sortedParamPairs )
 * Ref: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function generateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const sortedStr = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  return crypto
    .createHmac("sha1", authToken)
    .update(sortedStr)
    .digest("base64");
}

// ─── Webhook sender ────────────────────────────────────────────────────────────

/**
 * POSTs a Twilio-format message to the live webhook.
 * Returns { status, data } from the HTTP response.
 */
async function sendWebhookMessage(
  payload: TwilioWebhookPayload
): Promise<{ httpStatus: number; body: string }> {
  // Twilio sends application/x-www-form-urlencoded
  const params: Record<string, string> = {
    From:       payload.From,
    To:         payload.To,
    Body:       payload.Body,
    MessageSid: payload.MessageSid,
  };

  const urlEncoded = new URLSearchParams(params).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":   "TwilioProxy/1.1",
  };

  if (TWILIO_AUTH_TOKEN) {
    headers["X-Twilio-Signature"] = generateTwilioSignature(
      TWILIO_AUTH_TOKEN,
      WEBHOOK_URL,
      params
    );
  }

  let response: AxiosResponse<string>;
  try {
    response = await axios.post<string>(WEBHOOK_URL, urlEncoded, {
      headers,
      validateStatus: () => true, // never throw on 4xx/5xx so we can inspect
      timeout: 15_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error posting to webhook: ${msg}`);
  }

  return {
    httpStatus: response.status,
    body: typeof response.data === "string"
      ? response.data
      : JSON.stringify(response.data),
  };
}

// ─── ClickUp poller ────────────────────────────────────────────────────────────

const clickupClient = axios.create({
  baseURL: "https://api.clickup.com/api/v2",
  headers: {
    Authorization:  CLICKUP_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 10_000,
});

/** Searches the ClickUp list for a task whose Phone field matches `phone`. */
async function findLeadStatus(phone: string): Promise<string | null> {
  const normalised = phone.trim();
  let page = 0;

  while (page < 3) { // limit to first 3 pages (300 tasks) to avoid long waits
    const res = await clickupClient.get<ClickUpTasksResponse>(
      `/list/${CLICKUP_LIST_ID}/task`,
      {
        params: {
          custom_fields: true,
          include_closed: true,
          page,
          order_by: "created",
          reverse: true,
        },
      }
    );

    const tasks = res.data?.tasks ?? [];

    const match = tasks.find((task) => {
      const field = task.custom_fields.find((f) => f.id === PHONE_FIELD_ID);
      const value = field?.value;
      return typeof value === "string" && value.trim() === normalised;
    });

    if (match) {
      return match.status?.status ?? null;
    }

    if (tasks.length < 100) break; // last page
    page++;
  }

  return null; // not found yet
}

/**
 * Polls ClickUp until the lead's status equals `expectedStatus`
 * or max attempts are exhausted.
 */
async function pollUntilStatus(
  phone: string,
  expectedStatus: string,
  maxAttempts = POLL_MAX,
  intervalMs = POLL_INTERVAL_MS
): Promise<{ status: string | null; attempts: number }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    process.stdout.write(
      `\r  ${DIM(`Polling ClickUp… attempt ${attempt}/${maxAttempts}`)}`
    );

    let status: string | null = null;
    try {
      status = await findLeadStatus(phone);
    } catch {
      // transient ClickUp error — keep polling
    }

    if (status === expectedStatus) {
      process.stdout.write("\r" + " ".repeat(60) + "\r"); // clear line
      return { status, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  process.stdout.write("\r" + " ".repeat(60) + "\r");
  const finalStatus = await findLeadStatus(phone).catch(() => null);
  return { status: finalStatus, attempts: maxAttempts };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generates a unique Twilio MessageSid for each test message. */
function fakeSid(): string {
  return "SM" + crypto.randomBytes(16).toString("hex").toUpperCase();
}

function printHeader(text: string): void {
  const line = "─".repeat(72);
  console.log(`\n${CYAN(line)}`);
  console.log(BOLD(CYAN(`  ${text}`)));
  console.log(CYAN(line));
}

function printStep(step: StepResult, index: number): void {
  const icon   = step.passed ? GREEN("✓") : RED("✗");
  const status = step.passed
    ? GREEN(step.leadStatus ?? "—")
    : RED(step.leadStatus ?? "(not found)");

  console.log(`\n${icon} ${BOLD(`[Step ${index + 1}]`)} ${step.description}`);
  console.log(
    `   Webhook HTTP : ${step.webhookHttpCode === 200
      ? GREEN(String(step.webhookHttpCode))
      : RED(String(step.webhookHttpCode))
    }`
  );
  console.log(`   TwiML body   : ${DIM(step.twimlResponse.trim().slice(0, 80))}`);
  console.log(`   Lead status  : ${status}  ${DIM(`(expected: ${step.expectedStatus})`)}`);
  console.log(`   Poll attempts: ${DIM(String(step.pollAttempts))}`);

  if (step.error) {
    console.log(`   ${RED("Error")}        : ${step.error}`);
  }
}

function printSummary(results: StepResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  printHeader("Test Summary");
  results.forEach((r, i) => {
    const icon = r.passed ? GREEN("✓") : RED("✗");
    console.log(`  ${icon} Step ${i + 1}: ${r.description}`);
  });

  console.log(
    `\n  ${BOLD("Result:")} ${GREEN(`${passed} passed`)}  ${failed > 0 ? RED(`${failed} failed`) : DIM("0 failed")}`
  );

  if (failed === 0) {
    console.log(GREEN("\n  All tests passed! 🎉\n"));
  } else {
    console.log(RED(`\n  ${failed} test(s) failed. Check status progression above.\n`));
    process.exitCode = 1;
  }
}

// ─── Test runner ───────────────────────────────────────────────────────────────

async function runStep(step: TestStep, index: number): Promise<StepResult> {
  if (step.delayBeforeMs && step.delayBeforeMs > 0) {
    console.log(DIM(`\n  Waiting ${step.delayBeforeMs}ms before step ${index + 1}…`));
    await sleep(step.delayBeforeMs);
  }

  console.log(`\n${BOLD(`[Step ${index + 1}/${0}]`)} ${step.description}`);
  console.log(DIM(`  From: ${step.payload.From}`));
  console.log(DIM(`  Body: "${step.payload.Body}"`));
  console.log(DIM(`  SID : ${step.payload.MessageSid}`));
  console.log(DIM(`  Expected status: ${step.expectedStatus}`));

  let webhookHttpCode = 0;
  let twimlResponse   = "";
  let pollAttempts    = 0;
  let leadStatus: string | null = null;
  let error: string | undefined;

  // 1. Send the webhook request
  try {
    const res = await sendWebhookMessage(step.payload);
    webhookHttpCode = res.httpStatus;
    twimlResponse   = res.body;

    if (webhookHttpCode !== 200) {
      error = `Webhook returned HTTP ${webhookHttpCode}: ${twimlResponse.slice(0, 200)}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    webhookHttpCode = 0;
  }

  // 2. If webhook was accepted, poll ClickUp for the expected status
  if (webhookHttpCode === 200) {
    const poll = await pollUntilStatus(
      step.payload.From,
      step.expectedStatus
    );
    leadStatus   = poll.status;
    pollAttempts = poll.attempts;
  }

  const passed =
    webhookHttpCode === 200 &&
    leadStatus === step.expectedStatus &&
    !error;

  return {
    description:     step.description,
    webhookHttpCode,
    twimlResponse,
    leadStatus,
    expectedStatus:  step.expectedStatus,
    passed,
    pollAttempts,
    error,
  };
}

// ─── Test scenarios ────────────────────────────────────────────────────────────

function buildScenarios(): TestStep[] {
  const phone1 = process.env.TEST_PHONE_1 ?? "whatsapp:+19991110001";
  const phone2 = process.env.TEST_PHONE_2 ?? "whatsapp:+19991110002";

  return [
    // ── Patient 1: full status progression ──────────────────────────────────
    {
      description:    "First message from a new patient → NEW",
      expectedStatus: "new",
      payload: {
        From:       phone1,
        To:         TWILIO_TO,
        Body:       "Hello, I need to see a dentist.",
        MessageSid: fakeSid(),
      },
    },
    {
      description:    "Return message from same patient → CONTACTED",
      expectedStatus: "contacted",
      delayBeforeMs:  2_000,
      payload: {
        From:       phone1,
        To:         TWILIO_TO,
        Body:       "My name is Sarah Ali and I've been having some tooth pain.",
        MessageSid: fakeSid(),
      },
    },
    {
      description:    "Patient provides name + problem + time → BOOKED",
      expectedStatus: "booked",
      delayBeforeMs:  2_000,
      payload: {
        From:       phone1,
        To:         TWILIO_TO,
        Body:       "I have a toothache in my lower left molar. I can come in Monday morning around 10 AM.",
        MessageSid: fakeSid(),
      },
    },
    {
      description:    "Patient sends completion message → COMPLETED",
      expectedStatus: "completed",
      delayBeforeMs:  2_000,
      payload: {
        From:       phone1,
        To:         TWILIO_TO,
        Body:       "Thank you so much! My appointment is all sorted.",
        MessageSid: fakeSid(),
      },
    },

    // ── Patient 2: new phone number, fresh lead ──────────────────────────────
    {
      description:    "New phone number → fresh lead → NEW",
      expectedStatus: "new",
      payload: {
        From:       phone2,
        To:         TWILIO_TO,
        Body:       "Hi, I need to book a dental appointment.",
        MessageSid: fakeSid(),
      },
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  assertConfig();

  const scenarios = buildScenarios();

  printHeader("Dental Leads Webhook — Live E2E Test");
  console.log(`  Webhook URL   : ${CYAN(WEBHOOK_URL)}`);
  console.log(`  ClickUp list  : ${CYAN(CLICKUP_LIST_ID)}`);
  console.log(`  Signature     : ${TWILIO_AUTH_TOKEN ? GREEN("enabled (HMAC-SHA1)") : YELLOW("disabled")}`);
  console.log(`  Poll interval : ${POLL_INTERVAL_MS}ms  max attempts: ${POLL_MAX}`);
  console.log(`  Test patients : ${DIM(process.env.TEST_PHONE_1 ?? "whatsapp:+19991110001")}  /  ${DIM(process.env.TEST_PHONE_2 ?? "whatsapp:+19991110002")}`);

  const results: StepResult[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const result = await runStep(scenarios[i]!, i);
    results.push(result);
    printStep(result, i);
  }

  printSummary(results);
}

main().catch((err) => {
  console.error(RED(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
