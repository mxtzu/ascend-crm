import { describe, expect, it } from 'vitest';

import { blockedReason, isTransientBlock, withinSendWindow, type OutreachSettings } from '../gate';
import { CLAIM_LEASE_MS, reclaimForTest, runOutreach } from '../engine';
import {
  emailProvider,
  emailProviderState,
  isEmailConfigured,
  providerProblem,
  smsProviderState
} from '../config';
import {
  contact,
  ENROLMENT_ID,
  enrolment,
  FakeDb,
  FakeEmail,
  FakeSms,
  IN_WINDOW,
  intelligence,
  LEAD_ID,
  lead,
  seeded,
  settings,
  step
} from './fakes';

const SITE = 'https://crm.agency.test';

function run(db: FakeDb, overrides: { email?: FakeEmail; sms?: FakeSms; now?: Date } = {}) {
  const email = overrides.email ?? new FakeEmail();
  const sms = overrides.sms ?? new FakeSms();
  return {
    email,
    sms,
    result: runOutreach({
      service: db.client(),
      email,
      sms,
      siteUrl: SITE,
      now: overrides.now ?? IN_WINDOW
    })
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
const GATE_SETTINGS = settings() as unknown as OutreachSettings;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'email',
    leadStage: 'ready_for_outreach' as const,
    toEmail: 'dana@riverside.test',
    toPhone: null,
    suppressed: false,
    ignoreSendWindow: false,
    ...overrides
  };
}

const CONTEXT = {
  settings: GATE_SETTINGS,
  now: IN_WINDOW,
  sentToday: 0,
  sentThisRun: 0,
  hasEmailProvider: true,
  hasSmsProvider: true
};

