import { task } from "@trigger.dev/sdk";
import type { ConversationMessage } from "./clickup.js";

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

// STUB — full implementation comes in the next step
export const aiResponder = task({
  id: "ai-responder",
  run: async (_payload: AiResponderPayload): Promise<AiResponderOutput> => {
    // TODO: implement in ai-responder.ts step
    return {
      reply: "Thank you for contacting us. We will get back to you shortly.",
      extractedName: null,
      extractedProblem: null,
      extractedTime: null,
    };
  },
});
