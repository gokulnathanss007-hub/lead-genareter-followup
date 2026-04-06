import { describe, it, expect } from "vitest";
import { parseAiResponse } from "../trigger/dental-leads/ai-responder.js";

describe("parseAiResponse", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("parses a fully-populated JSON response", () => {
    const raw = JSON.stringify({
      reply:            "Great, we have your details!",
      extractedName:    "Ahmed Khan",
      extractedProblem: "toothache",
      extractedTime:    "Monday 10am",
    });

    const result = parseAiResponse(raw);

    expect(result.reply).toBe("Great, we have your details!");
    expect(result.extractedName).toBe("Ahmed Khan");
    expect(result.extractedProblem).toBe("toothache");
    expect(result.extractedTime).toBe("Monday 10am");
  });

  it("returns null for missing extracted fields", () => {
    const raw = JSON.stringify({
      reply: "Hello! What is your name?",
    });

    const result = parseAiResponse(raw);

    expect(result.reply).toBe("Hello! What is your name?");
    expect(result.extractedName).toBeNull();
    expect(result.extractedProblem).toBeNull();
    expect(result.extractedTime).toBeNull();
  });

  it("accepts explicit null values for extracted fields", () => {
    const raw = JSON.stringify({
      reply:            "Thanks! What brings you in today?",
      extractedName:    "Sara",
      extractedProblem: null,
      extractedTime:    null,
    });

    const result = parseAiResponse(raw);

    expect(result.extractedName).toBe("Sara");
    expect(result.extractedProblem).toBeNull();
    expect(result.extractedTime).toBeNull();
  });

  // ── Fallback / degraded cases ───────────────────────────────────────────────

  it("uses fallback reply when JSON has no reply field but still returns extracted fields", () => {
    const raw = JSON.stringify({ extractedName: "Ali" });
    const result = parseAiResponse(raw);
    // reply falls back to the default string
    expect(result.reply).toBeTruthy();
    // extracted fields ARE returned — JSON parsed successfully, name was present
    expect(result.extractedName).toBe("Ali");
    expect(result.extractedProblem).toBeNull();
    expect(result.extractedTime).toBeNull();
  });

  it("uses raw text as reply when model returns plain text (not JSON)", () => {
    const raw = "Hi there! Could you please share your name?";
    const result = parseAiResponse(raw);
    expect(result.reply).toBe(raw);
    expect(result.extractedName).toBeNull();
    expect(result.extractedProblem).toBeNull();
    expect(result.extractedTime).toBeNull();
  });

  it("uses raw text as reply when JSON is malformed / truncated", () => {
    const raw = '{"reply": "Hello", "extractedName": "Ahmed"'; // missing closing brace
    const result = parseAiResponse(raw);
    expect(result.reply).toBe(raw);
    expect(result.extractedName).toBeNull();
  });

  it("returns fallback reply for an empty string", () => {
    const result = parseAiResponse("");
    expect(result.reply).toBeTruthy();
    expect(result.extractedName).toBeNull();
    expect(result.extractedProblem).toBeNull();
    expect(result.extractedTime).toBeNull();
  });

  it("handles JSON wrapped in markdown fences gracefully (returns raw as reply)", () => {
    // Some models ignore the instruction and wrap output in ```json ... ```
    const raw = "```json\n{\"reply\": \"Hi!\"}\n```";
    // Not valid JSON — should fall back to raw text
    const result = parseAiResponse(raw);
    expect(result.reply).toBe(raw);
  });
});
