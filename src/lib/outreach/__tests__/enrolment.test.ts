import { describe, expect, it } from 'vitest';

import {
  normaliseEmail,
  normalisePhone,
  planEnrolment,
  summariseEnrolment,
  type EnrolCandidate
} from '../enrolment';
import type { PipelineStage } from '../../crm/types';

function lead(
  id: string,
  stage: PipelineStage,
  email: string | null = 'hello@example.test',
  phone: string | null = null
): EnrolCandidate {
  return { crm_lead_id: id, pipeline_stage: stage, email, phone };
}

const none = { emails: [], phones: [] };

/**
 * These cases are duplicated in `supabase/tests/outreach_test.sql`, which runs
 * the same inputs through `normalise_suppression()` against real Postgres.
 * Changing either side without the other fails a suite — the point being that
 * this TypeScript is a mirror of SQL, and mirrors drift.
 */
describe('normalisation mirrors normalise_suppression()', () => {
  it.each([
    ['Owner@Practice.CO.UK', 'owner@practice.co.uk'],
    ['  spaced@example.test  ', 'spaced@example.test'],
    ['', null],
    ['   ', null]
  ])('email %s → %s', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });

  it.each([
    ['+44 (0)7700 900222', '+4407700900222'],
    ['07700-900-222', '07700900222'],
    ['+447700900222', '+447700900222'],
    ['', null],
    ['---', null]
  ])('phone %s → %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it('does not fix the bracketed-zero case, which SQL does not either', () => {
    // Documented in docs/security-review.md as accepted behaviour: stripping
    // punctuation leaves the trunk zero, so these stay different numbers. A
    // real fix needs a phone-number library on both sides.
    expect(normalisePhone('+44 (0)7700 900222')).not.toBe(normalisePhone('+447700900222'));
  });
});

describe('planning an enrolment', () => {
  it('enrols a qualified lead with an address', () => {
    const plan = planEnrolment([lead('a', 'qualified')], none, []);
    expect(plan.enrol).toEqual(['a']);
  });

  it('skips a lead with neither email nor phone', () => {
    const plan = planEnrolment([lead('a', 'qualified', null, null)], none, []);
    expect(plan.enrol).toEqual([]);
    expect(plan.skipped.no_address).toBe(1);
  });

  it.each<PipelineStage>(['do_not_contact', 'lost', 'disqualified', 'won'])(
    'skips a lead at %s, matching the send gate',
    (stage) => {
      const plan = planEnrolment([lead('a', stage)], none, []);
      expect(plan.enrol).toEqual([]);
      expect(plan.skipped.stage).toBe(1);
    }
  );

  it('skips a suppressed address whatever its casing', () => {
    const plan = planEnrolment(
      [lead('a', 'qualified', 'Owner@Practice.co.uk')],
      { emails: ['owner@practice.co.uk'], phones: [] },
      []
    );
    expect(plan.enrol).toEqual([]);
    expect(plan.skipped.suppressed).toBe(1);
  });

  it('suppresses on the phone too, so an email opt-out is not routed around by SMS', () => {
    const plan = planEnrolment(
      [lead('a', 'qualified', null, '07700 900 222')],
      { emails: [], phones: ['07700900222'] },
      []
    );
    expect(plan.enrol).toEqual([]);
    expect(plan.skipped.suppressed).toBe(1);
  });

  it('skips a lead already in this sequence', () => {
    const plan = planEnrolment([lead('a', 'qualified')], none, ['a']);
    expect(plan.enrol).toEqual([]);
    expect(plan.skipped.already_enrolled).toBe(1);
  });

  it('checks consent before address, so a suppressed lead is never counted as enrollable', () => {
    const plan = planEnrolment(
      [
        lead('a', 'qualified', 'yes@example.test'),
        lead('b', 'qualified', 'no@example.test'),
        lead('c', 'do_not_contact', 'stage@example.test'),
        lead('d', 'qualified', null, null)
      ],
      { emails: ['no@example.test'], phones: [] },
      []
    );
    expect(plan.enrol).toEqual(['a']);
    expect(plan.skipped).toEqual({
      stage: 1,
      suppressed: 1,
      no_address: 1,
      already_enrolled: 0
    });
  });
});

describe('the summary', () => {
  it('says only what happened when nothing was skipped', () => {
    const plan = planEnrolment([lead('a', 'qualified')], none, []);
    expect(summariseEnrolment(plan, 'Cold open')).toBe('Enrolled 1 lead in Cold open.');
  });

  it('accounts for every skipped lead by reason', () => {
    const plan = planEnrolment(
      [
        lead('a', 'qualified'),
        lead('b', 'won'),
        lead('c', 'qualified', null, null),
        lead('d', 'qualified', 'no@example.test')
      ],
      { emails: ['no@example.test'], phones: [] },
      []
    );
    const text = summariseEnrolment(plan, 'Cold open');
    expect(text).toContain('Enrolled 1 lead');
    expect(text).toContain('1 at a stage outreach does not apply to');
    expect(text).toContain('1 with no email or phone');
    expect(text).toContain('1 on the do-not-contact list');
  });
});
