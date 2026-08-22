/**
 * Outreach home — the landing surface for `/engagement/outreach`.
 * Campaigns and reusable templates are separate first-class views. Opening the
 * landing page never mints an empty campaign.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  CircleAlert,
  FileText,
  Loader2,
  Mail,
  Plus,
  RotateCcw,
  Send,
  Users,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import {
  archiveOutreachV3Session,
  createOutreachV3Session,
  listOutreachV3Sessions,
  outreachV3CampaignBucket,
  safeOutreachV3Error,
  type OutreachV3CampaignBucket,
  type OutreachV3SessionSummary,
} from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import { VNextOutreachTemplates } from './VNextOutreachTemplates.js';
import './outreach-home-vnext.css';

export interface VNextOutreachHomeProps {
  onOpenCampaign: (sessionId: string) => void;
  selectedClientId: string | null;
}

type HomeFilter = 'all' | 'draft' | 'sent' | 'archived';
type HomeView = 'campaigns' | 'templates';

const FILTERS: Array<{ key: HomeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Sent' },
  { key: 'archived', label: 'Archived' },
];

export function outreachCampaignPill(row: OutreachV3SessionSummary): {
  label: string;
  tone: string;
} {
  if (outreachV3CampaignBucket(row) === 'archived') {
    return { label: 'Archived', tone: 'eng-pill--gray' };
  }
  switch ((row.recordStatus ?? '').trim().toLowerCase()) {
    case 'sent':
      return { label: 'Sent', tone: 'eng-pill--navy' };
    case 'partial':
      return { label: 'Partial', tone: 'eng-pill--warn' };
    case 'failed':
      return { label: 'Failed', tone: 'eng-pill--err' };
    default:
      return { label: 'Draft', tone: 'eng-pill--gray' };
  }
}

export function outreachCampaignName(row: OutreachV3SessionSummary): string {
  return row.topic?.trim() || row.title?.trim() || 'Untitled campaign';
}

export function outreachCampaignStatusDetail(row: OutreachV3SessionSummary): string {
  const record = (row.recordStatus ?? '').trim().toLowerCase();
  if (record === 'partial') return 'Sent with failures';
  if (record === 'failed') return 'Send failed';
  if (record === 'sent') return 'Sent';
  if (row.status === 'archived') return 'Archived';
  return 'In progress';
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function VNextOutreachHome({
  onOpenCampaign,
  selectedClientId,
}: VNextOutreachHomeProps) {
  const api = useApi();
  const qc = useQueryClient();
  const [view, setView] = useState<HomeView>('campaigns');
  const [filter, setFilter] = useState<HomeFilter>('all');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const campaigns = useQuery({
    queryKey: ['outreach-v3', 'sessions', 'home'],
    queryFn: () => listOutreachV3Sessions(api, { limit: 100, includeArchived: true }),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createOutreachV3Session(api, 'New outreach campaign'),
    onSuccess: async (envelope) => {
      setActionError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'sessions'] });
      onOpenCampaign(envelope.session.id);
    },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
  });

  const archive = useMutation({
    mutationFn: (sessionId: string) => archiveOutreachV3Session(api, sessionId),
    onSuccess: async () => {
      setActionError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'sessions'] });
    },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
    onSettled: () => setArchivingId(null),
  });

  const rows = campaigns.data ?? [];
  const counts = useMemo(() => {
    const tally: Record<OutreachV3CampaignBucket, number> = {
      draft: 0,
      sent: 0,
      archived: 0,
    };
    for (const row of rows) tally[outreachV3CampaignBucket(row)] += 1;
    return tally;
  }, [rows]);

  const visible = useMemo(
    () =>
      filter === 'all'
        ? rows.filter((row) => outreachV3CampaignBucket(row) !== 'archived')
        : rows.filter((row) => outreachV3CampaignBucket(row) === filter),
    [filter, rows],
  );
  const listError = campaigns.isError ? safeOutreachV3Error(campaigns.error) : null;
  const activeFilterLabel =
    FILTERS.find((entry) => entry.key === filter)?.label.toLowerCase() ?? '';

  return (
    <div className="uui-outreach-home">
      <nav className="uui-outreach-home__mode" aria-label="Outreach library">
        <button type="button" data-active={view === 'campaigns' || undefined} onClick={() => setView('campaigns')}><Mail size={15} />Campaigns</button>
        <button type="button" data-active={view === 'templates' || undefined} onClick={() => setView('templates')}><FileText size={15} />Templates</button>
      </nav>

      {view === 'templates' ? (
        <VNextOutreachTemplates
          selectedClientId={selectedClientId}
          onOpenCampaign={onOpenCampaign}
        />
      ) : (
        <>
          <header className="uui-outreach-home__bar">
            <div className="uui-outreach-home__summary">
              <span className="uui-eyebrow">Campaigns</span>
              <p>
                {campaigns.isLoading
                  ? 'Loading your campaigns…'
                  : `${counts.draft} draft · ${counts.sent} sent${
                      counts.archived ? ` · ${counts.archived} archived` : ''
                    }`}
              </p>
            </div>
            <div className="uui-outreach-home__actions">
              <button type="button" className="uui-button" disabled={campaigns.isFetching} onClick={() => void campaigns.refetch()}>
                {campaigns.isFetching ? <Loader2 className="uui-spin" size={14} /> : <RotateCcw size={14} />}
                Refresh
              </button>
              <button type="button" className="uui-button--primary uui-outreach-home__new" disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="uui-spin" size={16} /> : <Plus size={16} />}
                New campaign
              </button>
            </div>
          </header>

          <nav className="uui-outreach-home__filters" aria-label="Campaign status">
            {FILTERS.map((entry) => (
              <button key={entry.key} type="button" data-active={filter === entry.key || undefined} onClick={() => setFilter(entry.key)}>{entry.label}</button>
            ))}
          </nav>

          {listError ? (
            <div className="uui-engagement-error uui-engagement-error--inside" role="alert">
              <strong>Your campaigns could not be loaded</strong>
              <p>{listError}</p>
              <button type="button" className="uui-button" onClick={() => void campaigns.refetch()}>Try again</button>
            </div>
          ) : null}

          {actionError ? <div className="uui-outreach-home__error" role="alert"><CircleAlert size={16} />{actionError}</div> : null}

          {!listError && campaigns.isLoading ? (
            <div className="uui-outreach-home__skeleton" aria-busy="true"><i /><i /><i /></div>
          ) : null}

          {!listError && !campaigns.isLoading && visible.length === 0 ? (
            <div className="uui-outreach-home__empty">
              <Mail size={26} />
              <strong>{rows.length === 0 ? 'No campaigns yet' : `No ${activeFilterLabel} campaigns`}</strong>
              <p>{rows.length === 0 ? 'Start a governed campaign: goal, targets, delivery, context, immutable drafts, preflight, send.' : 'Nothing in this view. Switch the filter above, or start a new campaign.'}</p>
              <button type="button" className="uui-button--primary" disabled={create.isPending} onClick={() => create.mutate()}><Plus size={16} />New campaign</button>
            </div>
          ) : null}

          {visible.length > 0 ? (
            <div className="uui-outreach-home__table">
              <div className="uui-outreach-home__head" aria-hidden="true">
                <span>Status</span><span>Campaign</span><span>Targets</span><span>Last updated</span><span>Sent</span><span />
              </div>
              {visible.map((row) => {
                const bucket = outreachV3CampaignBucket(row);
                const pill = outreachCampaignPill(row);
                const name = outreachCampaignName(row);
                const detail = outreachCampaignStatusDetail(row);
                const record = (row.recordStatus ?? '').trim().toLowerCase();
                const subline = record === 'partial' || record === 'failed'
                  ? [detail, row.goal?.trim()].filter(Boolean).join(' · ')
                  : row.goal?.trim() || detail;
                return (
                  <div key={row.id} className="uui-outreach-home__row" data-archived={bucket === 'archived' || undefined}>
                    <button type="button" className="uui-outreach-home__open" onClick={() => onOpenCampaign(row.id)} title={`Open ${name}`}>
                      <span className={`eng-pill eng-pill--sm ${pill.tone}`}>{pill.label}</span>
                      <span className="uui-outreach-home__title"><strong>{name}</strong><small>{subline} · v{row.currentStateVersion}</small></span>
                      <span className="uui-outreach-home__count"><Users size={14} />{row.targetCount ?? 0}</span>
                      <span className="uui-outreach-home__when">{formatWhen(row.updatedAt)}</span>
                      <span className="uui-outreach-home__when">{row.sentAt ? <><Send size={13} /> {formatWhen(row.sentAt)}</> : '—'}</span>
                    </button>
                    {bucket === 'archived' ? <span className="uui-outreach-home__rowaction" /> : (
                      <button type="button" className="uui-button uui-outreach-home__rowaction" disabled={archivingId === row.id} title={`Archive ${name}`} onClick={() => { setArchivingId(row.id); archive.mutate(row.id); }}><Archive size={13} />{archivingId === row.id ? '…' : 'Archive'}</button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
