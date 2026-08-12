/*
 * Strategies vNext — Context library (/strategies/context), STRATEGIES-HANDOFF §7.5.
 *
 * The grounded-agent-context surface: summary stats (active documents /
 * extracted facts / open conflicts), documents grouped by template key with
 * state + staleness pills, and a right rail carrying the stewardship statement
 * and the document contract. Data rides the shared module hooks
 * (../strategies-api.js) over the SAME /strategy-api/context backend the
 * canonical app uses — every number below is live sp_context_* data, never the
 * mock's sample values.
 *
 * Governance (§7.5): a document is NEVER listed without its required front
 * matter (template key · scope · authority · as-of) — incomplete rows are
 * excluded and counted in an explicit notice, not silently dropped.
 */
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import {
  CapiroEmptyState,
  CapiroErrorState,
  CapiroSkeleton,
} from '../../../components/feedback/index.js';
import { CapiroCheckIcon, CapiroDownloadIcon, CapiroSearchIcon } from '../../../components/icons/index.js';
import {
  useClientsLite,
  useContextConflicts,
  useContextDocuments,
  useContextFacts,
} from '../strategies-api.js';
import {
  fmScalar,
  isContextDocStale,
} from '../../../../pages/strategy/context/context-utils.js';
import type { ContextDocumentListItem, ContextDocState } from '../../../../pages/strategy/types.js';
import './context-library.css';

type StateFilter = 'active' | 'all' | ContextDocState;

const STATE_FILTERS: ReadonlyArray<{ id: StateFilter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All states' },
  { id: 'draft', label: 'Draft' },
  { id: 'superseded', label: 'Superseded' },
  { id: 'archived', label: 'Archived' },
];

const STATE_TONE: Record<ContextDocState, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  draft: 'warning',
  superseded: 'neutral',
  archived: 'neutral',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO (date or datetime) → "Aug 7" (uppercased by CSS). Tolerates garbage. */
function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return null;
  const label = MONTHS[Number(m) - 1];
  if (!label || Number.isNaN(Number(d))) return null;
  return `${label} ${Number(d)}`;
}

/** "Updated …" at day granularity (the §7.5 row stamp). */
function updatedAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 31) return `${days} days ago`;
  return fmtDay(iso) ?? '—';
}

function isForbidden(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 403;
}

/** §7.5 gate: a document is never shown without template key/scope/authority/as-of. */
function hasRequiredFrontMatter(doc: ContextDocumentListItem): boolean {
  return Boolean(
    doc.templateKey && doc.scope && fmScalar(doc.frontmatter, 'authority') && fmScalar(doc.frontmatter, 'as_of'),
  );
}

/*
 * Blank-pack markdown template (Stage D grammar: flat `key: value` scalars
 * between `---` fences). Ships with the pack's literal placeholders — the
 * upload validator rejects them until replaced with real values, by design
 * (frontmatter.ts DATE_PLACEHOLDER / ID_PLACEHOLDERS).
 */
const MARKDOWN_TEMPLATE = `---
document_type: strategy_brief
schema_version: "1.0"
state: draft
scope: client
client_id: client_123
authority: working_draft
confidentiality: client_confidential
source_of_truth: false
as_of: YYYY-MM-DD
valid_until: null
supersedes: null
---

# Strategy brief

Replace the placeholder front matter above before uploading: as_of must be a
real YYYY-MM-DD date, client_id a real client id (required when scope is
'client'), and state 'active' only when the document should go live.

document_type one of: context_manifest, strategy_brief, client_constraints,
ask_and_options, stakeholder_map, calendar_and_deadlines, decision_rules,
current_plan, evidence_register, meeting_intelligence, decision_log,
agent_mission, execution_playbook, agent_permissions.
scope one of: once, node, strategy, client, firm.
authority one of: firm_approved, client_approved, working_draft,
external_authoritative, meeting_intelligence.
`;

