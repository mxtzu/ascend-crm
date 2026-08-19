import { describe, expect, it } from 'vitest';

import {
  CLOSED_OPPORTUNITY_STAGES,
  MAX_CONVERT_SELECTION,
  opportunityName,
  planConversion,
  summariseConversion,
  type ConvertibleLead
} from '../opportunities';

function lead(id: string, company: string | null = 'Acme Dental Ltd'): ConvertibleLead {
  return { id, external_lead_id: `ext-${id}`, company_name: company };
}

describe('naming a deal', () => {
  it('uses the company name, which is what people scan for', () => {
    expect(opportunityName(lead('a'), null)).toBe('Acme Dental Ltd');
  });

  it('appends a shared service, so a batch is not a hundred identical rows', () => {
    expect(opportunityName(lead('a'), 'SEO retainer')).toBe('Acme Dental Ltd — SEO retainer');
  });

  it('falls back to the pipeline id rather than producing a nameless deal', () => {
    // The RPC refuses a blank name outright, so this cannot be left to chance.
    expect(opportunityName(lead('a', null), null)).toBe('ext-a');
    expect(opportunityName(lead('a', '   '), null)).toBe('ext-a');
  });

  it('ignores a service that is only whitespace', () => {
    expect(opportunityName(lead('a'), '   ')).toBe('Acme Dental Ltd');
  });
});

describe('planning a conversion', () => {
  it('opens one deal per lead', () => {
    const plan = planConversion([lead('a'), lead('b')], [], null);
    expect(plan.create.map((t) => t.crm_lead_id)).toEqual(['a', 'b']);
    expect(plan.alreadyOpen).toBe(0);
  });

  /**
   * The guard that matters. A converted lead stays in a filtered list until
   * its stage moves, so running the same selection twice is easy to do — and
   * without this it silently doubles the pipeline value.
   */
  it('skips a lead that already has an open deal', () => {
    const plan = planConversion([lead('a'), lead('b')], ['a'], null);
    expect(plan.create.map((t) => t.crm_lead_id)).toEqual(['b']);
    expect(plan.alreadyOpen).toBe(1);
  });

  it('carries the service through to every name', () => {
    const plan = planConversion([lead('a'), lead('b', 'Beta Ltd')], [], 'Paid ads');
    expect(plan.create.map((t) => t.name)).toEqual([
      'Acme Dental Ltd — Paid ads',
      'Beta Ltd — Paid ads'
    ]);
  });

  it('treats won and lost as finished, so a lead can be revisited', () => {
    // The caller filters on these; asserting the list keeps the two in step.
    expect(CLOSED_OPPORTUNITY_STAGES).toEqual(['won', 'lost']);
  });
});

describe('the summary', () => {
  it('reports a clean run in one sentence', () => {
    const plan = planConversion([lead('a')], [], null);
    expect(summariseConversion(1, plan, [])).toBe('Opened 1 opportunity.');
  });

  it('pluralises properly, because "1 opportunities" reads as a bug', () => {
    const plan = planConversion([lead('a'), lead('b')], [], null);
    expect(summariseConversion(2, plan, [])).toContain('2 opportunities');
  });

  it('says how many were left alone and why', () => {
    const plan = planConversion([lead('a'), lead('b')], ['a'], null);
    expect(summariseConversion(1, plan, [])).toContain('1 lead already had an open deal');
  });

  /**
   * Partial success is exactly when detail matters. One lead refused out of a
   * hundred must not be reported as either total success or total failure.
   */
  it('names the first failure rather than only counting them', () => {
    const plan = planConversion([lead('a'), lead('b')], [], null);
    const text = summariseConversion(1, plan, ['An opportunity needs a name.']);
    expect(text).toContain('Opened 1 opportunity');
    expect(text).toContain('1 failed');
    expect(text).toContain('An opportunity needs a name.');
  });
});

describe('the selection cap', () => {
  it('is lower than the stage-move cap, because conversion is a write per lead', () => {
    expect(MAX_CONVERT_SELECTION).toBe(100);
  });
});
