/**
 * The parts of the browser lead import worth testing.
 *
 * Kept pure and free of server imports on purpose. The action that uses them
 * runs with the service role, so anything that can be verified without one
 * lives here where a unit test can reach it.
 */

import { isImportable, leadScore, type PipelineLeadExport, type SyncResult } from './sync';

/**
 * How large an upload the browser path accepts.
 *
 * Vercel rejects a serverless request body over 4.5 MB before any application
 * code runs, and `next.config.mjs` caps server actions at 4 MB. Checking the
 * size ourselves turns an unexplained platform failure into a sentence that
 * names the CLI, which has no such limit because it never crosses the network
 * as one request.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DryRunSummary {
  received: number;
  invalid: number;
  belowMinScore: number;
  wouldImport: number;
  /** Distinct businesses, after collapsing repeats of the same `lead_id`. */
  distinct: number;
}

/**
 * What a real run would do, without doing it.
 *
 * Deliberately mirrors the filter order inside `syncLeads` — invalid first,
 * then the score floor, then deduplication — and shares `isImportable` and
 * `leadScore` with it rather than reimplementing either.
 */
export function dryRun(leads: PipelineLeadExport[], minScore: number): DryRunSummary {
  let invalid = 0;
  let belowMinScore = 0;
  const ids: Record<string, true> = {};
  let wouldImport = 0;

  for (const lead of leads) {
    if (!isImportable(lead)) {
      invalid += 1;
      continue;
    }
    if (leadScore(lead) < minScore) {
      belowMinScore += 1;
      continue;
    }
    wouldImport += 1;
    ids[lead.lead_id] = true;
  }

  return {
    received: leads.length,
    invalid,
    belowMinScore,
    wouldImport,
    distinct: Object.keys(ids).length
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One sentence, because this lands in a banner rather than a terminal. */
export function summariseDryRun(summary: DryRunSummary, minScore: number): string {
  const parts = [`${plural(summary.distinct, 'lead')} would be imported`];
  if (summary.wouldImport !== summary.distinct) {
    parts.push(`${summary.wouldImport - summary.distinct} duplicate rows collapsed`);
  }
  if (summary.belowMinScore) {
    parts.push(`${summary.belowMinScore} below the score floor of ${minScore}`);
  }
  if (summary.invalid) {
    parts.push(`${summary.invalid} unusable (no id or company name)`);
  }
  return `Preview only — nothing was written. Of ${plural(summary.received, 'lead')} in the file, ${parts.join(', ')}.`;
}

/**
 * The result of a real run.
 *
 * "Already here" is stated explicitly because it is the number people expect
 * to be alarming and is in fact the point: a re-import is meant to leave
 * existing leads alone.
 */
export function summariseSync(result: SyncResult): string {
  const parts = [
    `${plural(result.crmLeadsCreated, 'new lead')}`,
    `${result.crmLeadsExisting} already here (stage and history untouched)`,
    `${plural(result.intelligenceUpserted, 'research row')} refreshed`
  ];
  if (result.skippedBelowMinScore) {
    parts.push(`${result.skippedBelowMinScore} below the score floor`);
  }
  if (result.skippedInvalid) {
    parts.push(`${result.skippedInvalid} unusable`);
  }

  const head = `Imported from ${plural(result.received, 'lead')}: ${parts.join(', ')}.`;
  if (result.errors.length === 0) return head;

  // Surface the first error rather than a count alone. "3 errors" sends
  // somebody to a log they may not have; the message says what broke.
  return `${head} ${plural(result.errors.length, 'error')} — first: ${result.errors[0]}`;
}
