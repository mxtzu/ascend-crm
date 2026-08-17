# Extraction audit

ASCEND was extracted from `mxtzu/revenueleakscorecard` (branch
`claude/local-business-lead-pipeline-2h6qil`). The Revenue Leak Scorecard is
discontinued and none of it came across.

This is the record of what was checked, what moved, what did not, and what
changed on the way. Seventeen points, in the order they were done.

---

## 1. Dependency audit, before anything was copied

A script resolved the transitive import closure — `@/` aliases, relative paths,
dynamic `import()`, `require`, CSS `@import` — starting from every root Next.js
loads on its own: `src/app/(crm)/**`, `src/app/api/crm/**`, `src/app/layout.tsx`,
`src/app/login/`, `src/app/global-error.tsx`, `src/app/globals.css`,
`src/middleware.ts`, `instrumentation.ts`, the three Sentry configs, `scripts/`
and `tests/`.

**86 of 140 source files were reachable. 54 were not.**

The audit's job was to stop `src/lib` being copied as a directory, and it
earned its place immediately:

| Reachable only via the scorecard landing page | Verdict |
| --- | --- |
| `src/lib/brand.ts` | not copied |
| `src/lib/links.ts` | not copied |
| `src/lib/tracking.ts` | not copied |
| `src/lib/server/supabase.ts`, `funnel.ts`, `webhook.ts` | not copied |
| `src/lib/proofConfig.ts`, `scorecard.ts`, `scorecard-data.ts` | not copied |
| `src/types/scorecard.ts` | not copied |

`clsx` fell out of the dependency list with them and was removed from
`package.json`. Unresolved imports after the closure: **0**.

## 2. A clean repository

`git init`, one commit, no history from the old repo. No submodules, no git
remotes pointing at `revenueleakscorecard`, no path references to it. 156 files.

## 3. The scorecard is entirely absent

Removed: `src/components/scorecard/` (13 components including `ScorecardApp` and
`ScorecardLanding`), `src/lib/scorecard.ts`, `src/lib/scorecard-data.ts`,
`src/lib/proofConfig.ts`, `src/types/scorecard.ts`, `src/app/api/scorecard-events/`,
`src/app/api/scorecard-sessions/`, `src/app/api/scorecard-submissions/`, the
static `index.html`, and `supabase/migrations/20260703_create_scorecard_sessions.sql`.

Scorecard analytics went too: the GA4 tag is gone from the root layout and
`NEXT_PUBLIC_GA_MEASUREMENT_ID` is gone from `.env.example`.

Verified by search: **zero** occurrences of `scorecard`, `roblox`,
`revenueleak`, `gtag` or `GA_MEASUREMENT` anywhere in the tree. Verified at
runtime: `GET /scorecard` → **404**. There is no `/scorecard` route and nothing
was renamed into ASCEND — it is deleted, not rebranded.

## 4. No lead pipeline, and the contract written down

`lead_pipeline/`, `.lead_pipeline_cache/` and `.venv/` were not copied. The CRM
receives leads over `POST /api/crm/sync-leads` authenticated with
`LEAD_SYNC_SECRET`, which fails closed — 503 on every request until the secret
is set.

New **[docs/lead-ingestion.md](lead-ingestion.md)** documents the endpoint, the
auth, the query parameters, every response code, the payload shape, why
`lead_id` must stay stable, what a re-sync does and does not touch, and the
data-collection obligations on the sending side.

Code comments that read as if the pipeline were a directory in this repo were
rewritten to describe an external system.

## 5. Migrations

All eight, unmodified: `20260815_create_agency_crm`, `20260816_add_lead_contact`,
`20260817_document_storage`, `20260818_sales_workflow`, `20260819_calendar_sync`,
`20260820_payments`, `20260821_outreach_engine`, `20260822_harden_grants`.

`supabase/tests/run.sh` iterates `migrations/*.sql`, so dropping the scorecard
migration needed no edit — confirmed by watching it apply exactly eight files.

## 6. Authentication preserved

`/login` with a server action (no credentials in client JS), Supabase Auth,
`src/middleware.ts` unchanged in behaviour — session refresh via
`getUser()` rather than `getSession()`, cookie rewriting on both request and
response, protected-route gating with `?next=`, profile lookup, roles and
permissions, and `src/lib/crm/redirects.ts` still guarding every redirect
target against the backslash open-redirect.

Live check: `/dashboard` → `/login?next=%2Fdashboard`, `/leads` →
`/login?next=%2Fleads`.

## 7. Rebranded, not redesigned

Title is "ASCEND | Agency Operating System"; the description, README and docs
follow. Metadata now sets `noindex, nofollow` — nothing here is public.

No component, no style, no layout and no Tailwind token was changed. The design
system is byte-identical apart from one comment that referred to the scorecard.

## 8. The root route

`/` is a server component that reads the session and redirects: `/dashboard`
when authenticated, `/login` when not, and `/login` when Supabase is
unconfigured rather than throwing a 500.

