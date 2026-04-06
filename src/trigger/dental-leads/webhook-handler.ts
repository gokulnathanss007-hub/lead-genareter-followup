import { task, logger } from "@trigger.dev/sdk";
import { aiResponder } from "./ai-responder.js";
import { scheduleFollowup } from "./followup.js";
import {
  findLeadByPhone,
  createLead,
  updateLead,
  LeadStatus,
  type ConversationMessage,
} from "./clickup.js";
import { sendWhatsAppMessage } from "../../utils/whatsapp.js";
import { capHistory } from "../../utils/history.js";

// Shape of the POST body Twilio sends to the webhook endpoint
export interface TwilioWebhookPayload {
  From: string;       // e.g. "whatsapp:+923001234567"
  To: string;         // clinic's Twilio number
  Body: string;       // patient's message text (already truncated by server.ts)
  MessageSid: string; // unique Twilio message ID
}

// Fallback reply sent to the patient when the AI task exhausts all retries.
const AI_FAILURE_REPLY =
  "We're experiencing a technical issue right now. Please try messaging again in a few minutes, or call us directly. We apologise for the inconvenience! 🙏";

export const webhookHandler = task({
  id: "whatsapp-webhook-handler",
  retry: { maxAttempts: 2 },

  run: async (payload: TwilioWebhookPayload) => {
    const phoneNumber = payload.From;   // includes "whatsapp:" prefix
    const messageText = payload.Body.trim();

    logger.info("Incoming message", { phone: phoneNumber, sid: payload.MessageSid });

    // ── 1. Look up existing lead in ClickUp ───────────────────────────────────
    const existingLead = await findLeadByPhone(phoneNumber);

    if (existingLead) {
      logger.info("Returning patient found", { taskId: existingLead.taskId, name: existingLead.name });
    } else {
      logger.info("New patient", { phone: phoneNumber });
    }

    // ── 2. Build conversation history — cap to avoid LLM token overflow ───────
    const rawHistory: ConversationMessage[] = [
      ...(existingLead?.conversationHistory ?? []),
      { role: "user", content: messageText },
    ];
    const conversationHistory = capHistory(rawHistory);

    if (rawHistory.length !== conversationHistory.length) {
      logger.warn("Conversation history trimmed", {
        dropped: rawHistory.length - conversationHistory.length,
      });
    }

    // ── 3. Get AI reply + extract lead fields ─────────────────────────────────
    const aiResult = await aiResponder.triggerAndWait({
      conversationHistory,
      patientPhone: phoneNumber,
      existingLead: existingLead
        ? {
            name:          existingLead.name,
            problem:       existingLead.problem,
            preferredTime: existingLead.preferredTime,
          }
        : null,
    });

    // ── 3a. Graceful AI failure — notify the patient before throwing ──────────
    if (!aiResult.ok) {
      logger.error("AI responder failed — sending fallback reply", {
        error: aiResult.error,
        phone: phoneNumber,
      });
      try {
        await sendWhatsAppMessage(phoneNumber, AI_FAILURE_REPLY);
      } catch (sendErr) {
        logger.error("Could not send fallback reply", { sendErr });
      }
      throw new Error(`AI responder failed: ${aiResult.error}`);
    }

    const { reply, extractedName, extractedProblem, extractedTime } = aiResult.output;

    // ── 4. Append AI reply to history and re-cap ──────────────────────────────
    const finalHistory = capHistory([
      ...conversationHistory,
      { role: "assistant", content: reply },
    ]);

    // ── 5. Merge extracted fields with whatever was already stored ────────────
    const updatedName    = extractedName    ?? existingLead?.name          ?? null;
    const updatedProblem = extractedProblem ?? existingLead?.problem        ?? null;
    const updatedTime    = extractedTime    ?? existingLead?.preferredTime  ?? null;
    const allFieldsCollected = !!(updatedName && updatedProblem && updatedTime);

    const now = new Date().toISOString();

    // ── 6. Create or update lead in ClickUp ───────────────────────────────────
    // Status flow: NEW (first contact) → CONTACTED (returning patient) → BOOKED (all info collected)
    if (existingLead) {
      await updateLead(existingLead.taskId, {
        name:                updatedName,
        problem:             updatedProblem,
        preferredTime:       updatedTime,
        conversationHistory: finalHistory,
        status:              allFieldsCollected ? LeadStatus.BOOKED : LeadStatus.CONTACTED,
        lastMessageAt:       now,
      });
      logger.info("Lead updated", { taskId: existingLead.taskId, allFieldsCollected });
    } else {
      const newTaskId = await createLead({
        phone:               phoneNumber,
        name:                updatedName,
        problem:             updatedProblem,
        preferredTime:       updatedTime,
        conversationHistory: finalHistory,
        status:              LeadStatus.NEW,
        lastMessageAt:       now,
      });
      logger.info("New lead created", { taskId: newTaskId });
    }

    // ── 7. Send reply to the patient via Twilio ───────────────────────────────
    await sendWhatsAppMessage(phoneNumber, reply);
    logger.info("Reply sent", { phone: phoneNumber });

    // ── 8. Schedule follow-ups if we still need more info ─────────────────────
    // idempotencyKey ties the follow-up chain to this specific incoming message,
    // preventing duplicate chains if this task ever retries.
    if (!allFieldsCollected) {
      await scheduleFollowup.trigger(
        { patientPhone: phoneNumber, triggerTime: now },
        { idempotencyKey: `followup-${payload.MessageSid}` }
      );
      logger.info("Follow-up chain scheduled", { phone: phoneNumber });
    }

    return {
      replied:           true,
      allFieldsCollected,
      name:              updatedName,
      problem:           updatedProblem,
      preferredTime:     updatedTime,
    };
  },
});
