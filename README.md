# Lead Qualifier

For a home-services business (the demo is an HVAC company, "Summit Air HVAC"). Every new enquiry gets a score from fixed, explainable rules and is filed in HubSpot under the right sales rep. A follow-up that sounds like a person wrote it is saved as a Gmail draft.

Built with TypeScript on [Trigger.dev](https://trigger.dev), Claude, HubSpot Free, Gmail and the free US Census geocoder.

## How it works

1. **A lead comes in**, either by email (a website form notification or a customer writing in) or straight from a website form through the Trigger.dev API. Both routes end in the same `qualify-lead` task. Each submission is processed once, even if it arrives twice.
2. **Read it.** For emailed leads, Claude extracts the fields: service wanted, address, urgency, budget, property type and contact details. Pitches and spam are filtered out.
3. **Score it in code.** The score is the sum of the rules that fire, from 0 to 100:
   - Service (up to 30)
   - Location (up to 25)
   - Urgency (up to 25)
   - Budget (up to 20)
   - Modifiers, for example a commercial job with 5 or more units

   70 or more is **Hot** and 45 or more is **Warm**; anything lower is **Cold**. A lead missing key details, or with unusual content, goes to **Needs Review**. Every score comes with its breakdown, for example `S1+30 L1+25 U2+25 B5+12 = 92` (emergency repair, core territory, no heat, repair job).
4. **File it in HubSpot.** A contact and deal are created with 10 custom lead properties and assigned to a rep by territory (the address is geocoded). Needs Review leads become a task for the manager.
5. **Draft the follow-up in Gmail:**
   - **Hot:** a booking link, or a confirmation of the times the customer already gave.
   - **Warm:** asks only for the details that are actually missing.
   - **Cold:** a polite reply.
6. **Safety first.** If the message mentions gas, carbon monoxide, smoke, burning or sparks, the draft is replaced by fixed safety instructions (always the same text, never written by the model). Staff also get an alert email and a high-priority HubSpot call task that is due immediately.
7. **Weekly numbers.** `lead-metrics` emails a summary every Monday.

## Design choices

- **The score is never AI.** All the rules are in one readable table in `rules.ts`, so a sales manager can see exactly why a lead scored 62 and change the points. Claude only extracts fields and writes the explanation and drafts.
- **Drafts, not sends.** A person reviews every email before it goes out.
- **Two ways in.** [docs/connect-a-website.md](docs/connect-a-website.md) shows both: forward form emails with no code, or call the API from the site's server.
- **Test data included.** `samples/leads.json` (11 form leads) and `samples/emails.json` (10 emailed leads) cover every tier, the safety case and spam.

## Project layout

```
src/trigger/lead-qualify/
  submit.ts             the one way a lead enters (deduplicated)
  qualify-lead.ts       score → HubSpot → draft → alerts
  check-lead-inbox.ts   emailed leads
  extract.ts            Claude: email → lead fields
  rules.ts              every scoring rule, in one table
  territories.ts        which rep covers which area
  geocode.ts            address → location (US Census, free)
  hubspot.ts            contacts, deals, owners, tasks
  hubspot-setup.ts      one-time: creates properties, prints IDs
  explain.ts            Claude: plain-English explanation + drafts
  lead-metrics.ts       weekly summary
```

## Running it

1. `npm install`, then copy `.env.example` to `.env`. Every line has a comment saying where to get the value.
2. Create a HubSpot Free account and a service key, then run the `hubspot-setup` task. It creates the lead properties and prints the owner, pipeline and stage IDs for `.env`.
3. Add a Gmail app password, an Anthropic API key and a Trigger.dev project (put its ref in `trigger.config.ts`).
4. `npm run dev`, then run `send-test-leads` or `send-test-emails` to push the samples through.

Claude usage is well under 1 cent per lead on the default model (Haiku).
