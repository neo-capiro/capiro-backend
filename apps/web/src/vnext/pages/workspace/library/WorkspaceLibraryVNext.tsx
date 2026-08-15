/**
 * Workspace vNext — Library (the `/workspace` landing surface).
 *
 * Renders the document management list backed by `GET /workspace-api/drafts`
 * (the existing Workspace prefix — see `api/client.ts`). Mirrors the locked
 * vNext library screen from WORKSPACE-HANDOFF §5 and the CSS tokens already
 * shipped in `styles/workspace.css` (`.ws-vnext-library*`).
 *
 * Composition rules (from the handoff + the existing routes contract):
 *  - The shell (TopBar, 232/72 navigation) is NOT rebuilt here. This component
 *    mounts inside the existing vNext shell exactly like ClientCrmPage does.
 *  - Row click opens that draft in the editor: `/workspace/:draftId`.
 *  - "New document" pushes `/workspace/new` (the creation flow, lazy-loaded
 *    separately in `WorkspaceVNextRoutes`). It does NOT create a draft inline —
 *    the creation flow owns draft creation + agent initialization so the agent
 *    state machine starts from a single, coherent entry point.
 *  - "Template Studio" pushes `/workspace/studio`.
 *
 * Data: react-query (`useQuery`) wrapping the workspace `api` client, which is
 * a raw-fetch layer over `/workspace-api` (NOT the axios `useApi` client, which
 * targets the MAIN `/api` tenant/user surface). The QueryClientProvider lives
 * above VNextApp in main.tsx, so it is available here.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../../components/actions/index.js';
import { api } from '../api/client.js';
import type { AgentPhase, AgentStatus, DraftSummary } from '../types/agent.js';
import '../styles/workspace.css';

// ── Phases ─────────────────────────────────────────────────────────────────

/**
 * The ordered phase spine, shared by every draft. Mirrors `AgentPhase` from
 * `types/agent.ts`. Kept as a const tuple (not the union) so the mini-spine can
 * index by position. If the backend adds a phase, this list and the union must
 * move together — the union is the source of truth, this is the render order.
 */
const PHASE_ORDER: readonly AgentPhase[] = [
  'type',
  'blueprint',
  'design',
  'goal',
  'brief',
  'context',
  'outline',
  'generate',
  'draft',
  'quality',
  'complete',
];

function phaseIndex(phase: string | undefined): number {
  if (!phase) return -1;
  const idx = PHASE_ORDER.indexOf(phase as AgentPhase);
  return idx === -1 ? PHASE_ORDER.length - 1 : idx;
}

// ── Scopes ─────────────────────────────────────────────────────────────────

type LibraryScope = 'all' | 'mine' | 'shared';

