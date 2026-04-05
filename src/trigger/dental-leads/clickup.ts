// STUB — full implementation comes in the next step
export interface LeadData {
  taskId: string;
  phone: string;
  name: string | null;
  problem: string | null;
  preferredTime: string | null;
  status: string;
  conversationHistory: ConversationMessage[];
  lastMessageAt: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export async function findLeadByPhone(_phone: string): Promise<LeadData | null> {
  // TODO: implement in clickup.ts step
  return null;
}

export async function createLead(_data: Omit<LeadData, "taskId">): Promise<string> {
  // TODO: implement in clickup.ts step
  return "";
}

export async function updateLead(_taskId: string, _data: Partial<LeadData>): Promise<void> {
  // TODO: implement in clickup.ts step
}
