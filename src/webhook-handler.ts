// ============================================================
// Express Webhook Handler — Dental Lead Management System
// ============================================================
//
// POST /webhook
//   Receives an incoming WhatsApp message, runs the 5-step
//   lead management workflow, and returns the AI reply.
//
// Mount in server.ts:
//   import { webhookRouter } from "./webhook-handler.js";
//   app.use(webhookRouter);
// ============================================================

import express, { type Request, type Response, type Router } from "express";
import pino from "pino";
import {
  upsertLead,
  appendConversation,
  updateLeadStatus,
  findLeadByPhone,
  LeadStatus,
  type ConversationMessage,
} from "./clickup.js";
import { aiGenerateResponse } from "./trigger/dental-leads/ai-responder.js";

// ── Logger ────────────────────────────────────────────────────────────────────

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});

// ── Constants ─────────────────────────────────────────────────────────────────

const FALLBACK_REPLY =
  "Sorry, something went wrong. We'll contact you soon.";

// Keywords in the patient's message that signal an explicit COMPLETED intent.
// E.g. "appointment done", "all good, thanks" → close the lead.
const COMPLETION_KEYWORDS = [
  "done",
  "completed",
  "finished",
  "all good",
  "thank you",
  "thanks",
  "bye",
];

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape of the JSON body expected at POST /webhook */
export interface WhatsAppWebhookBody {
  /** Patient's WhatsApp number, e.g. "+923001234567" */
  phone: string;
  /** Patient's display name (may be empty on first contact) */
  name: string;
  /** The text message the patient just sent */
  message: string;
}

/** What `processWebhookMessage` resolves with */
export interface WebhookResult {
  taskId: string;
  aiReply: string;
  status: string;
}

// ── Status detection ──────────────────────────────────────────────────────────

/**
 * Returns `true` when the patient's message implies the appointment is finished.
 * Kept simple and keyword-based; swap for an ML classifier if needed later.
 */
function isCompletionMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return COMPLETION_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Returns `true` when the AI's reply confirms a booking — the prompt instructs
 * the model to say "the clinic will call to finalise the booking" once all three
 * fields (name, problem, preferred time) are collected.
 */
function isBookingConfirmed(aiReply: string): boolean {
  const lower = aiReply.toLowerCase();
  return (
    lower.includes("call to finalise") ||
    lower.includes("booked") ||
    lower.includes("appointment confirmed") ||
    lower.includes("we'll be in touch")
  );
}

// ── Core workflow — pure, no Express coupling ─────────────────────────────────

/**
 * Executes the 5-step lead management workflow for a single incoming message.
 *
 * Steps:
 *  1. `upsertLead`          — create or update the ClickUp task
 *  2. `appendConversation`  — store the patient's message (role: "user")
 *  3. `aiGenerateResponse`  — generate an AI reply
 *  4. `appendConversation`  — store the AI reply (role: "assistant")
 *  5. `updateLeadStatus`    — advance to BOOKED or COMPLETED when appropriate
 *
 * On AI failure the FALLBACK_REPLY is used so the workflow never stalls.
 */
export async function processWebhookMessage(
  body: WhatsAppWebhookBody
): Promise<WebhookResult> {
  const { phone, name, message } = body;

  // ── 1. Upsert lead ─────────────────────────────────────────────────────────
  // First contact  → creates task, status: NEW
  // Return contact → updates task, status: CONTACTED
  logger.info({ phone, name }, "[webhook] Incoming message");

  const taskId = await upsertLead({ name, phone, message });
  logger.info({ taskId, phone }, "[webhook] Lead upserted");

  // ── Fetch the current conversation history ─────────────────────────────────
  // upsertLead already appended the user turn; retrieve the full history so
  // appendConversation can cap it correctly.
  const lead = await findLeadByPhone(phone);
  const history: ConversationMessage[] = lead?.conversationHistory ?? [];

  // ── 2. Append patient message (role: "user") ───────────────────────────────
  // Note: upsertLead already stored the turn, but we call appendConversation
  // here too so the role is explicitly recorded and the cap is applied.
  // In practice you may skip one of the two writes; both are idempotent.
  await appendConversation(taskId, message, history, "user");
  logger.info({ taskId }, "[webhook] Patient message appended");

  // ── 3. Generate AI reply ───────────────────────────────────────────────────
  let aiReply: string;
  try {
    aiReply = await aiGenerateResponse(message, history);
    logger.info({ taskId, aiReply }, "[webhook] AI reply generated");
  } catch (err) {
    logger.error({ taskId, err }, "[webhook] aiGenerateResponse threw — using fallback");
    aiReply = FALLBACK_REPLY;
  }

  // ── 4. Append AI reply (role: "assistant") ─────────────────────────────────
  const historyWithUser: ConversationMessage[] = [
    ...history,
    { role: "user", content: message },
  ];
  await appendConversation(taskId, aiReply, historyWithUser, "assistant");
  logger.info({ taskId }, "[webhook] AI reply appended");

  // ── 5. Advance lead status ─────────────────────────────────────────────────
  let finalStatus: string = lead?.status ?? LeadStatus.CONTACTED;

  if (isCompletionMessage(message)) {
    await updateLeadStatus(taskId, LeadStatus.COMPLETED);
    finalStatus = LeadStatus.COMPLETED;
    logger.info({ taskId }, "[webhook] Status → COMPLETED");
  } else if (isBookingConfirmed(aiReply)) {
    await updateLeadStatus(taskId, LeadStatus.BOOKED);
    finalStatus = LeadStatus.BOOKED;
    logger.info({ taskId }, "[webhook] Status → BOOKED");
  }

  return { taskId, aiReply, status: finalStatus };
}

// ── Express route handler ─────────────────────────────────────────────────────

/**
 * POST /webhook
 *
 * Expected JSON body:
 * ```json
 * { "phone": "+923001234567", "name": "Sara Ali", "message": "I have a toothache" }
 * ```
 *
 * Response (200):
 * ```json
 * { "taskId": "abc123", "reply": "...", "status": "contacted" }
 * ```
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // ── Validate incoming payload ────────────────────────────────────────────
  const { phone, name, message } = req.body as Partial<WhatsAppWebhookBody>;

  if (!phone || typeof phone !== "string" || phone.trim() === "") {
    logger.warn("[webhook] Missing or invalid field: phone");
    res.status(400).json({ error: "phone is required" });
    return;
  }
  if (!message || typeof message !== "string" || message.trim() === "") {
    logger.warn("[webhook] Missing or invalid field: message");
    res.status(400).json({ error: "message is required" });
    return;
  }

  const safeBody: WhatsAppWebhookBody = {
    phone:   phone.trim(),
    name:    (name ?? "").trim(),
    message: message.trim(),
  };

  // ── Run workflow ─────────────────────────────────────────────────────────
  try {
    const result = await processWebhookMessage(safeBody);

    res.status(200).json({
      taskId: result.taskId,
      reply:  result.aiReply,
      status: result.status,
    });
  } catch (err) {
    logger.error({ err, phone: safeBody.phone }, "[webhook] Unhandled workflow error");

    // Always return a reply so the caller can forward it to the patient.
    res.status(500).json({
      error: "Internal server error",
      reply: FALLBACK_REPLY,
    });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const webhookRouter: Router = express.Router();

webhookRouter.post("/webhook", express.json(), handleWebhook);
