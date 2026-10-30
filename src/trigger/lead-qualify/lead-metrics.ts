import { logger, schedules } from "@trigger.dev/sdk";
import { gmailSettings, sendInternalEmail } from "./gmail.js";
import { HubSpot } from "./hubspot.js";

const DAY_MS = 24 * 3600_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);

/**
 * Weekly, read-only report: response time and the share of qualified leads that booked.
 * "Booked" = the deal is in the booked stage, or any later stage except Closed lost.
 */
export const leadMetrics = schedules.task({
  id: "lead-metrics",
  cron: { pattern: "0 8 * * 1", timezone: "Asia/Manila" }, // Mondays 8am
  run: async (payload) => {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
    const pipelineId = process.env.HUBSPOT_PIPELINE_ID;
    if (!pipelineId) throw new Error("HUBSPOT_PIPELINE_ID is not set");
    const qualifiedStage = process.env.HUBSPOT_STAGE_QUALIFIED;
    if (!qualifiedStage) throw new Error("HUBSPOT_STAGE_QUALIFIED is not set");
    const bookedStage = process.env.HUBSPOT_STAGE_BOOKED;
    if (!bookedStage) throw new Error("HUBSPOT_STAGE_BOOKED is not set");
    const to = process.env.ALERT_EMAIL_TO;
    if (!to) throw new Error("ALERT_EMAIL_TO is not set");

    const hubspot = new HubSpot(token);
    const since = new Date(payload.timestamp.getTime() - 7 * DAY_MS);

    const contacts = await hubspot.searchAll(
      "contacts",
      [{ propertyName: "lead_received_at", operator: "GTE", value: String(since.getTime()) }],
      ["lead_tier", "lead_response_seconds"],
    );
    const byTier: Record<string, number> = { Hot: 0, Warm: 0, Cold: 0, "Needs Review": 0 };
    for (const c of contacts) byTier[c.properties.lead_tier ?? ""] = (byTier[c.properties.lead_tier ?? ""] ?? 0) + 1;
    const responseTimes = contacts.map((c) => Number(c.properties.lead_response_seconds)).filter((n) => Number.isFinite(n));

    const pipeline = await hubspot.getPipeline(pipelineId);
    const order = new Map(pipeline.stages.map((s) => [s.id, s.displayOrder]));
    const lost = new Set(pipeline.stages.filter((s) => s.metadata.isClosed === "true" && Number(s.metadata.probability) === 0).map((s) => s.id));
    const qualifiedOrder = order.get(qualifiedStage) ?? 0;
    const deals = await hubspot.searchAll(
      "deals",
      [
        { propertyName: "pipeline", operator: "EQ", value: pipelineId },
        { propertyName: "createdate", operator: "GTE", value: String(since.getTime()) },
      ],
      ["dealstage"],
    );
    const booked = deals.filter((d) => {
      const stage = d.properties.dealstage ?? "";
      return stage === bookedStage || (!lost.has(stage) && (order.get(stage) ?? -1) > qualifiedOrder);
    }).length;

    const med = median(responseTimes);
    const report = {
      period: `${since.toISOString().slice(0, 10)} to ${payload.timestamp.toISOString().slice(0, 10)}`,
      leads: contacts.length,
      byTier,
      medianResponseSeconds: med,
      qualifiedDeals: deals.length,
      booked,
      bookingRate: pct(booked, deals.length),
    };
    logger.info("Lead metrics", report);

    await sendInternalEmail(
      gmailSettings(),
      to,
      `Lead report: ${report.leads} leads, ${report.bookingRate} of qualified booked`,
      `Lead report for ${report.period}

Leads received: ${report.leads}
  Hot ${byTier.Hot} | Warm ${byTier.Warm} | Cold ${byTier.Cold} | Needs Review ${byTier["Needs Review"]}
Median response time (form → follow-up draft ready): ${med === null ? "n/a" : `${med} seconds`}

Qualified leads (deals created): ${report.qualifiedDeals}
Booked (Appointment scheduled or later): ${booked}
Booking rate: ${report.bookingRate}

Reps: move a deal to "Appointment scheduled" when the customer books, or this number stays at 0.`,
    );
    return report;
  },
});
