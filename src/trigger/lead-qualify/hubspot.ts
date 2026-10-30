import { logger } from "@trigger.dev/sdk";

const BASE = "https://api.hubapi.com";

// HubSpot-defined association type ids (v4 "HUBSPOT_DEFINED" category).
const NOTE_TO_CONTACT = 202;
const TASK_TO_CONTACT = 204;
const DEAL_TO_CONTACT = 3;

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Contact = { id: string; properties: Record<string, string | null>; dealIds: string[]; taskIds: string[] };
export type CrmObject = { id: string; properties: Record<string, string | null> };
export type Stage = { id: string; label: string; displayOrder: number; metadata: { isClosed?: string; probability?: string } };
export type Pipeline = { id: string; label: string; stages: Stage[] };

/** The 10 custom contact properties. Free HubSpot allows only about 10, so the rest lives in a Note. */
export const LEAD_PROPERTY_GROUP = { name: "lead_qualification", label: "Lead qualification" };
export const LEAD_PROPERTIES = [
  { name: "lead_key", label: "Lead key", type: "string", fieldType: "text", hasUniqueValue: true, description: "e:<email> or p:<phone>. Used to prevent duplicates." },
  { name: "lead_score", label: "Lead score", type: "number", fieldType: "number" },
  { name: "lead_tier", label: "Lead tier", type: "enumeration", fieldType: "select", options: ["Hot", "Warm", "Cold", "Needs Review"] },
  { name: "lead_confidence", label: "Lead confidence", type: "enumeration", fieldType: "select", options: ["High", "Low"] },
  { name: "lead_flags", label: "Lead flags", type: "string", fieldType: "text" },
  { name: "lead_missing_info", label: "Lead missing info", type: "string", fieldType: "text" },
  { name: "lead_territory", label: "Lead territory", type: "enumeration", fieldType: "select", options: ["North", "South", "West", "Commercial", "Out of area"] },
  { name: "lead_service", label: "Lead service", type: "enumeration", fieldType: "select", options: ["Emergency", "Replacement", "Repair", "Maintenance", "Commercial", "IAQ", "Other"] },
  { name: "lead_received_at", label: "Lead received at", type: "datetime", fieldType: "date" },
  { name: "lead_response_seconds", label: "Lead response (seconds)", type: "number", fieldType: "number", description: "Seconds from form submission to follow-up draft ready." },
] as const;

export const CONTACT_READ_PROPERTIES = [
  "email", "firstname", "lastname", "phone", "address", "city", "zip",
  "lead_key", "hs_lead_status", "lifecyclestage", "hubspot_owner_id",
];

