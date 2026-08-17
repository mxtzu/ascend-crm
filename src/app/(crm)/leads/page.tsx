/**
 * Lead list — the working surface for research output.
 *
 * Filters are read from the query string so a filtered view is a shareable URL.
 * They are applied as PostgREST filters, not in JavaScript, so the row limit
 * applies after filtering rather than to an arbitrary first page.
 */

import Link from 'next/link';

import { moveLeadsToStage } from '@/app/(crm)/_actions/bulk';
import { BulkStageBar, SelectAllLeads, SelectLead } from '@/components/crm/bulkStage';
import { ActionError, ActionNotice, ReturnTo } from '@/components/crm/forms';
import { ImportPanel } from '@/components/crm/importPanel';
import {
  AdvertisingBadge,
  Card,
  Cell,
  EmptyState,
  PageHeader,
  Row,
  ScoreBadge,
  StageBadge,
  Table
} from '@/components/crm/ui';
import { formatRelative, orDash } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { listLeads } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS, isPipelineStage } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

interface SearchParams {
  stage?: string;
  q?: string;
  min_score?: string;
  error?: string;
  notice?: string;
}

export default async function LeadsPage({ searchParams }: { searchParams?: SearchParams }) {
  const stage = isPipelineStage(searchParams?.stage) ? searchParams.stage : undefined;
  const search = searchParams?.q?.trim() || undefined;
  const parsedScore = Number(searchParams?.min_score);
  const minScore = Number.isFinite(parsedScore) && parsedScore > 0 ? parsedScore : undefined;

  const { client, profile } = await crmSession();
  const leads = await listLeads(client, { stage, search, minScore, limit: 200 });
  const canImport = isAdmin(profile);
  const canMove = canWrite(profile);
  const unfiltered = !stage && !search && !minScore;

  // Round-trips the caller to the view they were working through rather than a
  // bare /leads, so a filtered batch can be worked in passes.
  const query = new URLSearchParams();
  if (stage) query.set('stage', stage);
  if (search) query.set('q', search);
  if (minScore) query.set('min_score', String(minScore));
  const here = query.toString() ? `/leads?${query.toString()}` : '/leads';

  return (
    <>
      <PageHeader
        eyebrow="Research"
        title="Leads"
        description="Businesses discovered and scored by the lead pipeline. Sales state lives here; the underlying research is a read-only snapshot."
      />

      <ActionError message={searchParams?.error} />
      <ActionNotice message={searchParams?.notice} />

      {/* Open on an empty CRM: importing is the only useful thing on this page
          until there is something in it. */}
      <ImportPanel canImport={canImport} open={leads.length === 0 && unfiltered} />

      <Card className="mb-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-[200px] flex-1">
            <span className="label-mono text-white/40">Search</span>
            <input
              type="search"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Company name"
              className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-white/25"
            />
          </label>
          <label>
            <span className="label-mono text-white/40">Stage</span>
            <select
              name="stage"
              defaultValue={stage ?? ''}
              className="mt-1.5 rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
            >
              <option value="">All stages</option>
              {PIPELINE_STAGES.map((value) => (
                <option key={value} value={value}>
                  {PIPELINE_STAGE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label-mono text-white/40">Min score</span>
            <input
              type="number"
              name="min_score"
              min={0}
              max={100}
              defaultValue={minScore ?? ''}
              className="mt-1.5 w-24 rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
          >
            Apply
          </button>
          {stage || search || minScore ? (
            <Link href="/leads" className="px-2 py-2 text-sm text-white/45 hover:text-white/75">
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      <form action={moveLeadsToStage}>
      <ReturnTo path={here} />
      <Card
        title={`${leads.length} lead${leads.length === 1 ? '' : 's'}`}
        description={leads.length === 200 ? 'Showing the first 200 matches.' : undefined}
        footer={canMove && leads.length > 0 ? <BulkStageBar stageCount={leads.length} /> : undefined}
      >
        {leads.length === 0 ? (
          <EmptyState
            title="No leads match"
            description={
              canImport
                ? 'Import a pipeline export using the panel above, or widen the filters.'
                : 'Widen the filters, or ask an owner or admin to import a pipeline export.'
            }
          />
        ) : (
          <Table
            head={[
              canMove ? <SelectAllLeads key="all" /> : '',
              'Business',
              'Contact',
              'Location',
              'Score',
              'Ads',
              'Stage',
              'Owner',
              'Updated'
            ]}
          >
            {leads.map((lead) => {
              const info = lead.intelligence;
              return (
                <Row key={lead.id}>
                  <Cell className="w-8">{canMove ? <SelectLead id={lead.id} /> : null}</Cell>
                  <Cell>
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium text-white hover:text-electric-300"
                    >
                      {info?.company_name ?? lead.external_lead_id}
                    </Link>
                    <p className="mt-0.5 text-xs text-white/35">
                      {[info?.domain, info?.niche?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                    </p>
                  </Cell>
                  <Cell className="text-white/50">
                    {info?.contact_name ? (
                      <>
                        {info.contact_name}
                        {info.contact_role ? (
                          <p className="mt-0.5 text-xs text-white/30">{info.contact_role}</p>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-white/25">—</span>
                    )}
                  </Cell>
                  <Cell className="text-white/50">{orDash(info?.city)}</Cell>
                  <Cell>
                    <ScoreBadge score={info?.lead_score} />
                  </Cell>
                  <Cell>
                    <AdvertisingBadge status={info?.advertising_status} />
                  </Cell>
                  <Cell>
                    <StageBadge stage={lead.pipeline_stage} />
                  </Cell>
                  <Cell className="text-white/45">{orDash(lead.owner?.full_name)}</Cell>
                  <Cell className="whitespace-nowrap text-white/40">
                    {formatRelative(lead.updated_at)}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </Card>
      </form>
    </>
  );
}
