import { describe, expect, it } from 'vitest';

import { chunk, planStageMove, summariseStageMove, type StageRow } from '../bulk';
import type { PipelineStage } from '../types';

function row(id: string, stage: PipelineStage): StageRow {
  return { id, pipeline_stage: stage };
}

describe('planning a bulk move', () => {
  it('moves everything that is not already there', () => {
    const plan = planStageMove(
      [row('a', 'qualified'), row('b', 'qualified')],
      'ready_for_outreach'
    );
    expect(plan.move).toEqual(['a', 'b']);
    expect(plan.unchanged).toBe(0);
  });

  it('skips leads already at the target instead of logging a no-op change', () => {
    // The history trigger fires on any write to pipeline_stage, so writing a
    // lead to the stage it is already on would put a meaningless row in
    // pipeline_stage_history.
    const plan = planStageMove(
      [row('a', 'ready_for_outreach'), row('b', 'qualified')],
      'ready_for_outreach'
    );
    expect(plan.move).toEqual(['b']);
    expect(plan.unchanged).toBe(1);
  });

  /**
   * The safeguard. "Select all" then "ready for outreach" must not put someone
   * who asked not to be contacted back into a sending queue.
   */
  it('refuses to move a lead off do_not_contact', () => {
    const plan = planStageMove(
      [row('a', 'do_not_contact'), row('b', 'qualified')],
      'ready_for_outreach'
    );
    expect(plan.move).toEqual(['b']);
    expect(plan.protectedFromContact).toBe(1);
  });

  it('protects do_not_contact whatever the target', () => {
    for (const target of ['qualified', 'contacted', 'won', 'disqualified'] as PipelineStage[]) {
      expect(planStageMove([row('a', 'do_not_contact')], target).move).toEqual([]);
    }
  });

  it('moves backwards, which the forward-only RPC cannot', () => {
    const plan = planStageMove([row('a', 'contacted')], 'qualified');
    expect(plan.move).toEqual(['a']);
  });

  it('moves into a closed stage, which the forward-only RPC also cannot', () => {
    const plan = planStageMove([row('a', 'qualified')], 'disqualified');
    expect(plan.move).toEqual(['a']);
  });
});

describe('the summary', () => {
  it('leads with what happened', () => {
    const plan = planStageMove([row('a', 'qualified')], 'ready_for_outreach');
    expect(summariseStageMove(plan, 'ready_for_outreach', 'Ready for outreach')).toBe(
      'Moved 1 lead to Ready for outreach.'
    );
  });

  it('says what it left alone, and why', () => {
    const plan = planStageMove(
      [row('a', 'qualified'), row('b', 'ready_for_outreach'), row('c', 'do_not_contact')],
      'ready_for_outreach'
    );
    const text = summariseStageMove(plan, 'ready_for_outreach', 'Ready for outreach');
    expect(text).toContain('Moved 1 lead');
    expect(text).toContain('1 already there');
    expect(text).toContain('do not contact');
  });
});

describe('chunking', () => {
  it('splits a long selection', () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i));
    const batches = chunk(ids, 100);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(100);
    expect(batches[2].length).toBe(50);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(250);
  });

  it('returns nothing for an empty selection rather than one empty batch', () => {
    expect(chunk([], 100)).toEqual([]);
  });
});
