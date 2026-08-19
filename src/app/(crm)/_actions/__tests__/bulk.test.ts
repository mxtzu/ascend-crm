/**
 * The bulk stage action.
 *
 * Row level security is the real control here — `crm_leads_update` requires
 * `crm_can_write()` — so unlike the import this is not the only thing standing
 * between a viewer and a write. What is worth testing is everything RLS cannot
 * express: the do-not-contact safeguard, the selection cap, id validation, and
 * that a filtered view is returned to rather than a bare /leads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpportunitiesForLeads, moveLeadsToStage } from '../bulk';

const h = vi.hoisted(() => ({
  redirects: [] as string[],
  rows: [] as Array<{ id: string; pipeline_stage: string }>,
  updates: [] as Array<{ stage: string; ids: string[] }>,
  writerError: null as Error | null,
  openOpportunities: [] as string[],
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcFailOn: null as string | null
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    h.redirects.push(url);
    throw new Error('NEXT_REDIRECT');
  }
}));

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeBuilder {
  select(columns?: string): FakeBuilder;
  eq(): FakeBuilder;
  not(): FakeBuilder;
  update(patch: { pipeline_stage: string }): FakeBuilder;
  in(column: string, ids: string[]): FakeBuilder;
  then(
    resolve: (value: FakeResult) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown>;
}

/**
 * A thenable query builder, because the chains under test do not all end on
 * the same method: the stage read finishes on `.in()`, the open-deal lookup
 * finishes on `.not()`. Resolving on await instead of on a chosen terminal
 * method keeps the fake honest about order.
 *
 * A `function` declaration on purpose — `vi.mock` factories are hoisted above
 * the imports, so a `const` here would be in its temporal dead zone.
 */
function fakeFrom(table: string): FakeBuilder {
  const state: { stage?: string; ids: string[]; withCompany: boolean } = {
    ids: [],
    withCompany: false
  };

  function compute(): FakeResult {
    if (table === 'opportunities') {
      return {
        data: h.openOpportunities
          .filter((id) => state.ids.indexOf(id) !== -1)
          .map((id) => ({ crm_lead_id: id })),
        error: null
      };
    }
    if (state.stage) {
      h.updates.push({ stage: state.stage, ids: state.ids });
      return { data: null, error: null };
    }
    const matched = h.rows.filter((row) => state.ids.indexOf(row.id) !== -1);
    return {
      data: state.withCompany
        ? matched.map((row) => ({
            id: row.id,
            external_lead_id: `ext-${row.id.slice(0, 4)}`,
            lead_intelligence: { company_name: 'Acme Ltd' }
          }))
        : matched,
      error: null
    };
  }

  const builder: FakeBuilder = {
    select(columns?: string) {
      state.withCompany = Boolean(columns && columns.indexOf('lead_intelligence') !== -1);
      return builder;
    },
    eq: () => builder,
    not: () => builder,
    update(patch: { pipeline_stage: string }) {
      state.stage = patch.pipeline_stage;
      return builder;
    },
    in(_column: string, ids: string[]) {
      state.ids = ids;
      return builder;
    },
    then(resolve, reject) {
      return Promise.resolve(compute()).then(resolve, reject);
    }
  };
  return builder;
}