const SCOPES: ReadonlyArray<{ key: LibraryScope; label: string }> = [
  { key: 'all', label: 'All documents' },
  { key: 'mine', label: 'Created by me' },
  { key: 'shared', label: 'Shared with me' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Compact relative time ("2h ago", "Yesterday", "Jan 24"). Mirrors the legacy
 *  DocumentsPage formatter so the two surfaces never disagree on phrasing. */
function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Title-cased phase label for the table's Phase column. */
function phaseLabel(phase: string | undefined): string {
  if (!phase) return '—';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** Map a draft status to the attention-card buckets. */
type AttentionBucket = 'needs_input' | 'failed' | 'ready';

function bucketFor(status: string | undefined): AttentionBucket | null {
  switch (status as AgentStatus) {
    case 'needs_input':
      return 'needs_input';
    case 'failed':
    case 'partial':
      return 'failed';
    case 'ready':
    case 'complete':
      return 'ready';
    default:
      return null;
  }
}

// ── Mini phase spine ───────────────────────────────────────────────────────

/**
 * The compact progress bar shown in each row's Phase cell. Each of the 11
 * phases is a 4×12 segment; segments at/before the current phase render as
 * `done` (navy), the current phase as `current` (amber), the rest as
 * `upcoming` (line grey). The CSS lives at `.ws-vnext-phase-spine-mini*`.
 */
function PhaseSpineMini({ phase }: { phase: string | undefined }) {
  const current = phaseIndex(phase);
  return (
    <span
      className="ws-vnext-phase-spine-mini"
      role="img"
      aria-label={`Phase ${phase ? phaseLabel(phase) : 'unknown'} of ${PHASE_ORDER.length}`}
    >
      {PHASE_ORDER.map((p, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <span
            key={p}
            className="ws-vnext-phase-spine-mini__seg"
            data-state={state}
            title={phaseLabel(p)}
          />
        );
      })}
    </span>
  );
}

// ── Status pill ────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Active',
  needs_input: 'Needs input',
  ready: 'Ready',
  generating: 'Generating',
  partial: 'Partial',
  failed: 'Failed',
  complete: 'Complete',
};

function StatusPill({ status }: { status: string | undefined }) {
  const key = (status ?? 'active') as AgentStatus;
  const label = STATUS_LABELS[key] ?? (status ? phaseLabel(status) : '—');
  return (
    <span className="ws-vnext-status-pill" data-status={key}>
      <span className="ws-vnext-status-pill__dot" aria-hidden />
      {label}
    </span>
  );
}

// ── Attention cards ─────────────────────────────────────────────────────────

interface AttentionCardDef {
  bucket: AttentionBucket;
  label: string;
  desc: string;
}

const ATTENTION_CARDS: readonly AttentionCardDef[] = [
  { bucket: 'needs_input', label: 'Needs input', desc: 'Drafts waiting on your answer.' },
  { bucket: 'failed', label: 'Failed', desc: 'Generation or quality failures to revisit.' },
  { bucket: 'ready', label: 'Ready', desc: 'Ready to review or deliver.' },
];

function AttentionCards({ drafts }: { drafts: readonly DraftSummary[] }) {
  const counts = useMemo(() => {
    const map: Record<AttentionBucket, number> = { needs_input: 0, failed: 0, ready: 0 };
    for (const d of drafts) {
      const b = bucketFor(d.status);
      if (b) map[b] += 1;
    }
    return map;
  }, [drafts]);

  return (
    <div className="ws-vnext-attention-cards">
      {ATTENTION_CARDS.map((card) => (
        <div key={card.bucket} className="ws-vnext-attention-card">
          <div className="ws-vnext-attention-card__count">{counts[card.bucket]}</div>
          <div className="ws-vnext-attention-card__label">{card.label}</div>
          <div className="ws-vnext-attention-card__desc">{card.desc}</div>
        </div>
      ))}
    </div>
  );
}

// ── Empty / error states ────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }): ReactNode {
  return (
    <div className="ws-vnext-attention-card" style={{ marginTop: 8 }}>
      <div className="ws-vnext-attention-card__label">No documents yet</div>
      <div className="ws-vnext-attention-card__desc">
        Start a new document and the agent will guide you through the brief, context, and outline.
      </div>
      <div style={{ marginTop: 12 }}>
        <CapiroButton variant="primary" size="compact" onClick={onCreate}>
          New document
        </CapiroButton>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div className="ws-vnext-attention-card" style={{ marginTop: 8 }}>
      <div className="ws-vnext-attention-card__label">Couldn’t load documents</div>
      <div className="ws-vnext-attention-card__desc">
        The workspace service didn’t respond. Check your connection and try again.
      </div>
      <div style={{ marginTop: 12 }}>
        <CapiroButton variant="secondary" size="compact" onClick={onRetry}>
          Retry
        </CapiroButton>
      </div>
    </div>
  );
}

// ── Drafts table ──────────────────────────────────────────────────────────

