/**
 * `/` — the front door.
 *
 * This application is the CRM and nothing else, so the root has no content of
 * its own. It answers one question — are you signed in? — and sends you to the
 * only two places that exist: `/dashboard` or `/login`.
 *
 * The check is `auth.getUser()` rather than a profile lookup on purpose. A user
 * who has authenticated but has no `profiles` row yet is still authenticated,
 * and belongs on the dashboard, which explains that state properly. Bouncing
 * them back to a login form they have already completed would be a loop.
 *
 * `force-dynamic` because the answer depends on a cookie. Without it Next
 * prerenders one branch at build time and serves it to everybody.
 */

import { redirect } from 'next/navigation';

import { crmClient, isCrmConfigured } from '@/lib/crm/server';

export const dynamic = 'force-dynamic';

export default async function Root() {
  // A deployment with no Supabase credentials cannot check a session at all.
  // `/login` says what is missing; throwing here would just be a 500.
  if (!isCrmConfigured()) redirect('/login');

  const {
    data: { user }
  } = await crmClient().auth.getUser();

  // redirect() throws to unwind — it is deliberately the last statement and
  // deliberately not inside a try.
  redirect(user ? '/dashboard' : '/login');
}