describe('the send gate', () => {
  it('permits an ordinary send', () => {
    expect(blockedReason(candidate(), CONTEXT)).toBeNull();
  });

  it('refuses everything when sending is switched off', () => {
    expect(
      blockedReason(candidate(), {
        ...CONTEXT,
        settings: { ...GATE_SETTINGS, sending_enabled: false }
      })
    ).toMatch(/switched off/);
  });

  /**
   * Consent is checked before anything else, and the message says so — a
   * suppressed address must not read as a scheduling problem to be retried.
   */
  it('puts consent ahead of every other objection', () => {
    const reason = blockedReason(candidate({ suppressed: true, toEmail: null }), {
      ...CONTEXT,
      sentToday: 9999
    });
    expect(reason).toMatch(/do-not-contact/);
    expect(isTransientBlock(reason as string)).toBe(false);
  });

  it('never contacts a closed or opted-out lead', () => {
    for (const stage of ['do_not_contact', 'lost', 'disqualified', 'won'] as const) {
      expect(blockedReason(candidate({ leadStage: stage }), CONTEXT)).toMatch(/does not apply/);
    }
  });

  it('needs an address for the channel it is using', () => {
    expect(blockedReason(candidate({ toEmail: null }), CONTEXT)).toMatch(/No email address/);
    expect(blockedReason(candidate({ channel: 'sms', toPhone: null }), CONTEXT)).toMatch(
      /No mobile number/
    );
  });

  it('respects the per-run and daily caps', () => {
    expect(blockedReason(candidate(), { ...CONTEXT, sentThisRun: 25 })).toMatch(/this run/i);
    expect(blockedReason(candidate(), { ...CONTEXT, sentToday: 50 })).toMatch(/Today's limit/);
  });

  /**
   * Regression. A missing RESEND_API_KEY used to throw from the send path as a
   * plain Error, which the failure handler treats as permanent — so one run
   * with the key unset stopped every enrolment it touched, each needing
   * reactivation by hand. It is a deployment setting, not a fact about the
   * recipient, so it blocks transiently and the enrolment keeps its place.
   */
  it('blocks rather than stops when the deployment has no provider', () => {
    const reason = blockedReason(candidate(), { ...CONTEXT, hasEmailProvider: false });
    expect(reason).toMatch(/No email provider is configured/);
    expect(isTransientBlock(reason as string)).toBe(true);
  });

  it('does the same for SMS', () => {
    const reason = blockedReason(candidate({ channel: 'sms' }), {
      ...CONTEXT,
      hasSmsProvider: false
    });
    expect(reason).toMatch(/No SMS provider is configured/);
    expect(isTransientBlock(reason as string)).toBe(true);
  });

  it('reports a missing provider before a missing address, since it affects every lead', () => {
    expect(
      blockedReason(candidate({ toEmail: null }), { ...CONTEXT, hasEmailProvider: false })
    ).toMatch(/No email provider/);
  });

  it('still puts consent ahead of a missing provider', () => {
    // Configuration is fixable; a person who said no is not. Order matters.
    expect(
      blockedReason(candidate({ suppressed: true }), { ...CONTEXT, hasEmailProvider: false })
    ).toMatch(/do-not-contact/);
  });

  it('treats caps and windows as temporary, consent as settled', () => {
    // A cap clears by itself; a person who said no does not.
    expect(isTransientBlock("Today's limit of 50 has been reached.")).toBe(true);
    expect(isTransientBlock('Outside the sending window.')).toBe(true);
    expect(isTransientBlock('This address is on the do-not-contact list.')).toBe(false);
    expect(isTransientBlock('No email address for this lead.')).toBe(false);
  });
});

describe('the sending window', () => {
  it('is evaluated in the configured zone, not the server’s', () => {
    // 08:30 UTC in June is 09:30 in London — inside a 9–17 window.
    const summerMorning = new Date('2026-06-17T08:30:00Z');
    expect(withinSendWindow(summerMorning, GATE_SETTINGS)).toBe(true);
    expect(
      withinSendWindow(summerMorning, { ...GATE_SETTINGS, timezone: 'UTC' })
    ).toBe(false);
  });

  it('stops at the end of the window rather than running through it', () => {
    // A window ending at 17 stops at 16:59.
    expect(withinSendWindow(new Date('2026-01-14T16:30:00Z'), GATE_SETTINGS)).toBe(true);
    expect(withinSendWindow(new Date('2026-01-14T17:30:00Z'), GATE_SETTINGS)).toBe(false);
  });

  it('keeps off weekends unless told otherwise', () => {
    const saturday = new Date('2026-09-19T10:00:00Z');
    expect(withinSendWindow(saturday, GATE_SETTINGS)).toBe(false);
    expect(withinSendWindow(saturday, { ...GATE_SETTINGS, send_on_weekends: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------
describe('a normal send', () => {
  it('renders the step and sends it to the contact', async () => {
    const db = seeded();
    const { email, result } = run(db);
    const summary = await result;

    expect(summary.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('dana@riverside.test');
    expect(email.sent[0].subject).toBe('Quick question about Riverside Dental');
    expect(email.sent[0].text).toContain('Hi Dana,');
    expect(email.sent[0].text).toContain('no conversion tracking on the booking form');
  });

  it('appends the unsubscribe footer and the one-click header', async () => {
    const db = seeded();
    const { email, result } = run(db);
    await result;

    expect(email.sent[0].text).toContain(`${SITE}/api/crm/outreach/unsubscribe?token=tok_abc123`);
    expect(email.sent[0].text).toContain('1 Example Street');
    // Gmail and Outlook honour this without the recipient hunting for the link.
    expect(email.sent[0].headers?.['List-Unsubscribe']).toContain('tok_abc123');
  });

  it('records the send in the ledger and on the timeline', async () => {
    const db = seeded();
    await run(db).result;

    const message = db.first('outreach_messages')!;
    expect(message.status).toBe('sent');
    expect(message.provider_message_id).toBe('msg-1');
    expect(message.to_email).toBe('dana@riverside.test');

    const activity = db.first('activities')!;
    expect(activity.type).toBe('email');
    // Outbound, so it cannot trip the inbound-reply trigger.
    expect(activity.direction).toBe('outbound');
  });

  it('moves the lead to contacted on the first message out', async () => {
    const db = seeded();
    await run(db).result;
    expect(db.find('crm_leads', LEAD_ID)!.pipeline_stage).toBe('contacted');
  });

  it('does not drag a lead backwards from a later stage', async () => {
    const db = seeded();
    db.find('crm_leads', LEAD_ID)!.pipeline_stage = 'negotiation';
    await run(db).result;
    expect(db.find('crm_leads', LEAD_ID)!.pipeline_stage).toBe('negotiation');
  });

  it('schedules the next step by its own delay', async () => {
    const db = seeded({
      steps: [step(), step({ id: 'step-2', step_number: 2, delay_minutes: 4320 })]
    });
    await run(db).result;

    const enrolled = db.find('lead_outreach', ENROLMENT_ID)!;
    expect(enrolled.current_step).toBe(1);
    expect(enrolled.status).toBe('active');
    // Three days after the send, measured from now rather than from the
    // schedule, so a late run does not fire a burst to catch up.
    expect(enrolled.next_step_at).toBe('2026-09-19T10:00:00.000Z');
  });

  it('completes the enrolment after the last step', async () => {
    const db = seeded();
    await run(db).result;
    expect(db.find('lead_outreach', ENROLMENT_ID)!.status).toBe('completed');
  });
});

describe('refusals', () => {
  it('sends nothing at all when the kill switch is off', async () => {
    // The default on a fresh install: pointing a cron job at the engine must
    // not start emailing a database full of scraped leads.
    const db = seeded();
    (db.first('outreach_settings') as Record<string, unknown>).sending_enabled = false;

    const { email, result } = run(db);
    const summary = await result;

    expect(email.sent).toHaveLength(0);
    expect(summary.sent).toBe(0);
    expect(summary.reasons[0]).toMatch(/switched off/);
    // `considered` distinguishes the two places the switch is enforced. The
    // engine returns before it even looks for due enrolments; the per-message
    // gate would also refuse, but only after a scan. Asserting 0 here pins the
    // early return, so removing it fails a test instead of silently costing a
    // full table scan on every cron tick.
    expect(summary.considered).toBe(0);
    expect(db.rows('outreach_messages')).toHaveLength(0);
  });

  it('will not email a suppressed address, and stops the sequence', async () => {
    const db = seeded();
    db.rows('suppressions').push({ id: 's1', email: 'dana@riverside.test', reason: 'unsubscribed' });

    const { email, result } = run(db);
    await result;

    expect(email.sent).toHaveLength(0);
    expect(db.first('outreach_messages')!.status).toBe('skipped');
    expect(db.first('outreach_messages')!.skip_reason).toMatch(/do-not-contact/);
    expect(db.find('lead_outreach', ENROLMENT_ID)!.status).toBe('stopped');
  });

  it('matches a suppression written in a different case', async () => {
    // "Owner@Practice.co.uk" and "owner@practice.co.uk" are the same inbox.
    const db = seeded();
    db.rows('suppressions').push({ id: 's1', email: 'DANA@Riverside.test', reason: 'bounced' });

    const { email, result } = run(db);
    await result;

    expect(email.sent).toHaveLength(0);
    expect(db.first('outreach_messages')!.skip_reason).toMatch(/do-not-contact/);
  });

  it('leaves the enrolment queued when it is only outside the window', async () => {
    // A closed window clears by itself, so the lead keeps its place.
    const db = seeded();
    const saturday = new Date('2026-09-19T10:00:00Z');

    const { email, result } = run(db, { now: saturday });
    const summary = await result;

    expect(email.sent).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(db.find('lead_outreach', ENROLMENT_ID)!.status).toBe('active');
    // Nothing written to the ledger: it has not been decided, only deferred.
    expect(db.rows('outreach_messages')).toHaveLength(0);
  });

  it('stops rather than sending half a template', async () => {
    const db = seeded();
    db.rows('contacts')[0].first_name = null;

    const { email, result } = run(db);
    await result;

    expect(email.sent).toHaveLength(0);
    expect(db.first('outreach_messages')!.skip_reason).toMatch(/No value for first_name/);
    expect(db.find('lead_outreach', ENROLMENT_ID)!.status).toBe('stopped');
  });

  it('will not contact a lead marked do-not-contact', async () => {
    const db = seeded();
    db.find('crm_leads', LEAD_ID)!.pipeline_stage = 'do_not_contact';

    const { email, result } = run(db);
    await result;

    expect(email.sent).toHaveLength(0);
    expect(db.first('outreach_messages')!.skip_reason).toMatch(/does not apply/);
  });

  it('honours the per-run limit', async () => {
    const db = new FakeDb({
      outreach_settings: [settings({ per_run_limit: 2 })],
      outreach_steps: [step()],
      crm_leads: [lead(), lead({ id: 'lead-2' }), lead({ id: 'lead-3' })],
      lead_intelligence: [
        intelligence(),
        intelligence({ crm_lead_id: 'lead-2', business_email: 'b@two.test', contact_name: 'B' }),
        intelligence({ crm_lead_id: 'lead-3', business_email: 'c@three.test', contact_name: 'C' })
      ],
      contacts: [
        contact(),
        contact({ id: 'c2', crm_lead_id: 'lead-2', email: 'b@two.test', first_name: 'Bea' }),
        contact({ id: 'c3', crm_lead_id: 'lead-3', email: 'c@three.test', first_name: 'Cal' })
      ],
      lead_outreach: [
        enrolment(),
        enrolment({ id: 'e2', crm_lead_id: 'lead-2', contact_id: 'c2' }),
        enrolment({ id: 'e3', crm_lead_id: 'lead-3', contact_id: 'c3' })
      ],
      outreach_messages: [],
      activities: [],
      suppressions: [],
      tasks: []
    });

    const { email, result } = run(db);
    const summary = await result;

    expect(email.sent).toHaveLength(2);
    expect(summary.sent).toBe(2);
    // The third is untouched and goes out on the next run.
    expect(db.find('lead_outreach', 'e3')!.current_step).toBe(0);
  });
});

describe('a step is sent once', () => {
  it('refuses a second send of the same step', async () => {
    // The unique index is what stops two overlapping runs both emailing.
    const db = seeded();
    await run(db).result;

    // Re-arm the enrolment as though a scheduler had double-fired.
    const enrolled = db.find('lead_outreach', ENROLMENT_ID)!;
    enrolled.status = 'active';
    enrolled.current_step = 0;
    enrolled.next_step_at = '2026-09-16T09:00:00Z';

    const second = new FakeEmail();
    await runOutreach({ service: db.client(), email: second, sms: null, siteUrl: SITE, now: IN_WINDOW });

    expect(second.sent).toHaveLength(0);
    expect(db.rows('outreach_messages')).toHaveLength(1);
  });
});

describe('non-sending steps', () => {
  it('turns a call step into a task for a person', async () => {
    // "Call logging" in a sequence means a human makes the call. Nothing here
    // dials anybody.
    const db = seeded({
      steps: [step({ channel: 'call', task_title: 'Ring the practice manager', subject_template: null, body_template: 'Ask about the booking form.' })]
    });

    const { email, sms, result } = run(db);
    await result;

    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
    expect(db.first('tasks')!.title).toBe('Ring the practice manager');
    expect(db.first('outreach_messages')!.skip_reason).toMatch(/task was created/);
    expect(db.find('lead_outreach', ENROLMENT_ID)!.current_step).toBe(1);
  });
});

describe('SMS', () => {
  it('sends the text with an opt-out line', async () => {
    const db = seeded({
      steps: [step({ channel: 'sms', subject_template: null, body_template: 'Hi {{first_name}}, quick one about {{company_name}}.' })]
    });

    const { sms, result } = run(db);
    await result;

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe('+447700900222');
    expect(sms.sent[0].from).toBe('+447700900000');
    // No footer on a text, so the opt-out has to be in the body.
    expect(sms.sent[0].text).toContain('Reply STOP to opt out.');
  });
});

describe('provider failures', () => {
  it('records the failure and stops on a permanent error', async () => {
    const db = seeded();
    const email = new FakeEmail();
    email.failWith = new Error('Recipient domain does not exist');

    await runOutreach({ service: db.client(), email, sms: null, siteUrl: SITE, now: IN_WINDOW });

    expect(db.first('outreach_messages')!.status).toBe('failed');
    expect(db.first('outreach_messages')!.error).toMatch(/domain does not exist/);
    expect(db.find('lead_outreach', ENROLMENT_ID)!.status).toBe('stopped');
  });

  it('keeps a queued row even when the send throws, so nothing is invisible', async () => {
    const db = seeded();
    const email = new FakeEmail();
    email.failWith = new Error('boom');
    await runOutreach({ service: db.client(), email, sms: null, siteUrl: SITE, now: IN_WINDOW });

    expect(db.rows('outreach_messages')).toHaveLength(1);
  });
});

/**
 * Reclaiming a step's claim.
 *
 * The claim row exists so two overlapping runs cannot both email one person.
 * It used to be permanent: losing the insert race made the engine return, and
 * because the row stayed behind, every later run lost the same race. A step
 * whose first send failed could never be retried — and the run reported
 * nothing at all, because a silent `return` is neither a send nor a skip.
 *
 * These drive `reclaim` through the same fake client the engine uses, so the
 * conditional update is exercised rather than described.
 */
describe('taking over a claimed step', () => {
  const STEP = 'step-1';
  const ENROLMENT = 'enrolment-1';

  function client(prior: { status: string; created_at: string } | null) {
    const updates: Array<Record<string, unknown>> = [];
    let matchedStatus: string | null = null;

    const api = {
      updates,
      from() {
        const filters: Record<string, unknown> = {};
        let patch: Record<string, unknown> | null = null;
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          },
          update: (values: Record<string, unknown>) => {
            patch = values;
            return builder;
          },
          maybeSingle: () => {
            if (patch) {
              // The conditional update: only applies if status is unchanged.
              if (prior && filters.status === prior.status) {
                matchedStatus = String(filters.status);
                updates.push(patch as Record<string, unknown>);
                return Promise.resolve({ data: { id: 'm1', body: 'body' }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({
              data: prior ? { id: 'm1', ...prior } : null,
              error: null
            });
          }
        };
        return builder;
      },
      get matched() {
        return matchedStatus;
      }
    };
    return api;
  }

  const NOW = new Date('2026-08-18T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  async function attempt(prior: { status: string; created_at: string } | null) {
    const fake = client(prior);
    const result = await reclaimForTest(
      fake as never,
      ENROLMENT,
      STEP,
      { status: 'queued', subject: 's', body: 'b' },
      NOW
    );
    return { result, updates: fake.updates };
  }

  it('retakes a failed send, which is the whole point of a retry', async () => {
    const { result, updates } = await attempt({ status: 'failed', created_at: ago(60_000) });
    expect(result).toEqual({ id: 'm1', body: 'body' });
    // The previous error is cleared, so the ledger shows this attempt's outcome.
    expect(updates[0]).toMatchObject({ status: 'queued', error: null });
  });

  it.each(['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'])(
    'refuses to retake a %s message, because it already left',
    async (status) => {
      const { result, updates } = await attempt({ status, created_at: ago(999_999_999) });
      expect(result).toBeNull();
      expect(updates).toEqual([]);
    }
  );

  it('leaves a fresh queued claim alone — another run is mid-send', async () => {
    const { result } = await attempt({ status: 'queued', created_at: ago(60_000) });
    expect(result).toBeNull();
  });

  it('retakes a queued claim once the lease has expired', async () => {
    const { result } = await attempt({
      status: 'queued',
      created_at: ago(CLAIM_LEASE_MS + 60_000)
    });
    expect(result).toEqual({ id: 'm1', body: 'body' });
  });

  it('backs off when the row vanished', async () => {
    expect((await attempt(null)).result).toBeNull();
  });
});

/**
 * Telling absent from blank.
 *
 * "No email provider is configured" was true of three situations with three
 * different fixes, and working out which cost several rounds of guessing
 * against a live deployment. The distinction is now made in code and shown on
 * the page.
 */
describe('why a channel is unavailable', () => {
  it('is ready when the key has a value', () => {
    expect(emailProviderState({ RESEND_API_KEY: 're_abc123' })).toBe('ready');
  });

  it('is absent when the variable is not in the environment', () => {
    expect(emailProviderState({})).toBe('absent');
  });

  it('is blank when the variable exists with an empty value', () => {
    expect(emailProviderState({ RESEND_API_KEY: '' })).toBe('blank');
    expect(emailProviderState({ RESEND_API_KEY: '   ' })).toBe('blank');
  });

  it('treats an explicitly undefined variable as absent', () => {
    expect(emailProviderState({ RESEND_API_KEY: undefined })).toBe('absent');
  });

  it('tolerates a key pasted with surrounding whitespace', () => {
    // Copying an API key out of a dashboard routinely brings a newline with
    // it. That is still the key.
    expect(emailProvider({ RESEND_API_KEY: '  re_abc123\n' })).not.toBeNull();
    expect(isEmailConfigured({ RESEND_API_KEY: '  re_abc123\n' })).toBe(true);
  });

  it('needs both halves of the Twilio pair', () => {
    expect(smsProviderState({ TWILIO_ACCOUNT_SID: 'AC1' })).toBe('absent');
    expect(smsProviderState({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: '' })).toBe('blank');
    expect(smsProviderState({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' })).toBe('ready');
  });

  it('says something actionable for each state', () => {
    expect(providerProblem('ready', 'RESEND_API_KEY')).toBeNull();
    expect(providerProblem('blank', 'RESEND_API_KEY')).toContain('value is empty');
    // The redeploy note matters: Vercel binds variables at build time, so
    // adding one changes nothing until the next deployment.
    expect(providerProblem('absent', 'RESEND_API_KEY')).toContain('redeploy');
  });
});
