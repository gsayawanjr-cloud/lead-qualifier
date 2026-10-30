import { logger, task } from "@trigger.dev/sdk";
import samples from "../../../samples/emails.json";
import { gmailSettings, leadInboxAddress, sendInternalEmail } from "./gmail.js";

/**
 * Dev helper: emails the mock customer messages in samples/emails.json to the leads address,
 * the way real customers (or a website form's notification email) would. Each one has its own
 * display name and Reply-To, so every "customer" gets their own HubSpot contact.
 * Then run check-lead-inbox to process them. `only` picks samples by id.
 */
export const sendTestEmails = task({
  id: "send-test-emails",
  run: async (payload: { only?: string[] } = {}) => {
    const gmail = gmailSettings();
    const to = leadInboxAddress(gmail);
    const picked = samples.filter((s) => !payload.only || payload.only.some((id) => s.id.includes(id)));
    const sent = [];
    for (const sample of picked) {
      await sendInternalEmail(gmail, to, sample.subject, sample.body, { fromName: sample.fromName, replyTo: sample.replyTo });
      sent.push({ id: sample.id, expect: sample.expect });
    }
    logger.info("Test emails sent", { count: sent.length });
    return { to, sent };
  },
});
