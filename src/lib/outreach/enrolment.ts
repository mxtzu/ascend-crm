/**
 * Planning a bulk enrolment.
 *
 * The single-lead path in `_actions/outreach.ts` asks `crm_is_suppressed()` per
 * lead. That is one round trip, which is fine for one lead and unusable for two
 * hundred. So a bulk enrolment reads the `suppressions` table once — members
 * may select it — and matches locally.
 *
 * That means normalising addresses in TypeScript the way `normalise_suppression()`
 * does in SQL, which is a duplication across two languages and therefore
 * something that drifts. It is pinned from both sides: `enrolment.test.ts` and
 * the `normalisation matches the TypeScript mirror` block in
 * `supabase/tests/outreach_test.sql` assert the same table of cases, so
 * changing either without the other fails a suite.
 *
 * Nothing here is the safety guarantee. The engine re-checks suppression
 * through the gate immediately before every single send, and that check is
 * what actually protects someone who unsubscribed between enrolment and
 * delivery. This exists so a batch does not silently queue two hundred sends
 * that will never happen.
 */

import { NEVER_CONTACT_STAGES } from './gate';
import type { PipelineStage } from '../crm/types';

/** Mirrors `nullif(lower(btrim(coalesce(email, ''))), '')`. */
export function normaliseEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Mirrors `nullif(regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g'), '')`. */
export function normalisePhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/[^0-9+]/g, '');
  return digits === '' ? null : digits;
}

export interface EnrolCandidate {
  crm_lead_id: string;
  pipeline_stage: PipelineStage;
  email: string | null;
  phone: string | null;
}

export interface SuppressionIndex {
  emails: string[];
  phones: string[];
}

export type SkipReason =
  | 'stage'
  | 'suppressed'
  | 'no_address'
  | 'already_enrolled';

export interface EnrolPlan {
  enrol: string[];
  skipped: Record<SkipReason, number>;
}

function emptySkips(): Record<SkipReason, number> {
  return { stage: 0, suppressed: 0, no_address: 0, already_enrolled: 0 };
}

export function planEnrolment(
  candidates: EnrolCandidate[],
  suppressions: SuppressionIndex,
  alreadyEnrolled: string[]
): EnrolPlan {
  const plan: EnrolPlan = { enrol: [], skipped: emptySkips() };

  const suppressedEmails: Record<string, true> = {};
  for (const value of suppressions.emails) {
    const key = normaliseEmail(value);
    if (key) suppressedEmails[key] = true;
  }
  const suppressedPhones: Record<string, true> = {};
  for (const value of suppressions.phones) {
    const key = normalisePhone(value);
    if (key) suppressedPhones[key] = true;
  }
  const enrolledAlready: Record<string, true> = {};
  for (const id of alreadyEnrolled) enrolledAlready[id] = true;

  for (const candidate of candidates) {
    if (enrolledAlready[candidate.crm_lead_id]) {
      plan.skipped.already_enrolled += 1;
      continue;
    }

    // Stage first. `won`, `lost`, `disqualified` and `do_not_contact` are the
    // same list the send gate refuses, so enrolling them would queue work the
    // engine is guaranteed to throw away.
    if (NEVER_CONTACT_STAGES.indexOf(candidate.pipeline_stage) !== -1) {
      plan.skipped.stage += 1;
      continue;
    }

    const email = normaliseEmail(candidate.email);
    const phone = normalisePhone(candidate.phone);

    if (!email && !phone) {
      plan.skipped.no_address += 1;
      continue;
    }

    // Consent. Either identifier being on the list suppresses the lead — a
    // person who unsubscribed by email should not then receive an SMS.
    if ((email && suppressedEmails[email]) || (phone && suppressedPhones[phone])) {
      plan.skipped.suppressed += 1;
      continue;
    }

    plan.enrol.push(candidate.crm_lead_id);
  }

  return plan;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function summariseEnrolment(plan: EnrolPlan, sequenceName: string): string {
  const head = `Enrolled ${plural(plan.enrol.length, 'lead')} in ${sequenceName}.`;
  const notes: string[] = [];

  if (plan.skipped.already_enrolled) {
    notes.push(`${plan.skipped.already_enrolled} already enrolled`);
  }
  if (plan.skipped.stage) {
    notes.push(`${plan.skipped.stage} at a stage outreach does not apply to`);
  }
  if (plan.skipped.no_address) {
    notes.push(`${plan.skipped.no_address} with no email or phone`);
  }
  if (plan.skipped.suppressed) {
    notes.push(`${plan.skipped.suppressed} on the do-not-contact list`);
  }

  if (notes.length === 0) return head;
  return `${head} Skipped: ${notes.join(', ')}.`;
}
