// ── Conversation history utilities ────────────────────────────────────────────

import type { ConversationMessage } from "../clickup.js";

/**
 * Maximum number of messages kept in the conversation history.
 * Older messages beyond this limit are dropped (oldest first).
 *
 * Why 20?  A typical intake conversation is 6-10 turns.  20 messages
 * gives plenty of context while staying well inside LLM token budgets
 * and ClickUp's custom-field text size limit (~65 535 bytes).
 */
export const MAX_HISTORY_MESSAGES = 20;

/**
 * Returns the most recent `MAX_HISTORY_MESSAGES` entries from `history`.
 * If the history is already within the limit it is returned unchanged
 * (same reference, no copy).
 *
 * Slicing preserves message-pair alignment: because Twilio delivers one
 * user message at a time and we always append one assistant reply, the
 * total count is always even, so a simple tail-slice never splits a pair.
 */
export function capHistory(
  history: ConversationMessage[],
  maxMessages: number = MAX_HISTORY_MESSAGES
): ConversationMessage[] {
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}
