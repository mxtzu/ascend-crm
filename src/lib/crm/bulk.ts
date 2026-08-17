/**
 * Planning a bulk stage change.
 *
 * Pure, so the rules that decide which leads move can be tested without a
 * database. The write itself is an ordinary UPDATE under the caller's session
 * — `crm_leads_update` requires `crm_can_write()`, so row level security is the
 * enforcement and this is only deciding what to ask for.
 *
 * Note what this deliberately does NOT use: `crm_advance_lead_stage()`. That
 * RPC is forward-only and treats the closed stages as rank 0, which makes it
 * the right tool for the sales workflow — a deal should not silently reverse —
 * and the wrong one here. Preparing an outreach batch legitimately includes
 * moving leads backwards to re-work them, and marking a batch `disqualified`
 * is a move to rank 0 that the RPC cannot express at all.
 *
 * History is preserved either way: `crm_leads_record_stage_update` is a BEFORE
 * UPDATE OF pipeline_stage trigger, so every row this moves is written to
 * `pipeline_stage_history` regardless of which path did the moving.
 */

import type { PipelineStage } from './types';

/** Selecting more than this in one go is a mistake worth catching. */
export const MAX_BULK_SELECTION = 500;

/** PostgREST puts `in` filters in the query string; long lists overflow it. */
export const BULK_CHUNK_SIZE = 100;

export interface StageRow {
  id: string;
  pipeline_stage: PipelineStage;
}

export interface StageMovePlan {
  /** Ids to actually write. */
  move: string[];
  /** Already at the target — writing them would log a no-op stage change. */
  unchanged: number;
  /**
   * Leads sitting at `do_not_contact`, left alone.
   *
   * Someone who ticked "select all" and chose `ready_for_outreach` did not mean
   * to put a person who asked not to be contacted back into a sending queue.
   * Suppression at send time is the real guarantee, but quietly resurrecting
   * the record is still the wrong default. Moving one out of `do_not_contact`
   * stays possible from the lead's own page, one deliberate act at a time.
   */
  protectedFromContact: number;
}

export function planStageMove(rows: StageRow[], target: PipelineStage): StageMovePlan {
  const plan: StageMovePlan = { move: [], unchanged: 0, protectedFromContact: 0 };

  for (const row of rows) {
    if (row.pipeline_stage === target) {
      plan.unchanged += 1;
      continue;
    }
    if (row.pipeline_stage === 'do_not_contact') {
      plan.protectedFromContact += 1;
      continue;
    }
    plan.move.push(row.id);
  }

  return plan;
}

export function chunk<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function summariseStageMove(
  plan: StageMovePlan,
  target: PipelineStage,
  label: string
): string {
  const head = `Moved ${plural(plan.move.length, 'lead')} to ${label}.`;
  const notes: string[] = [];

  if (plan.unchanged) notes.push(`${plan.unchanged} already there`);
  if (plan.protectedFromContact) {
    notes.push(
      `${plural(plan.protectedFromContact, 'lead')} left on do not contact — move those individually`
    );
  }

  if (notes.length === 0) return head;
  return `${head} ${notes.join('; ')}.`;
}