vi.mock('@/lib/crm/server', () => ({
  requireWriter: async () => {
    if (h.writerError) throw h.writerError;
    return {
      profile: { id: 'p1', role: 'sales', is_active: true },
      userId: 'p1',
      client: {
        async rpc(_name: string, args: Record<string, unknown>) {
          h.rpcCalls.push(args);
          if (h.rpcFailOn && args.p_lead_id === h.rpcFailOn) {
            return { data: null, error: { message: 'An opportunity needs a name.' } };
          }
          return { data: 'opp-1', error: null };
        },
        from: fakeFrom
      }
    };
  }
}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function form(stage: string, ids: string[], returnTo?: string): FormData {
  const data = new FormData();
  data.append('stage', stage);
  for (const id of ids) data.append('lead_id', id);
  if (returnTo !== undefined) data.append('return_to', returnTo);
  return data;
}

async function submit(data: FormData) {
  await expect(moveLeadsToStage(data)).rejects.toThrow('NEXT_REDIRECT');
  const url = h.redirects[h.redirects.length - 1];
  const params = new URL(url, 'http://x').searchParams;
  return {
    url,
    path: url.split('?')[0],
    error: params.get('error') ?? undefined,
    notice: params.get('notice') ?? undefined
  };
}

beforeEach(() => {
  h.redirects.length = 0;
  h.updates.length = 0;
  h.writerError = null;
  h.rows = [
    { id: A, pipeline_stage: 'qualified' },
    { id: B, pipeline_stage: 'qualified' },
    { id: C, pipeline_stage: 'do_not_contact' }
  ];
});

describe('moving leads', () => {
  it('writes the target stage once for the selection', async () => {
    const { notice } = await submit(form('ready_for_outreach', [A, B]));
    expect(h.updates).toEqual([{ stage: 'ready_for_outreach', ids: [A, B] }]);
    expect(notice).toContain('Moved 2 leads');
  });

  it('leaves a do_not_contact lead alone and says so', async () => {
    const { notice } = await submit(form('ready_for_outreach', [A, C]));
    expect(h.updates).toEqual([{ stage: 'ready_for_outreach', ids: [A] }]);
    expect(notice).toContain('do not contact');
  });

  it('writes nothing when every selected lead is already there', async () => {
    h.rows = [{ id: A, pipeline_stage: 'contacted' }];
    const { notice } = await submit(form('contacted', [A]));
    expect(h.updates).toEqual([]);
    expect(notice).toContain('already there');
  });

  it('deduplicates a selection submitted twice', async () => {
    await submit(form('contacted', [A, A, B]));
    expect(h.updates[0].ids).toEqual([A, B]);
  });
});

describe('what it refuses', () => {
  it('an empty selection', async () => {
    const { error } = await submit(form('contacted', []));
    expect(error).toContain('Tick the leads');
    expect(h.updates).toEqual([]);
  });

  it('a stage that is not one', async () => {
    const { error } = await submit(form('outreachy', [A]));
    expect(error).toContain('Choose a stage');
    expect(h.updates).toEqual([]);
  });

  it('an id that is not a uuid', async () => {
    const { error } = await submit(form('contacted', ['../../etc/passwd']));
    expect(error).toContain('not valid');
    expect(h.updates).toEqual([]);
  });

  it('more than the selection cap', async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`
    );
    const { error } = await submit(form('contacted', many));
    expect(error).toContain('501 leads');
    expect(h.updates).toEqual([]);
  });

  it('a selection whose leads have all vanished', async () => {
    h.rows = [];
    const { error } = await submit(form('contacted', [A]));
    expect(error).toContain('no longer exist');
    expect(h.updates).toEqual([]);
  });

  it("a viewer's write, by reporting what requireWriter threw", async () => {
    h.writerError = new Error('Your role is read-only. Ask an admin for write access.');
    const { error } = await submit(form('contacted', [A]));
    expect(error).toContain('read-only');
    expect(h.updates).toEqual([]);
  });
});

describe('where it sends you back to', () => {
  it('the filtered view being worked through', async () => {
    const { path, url } = await submit(
      form('contacted', [A], '/leads?stage=qualified&min_score=60')
    );
    expect(path).toBe('/leads');
    expect(url).toContain('stage=qualified');
    expect(url).toContain('min_score=60');
  });

  it('/leads when no return path was given', async () => {
    expect((await submit(form('contacted', [A]))).path).toBe('/leads');
  });

  it('refuses an off-site return path', async () => {
    // The backslash form browsers normalise to //. See src/lib/crm/redirects.ts.
    const { path } = await submit(form('contacted', [A], '/\\evil.example'));
    expect(path).toBe('/leads');
  });
});

/**
 * Bulk conversion to opportunities.
 *
 * The RPC does the real work — deal, stage advance and activity in one
 * transaction — so what is worth testing here is everything around it: the
 * cap, the duplicate guard, that one failure does not abandon the rest, and
 * that a partial success is reported as one.
 */
describe('opening opportunities in bulk', () => {
  function convertForm(ids: string[], fields: Record<string, string> = {}): FormData {
    const data = new FormData();
    for (const id of ids) data.append('lead_id', id);
    for (const key of Object.keys(fields)) data.append(key, fields[key]);
    return data;
  }

  async function submitConvert(data: FormData) {
    await expect(createOpportunitiesForLeads(data)).rejects.toThrow('NEXT_REDIRECT');
    const url = h.redirects[h.redirects.length - 1];
    const params = new URL(url, 'http://x').searchParams;
    return {
      error: params.get('error') ?? undefined,
      notice: params.get('notice') ?? undefined
    };
  }

  beforeEach(() => {
    h.openOpportunities = [];
    h.rpcCalls.length = 0;
    h.rpcFailOn = null;
  });

  it('opens one deal per lead, named after the company', async () => {
    const { notice } = await submitConvert(convertForm([A, B]));
    expect(h.rpcCalls.length).toBe(2);
    expect(h.rpcCalls[0].p_name).toBe('Acme Ltd');
    expect(notice).toContain('Opened 2 opportunities');
  });

  it('appends the shared service to every name', async () => {
    await submitConvert(convertForm([A], { service_name: 'SEO retainer' }));
    expect(h.rpcCalls[0].p_name).toBe('Acme Ltd — SEO retainer');
    expect(h.rpcCalls[0].p_service_name).toBe('SEO retainer');
  });

  it('passes the stage and monthly value through', async () => {
    await submitConvert(convertForm([A], { opportunity_stage: 'proposal', monthly_value: '1500' }));
    expect(h.rpcCalls[0].p_stage).toBe('proposal');
    expect(h.rpcCalls[0].p_monthly_value).toBe(1500);
  });

  it('defaults to discovery with no commercials', async () => {
    await submitConvert(convertForm([A]));
    expect(h.rpcCalls[0].p_stage).toBe('discovery');
    expect(h.rpcCalls[0].p_monthly_value).toBeNull();
  });

  it('skips a lead that already has an open deal', async () => {
    h.openOpportunities = [A];
    const { notice } = await submitConvert(convertForm([A, B]));
    expect(h.rpcCalls.length).toBe(1);
    expect(notice).toContain('1 lead already had an open deal');
  });

  it('keeps going after one lead fails, and says so', async () => {
    h.rpcFailOn = B;
    const { notice } = await submitConvert(convertForm([A, B]));
    expect(h.rpcCalls.length).toBe(2);
    expect(notice).toContain('Opened 1 opportunity');
    expect(notice).toContain('1 failed');
  });

  it('refuses more than the cap', async () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`
    );
    const { error } = await submitConvert(convertForm(many));
    expect(error).toContain('101 leads');
    expect(h.rpcCalls).toEqual([]);
  });

  it('refuses a stage that is not one', async () => {
    const { error } = await submitConvert(convertForm([A], { opportunity_stage: 'daydream' }));
    expect(error).toContain('not an opportunity stage');
    expect(h.rpcCalls).toEqual([]);
  });

  it('refuses a negative monthly value', async () => {
    const { error } = await submitConvert(convertForm([A], { monthly_value: '-5' }));
    expect(error).toContain('0 or more');
    expect(h.rpcCalls).toEqual([]);
  });

  it("refuses a viewer's write", async () => {
    h.writerError = new Error('Your role is read-only. Ask an admin for write access.');
    const { error } = await submitConvert(convertForm([A]));
    expect(error).toContain('read-only');
    expect(h.rpcCalls).toEqual([]);
  });
});
