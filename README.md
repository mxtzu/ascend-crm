# ASCEND

The agency operating system. Leads, pipeline, sales calls, proposals, clients,
contracts, calendar, billing and outreach — one application, one database, one
sign-in.

Next.js 14 (App Router) · TypeScript · Tailwind · Supabase Postgres with row
level security · Stripe · Google Calendar · Resend · Twilio · Sentry.

---

## What it does

| Area | |
| --- | --- |
| **Leads** | Import a pipeline export from the browser or the API, filter by stage/score/name, full timeline |
| **Pipeline** | Board by stage, bulk stage moves from the lead list, stage-change history recorded in the database |
| **Sales calls** | A call workspace: talking points, notes, follow-up and next task in one save |
| **Opportunities** | Deals, weighted value, proposals, won → client, lost with a reason; open a deal for a whole selection from the lead list |
| **Clients** | Accounts, contracts, documents, notes, tasks |
| **Calendar** | Appointments, two-way Google Calendar sync, Google Meet links |
| **Billing** | Stripe invoices and retainer subscriptions; MRR, collected, outstanding, overdue |
| **Outreach** | Email and SMS sequences, bulk enrolment from the lead list, reply detection, suppression list, one-click unsubscribe |

---

## Quick start

```bash
npm install
cp .env.example .env.local     # fill in the Supabase values at minimum
npm run dev
```

Then apply the schema — every file in `supabase/migrations/`, in filename order,
to your Supabase project:

```bash
supabase link --project-ref <ref>
supabase db push
```

Create a user in the Supabase dashboard, then promote them:

```sql
update public.profiles set role = 'owner' where email = 'you@agency.com';
```

`npm run doctor` checks the result — configuration, every table, an admin
account, and that a signed-out request reads nothing.

---

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (vitest) |
| `npm run db:test` | Schema and RLS assertions against a real Postgres |
| `npm run verify` | typecheck → test → preflight → build |
| `npm run preflight` | Refuses a build that would leak a secret into the bundle |
| `npm run doctor` | Configuration and RLS check against a live project |
| `npm run sync:leads` | Import a pipeline export from a file |
| `npm run backup` | Logical JSON export of the CRM tables |

`npm run db:test` needs a Postgres 16+ you are happy for it to create and drop a
database on:

```bash
CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run db:test
```

---

## Two things worth knowing before you change anything

**Row level security is the authorisation model, not a backstop.** Every page
reads through a client bound to the request's session cookie, so a page that
forgets a filter still cannot leak another user's rows. The tables that must
never be written from a browser — `payments`, `subscriptions`,
`lead_intelligence`, `outreach_messages` — have no write policy at all rather
than a restrictive one. `calendar_credentials`, `calendar_deletions`,
`stripe_events` and `provider_events` have no policies whatsoever: service role
only.

**Stripe is the source of truth for payment status.** Nothing in the UI can mark
a payment paid. The webhook at `/api/crm/stripe/webhook` is the only writer, and
the database enforces that by having no write policy on `payments` for any role.

---

## Lead ingestion

**This repository contains no scraper.** Leads arrive from a separate pipeline,
three ways: the **Import** panel on `/leads` (owners and admins, previews by
default), `npm run sync:leads -- --file <export.json>`, or
`POST /api/crm/sync-leads` authenticated with `LEAD_SYNC_SECRET`. All three go
through the same idempotent `syncLeads`. Payload contract, idempotency rules
and the obligations on the sending side are in
**[docs/lead-ingestion.md](docs/lead-ingestion.md)**.

## Outreach is off by default

`outreach_settings.sending_enabled` defaults to `false`, and only an owner or
admin can change it, from `/outreach`. Deploying, configuring Resend and
pointing a scheduler at the run endpoint all leave it off. Nothing is sent to
anybody until someone decides it should be.

---

## Documentation

| | |
| --- | --- |
| [docs/agency-crm.md](docs/agency-crm.md) | Architecture, roles, every feature, every route |
| [docs/lead-ingestion.md](docs/lead-ingestion.md) | The lead import contract |
| [docs/deployment.md](docs/deployment.md) | Vercel and Supabase, in order |
| [docs/vercel-crons.md](docs/vercel-crons.md) | Scheduled work |
| [docs/security-review.md](docs/security-review.md) | What was found, fixed, and deliberately left |
| [docs/extraction-audit.md](docs/extraction-audit.md) | How this repository was extracted, and what was verified |
