/**
 * Bulk stage controls for the lead list.
 *
 * The row checkboxes, the select-all and the toolbar all live inside one form
 * wrapping the table, so the browser collects the ticked ids with no state of
 * our own. The only client-side code is the select-all toggle, which cannot be
 * done in HTML alone.
 */

'use client';

import { PIPELINE_STAGE_LABELS, PIPELINE_STAGES, type PipelineStage } from '@/lib/crm/types';

const checkboxClass = 'h-4 w-4 rounded border-line bg-ink-800 accent-electric-500';

/** Ticks or unticks every lead checkbox in the same form. */
export function SelectAllLeads() {
  return (
    <input
      type="checkbox"
      aria-label="Select every lead shown"
      className={checkboxClass}
      onChange={(event) => {
        const { checked, form } = event.currentTarget;
        if (!form) return;
        const boxes = form.querySelectorAll<HTMLInputElement>('input[name="lead_id"]');
        boxes.forEach((box) => {
          box.checked = checked;
        });
      }}
    />
  );
}

export function SelectLead({ id }: { id: string }) {
  return (
    <input
      type="checkbox"
      name="lead_id"
      value={id}
      aria-label="Select this lead"
      className={checkboxClass}
    />
  );
}

/**
 * The toolbar.
 *
 * `defaultValue` is `ready_for_outreach` because that is what this control is
 * overwhelmingly used for: taking a freshly imported batch sitting at
 * `qualified` and queueing it up.
 */
export function BulkStageBar({ stageCount }: { stageCount: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
      <span className="label-mono text-white/40">Move selected to</span>
      <select
        name="stage"
        defaultValue="ready_for_outreach"
        className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
      >
        {PIPELINE_STAGES.map((value: PipelineStage) => (
          <option key={value} value={value}>
            {PIPELINE_STAGE_LABELS[value]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
      >
        Move
      </button>
      <p className="text-xs text-white/35">
        Tick the leads above, or use the header box to take all {stageCount} shown. Every move is
        recorded in each lead&rsquo;s stage history.
      </p>
    </div>
  );
}
