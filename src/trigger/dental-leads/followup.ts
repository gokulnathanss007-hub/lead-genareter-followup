import { task, wait, logger } from "@trigger.dev/sdk";
import { findLeadByPhone } from "./clickup.js";
import { sendWhatsAppMessage } from "../../utils/whatsapp.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;  // total follow-up messages before giving up
const WAIT_HOURS   = 1;  // hours to wait between each reminder

// Each message is used for attempt 1, 2, 3 respectively.
// {clinicName} is replaced at runtime from the CLINIC_NAME env var.
const REMINDERS = [
  "Hi! 👋 It seems we got cut off. We'd love to help you book an appointment at {clinicName}. Could you share your name to get started?",
  "Hello again! We're still here at {clinicName} and ready to help. Just a couple more details and we'll get you booked in. 😊",
  "Last reminder from {clinicName} — we'd hate for you to miss out! Reply any time to continue and we'll take care of the rest. 🦷",
];

// ── Payload ───────────────────────────────────────────────────────────────────

export interface FollowupPayload {
  patientPhone:   string;
  triggerTime:    string;  // ISO timestamp of the original incoming message (idempotency anchor)
  attemptNumber?: number;  // 1-based; defaults to 1
}

// ── Task ──────────────────────────────────────────────────────────────────────

export const scheduleFollowup = task({
  id: "schedule-followup",
  retry: { maxAttempts: 2 },

  run: async (payload: FollowupPayload): Promise<void> => {
    const clinicName = process.env.CLINIC_NAME ?? "our clinic";
    const attempt    = payload.attemptNumber ?? 1;

    logger.info(`Follow-up attempt — waiting ${WAIT_HOURS}h`, {
      phone:       payload.patientPhone,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    });

    // ── 1. Wait before sending (auto-checkpointed by Trigger.dev) ────────────
    await wait.for({ hours: WAIT_HOURS });

    // ── 2. Re-fetch lead — stop if it no longer exists ────────────────────────
    const lead = await findLeadByPhone(payload.patientPhone);

    if (!lead) {
      logger.info("Lead not found — stopping follow-up chain", { phone: payload.patientPhone });
      return;
    }

    // ── 3. Stop if the patient already gave us all the info we need ───────────
    if (lead.name && lead.problem) {
      logger.info("Lead is complete — no reminder needed", { taskId: lead.taskId });
      return;
    }

    // ── 4. Stop if we've exhausted all attempts ───────────────────────────────
    if (attempt > MAX_ATTEMPTS) {
      logger.info("Max follow-up attempts reached — stopping", {
        phone: payload.patientPhone,
        attempt,
      });
      return;
    }

    // ── 5. Send reminder WhatsApp message ─────────────────────────────────────
    const template = REMINDERS[attempt - 1] ?? REMINDERS[REMINDERS.length - 1];
    const message  = template.replace("{clinicName}", clinicName);

    await sendWhatsAppMessage(payload.patientPhone, message);
    logger.info("Follow-up reminder sent", { phone: payload.patientPhone, attempt });

    // ── 6. Schedule the next attempt if there are more remaining ──────────────
    if (attempt < MAX_ATTEMPTS) {
      await scheduleFollowup.trigger(
        {
          patientPhone:  payload.patientPhone,
          triggerTime:   payload.triggerTime,
          attemptNumber: attempt + 1,
        },
        {
          idempotencyKey: `followup-${payload.patientPhone}-${payload.triggerTime}-attempt-${attempt + 1}`,
        }
      );
      logger.info("Next follow-up scheduled", {
        phone:       payload.patientPhone,
        nextAttempt: attempt + 1,
      });
    }
  },
});
