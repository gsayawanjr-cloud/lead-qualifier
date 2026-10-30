import { logger, schemaTask } from "@trigger.dev/sdk";
import { writeUp, type FollowUp } from "./explain.js";
import { geocode } from "./geocode.js";
import { gmailSettings, saveDraft, sendAlert } from "./gmail.js";
import { HubSpot, HubSpotError, type Contact } from "./hubspot.js";
import { draftMessageId, fillFromContact, LeadSchema, normalizeLead, type Lead } from "./lead.js";
import { scoreLead, type GeoResult, type ScoreResult } from "./rules.js";
import { ownerEnvVar } from "./territories.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function chooseFollowUp(result: ScoreResult): FollowUp {
  if (result.safety) return "safety";
  if (result.tier === "Needs Review") return "none";
  if (result.tier === "Hot") return "hot_booking";
  if (result.tier === "Warm") return result.missing.some((m) => m !== "phone") ? "warm_ask_missing" : "hot_booking";
  return "cold_polite";
}

// Fixed text, never written by the model: the safety instructions must always be exactly these.
function safetyEmail(lead: Lead): { subject: string; body: string } {
  return {
    subject: "Please read this first: your safety",
    body: `${lead.firstName ? `Hi ${lead.firstName},` : "Hi there,"}

What you described could be dangerous, so before anything else:

If you smell gas, see smoke or sparks, or your carbon monoxide alarm is going off, get everyone out of the house now. Don't switch anything on or off on the way out. Once you're outside, call 911 or your gas company.

When everyone is safe, reply here or give us a call and we'll get a technician to you first.`,
  };
}

/** How a Hot lead books. A customer who already said when they're free is never asked for times again. */
function bookingLine(lead: Lead, availability: string, bookingUrl: string): string {
  if (availability) {
    return lead.phoneDigits
      ? `I'll call you at ${formatPhone(lead.phoneDigits)} shortly to set an arrival time.`
      : "I'll reply shortly with an arrival time.";
  }
  return bookingUrl ? `You can pick a time here: ${bookingUrl}` : "Reply with a couple of times that work for you and I'll lock one in.";
}

