import { logger, task } from "@trigger.dev/sdk";
import samples from "../../../samples/leads.json";
import { LeadSchema } from "./lead.js";
import { submitLead } from "./submit.js";

/**
 * Dev helper: fires the dummy leads at qualify-lead, the same way a web form would (one run per
 * submission, keyed by submissionId). Re-running within 24h is skipped by idempotency unless
 * `fresh: true`, which gives every lead a new submissionId (the same people, so contacts still dedupe).
 */
export const sendTestLeads = task({
  id: "send-test-leads",
  run: async (payload: { fresh?: boolean; only?: string[] } = {}) => {
    const suffix = payload.fresh ? `-${Date.now()}` : "";
    const picked = samples.filter((s) => !payload.only || payload.only.some((id) => s.submissionId.includes(id)));
    const now = Date.now();
    const triggered = [];
    for (const [i, { expect, ...sample }] of picked.entries()) {
      // Submitted "just now", a few seconds apart, so response times are realistic.
      const lead = LeadSchema.parse({ ...sample, submissionId: `${sample.submissionId}${suffix}`, submittedAt: new Date(now + i * 1000).toISOString() });
      const { runId } = await submitLead(lead);
      triggered.push({ submissionId: lead.submissionId, runId, expect });
    }
    logger.info("Test leads sent", { count: triggered.length });
    return triggered;
  },
});