The check is `auth.getUser()`, not a profile lookup — a user who has
authenticated but has no `profiles` row yet is still authenticated and belongs
on the dashboard, which explains that state. Sending them back to a login form
they already completed would be a loop.

`export const dynamic = 'force-dynamic'`, because the answer depends on a
cookie. The build confirms it: `ƒ /`.

Live check: `GET /` → `307 Location: /login`.

## 9. Install

`npm install` — 311 packages, clean.

## 10. Typecheck

`npm run typecheck` — clean.

Two extraction-caused errors were found and fixed: a dangling
`checkDeployTarget(env, out)` call after its function was removed, and an unused
`next/link` import left by the removal of the scorecard link on the login page.

## 11. Tests

`npm test` — **387 passing across 22 files.**

One fewer than the source repo's 388. That difference is accounted for: the test
asserting `GITHUB_PAGES=true` fails the build was removed along with the check
itself (see 14). No test was skipped, weakened or deleted to make the suite
pass.

`npm run db:test` — **289 SQL assertions** against real Postgres 16, over the
eight migrations, under genuine role impersonation. RLS, triggers, cascades,
grants, and the assertion that an owner attempting
`update payments set status = 'paid'` changes nothing.

## 12. Environment variables

**No real secret value was copied.** `.env.example` has exactly one non-empty
assignment, `STRIPE_CURRENCY=gbp`, which is a default.

No `.env.local` exists in the tree and `.env*` is gitignored with a
`!.env.example` exception. A scan for key-shaped strings (`sk_live_`, `sk_test_`,
`whsec_`, `re_`, `AC[hex×32]`, JWTs) found only test fixtures and prefix
comparisons in `startsWith` calls.

`SUPABASE_SERVICE_ROLE_KEY` is server-side only and is referenced from no client
component. `npm run preflight` still enforces this: it exits **0** on a coherent
environment and **1** when a `service_role` JWT is pasted into the anon slot —
both verified by running it.

## 13. Build

`npm run build` — compiles, 15 static pages generated, 28 routes. Every CRM
page and API route present; no scorecard route in the manifest.

## 14. Cleanup of scorecard-era build configuration

- `.github/workflows/deploy-pages.yml` not copied.
- `next.config.mjs` loses `isGitHubPages`, `repoPath = "/revenueleakscorecard"`,
  `output: "export"`, `basePath` and `assetPrefix`.
- The `GITHUB_PAGES` guards in `src/lib/env.ts` and `scripts/doctor.ts` were
  removed. They failed a build on a flag that, with the export branch gone, does
  nothing — a false failure rather than a safety net.

**One change here has real consequences and is worth calling out.**
`trailingSlash: true` went with the static export. It was making Next answer
`POST /api/crm/stripe/webhook` with a 308 redirect to the slash-suffixed path,
and Stripe, Twilio and Resend do not follow redirects on POST. Every webhook
registered at the documented URL would have failed. Verified fixed: both webhook
paths now answer directly (503 unconfigured, not 308).

## 15. Production database untouched

This was a code extraction, not a database migration.

`list_migrations` against the live project showed all nine migrations already
applied. Nothing was re-applied. No `supabase db reset`, no dropped tables, no
deleted data, no manual RLS change.

The only calls made were read-only (`list_organizations`, `list_projects`,
`list_migrations`, `list_tables`). State confirmed intact: 29 tables, RLS
enabled on every one, all empty except the `outreach_settings` singleton — whose
`sending_enabled` is `false`, as it should be.

## 16. Runtime verification

`next start` against the built output:

| Check | Result |
| --- | --- |
| `GET /` signed out | 307 → `/login` |
| `GET /dashboard` signed out | 307 → `/login?next=%2Fdashboard` |
| `GET /scorecard` | 404 |
| `POST /api/crm/stripe/webhook` | 503 direct, no 308 |
| Security headers | `X-Frame-Options: DENY`, HSTS 63072000, `Referrer-Policy`, `Permissions-Policy`, CSP — all present |

## 17. What is deliberately still true

- **Outreach is off.** `outreach_settings.sending_enabled` defaults to `false`
  and only an owner or admin can change it. Extraction did not switch anything
  on.
- **Stripe remains the source of truth for payment status.** Nothing in the UI
  can mark a payment paid; the database has no write policy on `payments` for
  any role.
- **The accepted risks in [security-review.md](security-review.md) are
  unchanged** — no rate limiting on unauthenticated endpoints, `'unsafe-inline'`
  in the CSP, `crm_role_of()` executable by `anon`, naive phone-number
  suppression matching, no read audit log. None was introduced by the
  extraction; none was silently resolved by it either.
- **`SUPABASE_URL` is still accepted as an alias** for
  `NEXT_PUBLIC_SUPABASE_URL` server-side, because the CLI scripts run in shells
  that only have server-side variables. The comment explaining it no longer
  refers to the scorecard.
