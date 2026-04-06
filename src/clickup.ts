// ============================================================
// ClickUp CRM Integration — Dental Lead Management System
// ============================================================
//
// HOW TO GET YOUR REAL FIELD IDs:
//   1. Open a terminal and run:
//        curl -H "Authorization: YOUR_CLICKUP_API_KEY" \
//             "https://api.clickup.com/api/v2/list/YOUR_LIST_ID/field"
//      Or paste that URL into Postman / Insomnia with the same header.
//   2. In the JSON response, each object has an "id" and a "name".
//      Find the fields named "Phone", "Patient Name", and "Problem".
//   3. Copy the "id" value for each field and paste it below.
//      IDs look like: "abc123de-f012-3456-7890-abcdef123456"
//
// ============================================================

import axios, { type AxiosInstance, type AxiosError } from "axios";
import { logger } from "./utils/logger.js";

// ── Custom Field IDs ─────────────────────────────────────────────────────────
// Source list: "Dental Leadd" (space 90166718340, list 901614338320)
// Fetched via: GET /api/v2/list/901614338320/field
const PHONE_FIELD_ID                = "2ecfbffa-e940-48aa-92c3-540db05cbe41"; // field: "Phone"                (short_text)
const NAME_FIELD_ID                 = "bfa504e9-b48c-4efa-a774-b3de1c268729"; // field: "Patient Name"         (short_text)
const PROBLEM_FIELD_ID              = "1e85af4e-87c7-49fe-a1ff-0c13267b809d"; // field: "Problem"              (text)
const PREFERRED_TIME_FIELD_ID       = "81754396-24a5-49a5-9539-2459d7854b80"; // field: "Preferred Time"       (short_text)
const CONVERSATION_HISTORY_FIELD_ID = "21c5db35-7b4c-44ae-8bef-808fd26ce6dd"; // field: "Conversation History" (text)
// Status is a built-in ClickUp task field — set via task.status, not a custom field.

// ============================================================
// Lead Status constants  (NEW → CONTACTED → BOOKED → COMPLETED)
// ============================================================
// Centralised here so any typo is a compile error, not a silent
// "unknown status" that ClickUp silently ignores.
// These must exactly match the status names in your ClickUp list.

export const LeadStatus = {
  NEW:       "new",
  CONTACTED: "contacted",
  BOOKED:    "booked",
  COMPLETED: "completed",
} as const;

export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

// ============================================================
// Types
// ============================================================

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/** A dental lead as stored / returned by this module. */
export interface Lead {
  taskId: string;
  phone: string;
  name: string | null;
  problem: string | null;
  preferredTime: string | null;
  status: string;
  conversationHistory: ConversationMessage[];
  lastMessageAt: string;
}

/** Fields accepted when creating a new lead. */
export interface CreateLeadInput {
  phone: string;
  name?: string | null;
  problem?: string | null;
  preferredTime?: string | null;
  status?: string;
  conversationHistory?: ConversationMessage[];
  lastMessageAt?: string;
}

/** Fields accepted when updating an existing lead. */
export type UpdateLeadInput = Partial<Omit<CreateLeadInput, "phone">>;

// ── Internal ClickUp API shapes ───────────────────────────────────────────────

interface ClickUpCustomField {
  id: string;
  name: string;
  value?: string | number | boolean | null;
}

interface ClickUpTaskStatus {
  status: string;
  color: string;
  type: string;
  orderindex: number;
}

interface ClickUpTask {
  id: string;
  name: string;
  status: ClickUpTaskStatus;
  custom_fields: ClickUpCustomField[];
  url: string;
  date_created: string;
  date_updated: string;
}

interface ClickUpTasksResponse {
  tasks: ClickUpTask[];
}

// ============================================================
// Config & Axios client
// ============================================================

function getConfig(): { apiKey: string; listId: string } {
  const apiKey = process.env.CLICKUP_API_KEY;
  const listId = process.env.CLICKUP_LIST_ID;
  if (!apiKey) throw new Error("Missing env variable: CLICKUP_API_KEY");
  if (!listId) throw new Error("Missing env variable: CLICKUP_LIST_ID");
  return { apiKey, listId };
}

/** Returns a pre-configured Axios instance scoped to the ClickUp v2 API. */
function buildClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: "https://api.clickup.com/api/v2",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
  });
}

// ============================================================
// Internal helper — format Axios errors for logging
// ============================================================

function axiosErrorMessage(err: unknown): string {
  const e = err as AxiosError;
  if (e.response) {
    return `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`;
  }
  return String(err);
}

// ============================================================
// Helper — build custom_fields array (skips null/undefined values)
// ============================================================

interface FieldEntry {
  id: string;
  value: string | null | undefined;
}

function buildCustomFields(
  fields: FieldEntry[]
): Array<{ id: string; value: string }> {
  return fields
    .filter((f): f is { id: string; value: string } => f.value != null)
    .map(({ id, value }) => ({ id, value }));
}

