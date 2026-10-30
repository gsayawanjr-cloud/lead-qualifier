import type { Lead } from "./lead.js";
import { lookupZip, type Territory } from "./territories.js";

/**
 * Every scoring rule, in one readable table. The score is the sum of the rules that fire:
 * Service (max 30) + Location (max 25) + Urgency (max 25) + Budget (max 20) + modifiers, clamped to 0–100.
 * Change points here; the logic in scoreLead() below decides only WHICH rules fire.
 */
export const RULES = {
  // Service type
  S1: { label: "Emergency repair (no heat / no cooling)", points: 30 },
  S2: { label: "System replacement / new install", points: 30 },
  S3: { label: "Light commercial service / rooftop unit", points: 25 },
  S4: { label: "Non-emergency repair", points: 22 },
  S5: { label: "Maintenance / tune-up / service plan", points: 15 },
  S6: { label: "Indoor air quality, humidifier or water heater", points: 12 },
  S7: { label: "Duct cleaning or thermostat-only install", points: 8 },
  S8: { label: "Service we don't offer", points: 0 },
  S9: { label: "Service blank or unclear", points: 0 },
  // Location
  L1: { label: "ZIP in a core territory", points: 25 },
  L2: { label: "ZIP in the fringe zone (travel fee)", points: 12 },
  L3: { label: "Outside service area", points: 0 },
  L4: { label: "Address could not be verified (ZIP only)", points: 10 },
  L6: { label: "No address and no ZIP", points: 0 },
  // Urgency (the highest one counts, then U8 adds; capped at 25)
  U1: { label: "Safety risk (gas, CO, smoke, burning, sparks)", points: 25 },
  U2: { label: "No heat", points: 25 },
  U3: { label: "No cooling", points: 22 },
  U4: { label: "Needed today / ASAP", points: 20 },
  U5: { label: "Needed this week", points: 15 },
  U6: { label: "Needed this month", points: 10 },
  U7: { label: "Just researching / no rush", points: 3 },
  U8: { label: "Vulnerable occupant (elderly, infant, medical)", points: 5 },
  U9: { label: "No timeline given", points: 5 },
  // Budget
  B1: { label: "Budget $8,000 or more", points: 20 },
  B2: { label: "Budget $4,000–7,999", points: 14 },
  B3: { label: "Budget under $4,000 (below typical replacement cost)", points: 6 },
  B4: { label: "Replacement with no budget given", points: 8 },
  B5: { label: "Repair / maintenance (budget not needed)", points: 12 },
  B6: { label: "Commercial with no budget given", points: 18 },
  // Modifiers
  M1: { label: "Renter (needs landlord approval)", points: -10 },
  M2: { label: "Landlord / property manager", points: 5 },
  M3: { label: "Commercial with 5+ units", points: 5 },
  M4: { label: "Existing customer", points: 5 },
  M5: { label: "Disposable email address", points: -10 },
} as const;

export type RuleId = keyof typeof RULES;

export const HOT_MIN = 70;
export const WARM_MIN = 45;

export type Tier = "Hot" | "Warm" | "Cold" | "Needs Review";
export type ServiceCategory = "Emergency" | "Replacement" | "Repair" | "Maintenance" | "Commercial" | "IAQ" | "Other";

export type GeoResult =
  | { status: "matched"; zip: string; county: string | null; matchedAddress: string }
  | { status: "no_match" | "unavailable" | "skipped" };

export type ScoreInput = { lead: Lead; geo: GeoResult; isExistingCustomer: boolean };

export type FiredRule = { id: RuleId; label: string; points: number };

export type ScoreResult = {
  score: number;
  /** What the points alone say, even when the lead goes to review. */
  band: "Hot" | "Warm" | "Cold";
  tier: Tier;
  confidence: "High" | "Low";
  fired: FiredRule[];
  /** Problems that send the lead to a human (shown in lead_flags). */
  flags: string[];
  /** Why confidence is low / why it needs review (flags plus other reasons). */
  reviewReasons: string[];
  missing: string[];
  tags: string[];
  notes: string[];
  safety: boolean;
  service: ServiceCategory;
  territory: Territory;
  /** ZIP used for routing (the verified one when the geocoder matched). */
  zip: string;
  /** e.g. "S2+30 L1+25 U5+15 B4+8 = 78" */
  breakdown: string;
};

