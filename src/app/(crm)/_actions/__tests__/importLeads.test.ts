/**
 * The import action, end to end with its collaborators faked.
 *
 * This one is worth testing at the action level rather than only its pure
 * parts. `lead_intelligence` has no write policy for any CRM role, so the
 * import runs as the service role and row level security is not behind it —
 * the role check inside the action is the entire control. A pure test of
 * `isAdmin` would not notice if the action stopped calling it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipelineLeadExport, SyncResult } from '@/lib/crm/sync';
import type { CrmRole, Profile } from '@/lib/crm/types';

import { importLeads } from '../importLeads';

/**
 * Mutable state the mock factories read.
 *
 * It has to go through `vi.hoisted` because vitest lifts `vi.mock` calls above
 * the imports, and a factory that closed over an ordinary `const` would run
 * before that `const` was initialised.
 */
const h = vi.hoisted(() => ({
  redirects: [] as string[],
  profile: null as Partial<Profile> | null,
  serviceRoleConfigured: true,
  syncLeads:
    vi.fn<(client: unknown, leads: PipelineLeadExport[], options: unknown) => Promise<SyncResult>>()
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

vi.mock('next/navigation', () => ({
  // The real one throws to unwind the request; mirroring that keeps the
  // action's control flow honest — anything after a redirect must not run.
  redirect: (url: string) => {
    h.redirects.push(url);
    throw new Error('NEXT_REDIRECT');
  }
}));

vi.mock('@/lib/crm/server', () => ({
  crmSession: async () => ({ client: {}, profile: h.profile })
}));

vi.mock('@/lib/crm/supabase', () => ({
  isServiceRoleConfigured: () => h.serviceRoleConfigured,
  createServiceClient: () => ({ service: true })
}));

vi.mock('@/lib/crm/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/sync')>();
  return { ...actual, syncLeads: h.syncLeads };
});

function as(role: CrmRole, isActive = true): Partial<Profile> {
  return { id: 'p1', role, is_active: isActive };
}

function exportFile(leads: Partial<PipelineLeadExport>[], name = 'leads.json'): File {
  return new File([JSON.stringify({ leads })], name, { type: 'application/json' });
}

function form(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const key of Object.keys(fields)) data.append(key, fields[key] as string);
  return data;
}

/** Runs the action and returns the message it redirected back with. */
async function submit(data: FormData): Promise<{ url: string; error?: string; notice?: string }> {
  await expect(importLeads(data)).rejects.toThrow('NEXT_REDIRECT');
  const url = h.redirects[h.redirects.length - 1];
  const params = new URL(url, 'http://x').searchParams;
  return { url, error: params.get('error') ?? undefined, notice: params.get('notice') ?? undefined };
}

const oneLead = [{ lead_id: 'abc123', company_name: 'Example Ltd', lead_score: 70 }];

beforeEach(() => {
  h.redirects.length = 0;
  h.profile = as('owner');
  h.serviceRoleConfigured = true;
  h.syncLeads.mockReset();
  h.syncLeads.mockResolvedValue({
    received: 1,
    skippedBelowMinScore: 0,
    skippedInvalid: 0,
    crmLeadsCreated: 1,
    crmLeadsExisting: 0,
    intelligenceUpserted: 1,
    errors: []
  });
});

