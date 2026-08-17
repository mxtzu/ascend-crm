'use server';

/**
 * Import a pipeline export from the browser.
 *
 * THE AUTHORISATION HERE IS LOAD-BEARING. `lead_intelligence` has no INSERT,
 * UPDATE or DELETE policy for any CRM role — only the service role can write
 * it — so this action runs as the service role and row level security is not
 * standing behind it. The role check below is the entire control, not a
 * courtesy that hides a button.
 *
 * Admin-only, deliberately. This is a bulk write that lands in everybody's
 * lead list, and it is the same act the CLI performs from a trusted machine
 * with the service-role key in hand.
 *
 * Everything it does is what `npm run sync:leads` does, through the same
 * `syncLeads`: idempotent on `external_lead_id`, never touching the stage,
 * owner or history of a lead that already exists.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import {
  dryRun,
  formatBytes,
  MAX_IMPORT_BYTES,
  summariseDryRun,
  summariseSync
} from '@/lib/crm/import';
import { isAdmin } from '@/lib/crm/permissions';
import { withMessage } from '@/lib/crm/redirects';
import { crmSession } from '@/lib/crm/server';
import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { parseExportDocument, syncLeads } from '@/lib/crm/sync';
import { PIPELINE_STAGES, type PipelineStage } from '@/lib/crm/types';

export async function importLeads(formData: FormData): Promise<void> {
  let key: 'error' | 'notice' = 'notice';
  let message: string;

  try {
    message = await run(formData);
    revalidatePath('/leads');
    revalidatePath('/pipeline');
    revalidatePath('/dashboard');
  } catch (error) {
    key = 'error';
    message = readableWriteError(error);
  }

  // redirect() throws to unwind, so it must be outside the try.
  redirect(withMessage('/leads', key, message));
}

async function run(form: FormData): Promise<string> {
  const { profile } = await crmSession();
  if (!isAdmin(profile)) {
    throw new ValidationError(
      'Importing leads is restricted to owners and admins, because it writes research rows no other role can touch.'
    );
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new ValidationError('Choose a JSON export to import.');
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError(
      `That file is ${formatBytes(file.size)} and the browser import stops at ` +
        `${formatBytes(MAX_IMPORT_BYTES)}. Use \`npm run sync:leads -- --file <export.json>\`, ` +
        'which has no such limit.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new ValidationError(`${file.name} is not valid JSON.`);
  }

  // Throws its own sentence naming the shape it expected.
  const leads = parseExportDocument(parsed);
  if (leads.length === 0) {
    throw new ValidationError('That export has an empty "leads" array.');
  }

  const minScore = scoreFloor(form.get('min_score'));
  const stage = stageOf(form.get('stage'));

  if (form.get('dry_run') === 'on') {
    return summariseDryRun(dryRun(leads, minScore), minScore);
  }

  if (!isServiceRoleConfigured()) {
    throw new ValidationError(
      'SUPABASE_SERVICE_ROLE_KEY is not set on this deployment, so leads cannot be written.'
    );
  }

  const result = await syncLeads(createServiceClient(), leads, {
    minScore,
    initialStage: stage
  });
  return summariseSync(result);
}

function scoreFloor(value: FormDataEntryValue | null): number {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ValidationError('Minimum score must be a number between 0 and 100.');
  }
  return parsed;
}

function stageOf(value: FormDataEntryValue | null): PipelineStage {
  const text = String(value ?? '').trim();
  if (!text) return 'qualified';
  if (PIPELINE_STAGES.indexOf(text as PipelineStage) === -1) {
    throw new ValidationError('That is not a pipeline stage.');
  }
  return text as PipelineStage;
}
