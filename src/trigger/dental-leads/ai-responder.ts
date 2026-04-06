import { task, logger } from "@trigger.dev/sdk";
import type { ConversationMessage } from "./clickup.js";

// ── Payload / Output types ───────────────────────────────────���────────────────

export interface AiResponderPayload {
  conversationHistory: ConversationMessage[];
  patientPhone: string;
  existingLead: {
    name: string | null;
    problem: string | null;
    preferredTime: string | null;
  } | null;
}

export interface AiResponderOutput {
  reply: string;
  extractedName: string | null;
  extractedProblem: string | null;
  extractedTime: string | null;
}

// ── Internal NVIDIA API types ────────────────────────���────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NvidiaResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

interface AiJsonOutput {
  reply?: string;
  extractedName?: string | null;
  extractedProblem?: string | null;
  extractedTime?: string | null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(
  existingLead: AiResponderPayload["existingLead"]
): string {
  const clinicName = process.env.CLINIC_NAME ?? "our dental clinic";
  const services   = process.env.CLINIC_SERVICES ?? "dental services";
  const hours      = process.env.CLINIC_HOURS ?? "Monday to Saturday, 9am to 6pm";

  const known = existingLead
    ? ([
        existingLead.name          ? `name: ${existingLead.name}` : null,
        existingLead.problem       ? `dental problem: ${existingLead.problem}` : null,
        existingLead.preferredTime ? `preferred time: ${existingLead.preferredTime}` : null,
      ].filter(Boolean) as string[])
    : [];

  const knownContext =
    known.length > 0
      ? `You already know the following about this patient: ${known.join(", ")}. Do NOT ask for information you already have.`
      : "You do not yet know anything about this patient. Start with a warm greeting and ask for their name.";

  return `You are a friendly WhatsApp receptionist for ${clinicName}, a dental clinic.
Services: ${services}.
Clinic hours: ${hours}.

Your goal is to collect exactly 3 pieces of information through natural conversation:
1. Patient's full name
2. Their dental problem or reason for visiting
3. Their preferred appointment day and time

${knownContext}

Rules:
- Keep every reply short and warm — 1 to 3 sentences only.
- Ask for ONE missing piece of information per message.
- Once all 3 fields are known, confirm the details back to the patient and tell them the clinic will call to finalise the booking.
- Never invent clinic information.
- Reply in the same language the patient uses.

You MUST reply with ONLY a valid JSON object — no extra text, no markdown fences:
{
  "reply": "<your message to the patient>",
  "extractedName": "<full name if patient provided it this turn, otherwise null>",
  "extractedProblem": "<dental problem if patient provided it this turn, otherwise null>",
  "extractedTime": "<preferred time if patient provided it this turn, otherwise null>"
}`;
}

// ── Pure JSON parser — exported so tests can exercise it independently ────────

const FALLBACK_REPLY = "Thank you for your message. We will get back to you shortly.";

/**
 * Parses the raw LLM output string into a structured `AiResponderOutput`.
 * If the model returned plain text instead of JSON, the raw text becomes the reply.
 * Exported for unit testing.
 */
export function parseAiResponse(raw: string): AiResponderOutput {
  if (!raw) {
    return {
      reply:            FALLBACK_REPLY,
      extractedName:    null,
      extractedProblem: null,
      extractedTime:    null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as AiJsonOutput;
    return {
      reply:            parsed.reply            ?? FALLBACK_REPLY,
      extractedName:    parsed.extractedName    ?? null,
      extractedProblem: parsed.extractedProblem ?? null,
      extractedTime:    parsed.extractedTime    ?? null,
    };
  } catch {
    // Model returned plain text — use it directly as the reply
    return {
      reply:            raw,
      extractedName:    null,
      extractedProblem: null,
      extractedTime:    null,
    };
  }
}

// ── Standalone AI generator — usable outside Trigger.dev tasks ───────────────

const FALLBACK_AI_REPLY =
  "Sorry, something went wrong. We'll contact you soon.";

/**
 * Generates an AI reply for the given patient message and conversation history.
 *
 * Calls the NVIDIA LLaMA endpoint directly (no Trigger.dev wrapper) so it can
 * be used in example scripts, unit tests, or any non-task context.
 *
 * On any error, resolves with {@link FALLBACK_AI_REPLY} rather than throwing,
 * so the calling workflow can always continue.
 *
 * @example
 * const reply = await aiGenerateResponse("I have a toothache", history);
 */
export async function aiGenerateResponse(
  message: string,
  history: ConversationMessage[]
): Promise<string> {
  const apiKey  = process.env.NVIDIA_API_KEY;
  const baseUrl = process.env.NVIDIA_BASE_URL;
  const model   = process.env.NVIDIA_MODEL;

  if (!apiKey || !baseUrl || !model) {
    console.error("[aiGenerateResponse] Missing NVIDIA env vars — returning fallback");
    return FALLBACK_AI_REPLY;
  }

  // Append the new user message to the existing history
  const fullHistory: ConversationMessage[] = [
    ...history,
    { role: "user", content: message },
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(null) },
    ...fullHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[aiGenerateResponse] NVIDIA API error ${response.status}: ${errorText}`);
      return FALLBACK_AI_REPLY;
    }

    const data = (await response.json()) as NvidiaResponse;
    const raw  = data.choices[0]?.message?.content?.trim() ?? "";
    return parseAiResponse(raw).reply;
  } catch (err) {
    console.error("[aiGenerateResponse] Unexpected error:", err);
    return FALLBACK_AI_REPLY;
  }
}

// ── Task ──────────────────────────────────────────────────────────────────────

export const aiResponder = task({
  id: "ai-responder",
  retry: { maxAttempts: 3 },

  run: async (payload: AiResponderPayload): Promise<AiResponderOutput> => {
    // ── 1. Validate env vars ────────────────────────────────────────────────
    const apiKey  = process.env.NVIDIA_API_KEY;
    const baseUrl = process.env.NVIDIA_BASE_URL;
    const model   = process.env.NVIDIA_MODEL;

    if (!apiKey)  throw new Error("NVIDIA_API_KEY is not set");
    if (!baseUrl) throw new Error("NVIDIA_BASE_URL is not set");
    if (!model)   throw new Error("NVIDIA_MODEL is not set");

    // ── 2. Build messages: system prompt + full conversation history ────────
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(payload.existingLead) },
      ...payload.conversationHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    logger.info("Calling NVIDIA LLM", {
      phone: payload.patientPhone,
      turns: payload.conversationHistory.length,
    });

    // ── 3. Call NVIDIA LLaMA (OpenAI-compatible endpoint) ──────────────────
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NVIDIA API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as NvidiaResponse;
    const raw  = data.choices[0]?.message?.content?.trim() ?? "";

    logger.debug("Raw LLM output", { raw });

    // ── 4. Parse and return ─────────────────────────────────────────────────
    // parseAiResponse handles the JSON/plain-text fallback internally.
    const result = parseAiResponse(raw);

    // Surface a warning when the model ignored the JSON format instruction.
    if (!raw.trimStart().startsWith("{")) {
      logger.warn("Non-JSON LLM response — fell back to raw text reply", { raw });
    }

    return result;
  },
});
