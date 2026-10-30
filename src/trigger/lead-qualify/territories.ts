/**
 * Summit Air HVAC's service area (Denver metro, real ZIP codes). Edit these lists to change territories.
 * Core ZIPs score 25 location points, fringe ZIPs 12 (a travel fee applies); anything else is out of area.
 */
export type Area = "North" | "South" | "West";
export type Territory = Area | "Commercial" | "Out of area";

const CORE: Record<Area, string[]> = {
  North: ["80020", "80023", "80030", "80031", "80205", "80211", "80212", "80216", "80221", "80229", "80233", "80234", "80241", "80260"],
  South: ["80110", "80111", "80112", "80120", "80121", "80122", "80123", "80124", "80126", "80129", "80130", "80209", "80210", "80222", "80224", "80246"],
  West: ["80002", "80003", "80004", "80005", "80033", "80204", "80214", "80215", "80219", "80226", "80227", "80228", "80232", "80401"],
};

const FRINGE: Record<Area, string[]> = {
  North: ["80026", "80027", "80301", "80302", "80303", "80304", "80305", "80601", "80602", "80603"],
  South: ["80013", "80015", "80016", "80104", "80108", "80109", "80134", "80138"],
  West: ["80007", "80403", "80439", "80465"],
};

function areaOf(zip: string, table: Record<Area, string[]>): Area | null {
  for (const area of Object.keys(table) as Area[]) {
    if (table[area].includes(zip)) return area;
  }
  return null;
}

export type ZipLookup = { zone: "core" | "fringe" | "outside"; area: Area | null };

export function lookupZip(zip: string): ZipLookup {
  const core = areaOf(zip, CORE);
  if (core) return { zone: "core", area: core };
  const fringe = areaOf(zip, FRINGE);
  if (fringe) return { zone: "fringe", area: fringe };
  return { zone: "outside", area: null };
}

/** Which env var holds the HubSpot owner for each territory. Needs Review always goes to the manager. */
export function ownerEnvVar(territory: Territory, needsReview: boolean): string {
  if (needsReview || territory === "Out of area") return "HUBSPOT_OWNER_MANAGER";
  if (territory === "North" || territory === "West") return "HUBSPOT_OWNER_REP_A";
  return "HUBSPOT_OWNER_REP_B"; // South + Commercial
}
