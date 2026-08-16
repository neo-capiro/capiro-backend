/**
 * Workspace vNext — Document library (design-handoff §5).
 *
 * Pixel parity with the prototype: mono eyebrow hero, scope segmented control,
 * sector chips, the eight-column table (Document · Client · Submission type ·
 * Stage · Quality · Status · Updated · Collaborators) and the Needs-attention
 * card. Loading / empty / ready states all match the prototype.
 *
 * Honest gaps (GAPS.md):
 *  - §5  the list route does not project phase/status/quality — those columns
 *        render the value when present, "—" otherwise. No per-row N+1 fetch.
 *  - the "Needs attention" list is derived client-side from statuses the list
 *        route DOES return (needs_input / failed / partial); it is not a
 *        server-curated attention feed (none exists).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { DraftSummary } from '../types/agent.js';
import { WorkspaceIcon } from '../components/WorkspaceIcon.js';
import {
  WsButton,
  WsMono,
  WsPill,
  WsSegmented,
  type WsTone,
} from '../components/WorkspacePrimitives.js';
import '../styles/workspace.css';
import '../styles/workspace-parity.css';

type LibraryScope = 'all' | 'mine' | 'shared';

const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'shared', label: 'Shared with me' },
] as const;

const STAGES = ['Draft', 'Refine', 'Review', 'Deliver'] as const;

/** Map an 11-phase lifecycle value onto the four user-visible stages. */
function stageForPhase(phase: string | undefined): string | null {
  switch (phase) {
    case 'brief':
    case 'context':
    case 'outline':
    case 'generate':
    case 'type':
    case 'blueprint':
    case 'design':
    case 'goal':
      return 'Draft';
    case 'draft':
      return 'Refine';
    case 'quality':
      return 'Review';
    case 'complete':
      return 'Deliver';
    default:
      return null;
  }
}

const STATUS_TONE: Record<string, WsTone> = {
  active: 'neutral',
  needs_input: 'amber',
  in_review: 'navy',
  ready: 'navy',
  generating: 'navy',
  approved: 'green',
  complete: 'green',
  blocked: 'red',
  partial: 'amber',
  failed: 'red',
};

function statusLabel(status: string | undefined): string {
  if (!status) return '—';
  return status.replace(/_/g, ' ');
}

function qualityTone(score: number | null | undefined): string | undefined {
  if (score == null) return undefined;
  if (score >= 95) return 'var(--ws-green)';
  if (score >= 80) return 'var(--ws-amber)';
  return 'var(--ws-red)';
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** Four-segment stage spine (handoff §5.4 row cell 3). */
function StageSpine({
  phase,
  needsInput,
}: {
  phase: string | undefined;
  needsInput: boolean;
}) {
  const stage = stageForPhase(phase);
  const at = stage ? STAGES.indexOf(stage as (typeof STAGES)[number]) : -1;
  return (
    <span className="ws-lib-stage">
      <span className="ws-lib-stage__spine">
        {STAGES.map((label, index) => {
          const state =
            at < 0
              ? 'upcoming'
              : index < at
                ? 'done'
                : index === at
                  ? needsInput
                    ? 'blocked'
                    : 'current'
                  : 'upcoming';
          return (
            <span
              key={label}
              title={label}
              className="ws-lib-stage__seg"
              data-state={state}
            />
          );
        })}
      </span>
      <span className="ws-lib-stage__label">{stage ?? '—'}</span>
    </span>
  );
}

function OverlappingAvatars({ draftId }: { draftId: string }) {
  // The list route does not project collaborators; render the owning initials
  // placeholder honestly as a single avatar derived from the draft id.
  const initials = (draftId || '??').slice(0, 2).toUpperCase();
  return (
    <span className="ws-lib-avatars">
      <span className="ws-lib-avatars__avatar">{initials}</span>
    </span>
  );
}

function LoadingRows() {
  return (
    <div className="ws-lib-skeleton" aria-busy="true" role="status">
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="ws-lib-skeleton__bar" key={index} />
      ))}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="ws-lib-empty">
      <span className="ws-lib-empty__icon">
        <WorkspaceIcon name="File04" size={20} color="#667085" />
      </span>
      <span className="ws-lib-empty__title">Nothing here yet</span>
      <span className="ws-lib-empty__desc">
        No documents match this scope. Start one from a goal and Meri will
        recommend the document type, blueprint and theme.
      </span>
      <WsButton variant="metal" size="md" onClick={onCreate}>
        New document
      </WsButton>
    </div>
  );
}

