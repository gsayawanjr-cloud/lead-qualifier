import { logger } from "@trigger.dev/sdk";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

export type GmailSettings = { user: string; appPassword: string };

export function gmailSettings(): GmailSettings {
  const user = process.env.LEAD_GMAIL_USER;
  if (!user) throw new Error("LEAD_GMAIL_USER is not set");
  const appPassword = process.env.LEAD_GMAIL_APP_PASSWORD;
  if (!appPassword) throw new Error("LEAD_GMAIL_APP_PASSWORD is not set");
  return { user, appPassword: appPassword.replace(/\s/g, "") };
}

/** Gmail labels the inbox check puts on an email once it's handled, so the next check skips it. */
export const PROCESSED_LABEL = "lead-processed";
export const NOT_A_LEAD_LABEL = "not-a-lead";

/** The address customers (and website forms) email leads to. Default: the Gmail's +leads alias. */
export function leadInboxAddress(settings: GmailSettings): string {
  const configured = process.env.LEAD_INBOX_ADDRESS?.trim();
  if (configured) return configured.toLowerCase();
  const [local, domain] = settings.user.toLowerCase().split("@");
  return `${local}+leads@${domain}`;
}

export type InboxEmail = {
  messageId: string;
  /** When the email arrived (ISO 8601). Response time is measured from here. */
  receivedAt: string;
  fromName: string;
  fromAddress: string;
  /** Reply-To, else From: where the customer wants the answer. */
  replyAddress: string;
  subject: string;
  text: string;
};

async function connect(settings: GmailSettings): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: settings.user, pass: settings.appPassword },
    logger: false,
  });
  try {
    await client.connect();
  } catch (error) {
    // imapflow's message is just "Command failed"; Gmail's reason is in responseText.
    const e = error as Error & { responseText?: string; serverResponseCode?: string };
    const reason = e.serverResponseCode === "AUTHENTICATIONFAILED" ? "Gmail rejected the login: check LEAD_GMAIL_USER and LEAD_GMAIL_APP_PASSWORD" : (e.responseText ?? e.message);
    throw new Error(reason);
  }
  return client;
}

/**
 * Lead emails not handled yet: in the inbox, sent to the leads address, without either label.
 * Only the leads address is read, so alerts, metrics emails and drafts are never mistaken for leads.
 */
export async function fetchLeadEmails(settings: GmailSettings, limit: number): Promise<InboxEmail[]> {
  const query = `in:inbox to:${leadInboxAddress(settings)} -label:${PROCESSED_LABEL} -label:${NOT_A_LEAD_LABEL} newer_than:7d`;
  const client = await connect(settings);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Oldest first, so a backlog is worked through in arrival order.
      const uids = ((await client.search({ gmraw: query }, { uid: true })) || []).slice(0, limit);
      if (uids.length === 0) return [];
      const emails: InboxEmail[] = [];
      for (const message of await client.fetchAll(uids, { source: true, internalDate: true }, { uid: true })) {
        if (!message.source) continue;
        const mail = await simpleParser(message.source);
        if (!mail.messageId) continue;
        const from = mail.from?.value[0];
        const replyTo = mail.replyTo?.value[0]?.address;
        const received = message.internalDate ? new Date(message.internalDate) : (mail.date ?? new Date());
        emails.push({
          messageId: mail.messageId,
          receivedAt: received.toISOString(),
          fromName: from?.name ?? "",
          fromAddress: (from?.address ?? "").toLowerCase(),
          replyAddress: (replyTo ?? from?.address ?? "").toLowerCase(),
          subject: mail.subject ?? "",
          text: (mail.text ?? "").trim(),
        });
      }
      return emails;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Puts a Gmail label on an inbox email (found by its Message-ID). */
export async function labelEmail(settings: GmailSettings, messageId: string, label: string): Promise<void> {
  const client = await connect(settings);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ gmraw: `rfc822msgid:${messageId.replace(/^<|>$/g, "")}` }, { uid: true })) || [];
      if (uids.length === 0) throw new Error(`Email ${messageId} not found in the inbox`);
      await client.messageFlagsAdd(uids, [label], { uid: true, useLabels: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * Saves a follow-up as a Gmail draft (never sends it). The draft has a fixed Message-ID per lead,
 * so a repeat submission replaces the earlier unsent draft instead of adding a second one.
 * Sent mail lives in Sent, not Drafts, so replacing never touches a message the rep already sent.
 */
export async function saveDraft(
  settings: GmailSettings,
  draft: { to: string; subject: string; text: string; messageId: string; inReplyTo?: string },
): Promise<{ replaced: boolean }> {
  const client = await connect(settings);
  try {
    const mailboxes = await client.list();
    const draftsPath = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";

    let replaced = false;
    const lock = await client.getMailboxLock(draftsPath);
    try {
      const existing = (await client.search({ gmraw: `rfc822msgid:${draft.messageId.replace(/^<|>$/g, "")}` }, { uid: true })) || [];
      if (existing.length > 0) {
        await client.messageDelete(existing, { uid: true });
        replaced = true;
      }
    } finally {
      lock.release();
    }

    const raw = await new MailComposer({
      from: settings.user,
      to: draft.to,
      subject: draft.subject,
      text: draft.text,
      messageId: draft.messageId,
      // Threads the draft under the customer's email (Gmail also needs the "Re:" subject to match).
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo, references: draft.inReplyTo } : {}),
    })
      .compile()
      .build();
    await client.append(draftsPath, raw, ["\\Draft", "\\Seen"]);
    return { replaced };
  } finally {
    await client.logout();
  }
}

/** Emails ALERT_EMAIL_TO. Never throws: an alert problem must not fail the lead. */
export async function sendAlert(subject: string, body: string): Promise<boolean> {
  const to = process.env.ALERT_EMAIL_TO;
  if (!to) {
    logger.warn("Alert not sent: ALERT_EMAIL_TO is not set", { subject });
    return false;
  }
  try {
    await sendInternalEmail(gmailSettings(), to, `[Lead alert] ${subject}`, body);
    return true;
  } catch (error) {
    logger.error("Could not send alert", { subject, message: (error as Error).message });
    return false;
  }
}

/** Sends an internal email (alerts, the weekly metrics, test leads). Never used for customers. */
export async function sendInternalEmail(
  settings: GmailSettings,
  to: string,
  subject: string,
  text: string,
  options: { fromName?: string; replyTo?: string } = {},
): Promise<void> {
  await nodemailer
    .createTransport({ service: "gmail", auth: { user: settings.user, pass: settings.appPassword } })
    .sendMail({ from: options.fromName ? { name: options.fromName, address: settings.user } : settings.user, replyTo: options.replyTo, to, subject, text });
}
