import { useEffect, useMemo, useRef, useState } from 'react';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroCopyIcon, CapiroFolderIcon, CapiroSafetyCertificateIcon, CapiroThunderboltIcon } from '../../components/icons/index.js';
import { useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import { errorMessage } from '../../../lib/error-message.js';
import {
  useArchiveContextDocument,
  useContextDocument,
  useContextFacts,
  useContextLocate,
  useContextSections,
  useExtractContextFacts,
} from '../../../pages/strategy/api.js';
import { useClientsLite } from '../../../pages/strategy/clients-lite.js';
import {
  canArchiveContextDoc,
  canExtractContextFacts,
  fmScalar,
  isContextDocStale,
  resolveHighlight,
  templateLabel,
} from '../../../pages/strategy/context/context-utils.js';

/** Figma source: Strategies / 05 Context Document — 843:3134. */
export function StrategyContextDocumentVNext() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const toast = useCapiroToast();
  const doc = useContextDocument(id);
  const sections = useContextSections(id);
  const facts = useContextFacts();
  const clients = useClientsLite();
  const archive = useArchiveContextDocument();
  const extract = useExtractContextFacts();
  const me = useMe();
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const locate = useContextLocate(id, activeRef);
  const firstHitRef = useRef<HTMLDivElement | null>(null);

  const contentLines = useMemo(() => (doc.data?.content ?? '').split('\n'), [doc.data?.content]);
  const highlight = useMemo(
    () => (locate.data ? resolveHighlight(contentLines, locate.data) : null),
    [contentLines, locate.data],
  );
  useEffect(() => {
    if (highlight) firstHitRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  if (doc.isLoading) return <div className="vnext-strategy-loading">Loading document…</div>;
  if (doc.isError || !doc.data) {
    return (
      <div className="vnext-strategy-context-doc-error">
        <button className="vnext-strategy-button" type="button" onClick={() => navigate('/strategies/context')}>‹ Context library</button>
        <p>This context document could not be loaded.</p>
      </div>
    );
  }

  const d = doc.data;
  const clientName = d.clientId
    ? clients.data?.find((client) => client.id === d.clientId)?.name ?? 'Client'
    : 'Firm-wide';
  const authority = fmScalar(d.frontmatter, 'authority');
  const asOf = fmScalar(d.frontmatter, 'as_of');
  const validUntil = d.validUntil ?? fmScalar(d.frontmatter, 'valid_until');
  const stale = isContextDocStale(d);
  const documentFacts = (facts.data ?? []).filter((fact) => fact.documentId === d.id);
  const activeFacts = documentFacts.filter((fact) => fact.state === 'active').length;
  const historicalFacts = documentFacts.length - activeFacts;
  const showExtract = canExtractContextFacts(me.data?.features, d.state);

  const onExtract = () => {
    if (extract.isPending) return;
    extract.mutate(d.id, {
      onSuccess: (result) => {
        const details = [`${result.inserted} fact${result.inserted === 1 ? '' : 's'} extracted`];
        if (result.droppedRefs) details.push(`${result.droppedRefs} unlocatable ref${result.droppedRefs === 1 ? '' : 's'} dropped`);
        if (result.conflicts) details.push(`${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'} flagged`);
        toast.success(details.join(' · '));
      },
      onError: (error) => toast.error(errorMessage(error, 'The Steward could not extract facts.')),
    });
  };

  // Was antd's imperative `modal.confirm`. CapiroModal is declarative, so the
  // confirm step is page state and the mutation runs from the dialog's action.
  const confirmArchive = () => {
    archive.mutate(d.id, {
      onSuccess: () => {
        toast.success('Document archived.');
        setArchiveOpen(false);
      },
      onError: (error) => {
        toast.error(errorMessage(error, 'Could not archive the document.'));
        // Leave the dialog open so the failure is visible next to the action
        // that caused it, and the user can retry without re-navigating.
      },
    });
  };

  const copySourceLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Source link copied.');
    } catch {
      toast.error('Could not copy the source link.');
    }
  };

  return (
    <div className="vnext-strategy-context-doc" data-figma-node="843:3134">
      <div className="vnext-strategy-contextbar" aria-label="Document context">
        <ContextChip label="Client" value={clientName} />
        <ContextChip label="Template" value={templateLabel(d.templateKey)} />
        <ContextChip label="State" value={capitalize(d.state)} />
        <span className="vnext-strategy-context-doc__provenance">Provenance locked</span>
      </div>

      <header className="vnext-strategy-context-doc__header">
        <button className="vnext-strategy-button" type="button" onClick={() => navigate('/strategies/context')}>‹ Context library</button>
        <div className="vnext-strategy-context-doc__heading-row">
          <div>
            <span>{d.templateKey} · {clientName.toUpperCase()}</span>
            <h1>{d.title}</h1>
          </div>
          <div className="vnext-strategy-context-doc__actions">
            {showExtract ? (
              <button className="vnext-strategy-button is-primary" type="button" onClick={onExtract} disabled={extract.isPending}>
                <CapiroThunderboltIcon /> {extract.isPending ? 'Extracting…' : 'Extract facts'}
              </button>
            ) : null}
            {canArchiveContextDoc(d.state) ? (
              <button className="vnext-strategy-button" type="button" onClick={() => setArchiveOpen(true)} disabled={archive.isPending}>
                <CapiroFolderIcon /> {archive.isPending ? 'Archiving…' : 'Archive'}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="vnext-strategy-context-doc__metadata">
        <MetaBadge label={`Scope · ${d.scope}`} />
        {authority ? <MetaBadge label={`Authority · ${authority.replace(/_/g, ' ')}`} tone="info" /> : null}
        <MetaBadge label={`State · ${d.state}`} tone={d.state === 'active' ? 'success' : undefined} />
        {asOf ? <MetaBadge label={`As of · ${formatDate(asOf)}`} /> : null}
        {validUntil ? <MetaBadge label={`Valid to · ${formatDate(validUntil)}`} tone={stale ? 'warning' : undefined} /> : null}
        <span className="vnext-strategy-context-doc__version">
          {d.supersedesId ? 'Supersedes prior active version' : 'Current source version'} · updated {new Date(d.updatedAt).toLocaleDateString()}
        </span>
      </div>

      <main className="vnext-strategy-context-doc__body">
        <section className="vnext-strategy-context-doc__viewer">
          <header>
            <span>{d.templateKey}.md</span>
            <small>{highlight ? `Selected lines ${highlight.start}–${highlight.end}` : `${contentLines.length} source lines`}</small>
          </header>
          <div className="vnext-strategy-context-doc__code">
            {contentLines.map((line, index) => {
              const lineNumber = index + 1;
              const hit = Boolean(highlight && lineNumber >= highlight.start && lineNumber <= highlight.end);
              return (
                <div
                  key={lineNumber}
                  ref={highlight && lineNumber === highlight.start ? firstHitRef : undefined}
                  className={hit ? 'is-selected' : ''}
                >
                  <span>{lineNumber}</span>
                  <code>{line || ' '}</code>
                </div>
              );
            })}
          </div>
          {highlight ? <div className="vnext-strategy-context-doc__selection">Selected · lines {highlight.start}–{highlight.end}</div> : null}
        </section>

        <aside className="vnext-strategy-context-doc__sections">
          <div className="vnext-strategy-section-label">Sections</div>
          <h2>Document outline</h2>
          <div className="vnext-strategy-context-doc__section-list">
            {sections.isLoading ? <span className="is-note">Loading sections…</span> : null}
            {sections.isError ? <span className="is-note">Sections could not be loaded.</span> : null}
            {sections.data?.map((section, index) => {
              const active = section.ref === activeRef;
              return (
                <button
                  key={`${section.ref}-${index}`}
                  type="button"
                  className={active ? 'is-active' : ''}
                  style={{ '--section-depth': Math.max(0, Math.min(section.level - 1, 4)) } as React.CSSProperties}
                  onClick={() => setActiveRef(active ? null : section.ref)}
                >
                  <span>{section.heading}{active && locate.isFetching ? '…' : ''}</span>
                  <small>{section.line ? `L${section.line}` : ''}</small>
                </button>
              );
            })}
            {sections.isSuccess && !sections.data?.length ? <span className="is-note">No sections in this document.</span> : null}
          </div>

          <div className="vnext-strategy-context-doc__proof-card">
            <span>Provenance</span>
            <strong>Exact source references retained</strong>
            <p>Extracted facts retain this document ID, source reference and deterministic line anchor.</p>
            <small>Source anchored</small>
          </div>

          <div className="vnext-strategy-context-doc__facts">
            <span>Extracted facts</span>
            <strong>{activeFacts} active{historicalFacts ? ` · ${historicalFacts} historical` : ''}</strong>
          </div>
          <button className="vnext-strategy-button" type="button" onClick={() => navigate('/strategies/context/steward')}>
            <CapiroSafetyCertificateIcon /> Open steward review
          </button>
          <button className="vnext-strategy-button" type="button" onClick={copySourceLink}>
            <CapiroCopyIcon /> Copy source link
          </button>
          {activeRef && locate.isError ? <span className="vnext-strategy-context-doc__locate-error">Could not locate this section in the source.</span> : null}
        </aside>
      </main>

      <CapiroModal open={archiveOpen} title="Archive this document?" onClose={() => setArchiveOpen(false)}>
        <p className="vnext-strategy-context-doc__confirm">
          “{d.title}” will stop grounding new agent work. Its provenance and history are retained.
        </p>
        <div className="vnext-strategy-context-doc__confirm-actions">
          <button className="vnext-strategy-button" type="button" onClick={() => setArchiveOpen(false)} disabled={archive.isPending}>
            Cancel
          </button>
          <button className="vnext-strategy-button is-danger" type="button" onClick={confirmArchive} disabled={archive.isPending}>
            {archive.isPending ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </CapiroModal>
    </div>
  );
}

function ContextChip({ label, value }: { label: string; value: string }) {
  return <span className="vnext-strategy-contextbar__chip"><small>{label}</small><strong>{value}</strong></span>;
}

function MetaBadge({ label, tone }: { label: string; tone?: 'success' | 'info' | 'warning' }) {
  return <span className={`vnext-strategy-context-doc__badge${tone ? ` tone-${tone}` : ''}`}>{label}</span>;
}

function capitalize(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function formatDate(value: string) {
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
