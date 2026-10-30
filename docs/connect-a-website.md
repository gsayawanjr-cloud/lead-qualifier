# Connect a website to the lead qualifier

Leads can reach the qualifier two ways. Both end in the same `qualify-lead` task, so scoring, HubSpot,
drafts and alerts work the same whichever one a site uses.

## Route 1: the form emails its submissions (no code)

For Wix, Squarespace, WordPress contact forms, Google Forms, Jotform and anything else that can send
an email notification when someone submits.

1. In the form's notification settings, set the recipient to the leads address
   (`LEAD_INBOX_ADDRESS`, by default your Gmail with `+leads`, e.g. `you+leads@gmail.com`).
2. If the form has a "reply-to = submitter's email" option, turn it on. Otherwise, make sure the form
   includes an email field; it is read from the message.
3. `check-lead-inbox` reads the notification like any customer email. Claude fills in the fields
   from it, so labels like "Name:", "ZIP:" and "What do you need?" all work without any mapping.

Trade-off: Claude reads the form instead of getting exact values, and leads are only as fast as the
inbox check's schedule.

## Route 2: the form sends its fields straight to qualify-lead (fastest, exact)

For sites that can run a small server-side function (Next.js, Netlify/Vercel/Cloudflare functions,
a WordPress plugin with a webhook, Zapier/Make). The function calls Trigger.dev's API with the
**production secret key** (cloud.trigger.dev → this project → API Keys → `tr_prod_...`).

**Never put that key in browser code.** The browser posts to your function; only the function calls
Trigger.dev.

```ts
// Example: a server function that receives the website form and submits the lead.
export async function POST(request: Request) {
  const form = await request.json();
  const submissionId = crypto.randomUUID(); // or the form tool's own submission id

  const response = await fetch("https://api.trigger.dev/api/v1/tasks/qualify-lead/trigger", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TRIGGER_SECRET_KEY}`, // tr_prod_..., server-side only
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      payload: {
        submissionId,
        submittedAt: new Date().toISOString(),
        name: form.name,
        email: form.email,
        phone: form.phone,
        address: form.address,
        city: form.city,
        zip: form.zip,
        service: form.service,   // one of the values below, or ""
        timeline: form.timeline, // one of the values below, or ""
        message: form.message,
      },
      // A double-click or a retried request is processed only once.
      options: { idempotencyKey: `lead-${submissionId}`, idempotencyKeyTTL: "24h" },
    }),
  });
  if (!response.ok) return new Response("Could not submit", { status: 502 });
  return new Response("Thanks, we'll be in touch shortly.");
}
```

A site built in this same TypeScript project can call `submitLead(lead)` from
`src/trigger/lead-qualify/submit.ts` instead.

## The fields

Only `submissionId` and `submittedAt` are required. Everything else may be left out: missing
information is scored and asked about, never rejected. The source of truth is `LeadSchema` in
`src/trigger/lead-qualify/lead.ts`.

| Field | Type | Values |
|---|---|---|
| `submissionId` | text, required | Unique per submission |
| `submittedAt` | ISO 8601 date-time, required | e.g. `2026-10-29T09:15:00-06:00` |
| `name`, `email`, `phone` | text | Any format; phone is normalized to 10 digits |
| `address`, `city`, `state`, `zip` | text | `state` defaults to `CO` |
| `service` | choice | `emergency_repair`, `replacement`, `repair`, `maintenance`, `commercial`, `iaq`, `water_heater`, `duct_cleaning`, `thermostat`, `other` |
| `timeline` | choice | `today`, `this_week`, `this_month`, `researching` |
| `budget` | number (USD) | Ask only on replacement/commercial forms |
| `propertyType` | choice | `home`, `multi_unit`, `commercial` |
| `occupancy` | choice | `owner`, `renter`, `landlord` |
| `units` | whole number | Commercial: number of units / rooftop units |
| `message` | text | The customer's own words; the rules read it (gas smell, no heat) |

Suggested form: name, email, phone, street address, ZIP, a "What do you need?" dropdown (`service`),
a "How soon?" dropdown (`timeline`), and a message box. Use the choice values above as the dropdown
values and anything friendly as the labels.