// ============================================================
// Helper — parse a ClickUpTask into a Lead
// ============================================================

function getFieldValue(task: ClickUpTask, fieldId: string): string | null {
  const field = task.custom_fields.find((f) => f.id === fieldId);
  const value = field?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parses the raw conversation history stored as a JSON string in ClickUp.
 * Returns an empty array when the field is absent or invalid.
 * Exported so tests can exercise the parsing logic directly.
 */
export function parseConversationHistory(raw: string | null): ConversationMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ConversationMessage[];
  } catch {
    // malformed JSON — start fresh
  }
  return [];
}

function toLeadRecord(task: ClickUpTask): Lead {
  return {
    taskId:              task.id,
    phone:               getFieldValue(task, PHONE_FIELD_ID) ?? "",
    name:                getFieldValue(task, NAME_FIELD_ID),
    problem:             getFieldValue(task, PROBLEM_FIELD_ID),
    preferredTime:       getFieldValue(task, PREFERRED_TIME_FIELD_ID),
    status:              task.status?.status ?? "unknown",
    conversationHistory: parseConversationHistory(getFieldValue(task, CONVERSATION_HISTORY_FIELD_ID)),
    lastMessageAt:       task.date_updated,
  };
}

// ============================================================
// Conversation history — cap to last N messages
// ============================================================

const MAX_HISTORY = 20;

function capHistory(history: ConversationMessage[]): ConversationMessage[] {
  if (history.length <= MAX_HISTORY) return history;
  return history.slice(history.length - MAX_HISTORY);
}

// ============================================================
// 1. findLeadByPhone
// ============================================================

/**
 * Searches the ClickUp list for a task whose "Phone" custom field
 * matches the given number.  Pages through results in batches of 100.
 *
 * Returns a `Lead` when found, `null` otherwise.
 */
export async function findLeadByPhone(phone: string): Promise<Lead | null> {
  const { apiKey, listId } = getConfig();
  const client = buildClient(apiKey);
  const normalised = phone.trim();

  let page = 0;
  const PAGE_SIZE = 100;

  while (true) {
    let data: ClickUpTasksResponse;
    try {
      const res = await client.get<ClickUpTasksResponse>(`/list/${listId}/task`, {
        params: {
          custom_fields: true,
          include_closed: true,
          page,
          order_by: "created",
          reverse: true,
        },
      });
      data = res.data;
    } catch (err) {
      logger.error({ phone, page, err: axiosErrorMessage(err) }, "[ClickUp] findLeadByPhone failed");
      throw err;
    }

    const tasks = data.tasks ?? [];

    const match = tasks.find((task) => {
      const value = getFieldValue(task, PHONE_FIELD_ID);
      return value?.trim() === normalised;
    });

    if (match) {
      logger.info({ taskId: match.id, phone }, "[ClickUp] Found lead");
      return toLeadRecord(match);
    }

    if (tasks.length < PAGE_SIZE) break;
    page++;
  }

  logger.info({ phone }, "[ClickUp] No lead found");
  return null;
}

// ============================================================
// 2. createLead
// ============================================================

/**
 * Creates a new ClickUp task for an incoming dental lead.
 * Returns the newly created `Lead` record.
 */
export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const { apiKey, listId } = getConfig();
  const client = buildClient(apiKey);

  const taskName = input.name?.trim() || input.phone;

  const customFields = buildCustomFields([
    { id: PHONE_FIELD_ID,                value: input.phone },
    { id: NAME_FIELD_ID,                 value: input.name },
    { id: PROBLEM_FIELD_ID,              value: input.problem },
    { id: PREFERRED_TIME_FIELD_ID,       value: input.preferredTime },
    { id: CONVERSATION_HISTORY_FIELD_ID, value: input.conversationHistory ? JSON.stringify(input.conversationHistory) : null },
  ]);

  const body: Record<string, unknown> = {
    name: taskName,
    custom_fields: customFields,
  };

  if (input.status) {
    body.status = input.status;
  }

  let task: ClickUpTask;
  try {
    const res = await client.post<ClickUpTask>(`/list/${listId}/task`, body);
    task = res.data;
  } catch (err) {
    logger.error({ phone: input.phone, err: axiosErrorMessage(err) }, "[ClickUp] createLead failed");
    throw err;
  }

  logger.info({ taskId: task.id, name: task.name }, "[ClickUp] Lead created");
  return toLeadRecord(task);
}

// ============================================================
// 3. updateLead
// ============================================================

/**
 * Updates an existing ClickUp task by task ID.
 * Only the fields present in `updates` are changed; omitted fields are left untouched.
 *
 * Returns the refreshed `Lead` record after all updates are applied.
 */
