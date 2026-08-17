import { describe, expect, it } from 'vitest';

import { dryRun, formatBytes, summariseDryRun, summariseSync } from '../import';
import { leadScore, syncLeads, type PipelineLeadExport, type SyncResult } from '../sync';

function lead(overrides: Partial<PipelineLeadExport> = {}): PipelineLeadExport {
  return {
    lead_id: 'a1b2c3d4e5f60718',
    company_name: 'Example Dental Practice Ltd',
    lead_score: 70,
    ...overrides
  } as PipelineLeadExport;
}

function emptyResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    received: 0,
    skippedBelowMinScore: 0,
    skippedInvalid: 0,
    crmLeadsCreated: 0,
    crmLeadsExisting: 0,
    intelligenceUpserted: 0,
    errors: [],
    ...overrides
  };
}

describe('the score the filter uses', () => {
  it('prefers lead_score', () => {
    expect(leadScore(lead({ lead_score: 55 }))).toBe(55);
  });

  it('falls back to the nested score total', () => {
    expect(leadScore(lead({ lead_score: undefined, score: { total: 42 } } as never))).toBe(42);
  });

  it('treats an absent score as zero rather than excluding the lead', () => {
    // A lead the pipeline could not score is still a business worth importing;
    // it simply sorts to the bottom.
    expect(leadScore(lead({ lead_score: undefined } as never))).toBe(0);
  });
});

describe('the dry run', () => {
  it('counts what would be imported', () => {
    const summary = dryRun([lead({ lead_id: 'a' }), lead({ lead_id: 'b' })], 0);
    expect(summary.received).toBe(2);
    expect(summary.wouldImport).toBe(2);
    expect(summary.distinct).toBe(2);
  });

  it('applies the score floor', () => {
    const summary = dryRun([lead({ lead_id: 'a', lead_score: 80 }), lead({ lead_id: 'b', lead_score: 20 })], 50);
    expect(summary.wouldImport).toBe(1);
    expect(summary.belowMinScore).toBe(1);
  });

  it('rejects a lead with no id or no company name', () => {
    const summary = dryRun(
      [lead(), lead({ lead_id: '' }), lead({ company_name: '' })],
      0
    );
    expect(summary.invalid).toBe(2);
    expect(summary.wouldImport).toBe(1);
  });

  it('collapses repeats of the same business', () => {
    const summary = dryRun([lead({ lead_id: 'same' }), lead({ lead_id: 'same' })], 0);
    expect(summary.wouldImport).toBe(2);
    expect(summary.distinct).toBe(1);
  });

  /**
   * The point of the whole exercise. A preview that disagrees with the real run
   * is worse than no preview, so this drives both over the same input and
   * asserts they reach the same numbers.
   */
  it('agrees with what syncLeads actually skips', async () => {
    const leads = [
      lead({ lead_id: 'keep', lead_score: 90 }),
      lead({ lead_id: 'low', lead_score: 10 }),
      lead({ lead_id: '', lead_score: 90 }),
      lead({ lead_id: 'dupe', lead_score: 90 }),
      lead({ lead_id: 'dupe', lead_score: 90 })
    ];

    const preview = dryRun(leads, 50);

    // A client that reports nothing pre-existing and records what it was asked
    // to write, so syncLeads runs its real filtering path.
    const inserted: string[] = [];
    const client = {
      from(table: string) {
        const builder: Record<string, unknown> = {
          select: () => builder,
          in: () => Promise.resolve({ data: [], error: null }),
          upsert: (rows: Array<Record<string, unknown>>) => {
            if (table === 'crm_leads') {
              for (const row of rows) inserted.push(String(row.external_lead_id));
            }
            return {
              select: () =>
                Promise.resolve({
                  data: rows.map((row, index) => ({
                    id: `id-${index}`,
                    external_lead_id: row.external_lead_id
                  })),
                  error: null
                })
            };
          }
        };
        return builder;
      }
    };

    const result = await syncLeads(client as never, leads, { minScore: 50 });

    expect(result.received).toBe(preview.received);
    expect(result.skippedInvalid).toBe(preview.invalid);
    expect(result.skippedBelowMinScore).toBe(preview.belowMinScore);
    // Post-deduplication, the preview's `distinct` is what actually gets rows.
    expect(inserted.length).toBe(preview.distinct);
  });
});

describe('what the banner says', () => {
  it('leads with the number created and names what was left alone', () => {
    const text = summariseSync(
      emptyResult({ received: 120, crmLeadsCreated: 14, crmLeadsExisting: 106, intelligenceUpserted: 120 })
    );
    expect(text).toContain('14 new leads');
    expect(text).toContain('106 already here');
    expect(text).toContain('stage and history untouched');
  });

  it('uses the singular for one', () => {
    expect(summariseSync(emptyResult({ received: 1, crmLeadsCreated: 1 }))).toContain('1 new lead,');
  });

  it('quotes the first error rather than only counting them', () => {
    const text = summariseSync(
      emptyResult({ received: 2, errors: ['upsert failed: deadlock detected', 'and another'] })
    );
    expect(text).toContain('2 errors');
    expect(text).toContain('deadlock detected');
  });

  it('says plainly that a preview wrote nothing', () => {
    const text = summariseDryRun(dryRun([lead()], 0), 0);
    expect(text).toContain('nothing was written');
  });

  it('explains why leads were dropped', () => {
    const text = summariseDryRun(
      dryRun([lead({ lead_id: 'a', lead_score: 10 }), lead({ lead_id: '' })], 50),
      50
    );
    expect(text).toContain('below the score floor of 50');
    expect(text).toContain('unusable');
  });
});

describe('file sizes', () => {
  it('reads in the unit a person would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB');
  });
});
