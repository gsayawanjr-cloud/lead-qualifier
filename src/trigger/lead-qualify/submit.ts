import { idempotencyKeys } from "@trigger.dev/sdk";
import type { LeadPayload } from "./lead.js";
import { qualifyLead } from "./qualify-lead.js";

/**
 * The one way a lead enters the qualifier, whatever it came from (email, test data, a website).
 * Keyed by submissionId for 24h, so the same submission is only ever processed once. The key is
 * "global": a plain string inside a task would only be unique within that one parent run.
 */
export async function submitLead(lead: LeadPayload): Promise<{ runId: string }> {
  const handle = await qualifyLead.trigger(lead, {
    idempotencyKey: await idempotencyKeys.create(`lead-${lead.submissionId}`, { scope: "global" }),
    idempotencyKeyTTL: "24h",
  });
  return { runId: handle.id };
}
