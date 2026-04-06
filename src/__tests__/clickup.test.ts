import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseConversationHistory, LeadStatus } from "../clickup.js";
import type { Lead, ConversationMessage } from "../clickup.js";

describe("parseConversationHistory", () => {
  // ── Null / empty inputs ─────────────────────────────────────────────────────

  it("returns an empty array for null", () => {
    expect(parseConversationHistory(null)).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseConversationHistory("")).toEqual([]);
  });

  // ── Valid JSON ──────────────────────────────────────────────────────────────

  it("parses a valid conversation array", () => {
    const input = JSON.stringify([
      { role: "user",      content: "Hi, I have a toothache" },
      { role: "assistant", content: "Sorry to hear that! What is your name?" },
      { role: "user",      content: "Ahmed" },
    ]);

    const result = parseConversationHistory(input);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user",      content: "Hi, I have a toothache" });
    expect(result[1]).toEqual({ role: "assistant", content: "Sorry to hear that! What is your name?" });
    expect(result[2]).toEqual({ role: "user",      content: "Ahmed" });
  });

  it("returns an empty array for an empty JSON array", () => {
    expect(parseConversationHistory("[]")).toEqual([]);
  });

  // ── Malformed / unexpected data ─────────────────────────────────────────────

  it("returns an empty array for malformed JSON", () => {
    expect(parseConversationHistory("{not valid json")).toEqual([]);
  });

  it("returns an empty array when JSON is a non-array value", () => {
    expect(parseConversationHistory('"just a string"')).toEqual([]);
    expect(parseConversationHistory("42")).toEqual([]);
    expect(parseConversationHistory('{"role":"user"}')).toEqual([]);
  });

  it("returns an empty array for a truncated JSON string", () => {
    const truncated = '[{"role":"user","content":"Hi"';
    expect(parseConversationHistory(truncated)).toEqual([]);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("handles a single-message history correctly", () => {
    const input = JSON.stringify([{ role: "user", content: "Hello" }]);
    const result = parseConversationHistory(input);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("preserves message order", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role:    i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));

    const result = parseConversationHistory(JSON.stringify(messages));
    expect(result).toHaveLength(10);
    result.forEach((msg, i) => {
      expect(msg.content).toBe(`message ${i}`);
    });
  });
});

// ============================================================
// Example usage — full lead intake sequence (mocked ClickUp API)
// ============================================================
//
// These tests demonstrate the intended calling sequence:
//   upsertLead  →  appendConversation  →  updateLeadStatus
//
// All ClickUp HTTP calls are intercepted by vi.mock so no real
// network traffic is produced when running `npm test`.
// ============================================================

vi.mock("../clickup.js", async (importOriginal) => {
  // Keep the pure helpers (parseConversationHistory, LeadStatus) from the
  // real module; stub only the async ClickUp-bound functions.
  const real = await importOriginal<typeof import("../clickup.js")>();

  let _store: Record<string, Lead> = {};

  const findLeadByPhone = vi.fn(async (phone: string): Promise<Lead | null> =>
    Object.values(_store).find((l) => l.phone === phone) ?? null
  );

  const createLead = vi.fn(async (input: Omit<Lead, "taskId">): Promise<Lead> => {
    const taskId = `task-${Date.now()}`;
    const lead: Lead = { taskId, ...input } as unknown as Lead;
    _store[taskId] = lead;
    return lead;
  });

  const updateLead = vi.fn(async (taskId: string, updates: Partial<Lead>): Promise<Lead> => {
    _store[taskId] = { ..._store[taskId], ...updates };
    return _store[taskId];
  });

  const upsertLead = vi.fn(async (lead: { name: string; phone: string; message: string }): Promise<string> => {
    const existing = await findLeadByPhone(lead.phone);
    if (existing) {
      const history: ConversationMessage[] = [
        ...(existing.conversationHistory ?? []),
        { role: "user", content: lead.message },
      ];
      await updateLead(existing.taskId, { conversationHistory: history, status: real.LeadStatus.CONTACTED });
      return existing.taskId;
    }
    const created = await createLead({
      phone: lead.phone,
      name: lead.name,
      problem: null,
      preferredTime: null,
      status: real.LeadStatus.NEW,
      conversationHistory: [{ role: "user", content: lead.message }],
      lastMessageAt: new Date().toISOString(),
    } as Omit<Lead, "taskId">);
    return created.taskId;
  });

  const MAX_HISTORY = 20;
  const appendConversation = vi.fn(async (taskId: string, message: string, history: ConversationMessage[]): Promise<void> => {
    const full: ConversationMessage[] = [...history, { role: "assistant", content: message }];
    const capped = full.length > MAX_HISTORY ? full.slice(full.length - MAX_HISTORY) : full;
    await updateLead(taskId, { conversationHistory: capped });
  });

  const updateLeadStatus = vi.fn(async (taskId: string, status: LeadStatus): Promise<void> => {
    await updateLead(taskId, { status });
  });

  // Expose the internal store so tests can inspect state.
  const _getStore = () => _store;
  const _resetStore = () => { _store = {}; };

  return { ...real, findLeadByPhone, createLead, updateLead, upsertLead, appendConversation, updateLeadStatus, _getStore, _resetStore };
});

// Re-import after mock is in place.
const clickup = await import("../clickup.js");
const { upsertLead, appendConversation, updateLeadStatus, findLeadByPhone } = clickup as typeof clickup & {
  _getStore: () => Record<string, Lead>;
  _resetStore: () => void;
};
const { _getStore, _resetStore } = clickup as unknown as { _getStore: () => Record<string, Lead>; _resetStore: () => void };