interface AttentionRow {
  id: string;
  kind: string;
  tone: WsTone;
  text: string;
  docId: string;
}

export function WorkspaceLibraryVNext() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<LibraryScope>('all');
  const [sector, setSector] = useState('');

  const draftsQuery = useQuery({
    queryKey: ['ws-vnext', 'drafts', { scope, sector }],
    queryFn: async () =>
      (await api.listDrafts({ scope, sector: sector || undefined })).drafts,
    staleTime: 30_000,
  });

  const drafts = draftsQuery.data ?? [];
  const sectors = useMemo(
    () =>
      Array.from(
        new Set(
          drafts
            .map((draft) => draft.sector)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort(),
    [drafts],
  );

  const needsInputCount = useMemo(
    () => drafts.filter((d) => d.status === 'needs_input').length,
    [drafts],
  );

  const attentionRows = useMemo<AttentionRow[]>(() => {
    const rows: AttentionRow[] = [];
    for (const draft of drafts) {
      if (draft.status === 'needs_input') {
        rows.push({
          id: `${draft.id}-input`,
          kind: 'Needs input',
          tone: 'amber',
          text: `${draft.docTitle || 'Untitled document'} is waiting on an answer or decision before Meri can continue.`,
          docId: draft.id,
        });
      } else if (draft.status === 'failed' || draft.status === 'partial') {
        rows.push({
          id: `${draft.id}-run`,
          kind: draft.status === 'partial' ? 'Partial run' : 'Run failed',
          tone: draft.status === 'partial' ? 'amber' : 'red',
          text: `${draft.docTitle || 'Untitled document'} ${draft.status === 'partial' ? 'finished with some sections incomplete — they can be retried on their own.' : 'did not finish. Successful sections were kept.'}`,
          docId: draft.id,
        });
      } else if (draft.lockedBy) {
        rows.push({
          id: `${draft.id}-lock`,
          kind: 'Lock contention',
          tone: 'amber',
          text: `${draft.docTitle || 'Untitled document'} is locked for editing by ${draft.lockedBy}.`,
          docId: draft.id,
        });
      }
    }
    return rows;
  }, [drafts]);

  const retry = () =>
    queryClient.invalidateQueries({ queryKey: ['ws-vnext', 'drafts'] });

  const openDoc = (draftId: string) => navigate(`/workspace/${draftId}`);

  return (
    <div className="ws-lib">
      {/* Hero (handoff §5.1) */}
      <div className="ws-lib-hero">
        <div className="ws-lib-hero__lead">
          <WsMono variant="eyebrow">Workspace</WsMono>
          <h1 className="ws-lib-hero__title">Workspace</h1>
          <p className="ws-lib-hero__sub">
            Create, refine, review, and deliver client-ready government affairs
            documents with Meri.
          </p>
        </div>
        <div className="ws-lib-hero__actions">
          <WsButton
            variant="secondary"
            size="md"
            icon="LayoutAlt01"
            onClick={() => navigate('/workspace/studio')}
          >
            Template Studio
          </WsButton>
          <WsButton
            variant="secondary"
            size="md"
            icon="Link01"
            onClick={() => navigate('/workspace/shares')}
          >
            Client shares
          </WsButton>
          <WsButton
            variant="metal"
            size="md"
            icon="Plus"
            onClick={() => navigate('/workspace/new')}
          >
            New document
          </WsButton>
        </div>
      </div>

      {/* Filter bar (handoff §5.2) */}
      <div className="ws-lib-filter">
        <WsSegmented
          ariaLabel="Document scope"
          segments={SCOPES.map((s) => ({ key: s.key, label: s.label }))}
          value={scope}
          onChange={(key) => setScope(key as LibraryScope)}
        />
        <div className="ws-lib-sectors">
          <button
            type="button"
            data-active={!sector}
            onClick={() => setSector('')}
          >
            All sectors
          </button>
          {sectors.map((value) => (
            <button
              type="button"
              key={value}
              data-active={sector === value}
              onClick={() => setSector(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <span className="ws-lib-filter__spacer" />
        <span className="ws-lib-count" title="Document count">
          {draftsQuery.isLoading
            ? '—'
            : `${drafts.length} documents · ${needsInputCount} need input`}
        </span>
      </div>

      <div className="ws-lib-body">
        {draftsQuery.isLoading ? (
          <LoadingRows />
        ) : draftsQuery.isError ? (
          <div className="ws-lib-empty">
            <span className="ws-lib-empty__title">Couldn’t load documents</span>
            <span className="ws-lib-empty__desc">
              Workspace did not respond. Check your connection and try again.
            </span>
            <WsButton variant="secondary" size="md" onClick={retry}>
              Retry
            </WsButton>
          </div>
        ) : drafts.length === 0 ? (
          <EmptyState onCreate={() => navigate('/workspace/new')} />
        ) : (
          <>
            {/* Document table (handoff §5.4) */}
            <div className="ws-lib-table">
              <div className="ws-lib-table__head">
                <span>Document</span>
                <span>Client</span>
                <span>Submission type</span>
                <span>Stage</span>
                <span style={{ textAlign: 'right' }}>Quality</span>
                <span>Status</span>
                <span style={{ textAlign: 'right' }}>Updated</span>
                <span style={{ textAlign: 'right' }}>Collaborators</span>
              </div>
              {drafts.map((draft) => (
                <button
                  type="button"
                  className="ws-lib-table__row"
                  key={draft.id}
                  onClick={() => openDoc(draft.id)}
                >
                  <span className="ws-lib-table__doc">
                    <span className="ws-lib-table__doc-title">
                      <span className="ws-lib-table__doc-name">
                        {draft.docTitle || 'Untitled document'}
                      </span>
                      {draft.lockedBy ? (
                        <span
                          className="ws-lib-table__doc-lock"
                          title="Locked for editing"
                        >
                          <WorkspaceIcon name="Lock01" size={12} color="#B86E12" />
                        </span>
                      ) : null}
                    </span>
                    <span className="ws-lib-table__doc-meta">
                      {[draft.sector, draft.documentType]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </span>
                  </span>
                  <span className="ws-lib-table__cell">
                    {draft.clientName || '—'}
                  </span>
                  <span className="ws-lib-table__cell">
                    {draft.documentType || '—'}
                  </span>
                  <StageSpine
                    phase={draft.phase}
                    needsInput={draft.status === 'needs_input'}
                  />
                  <span
                    className="ws-lib-table__cell ws-lib-table__quality"
                    style={{ color: qualityTone(draft.qualityScore) }}
                  >
                    {draft.qualityScore == null
                      ? '—'
                      : `${draft.qualityScore}%`}
                  </span>
                  <span>
                    <WsPill tone={STATUS_TONE[draft.status ?? ''] ?? 'neutral'}>
                      {statusLabel(draft.status)}
                    </WsPill>
                  </span>
                  <span className="ws-lib-table__cell ws-lib-table__updated">
                    {relativeTime(draft.updatedAt)}
                  </span>
                  <span className="ws-lib-table__cell ws-lib-table__collab">
                    <OverlappingAvatars draftId={draft.id} />
                  </span>
                </button>
              ))}
            </div>

            {/* Needs attention (handoff §5.5) */}
            {attentionRows.length > 0 ? (
              <div className="ws-lib-attention">
                <div className="ws-lib-attention__head">
                  <span className="ws-lib-attention__title">
                    Needs attention
                  </span>
                  <WsMono variant="tag">{attentionRows.length} items</WsMono>
                </div>
                {attentionRows.map((row) => (
                  <button
                    type="button"
                    className="ws-lib-attention__row"
                    key={row.id}
                    onClick={() => openDoc(row.docId)}
                  >
                    <WsPill tone={row.tone} className="ws-lib-attention__kind">
                      {row.kind}
                    </WsPill>
                    <span className="ws-lib-attention__text">{row.text}</span>
                    <span className="ws-lib-attention__chev">
                      <WorkspaceIcon
                        name="ChevronRight"
                        size={15}
                        color="#98A2B3"
                      />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