function DraftsTable({
  drafts,
  onOpen,
}: {
  drafts: readonly DraftSummary[];
  onOpen: (draftId: string) => void;
}) {
  // Seven columns whose min-content is ~600px (7 cells of horizontal padding, a
  // fixed-width PhaseSpineMini, a status pill and mono meta text) inside a
  // ~294px mobile content box. Seven columns is too many to card-stack without
  // dropping data, so the table gets an explicit scroller of its own — without
  // one it only scrolled incidentally, via .ws-vnext-library's overflow-y:auto
  // forcing overflow-x to auto, which dragged the page header and the filter
  // row sideways with it. .capiro-scroll-x is the shared foundation utility.
  return (
    <div className="capiro-scroll-x">
      <table className="ws-vnext-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Client</th>
            <th>Type</th>
            <th>Phase</th>
            <th>Status</th>
            <th>Quality</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((draft) => {
            const meta = [draft.sector, draft.documentType].filter(Boolean).join(' · ');
            return (
              <tr
                key={draft.id}
                onClick={() => onOpen(draft.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(draft.id);
                  }
                }}
                tabIndex={0}
              >
                <td>
                  <div className="ws-vnext-doc-title">{draft.docTitle || 'Untitled document'}</div>
                  {meta ? <div className="ws-vnext-doc-meta">{meta}</div> : null}
                </td>
                <td>{draft.clientName ?? '—'}</td>
                <td>{draft.documentType ?? '—'}</td>
                <td>
                  <PhaseSpineMini phase={draft.phase} />
                </td>
                <td>
                  <StatusPill status={draft.status} />
                </td>
                <td>
                  {draft.qualityScore == null ? (
                    '—'
                  ) : (
                    <span className="ws-vnext-doc-meta" style={{ marginTop: 0 }}>
                      {draft.qualityScore}
                    </span>
                  )}
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

// ── Page ──────────────────────────────────────────────────────────────────

/**
 * The `/workspace` library surface. Lazy-loaded by `WorkspaceVNextRoutes` as a
 * named export (not default) — keep that import shape stable.
 */
export function WorkspaceLibraryVNext() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [scope, setScope] = useState<LibraryScope>('all');

  // The workspace `api` client is a raw-fetch layer over `/workspace-api`; it
  // is NOT the axios `useApi` client (which targets the MAIN `/api` tenant
  // surface). `scope` is passed straight through to the engine, which already
  // resolves "mine" vs "shared" against the signed-in Clerk identity server-side
  // — the frontend never compares ownerId itself, so no `me` lookup is needed.
  const draftsQuery = useQuery({
    queryKey: ['ws-vnext', 'drafts', scope],
    queryFn: async () => (await api.listDrafts({ scope })).drafts,
    staleTime: 30_000,
  });

  const drafts = draftsQuery.data ?? [];

  const openDraft = (draftId: string) => navigate(`/workspace/${draftId}`);
  const newDocument = () => navigate('/workspace/new');
  const openStudio = () => navigate('/workspace/studio');

  const retry = () => qc.invalidateQueries({ queryKey: ['ws-vnext', 'drafts'] });

  return (
    <div className="ws-vnext-library">
      <header className="ws-vnext-library__header">
        <div className="ws-vnext-library__title-block">
          <h1>Documents</h1>
          <p>Plan, draft, and deliver client documents with the document agent.</p>
        </div>
        <div className="ws-vnext-library__actions">
          <CapiroButton variant="secondary" size="compact" onClick={openStudio}>
            Template Studio
          </CapiroButton>
          <CapiroButton variant="primary" size="compact" onClick={newDocument}>
            New document
          </CapiroButton>
        </div>
      </header>

      <div className="ws-vnext-library__filter-row">
        <div className="ws-vnext-scope-segment" role="tablist" aria-label="Document scope">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={scope === s.key}
              onClick={() => setScope(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {draftsQuery.isLoading ? (
        <div className="ws-vnext-attention-card" style={{ marginTop: 8 }}>
          <div className="ws-vnext-attention-card__label">Loading…</div>
          <div className="ws-vnext-attention-card__desc">Fetching your documents.</div>
        </div>
      ) : draftsQuery.isError ? (
        <ErrorState onRetry={retry} />
      ) : drafts.length === 0 ? (
        <EmptyState onCreate={newDocument} />
      ) : (
        <>
          <DraftsTable drafts={drafts} onOpen={openDraft} />
          <AttentionCards drafts={drafts} />
        </>
      )}
    </div>
  );
}