/** Minimal HubSpot CRM v3 client: private-app token, retries on 429 (Retry-After) and 5xx. */
export class HubSpot {
  constructor(private token: string) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 4) {
        const wait = Number(response.headers.get("retry-after")) * 1000 || attempt * 2000;
        logger.warn("HubSpot busy, retrying", { status: response.status, attempt, waitMs: wait });
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // Not JSON; keep the raw text.
      }
      if (response.status === 401) message = `HubSpot auth failed (401): check HUBSPOT_ACCESS_TOKEN. ${message}`;
      if (response.status === 403) message = `HubSpot permission denied (403): the private app is missing a scope. ${message}`;
      throw new HubSpotError(`HubSpot API ${response.status} ${method} ${path.split("?")[0]}: ${message}`, response.status);
    }
  }

  /** Direct read by a unique property (no Search API, so it sees contacts created seconds ago). */
  async getContact(value: string, idProperty: "lead_key" | "email"): Promise<Contact | null> {
    const query = new URLSearchParams({ idProperty, properties: CONTACT_READ_PROPERTIES.join(","), associations: "deals,tasks" });
    try {
      const raw = await this.request<{
        id: string;
        properties: Record<string, string | null>;
        associations?: { deals?: { results: { id: string }[] }; tasks?: { results: { id: string }[] } };
      }>("GET", `/crm/v3/objects/contacts/${encodeURIComponent(value)}?${query}`);
      return {
        id: raw.id,
        properties: raw.properties,
        dealIds: [...new Set(raw.associations?.deals?.results.map((d) => d.id) ?? [])],
        taskIds: [...new Set(raw.associations?.tasks?.results.map((t) => t.id) ?? [])],
      };
    } catch (error) {
      if (error instanceof HubSpotError && error.status === 404) return null;
      throw error;
    }
  }

  async createContact(properties: Record<string, string>): Promise<string> {
    const created = await this.request<{ id: string }>("POST", "/crm/v3/objects/contacts", { properties });
    return created.id;
  }

  async updateContact(id: string, properties: Record<string, string>): Promise<void> {
    await this.request("PATCH", `/crm/v3/objects/contacts/${id}`, { properties });
  }

  async batchRead(objectType: "deals" | "tasks", ids: string[], properties: string[]): Promise<CrmObject[]> {
    if (ids.length === 0) return [];
    const result = await this.request<{ results: CrmObject[] }>("POST", `/crm/v3/objects/${objectType}/batch/read`, {
      inputs: ids.map((id) => ({ id })),
      properties,
    });
    return result.results;
  }

  async addNote(contactId: string, html: string, ownerId: string): Promise<void> {
    await this.request("POST", "/crm/v3/objects/notes", {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html, hubspot_owner_id: ownerId },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
    });
  }

  async createTask(contactId: string | null, properties: Record<string, string>): Promise<void> {
    await this.request("POST", "/crm/v3/objects/tasks", {
      properties,
      associations: contactId
        ? [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: TASK_TO_CONTACT }] }]
        : [],
    });
  }

  async updateTask(id: string, properties: Record<string, string>): Promise<void> {
    await this.request("PATCH", `/crm/v3/objects/tasks/${id}`, { properties });
  }

  async createDeal(contactId: string, properties: Record<string, string>): Promise<string> {
    const created = await this.request<{ id: string }>("POST", "/crm/v3/objects/deals", {
      properties,
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_CONTACT }] }],
    });
    return created.id;
  }

  async updateDeal(id: string, properties: Record<string, string>): Promise<void> {
    await this.request("PATCH", `/crm/v3/objects/deals/${id}`, { properties });
  }

  async getPipelines(): Promise<Pipeline[]> {
    return (await this.request<{ results: Pipeline[] }>("GET", "/crm/v3/pipelines/deals")).results;
  }

  async getPipeline(id: string): Promise<Pipeline> {
    return this.request<Pipeline>("GET", `/crm/v3/pipelines/deals/${encodeURIComponent(id)}`);
  }

  async listOwners(): Promise<{ id: string; email: string; firstName?: string; lastName?: string }[]> {
    return (await this.request<{ results: { id: string; email: string; firstName?: string; lastName?: string }[] }>("GET", "/crm/v3/owners?limit=100")).results;
  }

  /** The owner's first name for signing emails, or null when HubSpot has none (or the lookup fails). */
  async ownerFirstName(id: string): Promise<string | null> {
    try {
      const owner = await this.request<{ firstName?: string }>("GET", `/crm/v3/owners/${encodeURIComponent(id)}`);
      return owner.firstName?.trim() || null;
    } catch (error) {
      logger.warn("Owner name lookup failed; signing as the team", { message: (error as Error).message });
      return null;
    }
  }

  /** Search API (5 requests/second, results can lag a few seconds). Only used for reports. */
  async searchAll(objectType: "contacts" | "deals", filters: { propertyName: string; operator: string; value: string }[], properties: string[]): Promise<CrmObject[]> {
    const all: CrmObject[] = [];
    let after: string | undefined;
    do {
      const page = await this.request<{ results: CrmObject[]; paging?: { next?: { after: string } } }>("POST", `/crm/v3/objects/${objectType}/search`, {
        filterGroups: [{ filters }],
        properties,
        limit: 100,
        after,
      });
      all.push(...page.results);
      after = page.paging?.next?.after;
      if (after) await new Promise((resolve) => setTimeout(resolve, 250));
    } while (after);
    return all;
  }

  async tokenScopes(): Promise<string[]> {
    const info = await this.request<{ scopes?: string[] }>("POST", "/oauth/v2/private-apps/get/access-token-info", { tokenKey: this.token });
    return info.scopes ?? [];
  }

  /** Creates the property group and any of the 10 lead properties that don't exist yet. Returns the names created. */
  async ensureLeadProperties(): Promise<string[]> {
    try {
      await this.request("POST", "/crm/v3/properties/contacts/groups", { ...LEAD_PROPERTY_GROUP, displayOrder: -1 });
    } catch (error) {
      if (!(error instanceof HubSpotError && error.status === 409)) throw error;
    }
    const created: string[] = [];
    for (const prop of LEAD_PROPERTIES) {
      try {
        await this.request("GET", `/crm/v3/properties/contacts/${prop.name}`);
        continue;
      } catch (error) {
        if (!(error instanceof HubSpotError && error.status === 404)) throw error;
      }
      await this.request("POST", "/crm/v3/properties/contacts", {
        name: prop.name,
        label: prop.label,
        type: prop.type,
        fieldType: prop.fieldType,
        groupName: LEAD_PROPERTY_GROUP.name,
        description: "description" in prop ? prop.description : undefined,
        hasUniqueValue: "hasUniqueValue" in prop ? prop.hasUniqueValue : undefined,
        options: "options" in prop ? prop.options.map((value, i) => ({ label: value, value, displayOrder: i })) : undefined,
      });
      created.push(prop.name);
    }
    return created;
  }
}