// --- Keyword lists (all case-insensitive) ---
const SAFETY_RE = /gas (smell|leak)|smell(s|ing)? (of |like )?gas|carbon monoxide|\bco (alarm|detector)|\bsmoke\b|smoking|burning smell|smells? (like )?burning|\bsparks?\b|sparking/i;
const NO_HEAT_RE = /no heat|furnace (is )?(not working|out|died|dead|stopped|quit|won'?t (start|turn on|come on))|heat(er|ing)? (is )?(not working|out|stopped)|house is (freezing|cold)/i;
const NO_AC_RE = /no (ac|a\/c|air conditioning|cooling)\b|(ac|a\/c|air conditioner|air conditioning) (is )?(not working|out|died|dead|stopped|blowing warm)|not cooling/i;
const VULNERABLE_RE = /elderly|senior|grandm|grandp|infant|\bbaby\b|newborn|medical|oxygen|disabled|pregnan/i;
const RESEARCH_RE = /just (looking|researching|curious|getting (prices|quotes|estimates))|next year|no rush|price (check|comparison)/i;
const FINANCING_RE = /financ|payment plan|monthly payments?/i;
const OUT_OF_SCOPE_RE = /plumb|toilet|\bdrain|sewer|pipe (leak|burst)|electrician|electrical|wiring|\boutlet|solar|appliance|refrigerator|fridge|washer|dryer|dishwasher|roofing/i;
const HVAC_RE = /furnace|\bac\b|a\/c|air condition|heat pump|boiler|thermostat|duct|hvac|heating|cooling|rooftop unit|\brtu\b|humidifier|air quality|water heater|mini.?split/i;
const SPAM_RE = /https?:\/\/|www\.|\bseo\b|backlink|guest post|crypto|bitcoin|partnership|rank (your|on) google|web design services|marketing services|lead generation services/i;
const JOB_RE = /\bresume\b|\bcv\b|are you hiring|job (opening|application)|apply for (a|the) (job|position)|looking for (a )?(job|work)|employment/i;
const GARBAGE_NAME_RE = /^(test|testing|asdf\w*|qwerty|x+|a+|abc|n\/?a|none|fake|null)$/i;
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
  "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "throwawaymail.com", "maildrop.cc",
]);

type ServicePick = { rule: RuleId; category: ServiceCategory; guessed: boolean };

/** Picks the service rule from the form field, or guesses it from the message when the field is blank/"other". */
function pickService(lead: Lead, urgentText: { noHeat: boolean; noAc: boolean }): ServicePick {
  const text = lead.message;
  const commercial = lead.propertyType === "commercial";
  const fromForm: Partial<Record<Lead["service"], ServicePick>> = {
    emergency_repair: { rule: "S1", category: "Emergency", guessed: false },
    replacement: { rule: "S2", category: "Replacement", guessed: false },
    commercial: { rule: "S3", category: "Commercial", guessed: false },
    repair: { rule: "S4", category: "Repair", guessed: false },
    maintenance: { rule: "S5", category: "Maintenance", guessed: false },
    iaq: { rule: "S6", category: "IAQ", guessed: false },
    water_heater: { rule: "S6", category: "IAQ", guessed: false },
    duct_cleaning: { rule: "S7", category: "Other", guessed: false },
    thermostat: { rule: "S7", category: "Other", guessed: false },
  };

  let pick = fromForm[lead.service];
  if (!pick) {
    // Blank or "other": guess from the message. A guess always lowers confidence.
    if (OUT_OF_SCOPE_RE.test(text) && !HVAC_RE.test(text)) return { rule: "S8", category: "Other", guessed: false };
    if (urgentText.noHeat || urgentText.noAc) pick = { rule: "S1", category: "Emergency", guessed: true };
    else if (/replace|new (system|furnace|ac|unit)|install/i.test(text)) pick = { rule: "S2", category: "Replacement", guessed: true };
    else if (/tune.?up|maintenance|service plan|check.?up/i.test(text)) pick = { rule: "S5", category: "Maintenance", guessed: true };
    else if (/repair|broken|not working|noise|leak/i.test(text) && HVAC_RE.test(text)) pick = { rule: "S4", category: "Repair", guessed: true };
    else if (commercial && HVAC_RE.test(text)) pick = { rule: "S3", category: "Commercial", guessed: true };
    else return { rule: "S9", category: "Other", guessed: false };
  }
  // Commercial properties use the commercial rule, except emergencies and replacements (they already score higher).
  if (commercial && !["S1", "S2", "S3"].includes(pick.rule)) return { rule: "S3", category: "Commercial", guessed: pick.guessed };
  return pick;
}