export async function updateLead(
  taskId: string,
  updates: UpdateLeadInput
): Promise<Lead> {
  const { apiKey } = getConfig();
  const client = buildClient(apiKey);

  // ── Update task-level fields (name, status) ──────────────────────────────
  const taskPayload: Record<string, unknown> = {};

  if (updates.name != null) taskPayload.name   = updates.name.trim();
  if (updates.status != null) taskPayload.status = updates.status;

  if (Object.keys(taskPayload).length > 0) {
    try {
      await client.put<ClickUpTask>(`/task/${taskId}`, taskPayload);
    } catch (err) {
      logger.error({ taskId, taskPayload, err: axiosErrorMessage(err) }, "[ClickUp] updateLead:task failed");
      throw err;
    }
  }

  // ── Update custom fields one at a time (ClickUp API requirement) ──────────
  const fieldUpdates = buildCustomFields([
    { id: NAME_FIELD_ID,                 value: updates.name },
    { id: PROBLEM_FIELD_ID,              value: updates.problem },
    { id: PREFERRED_TIME_FIELD_ID,       value: updates.preferredTime },
    { id: CONVERSATION_HISTORY_FIELD_ID, value: updates.conversationHistory ? JSON.stringify(updates.conversationHistory) : undefined },
  ]);

  for (const field of fieldUpdates) {
    try {
      await client.post(`/task/${taskId}/field/${field.id}`, { value: field.value });
    } catch (err) {
      logger.error({ taskId, fieldId: field.id, err: axiosErrorMessage(err) }, "[ClickUp] updateLead:field failed");
      throw err;
    }
  }

  // ── Fetch and return the refreshed task ───────────────────────────────────
  const refreshed = await client.get<ClickUpTask>(`/task/${taskId}`, {
    params: { custom_fields: true },
  });

  logger.info({ taskId }, "[ClickUp] Lead updated");
  return toLeadRecord(refreshed.data);
}

// ============================================================
// 4. upsertLead  (phone-based create-or-update)
// ============================================================

/**
 * Looks up a lead by phone number.
 * - If found  → appends the first user message and updates the record.
 * - If absent → creates a brand-new task with status NEW.
 *
 * Returns the `taskId` in both cases.
 *
 * @example
 * const taskId = await upsertLead({ name: "Sara Ali", phone: "+923001234567", message: "I have a toothache" });
 */
export async function upsertLead(lead: {
  name: string;
  phone: string;
  message: string;
}): Promise<string> {
  const existing = await findLeadByPhone(lead.phone);

  if (existing) {
    const newHistory = capHistory([
      ...existing.conversationHistory,
      { role: "user", content: lead.message },
    ]);

    await updateLead(existing.taskId, {
      name:                lead.name || existing.name,
      conversationHistory: newHistory,
      status:              LeadStatus.CONTACTED,
    });

    logger.info(
      { taskId: existing.taskId, phone: lead.phone },
      "[ClickUp] upsertLead — updated existing lead"
    );
    return existing.taskId;
  }

  const created = await createLead({
    phone:               lead.phone,
    name:                lead.name,
    conversationHistory: [{ role: "user", content: lead.message }],
    status:              LeadStatus.NEW,
  });

  logger.info(
    { taskId: created.taskId, phone: lead.phone },
    "[ClickUp] upsertLead — created new lead"
  );
  return created.taskId;
}

// ============================================================
// 5. appendConversation
// ============================================================

/**
 * Appends `message` to `history` as the given `role` (default: `"assistant"`),
 * caps to {@link MAX_HISTORY} messages, then persists the result to ClickUp.
 *
 * Pass `role: "user"` to store a patient message; `role: "assistant"` (default)
 * to store an AI reply.
 *
 * @example
 * // Store a patient message
 * await appendConversation(taskId, "I have a toothache", history, "user");
 * // Store an AI reply
 * await appendConversation(taskId, "Great! What is your name?", history);
 */
export async function appendConversation(
  taskId: string,
  message: string,
  history: ConversationMessage[],
  role: "user" | "assistant" = "assistant"
): Promise<void> {
  const newHistory = capHistory([
    ...history,
    { role, content: message },
  ]);

  await updateLead(taskId, { conversationHistory: newHistory });

  logger.info(
    { taskId, role, totalMessages: newHistory.length },
    "[ClickUp] appendConversation — history persisted"
  );
}

// ============================================================
// 6. updateLeadStatus
// ============================================================

/**
 * Updates the status of a lead task in ClickUp.
 * Accepts any value from the {@link LeadStatus} constant object.
 *
 * Status flow: NEW → CONTACTED → BOOKED → COMPLETED
 *
 * @example
 * await updateLeadStatus(taskId, LeadStatus.BOOKED);
 */
export async function updateLeadStatus(
  taskId: string,
  status: LeadStatus
): Promise<void> {
  await updateLead(taskId, { status });
  logger.info({ taskId, status }, "[ClickUp] updateLeadStatus — status changed");
}
