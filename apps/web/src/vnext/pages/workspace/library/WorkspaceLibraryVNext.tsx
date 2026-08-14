import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../../components/actions/index.js';
import { api } from '../api/client.js';
import type { DraftSummary } from '../types/agent.js';
import '../styles/workspace.css';


type LibraryScope = 'all' | 'mine' | 'shared';

const SCOPES: ReadonlyArray<{ key: LibraryScope; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'shared', label: 'Shared with me' },
];

const WORKFLOW_STOPS = [
  'Brief',
  'Context',
  'Outline',
  'Draft',
  'Quality',
  'Delivery',
] as const;

function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function workflowIndex(phase: string | undefined): number {
  switch (phase) {
    case 'type':
    case 'blueprint':
    case 'design':
    case 'goal':
    case 'brief':
      return 0;
    case 'context':
      return 1;
    case 'outline':
      return 2;
    case 'generate':
    case 'draft':
      return 3;
    case 'quality':
      return 4;
    case 'complete':
      return 5;
    default:
      return -1;
  }
}

function phaseLabel(phase: string | undefined): string {
  const index = workflowIndex(phase);
  return index < 0 ? '—' : WORKFLOW_STOPS[index] ?? '—';
}

function PhaseSpineMini({
  phase,
  needsInput,
}: {
  phase: string | undefined;
  needsInput: boolean;
}) {
  const current = workflowIndex(phase);
  if (current < 0) return <span aria-label="Phase unknown">—</span>;

  return (
    <span
      className="ws-vnext-phase-spine-mini"
      role="img"
      aria-label={`Phase ${phaseLabel(phase)} of ${WORKFLOW_STOPS.length}`}
    >
      {WORKFLOW_STOPS.map((label, index) => {
        const state =
          index < current
            ? 'done'
            : index === current
              ? needsInput
                ? 'current'
                : 'done'
              : 'upcoming';
        return (
          <span
            key={label}
            className="ws-vnext-phase-spine-mini__seg"
            data-state={state}
            title={label}
          />
        );
      })}
    </span>
  );
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  needs_input: 'Needs input',
  ready: 'Ready',
  generating: 'Generating',
  partial: 'Partial',
  failed: 'Failed',
  complete: 'Complete',
};

function StatusPill({ status }: { status: string | undefined }) {
  if (!status || !STATUS_LABELS[status]) return <span>—</span>;
  return (
    <span className="ws-vnext-status-pill" data-status={status}>
      <span className="ws-vnext-status-pill__dot" aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

function EmptyState({
  filtered,
  onCreate,
}: {
  filtered: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="ws-vnext-attention-card" style={{ marginTop: 8 }}>
      <div className="ws-vnext-attention-card__label">
        {filtered ? 'No documents match these filters' : 'No documents yet'}
      </div>
      <div className="ws-vnext-attention-card__desc">
        {filtered
          ? 'Clear a filter or change the document scope.'
          : 'Start a document and the agent will guide the brief, context, outline, and draft.'}
      </div>
      {!filtered ? (
        <div style={{ marginTop: 12 }}>
          <CapiroButton variant="primary" size="compact" onClick={onCreate}>
            New document
          </CapiroButton>
        </div>
      ) : null}
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div className="ws-vnext-attention-card" style={{ marginTop: 8 }}>
      <div className="ws-vnext-attention-card__label">
        Couldn’t load documents
      </div>
      <div className="ws-vnext-attention-card__desc">
        Workspace did not respond. Check your connection and try again.
      </div>
      <div style={{ marginTop: 12 }}>
        <CapiroButton variant="secondary" size="compact" onClick={onRetry}>
          Retry
        </CapiroButton>
      </div>
    </div>
  );
}

function LoadingTable() {
  return (
    <div className="ws-vnext-table-shell" aria-busy="true" role="status">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="ws-vnext-library-skeleton-row" key={index}>
          <div className="ws-vnext-skeleton-row" style={{ width: '34%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '16%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '22%' }} />
        </div>
      ))}
    </div>
  );
}

