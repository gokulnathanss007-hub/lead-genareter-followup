import { describe, it, expect } from "vitest";
import { capHistory, MAX_HISTORY_MESSAGES } from "../utils/history.js";
import type { ConversationMessage } from "../clickup.js";

// Helper — builds a history of `n` alternating user/assistant messages
function makeHistory(n: number): ConversationMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i + 1}`,
  }));
}

describe("capHistory", () => {
  it("returns the same reference when history is within the limit", () => {
    const history = makeHistory(5);
    const result  = capHistory(history);
    expect(result).toBe(history); // same reference — no copy made
  });

  it("returns the same reference when history is exactly at the limit", () => {
    const history = makeHistory(MAX_HISTORY_MESSAGES);
    const result  = capHistory(history);
    expect(result).toBe(history);
  });

  it("trims to the last MAX_HISTORY_MESSAGES messages when over the limit", () => {
    const history = makeHistory(MAX_HISTORY_MESSAGES + 4);
    const result  = capHistory(history);
    expect(result).toHaveLength(MAX_HISTORY_MESSAGES);
  });

  it("keeps the most recent messages (drops the oldest)", () => {
    const history = makeHistory(MAX_HISTORY_MESSAGES + 2);
    const result  = capHistory(history);
    // The last message in the trimmed result should match the last in the original
    expect(result[result.length - 1]).toEqual(history[history.length - 1]);
    // The first message should NOT be the very first of the original
    expect(result[0]).not.toEqual(history[0]);
  });

  it("respects a custom maxMessages parameter", () => {
    const history = makeHistory(10);
    const result  = capHistory(history, 4);
    expect(result).toHaveLength(4);
    expect(result[3]).toEqual(history[9]); // last message preserved
  });

  it("returns an empty array unchanged", () => {
    const history: ConversationMessage[] = [];
    const result = capHistory(history);
    expect(result).toBe(history);
    expect(result).toHaveLength(0);
  });

  it("returns a single-message history unchanged", () => {
    const history: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = capHistory(history);
    expect(result).toBe(history);
  });
});