describe('who may import', () => {
  it('lets an owner through', async () => {
    const { notice } = await submit(form({ file: exportFile(oneLead) }));
    expect(h.syncLeads).toHaveBeenCalledOnce();
    expect(notice).toContain('1 new lead');
  });

  it('lets an admin through', async () => {
    h.profile = as('admin');
    await submit(form({ file: exportFile(oneLead) }));
    expect(h.syncLeads).toHaveBeenCalledOnce();
  });

  /**
   * The test that matters. `sales` and `account_manager` pass `canWrite`, so
   * an accidental downgrade from `isAdmin` to `canWrite` would open bulk
   * service-role writes to them with nothing else to catch it.
   */
  it.each<CrmRole>(['sales', 'account_manager', 'viewer'])('refuses %s', async (role) => {
    h.profile = as(role);
    const { error } = await submit(form({ file: exportFile(oneLead) }));
    expect(error).toContain('owners and admins');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller', async () => {
    h.profile = null;
    const { error } = await submit(form({ file: exportFile(oneLead) }));
    expect(error).toBeTruthy();
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses a deactivated owner', async () => {
    h.profile = as('owner', false);
    const { error } = await submit(form({ file: exportFile(oneLead) }));
    expect(error).toBeTruthy();
    expect(h.syncLeads).not.toHaveBeenCalled();
  });
});

describe('the upload', () => {
  it('asks for a file when none was chosen', async () => {
    const { error } = await submit(form({}));
    expect(error).toContain('Choose a JSON export');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses a file over the limit, and names the CLI', async () => {
    const big = new File(['x'.repeat(4 * 1024 * 1024 + 1)], 'huge.json');
    const { error } = await submit(form({ file: big }));
    expect(error).toContain('sync:leads');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses malformed JSON by name', async () => {
    const { error } = await submit(form({ file: new File(['{oops'], 'broken.json') }));
    expect(error).toContain('broken.json');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses a document with no leads array', async () => {
    const { error } = await submit(form({ file: new File(['{"rows":[]}'], 'wrong.json') }));
    expect(error).toContain('leads');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('refuses an empty leads array rather than reporting a no-op success', async () => {
    const { error } = await submit(form({ file: exportFile([]) }));
    expect(error).toContain('empty');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });
});

describe('options', () => {
  it('passes the score floor and starting stage through', async () => {
    await submit(form({ file: exportFile(oneLead), min_score: '55', stage: 'ready_for_outreach' }));
    expect(h.syncLeads).toHaveBeenCalledWith(expect.anything(), expect.any(Array), {
      minScore: 55,
      initialStage: 'ready_for_outreach'
    });
  });

  it('defaults to importing everything at qualified', async () => {
    await submit(form({ file: exportFile(oneLead) }));
    expect(h.syncLeads).toHaveBeenCalledWith(expect.anything(), expect.any(Array), {
      minScore: 0,
      initialStage: 'qualified'
    });
  });

  it('rejects a score outside 0–100', async () => {
    const { error } = await submit(form({ file: exportFile(oneLead), min_score: '900' }));
    expect(error).toContain('between 0 and 100');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('rejects a stage that is not one', async () => {
    const { error } = await submit(form({ file: exportFile(oneLead), stage: 'wishful' }));
    expect(error).toContain('not a pipeline stage');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('writes nothing', async () => {
    const { notice } = await submit(form({ file: exportFile(oneLead), dry_run: 'on' }));
    expect(h.syncLeads).not.toHaveBeenCalled();
    expect(notice).toContain('nothing was written');
  });

  it('still reports what would happen', async () => {
    const { notice } = await submit(
      form({
        file: exportFile([...oneLead, { lead_id: 'low', company_name: 'Low Ltd', lead_score: 5 }]),
        min_score: '50',
        dry_run: 'on'
      })
    );
    expect(notice).toContain('1 lead would be imported');
    expect(notice).toContain('below the score floor of 50');
  });
});

describe('a deployment without the service role', () => {
  it('refuses the real import rather than failing mid-write', async () => {
    h.serviceRoleConfigured = false;
    const { error } = await submit(form({ file: exportFile(oneLead) }));
    expect(error).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(h.syncLeads).not.toHaveBeenCalled();
  });

  it('still allows a preview, which needs no database at all', async () => {
    h.serviceRoleConfigured = false;
    const { notice } = await submit(form({ file: exportFile(oneLead), dry_run: 'on' }));
    expect(notice).toContain('nothing was written');
  });
});
