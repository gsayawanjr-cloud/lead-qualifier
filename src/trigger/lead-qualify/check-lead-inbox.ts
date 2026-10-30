import { logger, task } from "@trigger.dev/sdk";
import { extractLead } from "./extract.js";
import { fetchLeadEmails, gmailSettings, labelEmail, leadInboxAddress, NOT_A_LEAD_LABEL, PROCESSED_LABEL, sendAlert } from "./gmail.js";
import { submitLead } from "./submit.js";

// Caps Claude spend if the inbox suddenly fills up; the rest are picked up on the next check.
const MAX_EMAILS_PER_RUN = 25;

/**
 * Reads new emails sent to the leads address, turns each into a lead and hands it to qualify-lead,
 * exactly like a website form submission. Triggered by hand for now (no schedule yet).
 */
export const checkLeadInbox = task({
  id: "check-lead-inbox",
  // One check at a time, so two checks never pick up the same email.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    requireEnv("ANTHROPIC_API_KEY");
    const gmail = gmailSettings();
    const inbox = leadInboxAddress(gmail);

    const emails = await fetchLeadEmails(gmail, MAX_EMAILS_PER_RUN);
    logger.info("Inbox checked", { found: emails.length });

    const results = [];
    let claudeProblem: string | undefined;
    for (const email of emails) {
      const extracted = await extractLead(email, gmail.user.toLowerCase());
      if (!extracted.isLead) {
        await labelEmail(gmail, email.messageId, NOT_A_LEAD_LABEL);
        logger.info("Skipped: not a lead", { subject: email.subject, reason: extracted.reason });
        results.push({ subject: email.subject, result: `not a lead (${extracted.reason})` });
        continue;
      }
      if (extracted.problem) claudeProblem = extracted.problem;
      const { runId } = await submitLead(extracted.lead);
      // Labeled only after qualify-lead has the lead, so a crash before this point is retried next check
      // (and the idempotency key stops the same email from being qualified twice).
      await labelEmail(gmail, email.messageId, PROCESSED_LABEL);
      results.push({ subject: email.subject, result: `submitted ${extracted.lead.submissionId}`, read: extracted.source, runId });
    }

    if (claudeProblem) {
      await sendAlert(
        "Claude could not read some lead emails",
        `Those leads were still passed on with just the name, email and message, so they will show up as Needs Review.\n\nProblem: ${claudeProblem}\n\nCheck ANTHROPIC_API_KEY and the credit balance at platform.claude.com.`,
      );
    }
    return { inbox, found: emails.length, results };
  },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
