// ── ClickUp adapter ───────────────────────────────────────────────────────────
// Thin re-export of src/clickup.ts for use inside Trigger.dev tasks.
// createLead returns just the taskId string (all the webhook-handler needs).

import {
  findLeadByPhone,
  updateLead,
  createLead as _createLead,
  LeadStatus,
  type Lead,
  type ConversationMessage,
} from "../../clickup.js";

// LeadData is identical to Lead — re-export as an alias so callers
// don't need to change their imports if the name ever diverges.
export type LeadData = Lead;
export type { ConversationMessage };

export { findLeadByPhone, updateLead, LeadStatus };

/**
 * Creates a new ClickUp lead and returns only the taskId string,
 * which is all the webhook-handler needs after creation.
 */
export async function createLead(
  data: Omit<LeadData, "taskId">
): Promise<string> {
  const lead = await _createLead(data);
  return lead.taskId;
}
