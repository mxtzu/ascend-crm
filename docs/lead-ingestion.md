# Lead ingestion

**This repository contains no scraper.** Lead discovery is a separate system in
a separate repository, on its own schedule and its own machine. ASCEND receives
its output and never reaches back into it.

That separation is deliberate rather than incidental. The discovery side is
Python, is offline, holds an HTTP cache and a local database, and gets re-run
against the same territory repeatedly. The CRM is serverless and cannot reach
any of that. So the pipeline pushes, the CRM accepts, and the boundary is one
HTTP endpoint.

---

## The endpoint

```
POST /api/crm/sync-leads
Authorization: Bearer $LEAD_SYNC_SECRET
Content-Type: application/json
```

`X-Lead-Sync-Secret: <secret>` is accepted as an alternative to the bearer
header, for callers that cannot set `Authorization`.

### Authentication

A shared secret in `LEAD_SYNC_SECRET`, compared in constant time. The caller is
a job, not a person, so there is no session and no cookie — which is also why
this path is excluded from the auth middleware.

**It fails closed.** With `LEAD_SYNC_SECRET` unset the route answers `503` to
every request, including a correct one. An importer that silently accepts
unauthenticated writes to the lead table is worse than an importer that is off.

Generate one with:

```bash
openssl rand -hex 32
```

### Query parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `min_score` | `0` | Skip leads scoring below this. Filtering happens in the CRM, so the pipeline can post everything it found. |
| `stage` | `qualified` | Pipeline stage new leads land in. Must be one of the `crm_pipeline_stage` values. |

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Everything applied. |
| `207` | Applied, with per-lead errors in `result.errors`. |
| `400` | Malformed JSON, unparseable document, or a bad `min_score` / `stage`. |
| `401` | Secret missing or wrong. |
| `503` | `LEAD_SYNC_SECRET` or the Supabase service role is not configured. |

---

## The payload

One document, one `leads` array. Every field except `lead_id` and
`company_name` is optional — a business discovered without a website or without
enrichment is a normal outcome, not an error.

```json
{
  "generated_at": "2026-08-17T09:00:00Z",
  "lead_count": 2,
  "leads": [
    {
      "lead_id": "1320d1738b0db4a0",
      "company_name": "Example Dental Practice Ltd",
      "trading_name": "Example Dental",
      "niche": "invisalign_dental_practices",
      "website": "https://example-dental.test",
      "domain": "example-dental.test",
      "business_phone": "+441910000000",
      "business_email": "hello@example-dental.test",
      "contact_name": "A. Practitioner",
      "contact_role": "Practice Principal",
      "contact_source_url": "https://example-dental.test/about",
      "city": "Newcastle upon Tyne",
      "postcode": "NE1 1AA",
      "country": "GB",
      "online_presence": { "facebook_url": "https://facebook.com/exampledental" },
      "google": { "google_rating": 4.7, "google_review_count": 182 },
      "company_registry": { "company_number": "01234567" },
      "lead_score": 72,
      "score": { "band": "high" },
      "opportunities": ["No Google Ads presence"],
      "sources": ["https://example-dental.test/about"],
      "date_discovered": "2026-08-14"
    }
  ]
}
```

The full accepted shape is `PipelineLeadExport` in
[`src/lib/crm/sync.ts`](../src/lib/crm/sync.ts) — that type is the contract, and
this document is a description of it.

### `lead_id` is the join key

A stable 16-character digest of the strongest identity the pipeline has: Google
place id, else domain, else normalised name plus locality. It lands in
`crm_leads.external_lead_id`, which carries a `UNIQUE` constraint.

Stability is the whole point. If the pipeline ever changes how it derives this
id, every previously imported lead re-imports as a new one and the CRM ends up
holding two records for the same business with the sales history on the wrong
half.

### Provenance is preserved

`sources` and `contact_source_url` carry the URL each data point was read from,
and the CRM shows them on the lead page. A contact name with no source is
research nobody can check.

---

## What a re-sync does, and does not do

Re-running is safe, and expected — the pipeline re-scrapes the same territory
on a schedule.

**A re-sync writes `lead_intelligence` and nothing else.** It never touches
`pipeline_stage`, `owner_id`, `next_action`, `contacts`, `activities`,
`opportunities`, `clients` or `payments`. A lead your team moved to `won` stays
`won` however many times it is re-scraped.

`crm_leads` rows are insert-only from the sync's point of view: created once, on
first sight, at the configured stage.

This is enforced rather than remembered. `lead_intelligence` has no `INSERT`,
`UPDATE` or `DELETE` policy for any CRM role — only the service role, which is
what this endpoint runs as, can write it.

### Discovered contacts are not `contacts`

The decision-maker the pipeline finds lands on `lead_intelligence` as
`contact_name` / `contact_role` / `contact_source_url`. It does **not** become a
`contacts` row.

`contacts` is CRM state — people your team added, verified and possibly
corrected — and a re-sync must never overwrite it. The discovered name is shown
on the lead page next to the page it was read from, and a human promotes it to a
real contact when it turns out to be right.

---

## Running it by hand

The CLI applies exactly the same rules as the endpoint:

```bash
npm run sync:leads -- --file leads.json --min-score 55
```

Useful flags: `--dry-run` (parse and map, write nothing — prints the first
mapped row), `--limit n`, `--stage ready_for_outreach`.

A second run of the same export reports:

```
LEAD SYNC COMPLETE
  Received:            120
  CRM leads created:   14
  Already in CRM:      106 (stage and history preserved)
  Intelligence synced: 120
```

---

## Obligations on the sending side

These are constraints on the pipeline, not on this repository, but the CRM is
where the consequences land:

- Publicly available business contact information only. No personal data
  scraped from anywhere it was not published as a business contact.
- Never infer or fabricate a contact detail. An empty field is a fact; a guessed
  email address is a liability.
- Respect `robots.txt` and site terms. Do not bypass CAPTCHAs, authentication,
  paywalls or anti-bot measures.
- Keep the source URL for every data point, so anything can be traced back.

A lead can be deleted from the CRM at any time. Deleting it removes the
`crm_leads` row and cascades to its intelligence; note that a suppression added
from a `STOP` or an unsubscribe **survives** the deletion on purpose — see
`suppressions` in [docs/agency-crm.md](agency-crm.md).
