import "dotenv/config";   // must be first — loads .env before anything else reads process.env

import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger.js";
import { webhookHandler } from "./trigger/dental-leads/webhook-handler.js";

// ── App ───────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT ?? 3000;

// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Prevents message-spam from burning through AI / ClickUp API quota.
// 30 requests per IP per minute is generous for any real dental clinic patient.

const webhookLimiter = rateLimit({
  windowMs:        60 * 1000, // 1 minute
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (_req, res) => {
    logger.warn("Rate limit exceeded on /webhook/whatsapp");
    res.status(429).json({ error: "Too many requests — please wait a moment" });
  },
});

// ── Twilio signature validation ───────────────────────────────────────────────
// Verifies the request genuinely came from Twilio.
// Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// Set TWILIO_WEBHOOK_URL to the full public URL of this endpoint, e.g.:
//   https://abc123.ngrok.io/webhook/whatsapp
// Leave it unset to skip validation during local dev.

function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
  const twilioSig  = req.headers["x-twilio-signature"] as string | undefined;

  if (!webhookUrl) {
    logger.warn("TWILIO_WEBHOOK_URL not set — skipping signature validation (local dev only)");
    next();
    return;
  }

  if (!authToken) {
    res.status(500).json({ error: "TWILIO_AUTH_TOKEN is not set" });
    return;
  }

  if (!twilioSig) {
    res.status(403).json({ error: "Missing X-Twilio-Signature header" });
    return;
  }

  const params    = req.body as Record<string, string>;
  const sortedStr = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], webhookUrl);

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(sortedStr)
    .digest("base64");

  if (expected !== twilioSig) {
    logger.warn({ twilioSig }, "Invalid Twilio signature — request rejected");
    res.status(403).json({ error: "Invalid Twilio signature" });
    return;
  }

  next();
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── POST /webhook/whatsapp ────────────────────────────────────────────────────
// Twilio calls this URL every time a patient sends a WhatsApp message.
// We validate the payload, fire a Trigger.dev task, and respond with 200
// immediately — Twilio requires a response within 15 seconds.

const MAX_BODY_LENGTH = 2000; // characters — guards against giant messages blowing up the LLM prompt

app.post(
  "/webhook/whatsapp",
  webhookLimiter,
  validateTwilioSignature,
  async (req: Request, res: Response): Promise<void> => {
    const { From, To, Body, MessageSid } = req.body as Record<string, string | undefined>;

    // ── Basic payload validation ──────────────────────────────────────────
    if (!From || !Body || !MessageSid) {
      logger.error({ From, MessageSid }, "Missing required Twilio fields");
      res.status(400).json({ error: "Missing required fields: From, Body, MessageSid" });
      return;
    }

    // ── Silently drop Twilio sandbox join/leave confirmations ─────────────
    // When a user texts "join <word>" to the sandbox number, Twilio echoes
    // a confirmation message back through the webhook.  We don't want to
    // spin up an AI run for that.
    const trimmedBody = Body.trim();
    if (/^(join|leave)\s+\S+$/i.test(trimmedBody)) {
      logger.info({ From }, "Ignoring Twilio sandbox join/leave message");
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send("<Response></Response>");
      return;
    }

    // ── Truncate oversized messages ───────────────────────────────────────
    const safeBody = trimmedBody.slice(0, MAX_BODY_LENGTH);
    if (safeBody.length < trimmedBody.length) {
      logger.warn({ From, originalLength: trimmedBody.length }, "Message body truncated");
    }

    logger.info({ From, MessageSid }, "Incoming WhatsApp message");

    // ── Hand off to Trigger.dev — respond to Twilio immediately ──────────
    webhookHandler
      .trigger(
        { From, To: To ?? "", Body: safeBody, MessageSid },
        { idempotencyKey: MessageSid }
      )
      .then((run) => {
        logger.info({ runId: run.id, MessageSid }, "Trigger.dev run started");
      })
      .catch((err: unknown) => {
        logger.error({ err, MessageSid }, "Failed to trigger Trigger.dev run");
      });

    // Empty TwiML — tells Twilio we handled the message
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Server listening");
  logger.info(`Twilio webhook endpoint: POST http://localhost:${PORT}/webhook/whatsapp`);
});