function DraftsTable({
  drafts,
  onOpen,
}: {
  drafts: readonly DraftSummary[];
  onOpen: (draftId: string) => void;
}) {
  return (
    <div className="capiro-scroll-x ws-vnext-table-shell">
      <table className="ws-vnext-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Client</th>
            <th>Phase</th>
            <th>Status</th>
            <th>Quality</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((draft) => {
            const meta = [
              draft.documentType,
              draft.sector,
            ].filter(Boolean).join(' · ');
            return (
              <tr
                key={draft.id}
                tabIndex={0}
                onClick={() => onOpen(draft.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(draft.id);
                  }
                }}
              >
                <td>
                  <div className="ws-vnext-doc-title">
                    {draft.docTitle || 'Untitled document'}
                  </div>
                  <div className="ws-vnext-doc-meta">
                    {meta || '—'}
                  </div>
                </td>
                <td>{draft.clientName || '—'}</td>
                <td>
                  <div className="ws-vnext-library-phase-cell">
                    <PhaseSpineMini
                      phase={draft.phase}
                      needsInput={draft.status === 'needs_input'}
                    />
                    <span>{phaseLabel(draft.phase)}</span>
                  </div>
                </td>
                <td>
                  <StatusPill status={draft.status} />
                </td>
                <td>
                  {draft.qualityScore == null
                    ? '—'
                    : `${draft.qualityScore}%`}
                </td>
                <td>
                  <span className="ws-vnext-doc-meta" style={{ marginTop: 0 }}>
                    {relativeTime(draft.updatedAt)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AttentionCards({ drafts }: { drafts: readonly DraftSummary[] }) {
  const counts = useMemo(() => {
    let needsInput = 0;
    let recovery = 0;
    let ready = 0;
    for (const draft of drafts) {
      if (draft.status === 'needs_input') needsInput += 1;
      if (draft.status === 'failed' || draft.status === 'partial') {
        recovery += 1;
      }
      if (draft.status === 'ready' || draft.status === 'complete') {
        ready += 1;
      }
    }
    return { needsInput, recovery, ready };
  }, [drafts]);

  return (
    <div className="ws-vnext-attention-cards">
      <div className="ws-vnext-attention-card">
        <div className="ws-vnext-attention-card__count">
          {counts.needsInput}
        </div>
        <div className="ws-vnext-attention-card__label">Needs you</div>
        <div className="ws-vnext-attention-card__desc">
          Documents waiting for an answer or decision.
        </div>
      </div>
      <div className="ws-vnext-attention-card">
        <div className="ws-vnext-attention-card__count">
          {counts.recovery}
        </div>
        <div className="ws-vnext-attention-card__label">Needs recovery</div>
        <div className="ws-vnext-attention-card__desc">
          Partial or failed generation runs.
        </div>
      </div>
      <div className="ws-vnext-attention-card">
        <div className="ws-vnext-attention-card__count">{counts.ready}</div>
        <div className="ws-vnext-attention-card__label">
          Ready to review
        </div>
        <div className="ws-vnext-attention-card__desc">
          Documents ready for quality or delivery.
        </div>
      </div>
    </div>
  );
}

export function WorkspaceLibraryVNext() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<LibraryScope>('all');
  const [sector, setSector] = useState('');

  const draftsQuery = useQuery({
    queryKey: ['ws', 'drafts', { scope, sector }],
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

  const retry = () =>
    queryClient.invalidateQueries({ queryKey: ['ws', 'drafts'] });

  return (
    <div className="ws-vnext-library">
      <header className="ws-vnext-library__header">
        <div className="ws-vnext-library__title-block">
          <h1>Documents</h1>
          <p>
            Plan, draft, review, and deliver client documents with the
            Document Agent.
          </p>
        </div>
        <div className="ws-vnext-library__actions">
          <CapiroButton
            variant="secondary"
            size="compact"
            onClick={() => navigate('/workspace/studio')}
          >
            Template Studio
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            onClick={() => navigate('/workspace/new')}
          >
            New document
          </CapiroButton>
        </div>
      </header>

      <div className="ws-vnext-library__filter-row">
        <div
          className="ws-vnext-scope-segment"
          role="tablist"
          aria-label="Document scope"
        >
          {SCOPES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={scope === option.key}
              onClick={() => setScope(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div
          className="ws-vnext-sector-chips"
          aria-label="Document sector"
        >
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
              data-active={sector === value}
              key={value}
              onClick={() => setSector(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <span className="ws-vnext-library-count">
          {draftsQuery.isLoading ? '—' : drafts.length}{' '}
          {drafts.length === 1 ? 'document' : 'documents'}
        </span>
      </div>

      {draftsQuery.isLoading ? (
        <LoadingTable />
      ) : draftsQuery.isError ? (
        <ErrorState onRetry={retry} />
      ) : drafts.length === 0 ? (
        <EmptyState
          filtered={scope !== 'all' || Boolean(sector)}
          onCreate={() => navigate('/workspace/new')}
        />
      ) : (
        <>
          <DraftsTable
            drafts={drafts}
            onOpen={(draftId) => navigate(`/workspace/${draftId}`)}
          />
          <AttentionCards drafts={drafts} />
        </>
      )}
    </div>
  );
}
