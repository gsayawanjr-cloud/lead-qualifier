import { createHash } from "node:crypto";
import { z } from "zod";

/** One web-form submission. Everything except the ids and name is optional: missing info is scored, not rejected. */
export const LeadSchema = z.object({
  /** Unique per form submission. Used as the Trigger.dev idempotency key, so a double-click runs once. */
  submissionId: z.string().min(1),
  /** When the form was submitted (ISO 8601). Response time is measured from here. */
  submittedAt: z.string().datetime({ offset: true }),
  name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  address: z.string().default(""),
  city: z.string().default(""),
  state: z.string().default("CO"),
  zip: z.string().default(""),
  service: z
    .enum(["emergency_repair", "replacement", "repair", "maintenance", "commercial", "iaq", "water_heater", "duct_cleaning", "thermostat", "other", ""])
    .default(""),
  timeline: z.enum(["today", "this_week", "this_month", "researching", ""]).default(""),
  /** Budget in USD, if the form asked for one. */
  budget: z.number().nonnegative().nullable().default(null),
  propertyType: z.enum(["home", "multi_unit", "commercial", ""]).default(""),
  occupancy: z.enum(["owner", "renter", "landlord", ""]).default(""),
  /** Commercial only: number of units / rooftop units. */
  units: z.number().int().nonnegative().nullable().default(null),
  message: z.string().default(""),
  /** Set when the lead came in by email: the follow-up draft is saved as a reply to it. Websites leave it out. */
  sourceEmail: z.object({ messageId: z.string().min(1), subject: z.string() }).optional(),
});

/** Fills blanks in a repeat submission from what HubSpot already has, so a short follow-up isn't scored as a stranger. */
export function fillFromContact(payload: LeadPayload, known: Record<string, string | null>): { payload: LeadPayload; filled: string[] } {
  const filled: string[] = [];
  const pick = (field: "phone" | "address" | "city" | "zip", value: string | null | undefined): string => {
    if (payload[field].trim() || !value) return payload[field];
    filled.push(field);
    return value;
  };
  const name = payload.name.trim().includes(" ") || !known.lastname ? payload.name : `${known.firstname ?? ""} ${known.lastname}`.trim();
  if (name !== payload.name) filled.push("name");
  return {
    payload: {
      ...payload,
      name,
      phone: pick("phone", known.phone),
      address: pick("address", known.address),
      city: pick("city", known.city),
      zip: pick("zip", known.zip),
    },
    filled,
  };
}

export type LeadPayload = z.infer<typeof LeadSchema>;

export type Lead = LeadPayload & {
  firstName: string;
  lastName: string;
  emailValid: boolean;
  /** 10 digits, or "" when the phone number isn't a valid US number. */
  phoneDigits: string;
  zip5: string;
  /** `e:<email>` or `p:<phone>`; null when there is no way to contact the lead. */
  leadKey: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function normalizeLead(payload: LeadPayload): Lead {
  const name = payload.name.trim().replace(/\s+/g, " ");
  const [firstName, ...rest] = name.split(" ");
  const email = payload.email.trim().toLowerCase();
  const emailValid = EMAIL_RE.test(email);

  let digits = payload.phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  const phoneDigits = digits.length === 10 ? digits : "";

  const leadKey = emailValid ? `e:${email}` : phoneDigits ? `p:${phoneDigits}` : null;

  return {
    ...payload,
    name,
    email,
    address: payload.address.trim(),
    city: payload.city.trim(),
    message: payload.message.trim(),
    firstName: firstName ?? "",
    lastName: rest.join(" "),
    emailValid,
    phoneDigits,
    zip5: (payload.zip.match(/\d{5}/) ?? [""])[0],
    leadKey,
  };
}

/** Stable id for the Gmail draft of a lead, so a repeat submission replaces the old draft. */
export function draftMessageId(leadKey: string): string {
  return `<lead-${createHash("sha256").update(leadKey).digest("hex").slice(0, 24)}@lead-qualifier>`;
}
