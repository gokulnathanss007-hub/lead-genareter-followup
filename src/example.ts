/**
 * End-to-end workflow simulation — dental lead management system
 *
 * Demonstrates the full lifecycle:
 *   1. First patient message  → lead created (NEW)
 *   2. AI generates reply     → history saved
 *   3. Patient replies again  → status CONTACTED
 *   4. AI generates reply     → booking confirmed → status BOOKED
 *   5. Service completed      → status COMPLETED
 *
 * Run with:  npx tsx src/example.ts
 * (requires a valid .env file with CLICKUP_API_KEY, CLICKUP_LIST_ID,
 *  NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL)
 */

import "dotenv/config";

import { logger } from "./utils/logger.js";
import {
  upsertLead,
  appendConversation,
  updateLeadStatus,
  findLeadByPhone,
  LeadStatus,
  type ConversationMessage,
} from "./clickup.js";
import { aiGenerateResponse } from "./trigger/dental-leads/ai-responder.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simulates one full exchange: patient sends a message, AI replies.
 * Returns the updated conversation history.
 */
async function handleMessage(
  taskId: string,
  patientMessage: string,
  history: ConversationMessage[]
): Promise<ConversationMessage[]> {
  // Step A: persist the patient's message
  await appendConversation(taskId, patientMessage, history, "user");
  const historyAfterUser: ConversationMessage[] = [
    ...history,
    { role: "user", content: patientMessage },
  ];
  logger.info({ taskId, patientMessage }, "Patient message stored");

  // Step B: generate an AI reply (falls back to a safe message on error)
  const aiReply = await aiGenerateResponse(patientMessage, history);
  logger.info({ taskId, aiReply }, "AI reply generated");

  // Step C: persist the AI reply
  await appendConversation(taskId, aiReply, historyAfterUser, "assistant");
  logger.info({ taskId }, "AI reply stored");

  return [
    ...historyAfterUser,
    { role: "assistant", content: aiReply },
  ];
}

// ── Main simulation ───────────────────────────────────────────────────────────

async function runExample(): Promise<void> {
  const PATIENT_PHONE = "+923001234567";
  const PATIENT_NAME  = "Sara Ali";

  logger.info("=== Dental Lead Workflow Simulation ===");

  // ──────────────────────────────────────────────────────────────────────────
  // Turn 1 — First contact: lead does not exist yet → NEW
  // ──────────────────────────────────────────────────────────────────────────
  logger.info("--- Turn 1: First patient message (new lead) ---");

  const firstMessage = "Hi, I have a bad toothache and would like to book an appointment.";

  // upsertLead creates the task with status NEW and stores the first user message.
  const taskId = await upsertLead({
    name:    PATIENT_NAME,
    phone:   PATIENT_PHONE,
    message: firstMessage,
  });
  logger.info({ taskId }, "Lead upserted (status: NEW)");

  // Fetch current history to pass into subsequent appendConversation calls.
  let lead = await findLeadByPhone(PATIENT_PHONE);
  if (!lead) throw new Error("Lead not found immediately after upsert — check ClickUp config");
  let history: ConversationMessage[] = lead.conversationHistory;

  // Generate and store the AI reply for turn 1.
  const aiReply1 = await aiGenerateResponse(firstMessage, []);
  logger.info({ aiReply1 }, "AI reply — turn 1");
  await appendConversation(taskId, aiReply1, history, "assistant");
  history = [...history, { role: "assistant", content: aiReply1 }];

  // ──────────────────────────────────────────────────────────────────────────
  // Turn 2 — Patient replies → status CONTACTED
  // ──────────────────────────────────────────────────────────────────────────
  logger.info("--- Turn 2: Return message (status → CONTACTED) ---");

  const returnMessage = "My name is Sara Ali, the pain is on my upper right molar. I can come Thursday morning.";

  // upsertLead detects the existing phone number → sets status to CONTACTED.
  await upsertLead({
    name:    PATIENT_NAME,
    phone:   PATIENT_PHONE,
    message: returnMessage,
  });
  logger.info({ taskId }, "Lead updated (status: CONTACTED)");

  // Refresh history from ClickUp after upsert (upsert already appended the user turn).
  lead = await findLeadByPhone(PATIENT_PHONE);
  history = lead?.conversationHistory ?? history;

  history = await handleMessage(taskId, returnMessage, history);

  // ──────────────────────────────────────────────────────────────────────────
  // Booking confirmed — status BOOKED
  // ──────────────────────────────────────────────────────────────────────────
  logger.info("--- Booking confirmed (status → BOOKED) ---");
  await updateLeadStatus(taskId, LeadStatus.BOOKED);
  logger.info({ taskId }, "Lead status updated to BOOKED");

  // ──────────────────────────────────────────────────────────────────────────
  // Service completed — status COMPLETED
  // ──────────────────────────────────────────────────────────────────────────
  logger.info("--- Appointment done (status → COMPLETED) ---");
  await updateLeadStatus(taskId, LeadStatus.COMPLETED);
  logger.info({ taskId }, "Lead status updated to COMPLETED");

  // ──────────────────────────────────────────────────────────────────────────
  // Final state
  // ──────────────────────────────────────────────────────────────────────────
  lead = await findLeadByPhone(PATIENT_PHONE);
  logger.info(
    {
      taskId:              lead?.taskId,
      status:              lead?.status,
      name:                lead?.name,
      problem:             lead?.problem,
      preferredTime:       lead?.preferredTime,
      totalMessages:       lead?.conversationHistory.length,
    },
    "=== Final lead state ==="
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

runExample().catch((err: unknown) => {
  logger.error({ err }, "Simulation failed");
  process.exit(1);
});