function downloadMarkdownTemplate() {
  const blob = new Blob([MARKDOWN_TEMPLATE], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '01_strategy_brief.template.md';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ContextLibraryVNext() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const docs = useContextDocuments();
  const facts = useContextFacts();
  const conflicts = useContextConflicts();
  const clients = useClientsLite();

  const clientFilter = searchParams.get('client') ?? 'all';
  const stateFilter = (searchParams.get('state') ?? 'active') as StateFilter;
  const query = searchParams.get('q') ?? '';

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === '' || (key === 'client' && value === 'all') || (key === 'state' && value === 'active')) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const clientName = (id: string | null) =>
    id === null ? 'Firm' : (clients.data?.find((client) => client.id === id)?.name ?? 'Client');

  /* Library-wide stats describe the WHOLE library, not the current filter. */
  const activeDocuments = (docs.data ?? []).filter((doc) => doc.state === 'active');
  const activeFacts = (facts.data ?? []).filter((fact) => fact.state === 'active');
  const staleFactCount = (facts.data ?? []).filter((fact) => fact.state === 'stale').length;
  const openConflicts = (conflicts.data ?? []).filter((conflict) => conflict.state === 'open');
  const healthy = openConflicts.length === 0;

  const clientOptions = useMemo(
    () =>
      [...new Set((docs.data ?? []).map((doc) => doc.clientId).filter((id): id is string => Boolean(id)))].map(
        (id) => ({ id, name: clientName(id) }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs.data, clients.data],
  );
  const hasFirmDocs = (docs.data ?? []).some((doc) => doc.clientId === null);

  /* §7.5: group by template key; rows without the required front matter are
   * excluded from display and surfaced as a count, never rendered bare. */
  const { groups, excludedCount, visibleCount } = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = (docs.data ?? []).filter((doc) => {
      if (clientFilter !== 'all' && (clientFilter === 'firm' ? doc.clientId !== null : doc.clientId !== clientFilter))
        return false;
      if (stateFilter !== 'all' && doc.state !== stateFilter) return false;
      if (term && !`${doc.title} ${doc.templateKey}`.toLowerCase().includes(term)) return false;
      return true;
    });
    let excluded = 0;
    const map = new Map<string, ContextDocumentListItem[]>();
    for (const doc of filtered) {
      if (!hasRequiredFrontMatter(doc)) {
        excluded += 1;
        continue;
      }
      const rows = map.get(doc.templateKey) ?? [];
      rows.push(doc);
      map.set(doc.templateKey, rows);
    }
    for (const rows of map.values()) rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return {
      groups: entries,
      excludedCount: excluded,
      visibleCount: entries.reduce((sum, [, rows]) => sum + rows.length, 0),
    };
  }, [docs.data, clientFilter, stateFilter, query]);

  const statsLoading = docs.isLoading || facts.isLoading || conflicts.isLoading;
  const statsFailed = docs.isError || facts.isError || conflicts.isError;

  return (
    <div className="st-ctxlib">
      {/* ---- context status bar ------------------------------------------- */}
      <div className="st-ctxbar" aria-label="Context status">
        <span className="st-ctxbar__chip">
          <small>Context</small>
          <strong>
            {clientFilter === 'all' ? 'All clients' : clientFilter === 'firm' ? 'Firm' : clientName(clientFilter)}
          </strong>
        </span>
        <span className="st-ctxbar__chip">
          <small>Pack</small>
          <strong>00–13</strong>
        </span>
        <span className="st-ctxbar__chip">
          <small>State</small>
          <strong>{STATE_FILTERS.find((f) => f.id === stateFilter)?.label ?? 'Active'}</strong>
        </span>
        <span className="st-ctxbar__spacer" />
        {conflicts.isError ? (
          <span className="st-ctxbar__health is-unknown">Health unavailable</span>
        ) : (
          <span className={`st-ctxbar__health ${healthy ? 'is-healthy' : 'is-conflict'}`}>
            <span aria-hidden="true" className="st-ctxbar__health-dot" />
            {healthy
              ? `Healthy · ${activeFacts.length} facts`
              : `${openConflicts.length} open conflict${openConflicts.length === 1 ? '' : 's'} · ${activeFacts.length} facts`}
          </span>
        )}
      </div>

      {/* ---- header --------------------------------------------------------- */}
      <header className="st-ctxlib__header">
        <Link className="st-ctxlib__back" to="/strategies">
          ‹ Strategies
        </Link>
        <div className="st-ctxlib__title-row">
          <div className="st-ctxlib__title-block">
            <div className="st-ctxlib__eyebrow">Grounded agent context</div>
            <h1 className="st-ctxlib__title">Context library</h1>
          </div>
          <p className="st-ctxlib__lede">
            Durable, typed documents that ground Meri and strategy agents with validated front matter, provenance
            and supersession.
          </p>
          <div className="st-ctxlib__actions">
            <CapiroButton variant="primary" onClick={() => navigate('/strategies/context/steward')}>
              Steward review
            </CapiroButton>
            <CapiroButton variant="secondary" onClick={() => navigate('/strategies/context/upload')}>
              Upload document
            </CapiroButton>
          </div>
        </div>
      </header>

      <main className="st-ctxlib__body">
        {/* ---- stats + stewardship band ------------------------------------ */}
        <section className="st-ctxlib__band" aria-label="Context summary">
          <StatCard
            loading={statsLoading}
            failed={docs.isError}
            value={activeDocuments.length}
            label="Active documents"
            detail="Across firm + clients"
          />
          <StatCard
            loading={statsLoading}
            failed={facts.isError}
            value={activeFacts.length}
            label="Extracted facts"
            detail={`${activeFacts.length} active · ${staleFactCount} stale`}
          />
          <StatCard
            loading={statsLoading}
            failed={conflicts.isError}
            value={openConflicts.length}
            label="Open conflicts"
            detail={openConflicts.length > 0 ? 'Steward decision required' : 'No steward decision required'}
            tone={openConflicts.length > 0 ? 'error' : 'default'}
          />
          <aside className="st-ctxlib__stewardship">
            <span className="st-ctxlib__stewardship-label">Stewardship</span>
            <strong>Context is operational data.</strong>
            <p>
              Facts retain exact source references. Supersession preserves history. Rejection never edits the
              source document.
            </p>
          </aside>
        </section>

        <div className="st-ctxlib__grid">
          {/* ---- documents -------------------------------------------------- */}
          <section className="st-ctxlib__documents" aria-label="Context documents">
            <div className="st-ctxlib__toolbar">
              <div className="st-ctxlib__toolbar-title">
                <span className="st-ctxlib__section-label">Documents</span>
                <strong>
                  {visibleCount} document{visibleCount === 1 ? '' : 's'} · grouped by template
                </strong>
              </div>
              <div className="st-ctxlib__pill-group" role="group" aria-label="Filter by client">
                <FilterPill active={clientFilter === 'all'} onClick={() => setParam('client', 'all')}>
                  All clients
                </FilterPill>
                {hasFirmDocs ? (
                  <FilterPill active={clientFilter === 'firm'} onClick={() => setParam('client', 'firm')}>
                    Firm
                  </FilterPill>
                ) : null}
                {clientOptions.map((option) => (
                  <FilterPill
                    key={option.id}
                    active={clientFilter === option.id}
                    onClick={() => setParam('client', option.id)}
                  >
                    {option.name}
                  </FilterPill>
                ))}
              </div>
              <div className="st-ctxlib__pill-group" role="group" aria-label="Filter by state">
                {STATE_FILTERS.map((filter) => (
                  <FilterPill
                    key={filter.id}
                    active={stateFilter === filter.id}
                    onClick={() => setParam('state', filter.id)}
                  >
                    {filter.label}
                  </FilterPill>
                ))}
              </div>
              <label className="st-ctxlib__search">
                <CapiroSearchIcon size={0.9} />
                <input
                  value={query}
                  onChange={(event) => setParam('q', event.target.value)}
                  placeholder="Search documents"
                  aria-label="Search context documents"
                />
              </label>
            </div>

            {docs.isRefetchError && docs.data ? (
              <div className="st-ctxlib__stale-note" role="status">
                Refresh failed — showing data from {new Date(docs.dataUpdatedAt).toLocaleTimeString()}.
              </div>
            ) : null}

            {docs.isLoading ? (
              <div className="st-ctxlib__groups" aria-label="Loading documents">
                {[0, 1, 2].map((group) => (
                  <div className="st-ctxlib__group" key={group}>
                    <div className="st-ctxlib__group-header">
                      <CapiroSkeleton width={220} height={12} />
                      <CapiroSkeleton width={48} height={18} />
                    </div>
                    {[0, 1].map((row) => (
                      <div className="st-ctxlib__row is-skeleton" key={row}>
                        <CapiroSkeleton width="55%" height={14} />
                        <CapiroSkeleton width="35%" height={11} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : docs.isError ? (
              isForbidden(docs.error) ? (
                <CapiroEmptyState
                  title="You don't have access to the context library"
                  description="Context documents need the agentic Meri feature. Ask an admin to enable it for your account."
                />
              ) : (
                <CapiroErrorState
                  title="The context library could not be loaded"
                  description="The document list request failed. Your documents are unchanged."
                  onRetry={() => void docs.refetch()}
                />
              )
            ) : groups.length === 0 ? (
              <CapiroEmptyState
                title={(docs.data?.length ?? 0) > 0 ? 'No documents match these filters' : 'No context documents yet'}
                description={
                  (docs.data?.length ?? 0) > 0
                    ? 'Try another client, state, or search term.'
                    : 'Upload a markdown document with typed front matter to start grounding agents.'
                }
                action={
                  (docs.data?.length ?? 0) === 0 ? (
                    <CapiroButton variant="primary" size="compact" onClick={() => navigate('/strategies/context/upload')}>
                      Upload document
                    </CapiroButton>
                  ) : undefined
                }
              />
            ) : (
              <div className="st-ctxlib__groups">
                {excludedCount > 0 ? (
                  <div className="st-ctxlib__excluded-note" role="status">
                    {excludedCount} document{excludedCount === 1 ? '' : 's'} not shown — missing required front
                    matter (template key, scope, authority, or as-of).
                  </div>
                ) : null}
                {groups.map(([templateKey, rows]) => (
                  <section className="st-ctxlib__group" key={templateKey}>
                    <header className="st-ctxlib__group-header">
                      <span className="st-mono">{templateKey}</span>
                      <span className="st-ctxlib__group-count">
                        {rows.length} doc{rows.length === 1 ? '' : 's'}
                      </span>
                    </header>
                    {rows.map((doc) => (
                      <DocumentRow key={doc.id} doc={doc} clientLabel={clientName(doc.clientId)} />
                    ))}
                  </section>
                ))}
              </div>
            )}
          </section>

          {/* ---- right rail: document contract ------------------------------ */}
          <aside className="st-ctxlib__rail">
            <div className="st-ctxlib__contract">
              <span className="st-ctxlib__section-label">Document contract</span>
              <h2>What every context document carries</h2>
              <ContractItem
                title="Typed front matter"
                detail="Template key, scope, client and authority."
              />
              <ContractItem title="Validity window" detail="As-of and valid-until dates drive staleness." />
              <ContractItem title="Supersession chain" detail="New versions never erase prior evidence." />
              <ContractItem title="Exact provenance" detail="Facts point back to source document lines." />
              <CapiroButton
                variant="secondary"
                leadingIcon={<CapiroDownloadIcon size={0.95} />}
                onClick={downloadMarkdownTemplate}
              >
                Download markdown template
              </CapiroButton>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function StatCard({
  value,
  label,
  detail,
  tone = 'default',
  loading,
  failed,
}: {
  value: number;
  label: string;
  detail: string;
  tone?: 'default' | 'error';
  loading: boolean;
  failed: boolean;
}) {
  return (
    <article className={`st-ctxlib__stat${tone === 'error' ? ' is-error' : ''}`}>
      {loading ? (
        <CapiroSkeleton width={56} height={30} />
      ) : failed ? (
        <strong className="st-ctxlib__stat-value is-unavailable">—</strong>
      ) : (
        <strong className="st-ctxlib__stat-value">{value}</strong>
      )}
      <div className="st-ctxlib__stat-copy">
        <span className="st-ctxlib__stat-label">{label}</span>
        <small>{failed ? 'Unavailable — see panel below' : detail}</small>
      </div>
    </article>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`st-ctxlib__pill${active ? ' is-active' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

function DocumentRow({ doc, clientLabel }: { doc: ContextDocumentListItem; clientLabel: string }) {
  const navigate = useNavigate();
  const stale = isContextDocStale(doc);
  const asOf = fmtDay(fmScalar(doc.frontmatter, 'as_of'));
  const validTo = fmtDay(doc.validUntil ?? fmScalar(doc.frontmatter, 'valid_until'));
  const meta = [
    clientLabel,
    doc.scope,
    asOf ? `as of ${asOf}` : null,
    validTo ? `valid to ${validTo}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button type="button" className="st-ctxlib__row" onClick={() => navigate(`/strategies/context/${doc.id}`)}>
      <span className="st-ctxlib__row-copy">
        <strong>{doc.title}</strong>
        <small>{meta}</small>
      </span>
      <span className="st-ctxlib__row-pills">
        <CapiroBadge tone={STATE_TONE[doc.state]} dot={<span className="st-dot" aria-hidden="true" />}>
          {doc.state}
        </CapiroBadge>
        {stale ? (
          <CapiroBadge tone="warning" dot={<span className="st-dot" aria-hidden="true" />}>
            Stale
          </CapiroBadge>
        ) : null}
      </span>
      <span className="st-ctxlib__row-updated">Updated {updatedAgo(doc.updatedAt)}</span>
      <span className="st-ctxlib__row-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function ContractItem({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="st-ctxlib__contract-item">
      <span className="st-ctxlib__contract-check" aria-hidden="true">
        <CapiroCheckIcon size={0.8} />
      </span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}
