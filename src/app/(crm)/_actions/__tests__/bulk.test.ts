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

import { moveLeadsToStage } from '../bulk';

const h = vi.hoisted(() => ({
  redirects: [] as string[],
  rows: [] as Array<{ id: string; pipeline_stage: string }>,
  updates: [] as Array<{ stage: string; ids: string[] }>,
  writerError: null as Error | null
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    h.redirects.push(url);
    throw new Error('NEXT_REDIRECT');
  }
}));

vi.mock('@/lib/crm/server', () => ({
  requireWriter: async () => {
    if (h.writerError) throw h.writerError;
    return {
      profile: { id: 'p1', role: 'sales', is_active: true },
      userId: 'p1',
      client: {
        from() {
          const state: { stage?: string } = {};
          const builder = {
            select: () => builder,
            update: (patch: { pipeline_stage: string }) => {
              state.stage = patch.pipeline_stage;
              return builder;
            },
            in: (_column: string, ids: string[]) => {
              if (state.stage) {
                h.updates.push({ stage: state.stage, ids });
                return Promise.resolve({ data: null, error: null });
              }
              return Promise.resolve({
                data: h.rows.filter((row) => ids.indexOf(row.id) !== -1),
                error: null
              });
            }
          };
          return builder;
        }
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
