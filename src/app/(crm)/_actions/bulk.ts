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
import {
  OPPORTUNITY_STAGES,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type OpportunityStage,
  type PipelineStage
} from '@/lib/crm/types';
import {
  CLOSED_OPPORTUNITY_STAGES,
  MAX_CONVERT_SELECTION,
  planConversion,
  summariseConversion,
  type ConvertibleLead
} from '@/lib/crm/opportunities';
import { convertLeadToOpportunity } from '@/lib/crm/workflow';
import { planEnrolment, summariseEnrolment } from '@/lib/outreach/enrolment';

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

// ---------------------------------------------------------------------------
// Bulk enrolment
// ---------------------------------------------------------------------------

/**
 * Enrol a selection of leads in a sequence.
 *
 * Applies the same consent rules as the single-lead path, but reads the
 * suppression list once instead of asking `crm_is_suppressed()` per lead —
 * two hundred round trips would not finish inside a serverless invocation.
 * The decision logic is in `src/lib/outreach/enrolment.ts`.
 *
 * This does not send anything. It queues, and the engine's gate re-checks
 * suppression, stage, the window and the caps immediately before each send.
 */
export async function enrolLeadsInSequence(form: FormData): Promise<void> {
  const back = safeDestination(form.get('return_to'), '/leads');

  let key: 'error' | 'notice' = 'notice';
  let message: string;

  try {
    message = await enrol(form);
    revalidatePath('/leads');
    revalidatePath('/outreach');
  } catch (error) {
    key = 'error';
    message = readableWriteError(error);
  }

  redirect(withMessage(back, key, message));
}

async function enrol(form: FormData): Promise<string> {
  const { client, userId } = await requireWriter();

  const sequenceId = String(form.get('sequence_id') ?? '').trim();
  if (!UUID.test(sequenceId)) throw new ValidationError('Choose a sequence to enrol them in.');
  const ids = selectedIds(form);

  const { data: sequenceRow, error: sequenceError } = await client
    .from('outreach_sequences')
    .select('id, name, active')
    .eq('id', sequenceId)
    .maybeSingle();
  if (sequenceError) throw new Error(sequenceError.message);
  const sequence = sequenceRow as { id: string; name: string; active: boolean } | null;
  if (!sequence) throw new ValidationError('That sequence no longer exists.');
  if (!sequence.active) {
    throw new ValidationError(`"${sequence.name}" is paused. Activate it before enrolling into it.`);
  }

  // Stages, through RLS.
  const { data: leadRows, error: leadError } = await client
    .from('crm_leads')
    .select('id, pipeline_stage')
    .in('id', ids);
  if (leadError) throw new Error(leadError.message);
  const stages = (leadRows ?? []) as Array<{ id: string; pipeline_stage: PipelineStage }>;
  if (stages.length === 0) {
    throw new ValidationError('Those leads no longer exist. Reload and try again.');
  }

  // Addresses. The published business address is the fallback the single-lead
  // form uses when no specific contact is chosen; a bulk enrolment has no way
  // to choose one, so it always uses it.
  const intel: Record<string, { email: string | null; phone: string | null }> = {};
  for (const batch of chunk(ids)) {
    const { data, error } = await client
      .from('lead_intelligence')
      .select('crm_lead_id, business_email, business_phone')
      .in('crm_lead_id', batch);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{
      crm_lead_id: string;
      business_email: string | null;
      business_phone: string | null;
    }>) {
      intel[row.crm_lead_id] = { email: row.business_email, phone: row.business_phone };
    }
  }

  // The whole do-not-contact list, once. It is small by nature.
  const { data: suppressionRows, error: suppressionError } = await client
    .from('suppressions')
    .select('email, phone');
  if (suppressionError) throw new Error(suppressionError.message);
  const suppressions = { emails: [] as string[], phones: [] as string[] };
  for (const row of (suppressionRows ?? []) as Array<{ email: string | null; phone: string | null }>) {
    if (row.email) suppressions.emails.push(row.email);
    if (row.phone) suppressions.phones.push(row.phone);
  }

  // Who is already in this sequence. The unique index would refuse them anyway;
  // knowing up front turns a failed insert into an accurate count.
  const enrolled: string[] = [];
  for (const batch of chunk(ids)) {
    const { data, error } = await client
      .from('lead_outreach')
      .select('crm_lead_id')
      .eq('sequence_id', sequenceId)
      .in('crm_lead_id', batch);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ crm_lead_id: string }>) enrolled.push(row.crm_lead_id);
  }

  const plan = planEnrolment(
    stages.map((row) => ({
      crm_lead_id: row.id,
      pipeline_stage: row.pipeline_stage,
      email: intel[row.id]?.email ?? null,
      phone: intel[row.id]?.phone ?? null
    })),
    suppressions,
    enrolled
  );

  const now = new Date().toISOString();
  for (const batch of chunk(plan.enrol)) {
    const { error } = await client.from('lead_outreach').insert(
      batch.map((leadId) => ({
        crm_lead_id: leadId,
        sequence_id: sequenceId,
        enrolled_by: userId,
        status: 'active',
        current_step: 0,
        // Due immediately; the engine's window and caps decide when it goes.
        next_step_at: now
      }))
    );
    if (error) throw new Error(error.message);
  }

  return summariseEnrolment(plan, sequence.name);
}