export function scoreLead({ lead, geo, isExistingCustomer }: ScoreInput): ScoreResult {
  const fired: FiredRule[] = [];
  const flags: string[] = [];
  const reviewReasons: string[] = [];
  const missing: string[] = [];
  const tags: string[] = [];
  const notes: string[] = [];
  const fire = (id: RuleId, points: number = RULES[id].points) => fired.push({ id, label: RULES[id].label, points });

  const text = lead.message;
  const safety = SAFETY_RE.test(text);
  const noHeat = NO_HEAT_RE.test(text);
  const noAc = NO_AC_RE.test(text);

  // --- Service ---
  const service = pickService(lead, { noHeat, noAc });
  fire(service.rule);
  if (service.rule === "S8") flags.push("Out of scope");
  if (service.rule === "S9") missing.push("service type");
  if (service.guessed) reviewReasons.push("Service guessed from the message");

  // --- Location ---
  const verifiedZip = geo.status === "matched" ? geo.zip : "";
  const zip = verifiedZip || lead.zip5;
  let territory: Territory = "Out of area";
  if (!lead.address && !zip) {
    fire("L6");
    missing.push("address");
  } else {
    const where = lookupZip(zip);
    if (where.zone === "outside") {
      fire("L3");
      flags.push("Out of area");
    } else if (geo.status !== "matched") {
      // L4: couldn't confirm the address, so trust the typed ZIP for less.
      fire("L4");
      flags.push("Unverified address");
      if (!lead.address) missing.push("address");
      territory = where.area!;
    } else {
      fire(where.zone === "core" ? "L1" : "L2");
      territory = where.area!;
    }
    if (verifiedZip && lead.zip5 && verifiedZip !== lead.zip5) notes.push(`Verified ZIP ${verifiedZip} used instead of typed ${lead.zip5} (L5)`);
  }
  if (lead.propertyType === "commercial" && territory !== "Out of area") territory = "Commercial";

  // --- Urgency: the strongest signal counts, then the vulnerable-occupant bonus, capped at 25 ---
  const timelineRule: Partial<Record<Lead["timeline"], RuleId>> = { today: "U4", this_week: "U5", this_month: "U6", researching: "U7" };
  const candidates: RuleId[] = [];
  if (safety) candidates.push("U1");
  if (noHeat) candidates.push("U2");
  if (noAc) candidates.push("U3");
  const fromTimeline = timelineRule[lead.timeline] ?? (RESEARCH_RE.test(text) ? "U7" : undefined);
  if (fromTimeline) candidates.push(fromTimeline);
  let urgency = 0;
  if (candidates.length > 0) {
    const strongest = candidates.reduce((a, b) => (RULES[b].points > RULES[a].points ? b : a));
    fire(strongest);
    urgency = RULES[strongest].points;
  } else {
    fire("U9");
    urgency = RULES.U9.points;
    missing.push("timeline");
  }
  if (VULNERABLE_RE.test(text)) {
    const bonus = Math.min(RULES.U8.points, 25 - urgency);
    fire("U8", bonus);
  }
  if (safety) flags.push("SAFETY");
  if ((service.rule === "S1" || noHeat || noAc) && fromTimeline === "U7") reviewReasons.push("Says emergency but timeline is no rush (conflict)");

  // --- Budget ---
  const budget = lead.budget;
  const commercial = service.category === "Commercial";
  if (service.rule === "S2" || (commercial && budget !== null)) {
    if (budget === null) {
      fire("B4");
      missing.push("budget");
    } else if (budget >= 8000) fire("B1");
    else if (budget >= 4000) fire("B2");
    else {
      fire("B3");
      notes.push("Budget is below typical replacement cost");
    }
  } else if (commercial) {
    fire("B6");
  } else if (!["S8", "S9"].includes(service.rule)) {
    fire("B5");
  }
  if (FINANCING_RE.test(text)) tags.push("Financing");

  // --- Modifiers ---
  if (lead.occupancy === "renter") {
    fire("M1");
    missing.push("landlord approval");
  }
  if (lead.occupancy === "landlord" || lead.propertyType === "multi_unit") fire("M2");
  if (commercial && (lead.units ?? 0) >= 5) fire("M3");
  if (isExistingCustomer) fire("M4");
  const domain = lead.email.split("@")[1] ?? "";
  if (lead.emailValid && DISPOSABLE_DOMAINS.has(domain)) {
    fire("M5");
    flags.push("Disposable email");
  }

  // --- Junk / unusual (J1–J6): never discarded, always a human ---
  if (!lead.emailValid && !lead.phoneDigits) flags.push("Unreachable");
  if (SPAM_RE.test(text)) flags.push("Possible spam");
  if (JOB_RE.test(text)) flags.push("Not a lead");
  if (lead.name.length < 2 || !/[a-z]/i.test(lead.name) || GARBAGE_NAME_RE.test(lead.name)) flags.push("Suspicious name");
  const letters = text.replace(/[^a-z]/gi, "");
  if (text.length > 2000 || (letters.length >= 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8)) flags.push("Unusual message");
  if (!lead.phoneDigits) missing.push("phone");
  if (!lead.emailValid && lead.phoneDigits) missing.push("email");

  // --- Score, confidence, tier ---
  const raw = fired.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  const band = score >= HOT_MIN ? "Hot" : score >= WARM_MIN ? "Warm" : "Cold";

  const keyMissing = missing.filter((m) => ["service type", "address", "timeline", "budget"].includes(m));
  if (keyMissing.length >= 2) reviewReasons.push(`Missing ${keyMissing.join(" and ")}`);
  reviewReasons.unshift(...flags);
  const confidence = reviewReasons.length > 0 ? "Low" : "High";
  const tier: Tier = confidence === "Low" ? "Needs Review" : band;

  const breakdown = `${fired.map((r) => `${r.id}${r.points >= 0 ? "+" : ""}${r.points}`).join(" ")} = ${score}`;

  return {
    score,
    band,
    tier,
    confidence,
    fired,
    flags,
    reviewReasons,
    missing: [...new Set(missing)],
    tags,
    notes,
    safety,
    service: service.category,
    territory,
    zip,
    breakdown,
  };
}