function signOff(repName: string | null, companyName: string): string {
  return repName ? `Thanks,\n${repName}\n${companyName}` : `Thanks,\nThe ${companyName} team`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
const formatPhone = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;

function noteHtml(lead: Lead, result: ScoreResult, geo: GeoResult, explanation: string, extra: { draft: string; responseSeconds: number; writtenBy: string }): string {
  const list = (items: string[]) => (items.length > 0 ? escapeHtml(items.join("; ")) : "none");
  const address =
    geo.status === "matched" ? `verified: ${escapeHtml(geo.matchedAddress)}${geo.county ? ` (${escapeHtml(geo.county)})` : ""}` : `not verified (${geo.status})`;
  return [
    `<p><strong>Lead score ${result.score}/100: ${result.tier}</strong> (points say ${result.band}, confidence ${result.confidence})</p>`,
    `<p>${escapeHtml(explanation)}</p>`,
    `<p><strong>Rules:</strong> ${escapeHtml(result.breakdown)}</p>`,
    `<ul>${result.fired.map((r) => `<li>${r.id} ${escapeHtml(r.label)}: ${r.points >= 0 ? "+" : ""}${r.points}</li>`).join("")}</ul>`,
    `<p><strong>Needs review because:</strong> ${list(result.reviewReasons)}<br><strong>Missing:</strong> ${list(result.missing)}<br><strong>Tags:</strong> ${list(result.tags)}<br><strong>Notes:</strong> ${list(result.notes)}</p>`,
    `<p><strong>Form:</strong> service ${escapeHtml(lead.service || "blank")}, timeline ${escapeHtml(lead.timeline || "blank")}, budget ${lead.budget === null ? "blank" : `$${lead.budget}`}, property ${escapeHtml(lead.propertyType || "blank")}, occupancy ${escapeHtml(lead.occupancy || "blank")}${lead.units !== null ? `, units ${lead.units}` : ""}<br><strong>Address:</strong> ${address}<br><strong>Territory:</strong> ${result.territory}</p>`,
    `<p><strong>Follow-up:</strong> ${escapeHtml(extra.draft)} | <strong>Response time:</strong> ${extra.responseSeconds}s | <strong>Written by:</strong> ${extra.writtenBy}</p>`,
    `<p><strong>Message:</strong><br>${escapeHtml(lead.message || "(empty)")}</p>`,
  ].join("");
}

/** Finds the lead's contact without the Search API (which lags): by lead_key, then by email. */
async function findContact(hubspot: HubSpot, lead: Lead): Promise<Contact | null> {
  if (!lead.leadKey) return null;
  return (await hubspot.getContact(lead.leadKey, "lead_key")) ?? (lead.emailValid ? await hubspot.getContact(lead.email, "email") : null);
}

/** Statuses the automation itself sets. Anything else was set by a rep and is left alone. */
const AUTO_LEAD_STATUSES = new Set(["", "NEW", "OPEN", "IN_PROGRESS"]);

export const qualifyLead = schemaTask({
  id: "qualify-lead",
  schema: LeadSchema,
  // One lead at a time, so two submissions from the same person can never create two contacts.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3 },
  onFailure: async ({ payload, error, ctx }) => {
    await sendAlert(
      `A lead could not be processed: ${payload.name || payload.email || payload.submissionId}`,
      `The lead qualifier failed after all retries, so this lead is NOT in HubSpot yet.\n\nLead: ${payload.name} <${payload.email}> ${payload.phone}\nSubmission: ${payload.submissionId}\nError: ${(error as Error)?.message ?? String(error)}\nRun: ${ctx.run.id}\n\nFix the problem, then replay the run from the Trigger.dev dashboard.`,
    );
  },
  run: async (payload) => {
    const hubspot = new HubSpot(requireEnv("HUBSPOT_ACCESS_TOKEN"));
    const managerOwner = requireEnv("HUBSPOT_OWNER_MANAGER");
    const pipelineId = requireEnv("HUBSPOT_PIPELINE_ID");
    const qualifiedStage = requireEnv("HUBSPOT_STAGE_QUALIFIED");
    const companyName = requireEnv("COMPANY_NAME");
    requireEnv("ANTHROPIC_API_KEY");
    const gmail = gmailSettings();
    const bookingUrl = process.env.BOOKING_URL ?? "";

    let lead = normalizeLead(payload);
    logger.info("Lead received", { submissionId: lead.submissionId, hasEmail: lead.emailValid, hasPhone: Boolean(lead.phoneDigits) });

    // 1. What HubSpot already knows (existing contact, its deals and open review tasks).
    let contact = await findContact(hubspot, lead);
    if (contact) {
      // A follow-up ("forgot to mention...") often leaves out the address and phone given the first time.
      const { payload: filledPayload, filled } = fillFromContact(payload, contact.properties);
      if (filled.length > 0) {
        lead = normalizeLead(filledPayload);
        logger.info("Filled blanks from the existing contact", { filled });
      }
    }
    const pipeline = await hubspot.getPipeline(pipelineId);
    const closedStages = new Set(pipeline.stages.filter((s) => s.metadata.isClosed === "true").map((s) => s.id));
    const wonStages = new Set(pipeline.stages.filter((s) => s.metadata.isClosed === "true" && Number(s.metadata.probability) >= 1).map((s) => s.id));
    const deals = contact ? await hubspot.batchRead("deals", contact.dealIds, ["dealstage", "pipeline", "dealname"]) : [];
    const isExistingCustomer = contact?.properties.lifecyclestage === "customer" || deals.some((d) => wonStages.has(d.properties.dealstage ?? ""));
    const openDeal = deals.find((d) => d.properties.pipeline === pipelineId && !closedStages.has(d.properties.dealstage ?? ""));

    // 2. Enrich, 3. score (pure rules), 4. route.
    const geo = await geocode(lead);
    const result = scoreLead({ lead, geo, isExistingCustomer });
    const needsReview = result.tier === "Needs Review";
    const ownerId = process.env[ownerEnvVar(result.territory, needsReview)] || managerOwner;
    logger.info("Scored", { score: result.score, tier: result.tier, breakdown: result.breakdown, territory: result.territory, reviewReasons: result.reviewReasons });

    // 5. Explanation + draft text (Claude, or the template if Claude is unavailable).
    const followUp = chooseFollowUp(result);
    const repName = followUp === "none" ? null : await hubspot.ownerFirstName(ownerId);
    const writeup = await writeUp(lead, result, followUp, companyName, repName);

    // 6. Gmail draft (never sent automatically).
    let draft = "No draft (needs review)";
    let draftFailed = false;
    if (followUp !== "none" && !lead.emailValid) draft = "No draft (no valid email; call instead)";
    else if (followUp !== "none" && lead.leadKey) {
      const written = followUp === "safety" ? safetyEmail(lead) : { subject: writeup.emailSubject, body: writeup.emailBody };
      // An emailed lead gets the draft as a reply in its thread; a website lead gets the written subject.
      const source = lead.sourceEmail;
      const subject = source && source.subject.trim() ? (/^re:/i.test(source.subject.trim()) ? source.subject.trim() : `Re: ${source.subject.trim()}`) : written.subject;
      const body = written.body;
      const booking = followUp === "hot_booking" ? `\n\n${bookingLine(lead, writeup.availability, bookingUrl)}` : "";
      try {
        const saved = await saveDraft(gmail, {
          to: lead.email,
          subject,
          text: `${body}${booking}\n\n${signOff(repName, companyName)}`,
          messageId: draftMessageId(lead.leadKey),
          inReplyTo: source?.messageId,
        });
        draft = `${saved.replaced ? "Draft replaced" : "Draft saved"} in Gmail (${followUp})`;
      } catch (error) {
        draftFailed = true;
        draft = `Draft FAILED: ${(error as Error).message}`;
        logger.error("Gmail draft failed", { message: (error as Error).message });
      }
    }
    const responseSeconds = Math.max(0, Math.round((Date.now() - Date.parse(lead.submittedAt)) / 1000));

    // 7. Create or update the contact (one per person).
    const leadStatus = needsReview ? "IN_PROGRESS" : result.tier === "Cold" ? "OPEN" : "NEW";
    const props: Record<string, string> = {
      lead_score: String(result.score),
      lead_tier: result.tier,
      lead_confidence: result.confidence,
      lead_flags: result.flags.join("; "),
      lead_missing_info: result.missing.join("; "),
      lead_territory: result.territory,
      lead_service: result.service,
      lead_received_at: new Date(lead.submittedAt).toISOString(),
      lead_response_seconds: String(responseSeconds),
    };
    // Contact details: only fill in what the form has, so a rep's edits are never wiped.
    if (lead.firstName) props.firstname = lead.firstName;
    if (lead.lastName) props.lastname = lead.lastName;
    if (lead.phoneDigits) props.phone = formatPhone(lead.phoneDigits);
    if (lead.address) props.address = lead.address;
    if (lead.city) props.city = lead.city;
    if (lead.state) props.state = lead.state;
    if (result.zip) props.zip = result.zip;

    let contactId: string | null = null;
    if (lead.leadKey) {
      if (!contact) {
        try {
          contactId = await hubspot.createContact({
            ...props,
            lead_key: lead.leadKey,
            ...(lead.emailValid ? { email: lead.email } : {}),
            hubspot_owner_id: ownerId,
            hs_lead_status: leadStatus,
            lifecyclestage: "lead",
          });
          logger.info("Contact created", { contactId });
        } catch (error) {
          // 409: HubSpot already has this email (created moments ago, or by hand). Update that contact instead.
          if (!(error instanceof HubSpotError && error.status === 409)) throw error;
          contact = await findContact(hubspot, lead);
          if (!contact) throw error;
        }
      }
      if (contact) {
        contactId = contact.id;
        const update = { ...props };
        if (!contact.properties.lead_key) update.lead_key = lead.leadKey;
        if (!contact.properties.email && lead.emailValid) update.email = lead.email;
        if (!contact.properties.hubspot_owner_id) update.hubspot_owner_id = ownerId;
        if (AUTO_LEAD_STATUSES.has(contact.properties.hs_lead_status ?? "")) update.hs_lead_status = leadStatus;
        await hubspot.updateContact(contact.id, update);
        logger.info("Contact updated (repeat submission)", { contactId });
      }
    }

    // 8. Note with the explanation and full rule breakdown.
    if (contactId) {
      await hubspot.addNote(
        contactId,
        noteHtml(lead, result, geo, writeup.explanation, {
          draft,
          responseSeconds,
          writtenBy: writeup.source === "claude" ? (process.env.LEAD_MODEL || "claude-haiku-5-5") : "template (Claude unavailable)",
        }),
        ownerId,
      );
    }

    // 9. Qualified leads get one open deal; repeats update it (the rep's stage is never changed).
    let deal = "none";
    if (contactId && (result.tier === "Hot" || result.tier === "Warm")) {
      const dealname = `${lead.name || "Lead"} – ${result.service} (${result.zip || "no ZIP"})`;
      if (openDeal) {
        await hubspot.updateDeal(openDeal.id, { dealname });
        deal = `updated ${openDeal.id}`;
      } else {
        const id = await hubspot.createDeal(contactId, { dealname, pipeline: pipelineId, dealstage: qualifiedStage, hubspot_owner_id: ownerId });
        deal = `created ${id}`;
      }
    }

    // 10. Needs Review (or a failed draft) becomes a task for the manager. One open review task per contact.
    let task = "none";
    const tasks = contact ? await hubspot.batchRead("tasks", contact.taskIds, ["hs_task_subject", "hs_task_status"]) : [];
    const openReview = tasks.find((t) => t.properties.hs_task_status !== "COMPLETED" && (t.properties.hs_task_subject ?? "").startsWith("Review lead:"));
    if (!needsReview && !draftFailed && openReview && /draft failed/i.test(openReview.properties.hs_task_subject ?? "")) {
      // An earlier run couldn't save the draft; this one did, so that to-do is done.
      await hubspot.updateTask(openReview.id, { hs_task_status: "COMPLETED" });
      task = `completed ${openReview.id} (draft now saved)`;
    }
    if (needsReview || draftFailed) {
      const reasons = [...(needsReview ? result.reviewReasons : []), ...(draftFailed ? ["Gmail draft failed, send the follow-up by hand"] : [])];
      const subject = `Review lead: ${reasons.join(", ")}`.slice(0, 250);
      const body = contactId
        ? `${writeup.explanation}\n\nScore ${result.breakdown}. Open the contact for the full note.`
        : `No email or phone, so no contact was created. Raw submission:\n${JSON.stringify(payload, null, 2)}`;
      const taskProps = {
        hs_task_subject: subject,
        hs_task_body: body,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: result.safety ? "HIGH" : "MEDIUM",
        hs_task_type: result.safety ? "CALL" : "TODO",
        // Due now for safety, otherwise within 4 hours.
        hs_timestamp: new Date(Date.now() + (result.safety ? 0 : 4 * 3600_000)).toISOString(),
        hubspot_owner_id: managerOwner,
      };
      if (openReview) {
        await hubspot.updateTask(openReview.id, taskProps);
        task = `updated ${openReview.id}`;
      } else {
        await hubspot.createTask(contactId, taskProps);
        task = "created";
      }
    }

    // 11. Alerts that can't wait for someone to open HubSpot.
    if (result.safety) {
      await sendAlert(
        `SAFETY lead: call ${lead.name || "the customer"} now`,
        `A lead mentions a possible safety risk (gas, CO, smoke, burning or sparks).\n\nName: ${lead.name}\nPhone: ${lead.phoneDigits ? formatPhone(lead.phoneDigits) : "none"}\nEmail: ${lead.email || "none"}\nAddress: ${[lead.address, lead.city, lead.zip5].filter(Boolean).join(", ")}\n\nMessage:\n${lead.message}\n\nA safety-instructions draft is in Gmail. Call them first.`,
      );
    }
    if (writeup.problem) {
      await sendAlert("Claude is unavailable (template explanations in use)", `Leads are still processed, with template explanations and drafts.\n\nProblem: ${writeup.problem}\n\nCheck ANTHROPIC_API_KEY and the credit balance at platform.claude.com.`);
    }

    const summary = {
      submissionId: lead.submissionId,
      contactId,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      territory: result.territory,
      ownerId,
      reviewReasons: result.reviewReasons,
      missing: result.missing,
      followUp,
      draft,
      deal,
      task,
      responseSeconds,
      writtenBy: writeup.source,
    };
    logger.info("Lead done", summary);
    return summary;
  },
});