// ---------------------------------------------------------------------------
// Bulk conversion to opportunities
// ---------------------------------------------------------------------------

/**
 * Open an opportunity for each selected lead.
 *
 * One `crm_convert_lead_to_opportunity()` RPC per lead, because that function
 * creates the deal, advances the lead's stage and writes the activity in a
 * single transaction. Doing it in one bulk statement would mean reimplementing
 * all three and losing the transaction.
 *
 * A failure on one lead does not abandon the rest. Ninety-nine deals opened
 * and one refused is a better outcome than nothing, provided the report says
 * so — which is why the summary names the first error rather than only
 * counting them.
 */
export async function createOpportunitiesForLeads(form: FormData): Promise<void> {
  const back = safeDestination(form.get('return_to'), '/leads');

  let key: 'error' | 'notice' = 'notice';
  let message: string;

  try {
    message = await convert(form);
    revalidatePath('/leads');
    revalidatePath('/opportunities');
    revalidatePath('/pipeline');
    revalidatePath('/dashboard');
  } catch (error) {
    key = 'error';
    message = readableWriteError(error);
  }

  redirect(withMessage(back, key, message));
}

async function convert(form: FormData): Promise<string> {
  const { client } = await requireWriter();

  const ids = selectedIds(form);
  if (ids.length > MAX_CONVERT_SELECTION) {
    throw new ValidationError(
      `That is ${ids.length} leads. Opening opportunities is one write each, so it is capped at ${MAX_CONVERT_SELECTION} at a time — narrow the filters and work through it in batches.`
    );
  }

  const stage = opportunityStageOf(form.get('opportunity_stage'));
  const service = optionalText(form.get('service_name'), 'Service', 120);
  const monthly = optionalMoney(form.get('monthly_value'), 'Monthly value');

  // Through RLS, joined to the research for the company name.
  const { data, error } = await client
    .from('crm_leads')
    .select('id, external_lead_id, lead_intelligence(company_name)')
    .in('id', ids);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{
    id: string;
    external_lead_id: string;
    lead_intelligence: { company_name: string | null } | { company_name: string | null }[] | null;
  }>;
  if (rows.length === 0) {
    throw new ValidationError('Those leads no longer exist. Reload and try again.');
  }

  const leads: ConvertibleLead[] = rows.map((row) => {
    const intel = Array.isArray(row.lead_intelligence)
      ? row.lead_intelligence[0]
      : row.lead_intelligence;
    return {
      id: row.id,
      external_lead_id: row.external_lead_id,
      company_name: intel?.company_name ?? null
    };
  });

  // Which of these already have a deal in flight.
  const openAlready: string[] = [];
  for (const batch of chunk(ids)) {
    const { data: open, error: openError } = await client
      .from('opportunities')
      .select('crm_lead_id')
      .in('crm_lead_id', batch)
      .not('stage', 'in', `(${CLOSED_OPPORTUNITY_STAGES.join(',')})`);
    if (openError) throw new Error(openError.message);
    for (const row of (open ?? []) as Array<{ crm_lead_id: string }>) {
      openAlready.push(row.crm_lead_id);
    }
  }

  const plan = planConversion(leads, openAlready, service);

  let created = 0;
  const errors: string[] = [];
  for (const target of plan.create) {
    try {
      await convertLeadToOpportunity(client, {
        crm_lead_id: target.crm_lead_id,
        name: target.name,
        stage,
        contact_id: null,
        owner_id: null,
        service_name: service,
        setup_fee: null,
        monthly_value: monthly,
        one_time_value: null,
        contract_months: null,
        probability: null,
        expected_close_date: null,
        pain_points: null,
        desired_outcome: null,
        budget: null,
        objections: null,
        next_action: null,
        next_action_at: null,
        note: null
      });
      created += 1;
    } catch (error) {
      errors.push(readableWriteError(error));
    }
  }

  return summariseConversion(created, plan, errors);
}

function opportunityStageOf(value: FormDataEntryValue | null): OpportunityStage {
  const text = String(value ?? '').trim();
  if (!text) return 'discovery';
  if (OPPORTUNITY_STAGES.indexOf(text as OpportunityStage) === -1) {
    throw new ValidationError('That is not an opportunity stage.');
  }
  return text as OpportunityStage;
}

function optionalText(value: FormDataEntryValue | null, label: string, max: number): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return text;
}

function optionalMoney(value: FormDataEntryValue | null, label: string): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ValidationError(`${label} must be a number of 0 or more.`);
  }
  return parsed;
}
