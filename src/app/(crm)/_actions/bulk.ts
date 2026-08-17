'use server';

/**
 * Bulk stage changes from the lead list.
 *
 * Unlike the import, this runs under the caller's own session rather than the
 * service role: `crm_leads_update` requires `crm_can_write()`, so row level
 * security refuses a viewer's write whatever this code does. `requireWriter()`
 * is here to turn that refusal into a sentence, not to be the control.
 *
 * The decision about which rows move lives in `src/lib/crm/bulk.ts`, where it
 * can be tested without a database.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { chunk, MAX_BULK_SELECTION, planStageMove, summariseStageMove, type StageRow } from '@/lib/crm/bulk';
import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { requireWriter } from '@/lib/crm/server';
import { PIPELINE_STAGE_LABELS, PIPELINE_STAGES, type PipelineStage } from '@/lib/crm/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function moveLeadsToStage(form: FormData): Promise<void> {
  // Back to the filtered view they were working through, not a bare /leads.
  const back = safeDestination(form.get('return_to'), '/leads');

  let key: 'error' | 'notice' = 'notice';
  let message: string;

  try {
    message = await run(form);
    revalidatePath('/leads');
    revalidatePath('/pipeline');
    revalidatePath('/dashboard');
  } catch (error) {
    key = 'error';
    message = readableWriteError(error);
  }

  redirect(withMessage(back, key, message));
}

async function run(form: FormData): Promise<string> {
  const { client } = await requireWriter();

  const target = stageOf(form.get('stage'));
  const ids = selectedIds(form);

  // Read the current stages through RLS. A row coming back is proof the caller
  // may see it, and the plan needs to know where each lead is starting from.
  const { data, error } = await client
    .from('crm_leads')
    .select('id, pipeline_stage')
    .in('id', ids);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as StageRow[];
  if (rows.length === 0) {
    throw new ValidationError('Those leads no longer exist. Reload and try again.');
  }

  const plan = planStageMove(rows, target);

  // Chunked because PostgREST puts `in` filters in the query string, and a few
  // hundred uuids there is a URL long enough for a proxy to truncate.
  for (const batch of chunk(plan.move)) {
    const { error: writeError } = await client
      .from('crm_leads')
      .update({ pipeline_stage: target })
      .in('id', batch);
    if (writeError) throw new Error(writeError.message);
  }

  return summariseStageMove(plan, target, PIPELINE_STAGE_LABELS[target]);
}

function selectedIds(form: FormData): string[] {
  const raw = form.getAll('lead_id').map((value) => String(value));
  if (raw.length === 0) {
    throw new ValidationError('Tick the leads you want to move first.');
  }
  if (raw.length > MAX_BULK_SELECTION) {
    throw new ValidationError(
      `That is ${raw.length} leads at once; the limit is ${MAX_BULK_SELECTION}. Narrow the filters and work through it in batches.`
    );
  }
  for (const id of raw) {
    // The ids come from a form the browser controls. A malformed one would
    // reach PostgREST as a filter value; refuse it here instead.
    if (!UUID.test(id)) throw new ValidationError('That selection is not valid. Reload and try again.');
  }

  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const id of raw) {
    if (seen[id]) continue;
    seen[id] = true;
    unique.push(id);
  }
  return unique;
}

function stageOf(value: FormDataEntryValue | null): PipelineStage {
  const text = String(value ?? '').trim();
  if (PIPELINE_STAGES.indexOf(text as PipelineStage) === -1) {
    throw new ValidationError('Choose a stage to move them to.');
  }
  return text as PipelineStage;
}
