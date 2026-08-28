/**
 * Outreach home — the landing surface for `/engagement/outreach`.
 * Campaigns and reusable templates are separate first-class views. Opening the
 * landing page never mints an empty campaign.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  FileText,
  Loader2,
  Mail,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
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
import './outreach-builder.css';
import './outreach-home-vnext.css';

/**
 * What the campaign was started from. The prototype's chooser writes this to
 * `bStart` and surfaces it later as the builder's context label and the Name
 * step's "Started from" row; here it is handed back through `onOpenCampaign`.
 */
export type OutreachStartedFrom = 'Firm Template' | 'Capiro Template';

/**
 * The two entry tiles, verbatim from the prototype's chooser.
 *
 * Both create a real campaign and land on step 1 — they differ only in the
 * provenance label, exactly as the prototype's two handlers do. "Capiro
 * Template" deliberately does NOT browse a Capiro-curated library: no `capiro`
 * template scope exists server-side, and inventing one would be a fabricated
 * capability. Reported as a divergence rather than dropped, because the tile
 * itself still does something real.
 */
const START_OPTIONS: Array<{
  key: OutreachStartedFrom;
  Icon: typeof FileText;
  description: string;
}> = [
  {
    key: 'Firm Template',
    Icon: FileText,
    description:
      'Your firm’s own custom template. Strategy and guardrails carry over; recipients, context and approvals are always fresh.',
  },
  {
    key: 'Capiro Template',
    // The prototype uses Untitled UI's `MagicWand02`; Sparkles is this repo's
    // established stand-in for it.
    Icon: Sparkles,
    description: 'Capiro’s own campaign structures, maintained for you.',
  },
];

/**
 * The title every new campaign is created with.
 *
 * The gap analysis suggested carrying the chooser's provenance in the session
 * `title` instead. Declined: a brand-new session has no spec topic yet, and
 * `outreachCampaignName` falls back to `title`, so the list would render a row
 * literally named "Firm Template" until the operator reached the Name step.
 */
const NEW_CAMPAIGN_TITLE = 'New outreach campaign';

