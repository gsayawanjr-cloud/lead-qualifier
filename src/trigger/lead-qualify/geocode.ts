import { logger } from "@trigger.dev/sdk";
import type { Lead } from "./lead.js";
import type { GeoResult } from "./rules.js";

// US Census Geocoder: free, no API key. Rate limits are not published, so keep calls to one per lead.
const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

type CensusResponse = {
  result?: {
    addressMatches?: {
      matchedAddress: string;
      addressComponents?: { zip?: string };
      geographies?: { Counties?: { NAME?: string }[] };
    }[];
  };
};

/**
 * Verifies the street address and returns the real ZIP and county. Never throws: when the
 * service is down the lead is still scored, just flagged "Unverified address".
 */
export async function geocode(lead: Lead): Promise<GeoResult> {
  if (!lead.address) return { status: "skipped" };
  const oneLine = [lead.address, lead.city, `${lead.state} ${lead.zip5}`.trim()].filter(Boolean).join(", ");
  const url = `${CENSUS_URL}?${new URLSearchParams({ address: oneLine, benchmark: "Public_AR_Current", vintage: "Current_Current", format: "json" })}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.status >= 500) throw new Error(`Census Geocoder ${response.status}`);
      if (!response.ok) {
        logger.warn("Census Geocoder rejected the request", { status: response.status });
        return { status: "unavailable" };
      }
      const data = (await response.json()) as CensusResponse;
      const match = data.result?.addressMatches?.[0];
      if (!match?.addressComponents?.zip) return { status: "no_match" };
      return {
        status: "matched",
        zip: match.addressComponents.zip,
        county: match.geographies?.Counties?.[0]?.NAME ?? null,
        matchedAddress: match.matchedAddress,
      };
    } catch (error) {
      logger.warn("Census Geocoder attempt failed", { attempt, message: (error as Error).message });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  return { status: "unavailable" };
}
