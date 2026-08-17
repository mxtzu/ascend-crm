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
const selectClass = 'rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white';
const buttonClass =
  'rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600';

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
 * Two actions off one selection. The form's own action moves stage; the enrol
 * button overrides it with `formAction`, so the ticked boxes are submitted to
 * whichever the person pressed without duplicating the checkboxes.
 *
 * "Move selected to" defaults to `ready_for_outreach` because that is
 * overwhelmingly what it is used for — taking a freshly imported batch sitting
 * at `qualified` and queueing it up.
 */
export function BulkStageBar({
  stageCount,
  sequences,
  enrolAction,
  sendingEnabled
}: {
  stageCount: number;
  sequences: { id: string; name: string }[];
  enrolAction: (form: FormData) => void | Promise<void>;
  sendingEnabled: boolean;
}) {
  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="label-mono w-24 shrink-0 text-white/40">Move to</span>
        <select
          name="stage"
          defaultValue="ready_for_outreach"
          className={selectClass}
        >
          {PIPELINE_STAGES.map((value: PipelineStage) => (
            <option key={value} value={value}>
              {PIPELINE_STAGE_LABELS[value]}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass}>
          Move
        </button>
      </div>

      {sequences.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="label-mono w-24 shrink-0 text-white/40">Enrol in</span>
          <select name="sequence_id" className={selectClass}>
            {sequences.map((sequence) => (
              <option key={sequence.id} value={sequence.id}>
                {sequence.name}
              </option>
            ))}
          </select>
          <button type="submit" formAction={enrolAction} className={buttonClass}>
            Enrol
          </button>
          <span className="text-xs text-white/35">
            {sendingEnabled
              ? 'Queues them. The engine checks consent, stage, the window and the caps again before each send.'
              : 'Sending is switched off, so this queues and goes nowhere until an admin turns it on.'}
          </span>
        </div>
      ) : null}

      <p className="text-xs text-white/35">
        Tick the leads above, or use the header box to take all {stageCount} shown. Every stage
        move is recorded in that lead&rsquo;s history; leads on do-not-contact are never moved or
        enrolled in bulk.
      </p>
    </div>
  );
}
