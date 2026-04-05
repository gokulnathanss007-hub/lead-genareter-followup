import { task } from "@trigger.dev/sdk";
import { aiResponder } from "./ai-responder.js";
import { scheduleFollowup } from "./followup.js";
import {
  findLeadByPhone,
  createLead,
  updateLead,
  type ConversationMessage,
} from "./clickup.js";

// Shape of the POST body Twilio sends to the webhook endpoint
export interface TwilioWebhookPayload {
  From: string;       // e.g. "whatsapp:+923001234567"
  To: string;         // clinic's Twilio number
  Body: string;       // patient's message text
  MessageSid: string; // unique Twilio message ID
}

export const webhookHandler = task({
  id: "whatsapp-webhook-handler",
  retry: { maxAttempts: 2 },

  run: async (payload: TwilioWebhookPayload) => {
    // ── 1. Validate required environment variables ────────────────────────────
    const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!twilioAccountSid) throw new Error("TWILIO_ACCOUNT_SID is not set");
    if (!twilioAuthToken) throw new Error("TWILIO_AUTH_TOKEN is not set");
    if (!twilioWhatsAppNumber) throw new Error("TWILIO_WHATSAPP_NUMBER is not set");

    const phoneNumber = payload.From;   // includes "whatsapp:" prefix
    const messageText = payload.Body.trim();

    console.log(`Incoming message from ${phoneNumber}: "${messageText}"`);

    // ── 2. Look up existing lead in ClickUp ───────────────────────────────────
    const existingLead = await findLeadByPhone(phoneNumber);
    console.log(existingLead ? `Returning patient found: ${existingLead.name}` : "New patient");

    // ── 3. Build conversation history with the new incoming message ───────────
    const conversationHistory: ConversationMessage[] = [
      ...(existingLead?.conversationHistory ?? []),
      { role: "user", content: messageText },
    ];

    // ── 4. Get AI reply + extract any lead fields from the patient's message ───
    const aiResult = await aiResponder.triggerAndWait({
      conversationHistory,
      patientPhone: phoneNumber,
      existingLead: existingLead
        ? {
            name: existingLead.name,
            problem: existingLead.problem,
            preferredTime: existingLead.preferredTime,
          }
        : null,
    });

    if (!aiResult.ok) {
      throw new Error(`AI responder failed: ${aiResult.error}`);
    }

    const { reply, extractedName, extractedProblem, extractedTime } = aiResult.output;

    // ── 5. Append AI reply to conversation history ────────────────────────────
    conversationHistory.push({ role: "assistant", content: reply });

    // ── 6. Merge extracted fields with whatever was already stored ────────────
    const updatedName = extractedName ?? existingLead?.name ?? null;
    const updatedProblem = extractedProblem ?? existingLead?.problem ?? null;
    const updatedTime = extractedTime ?? existingLead?.preferredTime ?? null;
    const allFieldsCollected = !!(updatedName && updatedProblem && updatedTime);

    const now = new Date().toISOString();

    // ── 7. Create or update lead in ClickUp ───────────────────────────────────
    if (existingLead) {
      await updateLead(existingLead.taskId, {
        name: updatedName,
        problem: updatedProblem,
        preferredTime: updatedTime,
        conversationHistory,
        status: allFieldsCollected ? "Ready to Book" : "In Progress",
        lastMessageAt: now,
      });
      console.log(`Updated lead ${existingLead.taskId} in ClickUp`);
    } else {
      const newTaskId = await createLead({
        phone: phoneNumber,
        name: updatedName,
        problem: updatedProblem,
        preferredTime: updatedTime,
        conversationHistory,
        status: "In Progress",
        lastMessageAt: now,
      });
      console.log(`Created new lead ${newTaskId} in ClickUp`);
    }

    // ── 8. Send reply to the patient via Twilio ───────────────────────────────
    await sendWhatsAppMessage({
      to: phoneNumber,
      from: twilioWhatsAppNumber,
      body: reply,
      accountSid: twilioAccountSid,
      authToken: twilioAuthToken,
    });
    console.log(`Sent reply to ${phoneNumber}`);

    // ── 9. Schedule follow-ups if we still need more info from the patient ─────
    // idempotencyKey ties the follow-up to this specific incoming message,
    // so re-runs of the task don't create duplicate follow-up chains.
    if (!allFieldsCollected) {
      await scheduleFollowup.trigger(
        {
          patientPhone: phoneNumber,
          triggerTime: now,
        },
        {
          idempotencyKey: `followup-${payload.MessageSid}`,
        }
      );
      console.log("Follow-up scheduled");
    }

    return {
      replied: true,
      allFieldsCollected,
      name: updatedName,
      problem: updatedProblem,
      preferredTime: updatedTime,
    };
  },
});

// ── Twilio REST helper (native fetch, no Twilio SDK needed) ──────────────────
async function sendWhatsAppMessage({
  to,
  from,
  body,
  accountSid,
  authToken,
}: {
  to: string;
  from: string;
  body: string;
  accountSid: string;
  authToken: string;
}): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio API error ${response.status}: ${errorText}`);
  }
}
