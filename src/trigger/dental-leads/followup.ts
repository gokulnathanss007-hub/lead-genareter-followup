import { task } from "@trigger.dev/sdk";

export interface FollowupPayload {
  patientPhone: string;
  triggerTime: string; // ISO timestamp of the original message
}

// STUB — full implementation comes in the next step
export const scheduleFollowup = task({
  id: "schedule-followup",
  run: async (_payload: FollowupPayload): Promise<void> => {
    // TODO: implement in followup.ts step
  },
});
