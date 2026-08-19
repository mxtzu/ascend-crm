/**
 * Planning a bulk lead → opportunity conversion.
 *
 * Pure, so the naming and the duplicate guard can be tested without a
 * database. The write itself is one `crm_convert_lead_to_opportunity()` RPC
 * per lead — that function creates the deal, advances the lead's stage and
 * logs the activity in a single transaction, and doing it any other way would
 * mean reimplementing all three.
 */

import type { OpportunityStage } from './types';

/**
 * Lower than the stage-move cap on purpose.
 *
 * Conversion is one round trip per lead rather than one chunked statement, so
 * the cost is linear and a serverless invocation has a wall clock. It is also
 * a sane product limit: opening a hundred deals in one click is already a lot,
 * and opening five hundred is almost certainly a mistake.
 */
export const MAX_CONVERT_SELECTION = 100;

/** Opportunity stages that are finished. A lead may have a new deal after one. */
export const CLOSED_OPPORTUNITY_STAGES: OpportunityStage[] = ['won', 'lost'];

export interface ConvertibleLead {
  id: string;
  external_lead_id: string;
  company_name: string | null;
}

export interface ConversionTarget {
  crm_lead_id: string;
  name: string;
}

export interface ConversionPlan {
  create: ConversionTarget[];
  /** Leads already carrying an open deal, left alone. */
  alreadyOpen: number;
}

/**
 * What the deal is called.
 *
 * The company name, because that is what a person scanning the opportunities
 * list is looking for. A shared service name is appended when one is given, so
 * a batch reads "Acme Dental — SEO retainer" rather than a hundred rows called
 * the same thing.
 *
 * Falls back to the pipeline id: a lead with no company name is unusual but a
 * deal with no name is refused outright by the RPC.
 */
export function opportunityName(lead: ConvertibleLead, service: string | null): string {
  const company = (lead.company_name ?? '').trim() || lead.external_lead_id;
  const suffix = (service ?? '').trim();
  return suffix ? `${company} — ${suffix}` : company;
}

/**
 * Which leads get a deal.
 *
 * A lead already holding an open opportunity is skipped. Without that, running
 * this twice over the same filter — easy to do, since the lead stays in the
 * list until its stage moves — silently doubles the pipeline value.
 */
export function planConversion(
  leads: ConvertibleLead[],
  leadsWithOpenOpportunity: string[],
  service: string | null
): ConversionPlan {
  const open: Record<string, true> = {};
  for (const id of leadsWithOpenOpportunity) open[id] = true;

  const plan: ConversionPlan = { create: [], alreadyOpen: 0 };
  for (const lead of leads) {
    if (open[lead.id]) {
      plan.alreadyOpen += 1;
      continue;
    }
    plan.create.push({ crm_lead_id: lead.id, name: opportunityName(lead, service) });
  }
  return plan;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function summariseConversion(
  created: number,
  plan: ConversionPlan,
  errors: string[]
): string {
  const head = `Opened ${plural(created, 'opportunity', 'opportunities')}.`;
  const notes: string[] = [];

  if (plan.alreadyOpen) {
    notes.push(`${plural(plan.alreadyOpen, 'lead')} already had an open deal`);
  }
  if (errors.length) {
    // Name the first failure. A bare count sends somebody to a log they may
    // not have, and a partial success is exactly when detail matters most.
    notes.push(`${plural(errors.length, 'failed')} — first: ${errors[0]}`);
  }

  if (notes.length === 0) return head;
  return `${head} ${notes.join('; ')}.`;
}