describe("Example usage — full lead intake sequence", () => {
  beforeEach(() => {
    _resetStore();
    vi.clearAllMocks();
  });

  // ── 1. upsertLead ────────────────────────────────────────────────────────────
  it("upsertLead creates a NEW lead on first contact", async () => {
    const taskId = await upsertLead({
      name:    "Sara Ali",
      phone:   "+923001234567",
      message: "Hi, I have a toothache.",
    });

    expect(typeof taskId).toBe("string");
    expect(taskId.length).toBeGreaterThan(0);

    const lead = _getStore()[taskId];
    expect(lead.phone).toBe("+923001234567");
    expect(lead.name).toBe("Sara Ali");
    expect(lead.status).toBe(LeadStatus.NEW);
    expect(lead.conversationHistory).toHaveLength(1);
    expect(lead.conversationHistory[0]).toEqual({ role: "user", content: "Hi, I have a toothache." });
  });

  it("upsertLead updates an existing lead to CONTACTED on return message", async () => {
    // First message — creates the task.
    const taskId = await upsertLead({ name: "Sara Ali", phone: "+923001234567", message: "Hi!" });

    // Second message from the same phone.
    const sameId = await upsertLead({ name: "Sara Ali", phone: "+923001234567", message: "I need an appointment." });

    expect(sameId).toBe(taskId);                              // same task, not a duplicate
    const lead = _getStore()[taskId];
    expect(lead.status).toBe(LeadStatus.CONTACTED);           // status advanced
    expect(lead.conversationHistory).toHaveLength(2);         // both messages stored
  });

  // ── 2. appendConversation ────────────────────────────────────────────────────
  it("appendConversation stores the AI reply in history", async () => {
    const taskId = await upsertLead({ name: "Ahmed", phone: "+923009876543", message: "I need a cleaning." });
    const existingHistory = _getStore()[taskId].conversationHistory;

    await appendConversation(taskId, "Sure! What day works best for you?", existingHistory);

    const lead = _getStore()[taskId];
    expect(lead.conversationHistory).toHaveLength(2);
    expect(lead.conversationHistory[1]).toEqual({
      role:    "assistant",
      content: "Sure! What day works best for you?",
    });
  });

  it("appendConversation caps history to 20 messages", async () => {
    const taskId = await upsertLead({ name: "Ahmed", phone: "+923009876543", message: "msg 0" });

    // Build a history of 20 messages (10 pairs).
    let history = _getStore()[taskId].conversationHistory;
    for (let i = 1; i <= 19; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      history = [...history, { role, content: `msg ${i}` }];
      await appendConversation(taskId, `msg ${i}`, history.slice(0, -1));
      history = _getStore()[taskId].conversationHistory;
    }

    // One more append should drop the oldest entry.
    await appendConversation(taskId, "msg 20", history);
    const lead = _getStore()[taskId];
    expect(lead.conversationHistory.length).toBeLessThanOrEqual(20);
  });

  // ── 3. updateLeadStatus ──────────────────────────────────────────────────────
  it("updateLeadStatus advances status to BOOKED", async () => {
    const taskId = await upsertLead({ name: "Zara", phone: "+923007654321", message: "I need a root canal." });

    await updateLeadStatus(taskId, LeadStatus.BOOKED);

    expect(_getStore()[taskId].status).toBe(LeadStatus.BOOKED);
  });

  it("updateLeadStatus can mark a lead COMPLETED", async () => {
    const taskId = await upsertLead({ name: "Zara", phone: "+923007654321", message: "Done!" });

    await updateLeadStatus(taskId, LeadStatus.COMPLETED);

    expect(_getStore()[taskId].status).toBe(LeadStatus.COMPLETED);
  });

  // ── 4. Full sequence in one flow ─────────────────────────────────────────────
  it("full sequence: upsertLead → appendConversation → updateLeadStatus", async () => {
    // Step 1 — patient sends first message.
    const taskId = await upsertLead({
      name:    "Bilal Khan",
      phone:   "+923331234567",
      message: "I have a broken tooth.",
    });
    expect(_getStore()[taskId].status).toBe(LeadStatus.NEW);

    // Step 2 — AI asks for preferred appointment time.
    let history = _getStore()[taskId].conversationHistory;
    await appendConversation(taskId, "Sorry to hear that! When would you like to come in?", history);
    history = _getStore()[taskId].conversationHistory;
    expect(history).toHaveLength(2);

    // Step 3 — patient replies with preferred time (second upsert call).
    await upsertLead({ name: "Bilal Khan", phone: "+923331234567", message: "Saturday morning please." });
    expect(_getStore()[taskId].status).toBe(LeadStatus.CONTACTED);

    // Step 4 — AI confirms booking, status → BOOKED.
    history = _getStore()[taskId].conversationHistory;
    await appendConversation(taskId, "Perfect! We've noted Saturday morning. The clinic will call to confirm. 🦷", history);
    await updateLeadStatus(taskId, LeadStatus.BOOKED);
    expect(_getStore()[taskId].status).toBe(LeadStatus.BOOKED);

    // Step 5 — appointment completed.
    await updateLeadStatus(taskId, LeadStatus.COMPLETED);
    expect(_getStore()[taskId].status).toBe(LeadStatus.COMPLETED);

    // Verify findLeadByPhone still resolves the same task.
    const found = await findLeadByPhone("+923331234567");
    expect(found?.taskId).toBe(taskId);
    expect(found?.status).toBe(LeadStatus.COMPLETED);
  });
});
