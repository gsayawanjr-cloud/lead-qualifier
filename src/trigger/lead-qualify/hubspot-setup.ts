import { logger, task } from "@trigger.dev/sdk";
import { HubSpot, LEAD_PROPERTIES } from "./hubspot.js";

const REQUIRED_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.owners.read",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
];

/**
 * One-time setup (run it by hand, safe to re-run): checks the token's scopes, creates the 10 lead
 * properties, and prints the owner, pipeline and stage IDs to copy into .env. Changes nothing else.
 */
export const hubspotSetup = task({
  id: "hubspot-setup",
  run: async () => {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN is not set");
    const hubspot = new HubSpot(token);

    // The scope lookup only works for legacy private-app tokens. For service keys it may fail; then a
    // missing scope shows up below as a clear "permission denied (403)" error instead.
    let scopesChecked = false;
    try {
      const scopes = await hubspot.tokenScopes();
      scopesChecked = true;
      const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      if (missingScopes.length > 0) {
        throw new Error(`The key is missing these scopes: ${missingScopes.join(", ")}. Add them in HubSpot (Development → Keys → your key → Edit), save, then run this again.`);
      }
    } catch (error) {
      if (scopesChecked) throw error;
      logger.info("Scope lookup not available for this key type; checking access by using it", { message: (error as Error).message });
    }

    const created = await hubspot.ensureLeadProperties();
    const owners = (await hubspot.listOwners()).map((o) => ({ id: o.id, name: [o.firstName, o.lastName].filter(Boolean).join(" "), email: o.email }));
    const pipelines = (await hubspot.getPipelines()).map((p) => ({
      id: p.id,
      label: p.label,
      stages: [...p.stages].sort((a, b) => a.displayOrder - b.displayOrder).map((s) => ({ id: s.id, label: s.label })),
    }));

    const first = owners[0]?.id ?? "";
    const main = pipelines[0];
    const stageId = (label: RegExp, fallback: string) => main?.stages.find((s) => label.test(s.label))?.id ?? fallback;
    const envLines = [
      `HUBSPOT_OWNER_REP_A=${owners[0]?.id ?? ""}`,
      `HUBSPOT_OWNER_REP_B=${owners[1]?.id ?? first}`,
      `HUBSPOT_OWNER_MANAGER=${first}`,
      `HUBSPOT_PIPELINE_ID=${main?.id ?? "default"}`,
      `HUBSPOT_STAGE_QUALIFIED=${stageId(/qualified/i, "qualifiedtobuy")}`,
      `HUBSPOT_STAGE_BOOKED=${stageId(/appointment/i, "appointmentscheduled")}`,
    ];

    const result = {
      scopesChecked,
      propertiesCreated: created,
      propertiesAlreadyThere: LEAD_PROPERTIES.map((p) => p.name).filter((n) => !created.includes(n)),
      owners,
      pipelines,
      suggestedEnv: envLines,
    };
    logger.info("HubSpot setup done. Copy suggestedEnv into .env (change the owner IDs if you want different reps).", result);
    return result;
  },
});