function StartCampaignChooser({
  creating,
  onPick,
  onClose,
}: {
  creating: boolean;
  onPick: (startedFrom: OutreachStartedFrom) => void;
  onClose: () => void;
}) {
  return (
    <EngagementDialog
      open
      eyebrow="Start a campaign"
      title="How would you like to start?"
      width={480}
      busy={creating}
      onClose={onClose}
      footer={
        <button type="button" className="ocb-btn ocb-btn--secondary" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="ochome-start">
        {START_OPTIONS.map(({ key, Icon, description }) => (
          <button
            key={key}
            type="button"
            className="ochome-start__tile"
            disabled={creating}
            onClick={() => onPick(key)}
          >
            <span className="ochome-start__icon">
              <Icon size={20} />
            </span>
            <span className="ocb-option__body">
              <span className="ocb-option__title">{key}</span>
              <span className="ocb-option__desc">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </EngagementDialog>
  );
}

export interface VNextOutreachHomeProps {
  /**
   * `startedFrom` is the chooser's provenance label. The route currently
   * ignores the second argument; appending it as `?from=` there is what makes
   * it survive into the builder header (the builder already reads that param).
   */
  onOpenCampaign: (sessionId: string, startedFrom?: OutreachStartedFrom) => void;
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

/**
 * The prototype's date cells read `Aug 21` — month and day, no year and no
 * clock. This surface is a scan of "which campaign moved recently", and the
 * fuller `Aug 21, 2026, 3:04 PM` it used to print made the two 130px columns
 * the loudest thing in the row.
 */
export function outreachCampaignWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const [showChooser, setShowChooser] = useState(false);

  const campaigns = useQuery({
    queryKey: ['outreach-v3', 'sessions', 'home'],
    queryFn: () => listOutreachV3Sessions(api, { limit: 100, includeArchived: true }),
    retry: false,
  });

  const create = useMutation({
    mutationFn: async (startedFrom: OutreachStartedFrom) => ({
      envelope: await createOutreachV3Session(api, NEW_CAMPAIGN_TITLE),
      startedFrom,
    }),
    onSuccess: async ({ envelope, startedFrom }) => {
      setActionError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'sessions'] });
      onOpenCampaign(envelope.session.id, startedFrom);
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
  /* Counted over every campaign, archived included — the summary line
     describes the library, not the active filter. */
  const counts = useMemo(() => {
    const tally: Record<OutreachV3CampaignBucket, number> = {
      draft: 0,
      sent: 0,
      archived: 0,
    };
    for (const row of rows) tally[outreachV3CampaignBucket(row)] += 1;
    return tally;
  }, [rows]);

  /* "All" is everything except archived — archived campaigns are reachable
     only through their own chip. */
  const visible = useMemo(
    () =>
      filter === 'all'
        ? rows.filter((row) => outreachV3CampaignBucket(row) !== 'archived')
        : rows.filter((row) => outreachV3CampaignBucket(row) === filter),
    [filter, rows],
  );
  const listError = campaigns.isError ? safeOutreachV3Error(campaigns.error) : null;
  const summary = `${counts.draft} draft · ${counts.sent} sent${
    counts.archived ? ` · ${counts.archived} archived` : ''
  }`;

  return (
    <div className="ocb ochome">
      <nav className="ocb-seg ochome__seg" aria-label="Outreach library">
        <button
          type="button"
          className="ocb-seg__item"
          data-active={view === 'campaigns' || undefined}
          aria-pressed={view === 'campaigns'}
          onClick={() => setView('campaigns')}
        >
          <Mail size={15} />
          Campaigns
        </button>
        <button
          type="button"
          className="ocb-seg__item"
          data-active={view === 'templates' || undefined}
          aria-pressed={view === 'templates'}
          onClick={() => setView('templates')}
        >
          <FileText size={15} />
          Templates
        </button>
      </nav>

      {view === 'templates' ? (
        <VNextOutreachTemplates
          selectedClientId={selectedClientId}
          onOpenCampaign={onOpenCampaign}
        />
      ) : (
        <>
          {/* The prototype's Campaigns view has no h2 and no descriptive
              paragraph — the mono eyebrow sits straight on the count line. */}
          <header className="ochome__bar">
            <div>
              <span className="ocb-eyebrow">Campaigns</span>
              <p className="ochome__summary">
                {campaigns.isLoading ? 'Loading your campaigns…' : summary}
              </p>
            </div>
            <div className="ochome__actions">
              <button
                type="button"
                className="ocb-btn ocb-btn--secondary"
                disabled={campaigns.isFetching}
                onClick={() => void campaigns.refetch()}
              >
                {campaigns.isFetching ? (
                  <Loader2 className="uui-spin" size={14} />
                ) : (
                  <RotateCcw size={14} />
                )}
                Refresh
              </button>
              <button
                type="button"
                className="ocb-btn ocb-btn--primary"
                disabled={create.isPending}
                onClick={() => setShowChooser(true)}
              >
                {create.isPending ? <Loader2 className="uui-spin" size={16} /> : <Plus size={16} />}
                New campaign
              </button>
            </div>
          </header>

          <div className="ochome__filters" role="group" aria-label="Campaign status">
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="ocb-chip"
                data-active={filter === entry.key ? 'true' : undefined}
                aria-pressed={filter === entry.key}
                onClick={() => setFilter(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {listError ? (
            <div className="uui-engagement-error uui-engagement-error--inside" role="alert">
              <strong>Your campaigns could not be loaded</strong>
              <p>{listError}</p>
              <button
                type="button"
                className="ocb-btn ocb-btn--secondary"
                onClick={() => void campaigns.refetch()}
              >
                Try again
              </button>
            </div>
          ) : null}

          {actionError ? (
            <div className="ochome__error" role="alert">
              <CircleAlert size={16} />
              {actionError}
            </div>
          ) : null}

          {!listError && campaigns.isLoading ? (
            <div className="ochome__skeleton" aria-busy="true">
              <i />
              <i />
              <i />
            </div>
          ) : null}

          {!listError && !campaigns.isLoading && visible.length === 0 ? (
            <div className="ochome__empty">
              <Mail size={24} />
              <span className="ochome__empty-title">No campaigns in this view</span>
              {/* Verbatim, "delivery" included: the prototype's own wizard has
                  no Delivery step either. Copy is not ours to correct. */}
              <p className="ochome__empty-body">
                Start a governed campaign: goal, targets, delivery, context, immutable drafts,
                preflight, send.
              </p>
              <button
                type="button"
                className="ocb-btn ocb-btn--primary ochome__empty-cta"
                disabled={create.isPending}
                onClick={() => setShowChooser(true)}
              >
                New campaign
              </button>
            </div>
          ) : null}

          {visible.length > 0 ? (
            <div className="ochome__table">
              <div className="ochome__head" aria-hidden="true">
                <span>Status</span>
                <span>Campaign</span>
                <span>Targets</span>
                <span>Last updated</span>
                <span>Sent</span>
                <span />
              </div>
              {visible.map((row) => {
                const bucket = outreachV3CampaignBucket(row);
                const pill = outreachCampaignPill(row);
                const name = outreachCampaignName(row);
                const detail = outreachCampaignStatusDetail(row);
                const record = (row.recordStatus ?? '').trim().toLowerCase();
                /* A partial or failed send is named on the row itself; the
                   goal alone would let a broken send read as a clean one. */
                const goal =
                  record === 'partial' || record === 'failed'
                    ? [detail, row.goal?.trim()].filter(Boolean).join(' · ')
                    : row.goal?.trim() || detail;
                return (
                  <div
                    key={row.id}
                    className="ochome__row"
                    data-archived={bucket === 'archived' || undefined}
                  >
                    <span className={`eng-pill ${pill.tone}`}>{pill.label}</span>
                    {/* Only this cell opens the campaign — the row itself is
                        not a click target, so Archive stays reachable. */}
                    <button type="button" className="ochome__open" onClick={() => onOpenCampaign(row.id)}>
                      <span className="ochome__name">{name}</span>
                      <span className="ochome__goal">{goal}</span>
                    </button>
                    <span className="ochome__count">{row.targetCount ?? 0}</span>
                    <span className="ochome__when">{outreachCampaignWhen(row.updatedAt)}</span>
                    <span className="ochome__when">{outreachCampaignWhen(row.sentAt)}</span>
                    {bucket === 'archived' ? (
                      <span />
                    ) : (
                      <button
                        type="button"
                        className="ochome__archive"
                        disabled={archivingId === row.id}
                        aria-label={`Archive ${name}`}
                        onClick={() => {
                          setArchivingId(row.id);
                          archive.mutate(row.id);
                        }}
                      >
                        {archivingId === row.id ? '…' : 'Archive'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      )}

      {showChooser ? (
        <StartCampaignChooser
          creating={create.isPending}
          onClose={() => setShowChooser(false)}
          onPick={(startedFrom) => {
            setShowChooser(false);
            create.mutate(startedFrom);
          }}
        />
      ) : null}
    </div>
  );
}
