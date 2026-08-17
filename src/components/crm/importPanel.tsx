/**
 * The import control on the lead list.
 *
 * Renders nothing at all for non-admins rather than a disabled button. The
 * action refuses them anyway, and offering a control that always fails is how
 * people learn to distrust the interface.
 *
 * Collapsed by default when leads already exist, open when the list is empty —
 * on an empty CRM this is the only thing worth doing on the page.
 */

import { importLeads } from '@/app/(crm)/_actions/importLeads';
import { Disclosure, SubmitButton } from '@/components/crm/forms';
import { Card } from '@/components/crm/ui';
import { formatBytes, MAX_IMPORT_BYTES } from '@/lib/crm/import';
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS } from '@/lib/crm/types';

const inputClass =
  'mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-white/25';

export function ImportPanel({ canImport, open }: { canImport: boolean; open?: boolean }) {
  if (!canImport) return null;

  return (
    <Card className="mb-4">
      <Disclosure summary="Import leads from a pipeline export" tone="primary" open={open}>
        <form action={importLeads} className="space-y-4">
          <div>
            <span className="label-mono text-white/40">Export file</span>
            <input
              type="file"
              name="file"
              accept="application/json,.json"
              required
              className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-electric-500/15 file:px-3 file:py-1 file:text-xs file:text-electric-300`}
            />
            <p className="mt-1.5 text-xs text-white/35">
              The JSON your pipeline exports — either a bare array or a document with a{' '}
              <code className="text-white/50">leads</code> array. Up to{' '}
              {formatBytes(MAX_IMPORT_BYTES)}; for anything larger use{' '}
              <code className="text-white/50">npm run sync:leads</code>.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label>
              <span className="label-mono text-white/40">Minimum score</span>
              <input
                type="number"
                name="min_score"
                min={0}
                max={100}
                defaultValue={0}
                className={inputClass}
              />
              <span className="mt-1.5 block text-xs text-white/35">
                Leads scoring below this are skipped. 0 imports everything.
              </span>
            </label>

            <label>
              <span className="label-mono text-white/40">Starting stage</span>
              <select name="stage" defaultValue="qualified" className={inputClass}>
                {PIPELINE_STAGES.map((value) => (
                  <option key={value} value={value}>
                    {PIPELINE_STAGE_LABELS[value]}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-xs text-white/35">
                Applied to new leads only. Existing leads keep the stage they are on.
              </span>
            </label>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-line bg-white/[0.02] px-3 py-2.5">
            <input
              type="checkbox"
              name="dry_run"
              defaultChecked
              className="mt-0.5 h-4 w-4 rounded border-line bg-ink-800 accent-electric-500"
            />
            <span className="text-sm text-white/70">
              Preview first
              <span className="mt-0.5 block text-xs text-white/35">
                Counts what would be imported and writes nothing. On by default — untick it to
                import for real.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <SubmitButton>Import</SubmitButton>
            <p className="text-xs text-white/35">
              Safe to repeat: leads are matched on their pipeline id, so a second import refreshes
              the research and leaves stage, owner, tasks and deals alone.
            </p>
          </div>
        </form>
      </Disclosure>
    </Card>
  );
}
