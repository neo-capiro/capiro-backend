import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { App as AntApp } from 'antd';
import {
  CheckOutlined,
  DownloadOutlined,
  PlusOutlined,
  SearchOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  useContextConflicts,
  useContextDocuments,
  useContextFacts,
  useUploadContextDocument,
} from '../../../pages/strategy/api.js';
import { useClientsLite } from '../../../pages/strategy/clients-lite.js';
import {
  fmScalar,
  isContextDocStale,
  parseUploadError,
  templateLabel,
  type UploadErrorView,
} from '../../../pages/strategy/context/context-utils.js';
import { relativeTime } from '../../../pages/strategy/constants.js';
import type {
  ContextDocState,
  ContextDocumentDetail,
  ContextDocumentListItem,
} from '../../../pages/strategy/types.js';

type StateFilter = 'active' | 'all' | ContextDocState;

/**
 * Figma source: Strategies / 04 Context Library — 843:2976.
 * Summary numbers and health state are live sp_context_* data, never the mock's
 * sample values. The upload flow still writes through the production context
 * endpoint and keeps server-side field validation authoritative.
 */
export function StrategyContextLibraryVNext() {
  const navigate = useNavigate();
  const docs = useContextDocuments();
  const facts = useContextFacts();
  const conflicts = useContextConflicts();
  const clients = useClientsLite();
  const [clientFilter, setClientFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('active');
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);

  const activeDocuments = (docs.data ?? []).filter((doc) => doc.state === 'active');
  const activeFacts = (facts.data ?? []).filter((fact) => fact.state === 'active');
  const staleFacts = (facts.data ?? []).filter((fact) => fact.state === 'stale').length;
  const openConflicts = (conflicts.data ?? []).filter((conflict) => conflict.state === 'open');
  const healthy = openConflicts.length === 0;

  const clientName = (id: string | null) =>
    id === null ? 'Firm' : clients.data?.find((client) => client.id === id)?.name ?? 'Client';

  const clientOptions = useMemo(
    () => [...new Set((docs.data ?? []).map((doc) => doc.clientId).filter((id): id is string => Boolean(id)))],
    [docs.data],
  );

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (docs.data ?? []).filter((doc) => {
      if (clientFilter !== 'all' && (clientFilter === 'firm' ? doc.clientId !== null : doc.clientId !== clientFilter)) return false;
      if (stateFilter !== 'all' && doc.state !== stateFilter) return false;
      if (query && !`${doc.title} ${doc.templateKey}`.toLowerCase().includes(query)) return false;
      return true;
    });
    const map = new Map<string, ContextDocumentListItem[]>();
    for (const doc of filtered) {
      const rows = map.get(doc.templateKey) ?? [];
      rows.push(doc);
      map.set(doc.templateKey, rows);
    }
    for (const rows of map.values()) {
      rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [clientFilter, docs.data, search, stateFilter]);

  const visibleCount = groups.reduce((sum, [, rows]) => sum + rows.length, 0);

  return (
    <div className="vnext-strategy-context" data-figma-node="843:2976">
      <div className="vnext-strategy-contextbar" aria-label="Context status">
        <ContextBarChip label="Context" value={clientFilter === 'all' ? 'All clients' : clientFilter === 'firm' ? 'Firm' : clientName(clientFilter)} />
        <ContextBarChip label="Pack" value="00–13" />
        <ContextBarChip label="State" value={stateFilter === 'all' ? 'All' : capitalize(stateFilter)} />
        <span className={`vnext-strategy-contextbar__health${healthy ? '' : ' has-conflict'}`}>
          {healthy ? `Healthy · ${activeFacts.length} facts` : `${openConflicts.length} open conflict${openConflicts.length === 1 ? '' : 's'} · ${activeFacts.length} facts`}
        </span>
      </div>

      <header className="vnext-strategy-context__header">
        <button className="vnext-strategy-button" type="button" onClick={() => navigate('/strategies')}>‹ Strategies</button>
        <div className="vnext-strategy-context__title-row">
          <div>
            <div className="vnext-strategy-eyebrow">Grounded agent context</div>
            <h1>Context library</h1>
          </div>
          <p>Durable, typed documents that ground Meri and strategy agents with validated front matter, provenance and supersession.</p>
          <div className="vnext-strategy-context__actions">
            <button className="vnext-strategy-button" type="button" onClick={() => navigate('/strategies/context/steward')}>
              <SafetyCertificateOutlined /> Steward review
            </button>
            <button className="vnext-strategy-button is-primary" type="button" onClick={() => setUploadOpen(true)}>
              <PlusOutlined /> Upload document
            </button>
          </div>
        </div>
      </header>

      <main className="vnext-strategy-context__body">
        <div className="vnext-strategy-context__content">
          <div className="vnext-strategy-context__summary">
            <ContextMetric value={activeDocuments.length} label="Active documents" detail="Across firm + clients" tone="accent" />
            <ContextMetric value={activeFacts.length} label="Extracted facts" detail={`${Math.max(activeFacts.length - staleFacts, 0)} active · ${staleFacts} stale`} tone="success" />
            <ContextMetric value={openConflicts.length} label="Open conflicts" detail={openConflicts.length ? 'Steward decision required' : 'No steward decision required'} tone="warning" />
          </div>

          <aside className="vnext-strategy-steward-card">
            <span>Stewardship</span>
            <strong>Context is operational data.</strong>
            <p>Facts retain exact source references. Supersession preserves history. Rejection never edits the source document.</p>
            <button type="button" onClick={() => navigate('/strategies/context/steward')}>
              <SafetyCertificateOutlined /> {openConflicts.length ? `Review ${openConflicts.length} conflict${openConflicts.length === 1 ? '' : 's'}` : 'Open Steward'}
            </button>
          </aside>

          <section className="vnext-strategy-context__documents">
            <div className="vnext-strategy-context__documents-toolbar">
              <div>
                <div className="vnext-strategy-section-label">Documents</div>
                <strong>{visibleCount} document{visibleCount === 1 ? '' : 's'} · grouped by template</strong>
              </div>
              <select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)} aria-label="Filter context by client">
                <option value="all">All clients</option>
                {(docs.data ?? []).some((doc) => doc.clientId === null) ? <option value="firm">Firm-wide</option> : null}
                {clientOptions.map((id) => <option key={id} value={id}>{clientName(id)}</option>)}
              </select>
              <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as StateFilter)} aria-label="Filter context by state">
                <option value="active">Active</option>
                <option value="all">All states</option>
                <option value="draft">Draft</option>
                <option value="superseded">Superseded</option>
                <option value="archived">Archived</option>
              </select>
              <label className="vnext-strategy-context-search">
                <SearchOutlined />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents" aria-label="Search context documents" />
              </label>
            </div>

            <div className="vnext-strategy-context__document-list">
              {docs.isLoading ? (
                <ContextEmpty title="Loading context documents…" />
              ) : docs.isError ? (
                <ContextEmpty title="The context library could not be loaded." />
              ) : groups.length === 0 ? (
                <ContextEmpty title={docs.data?.length ? 'No documents match these filters.' : 'No context documents yet.'} />
              ) : (
                groups.map(([templateKey, rows]) => (
                  <section className="vnext-strategy-context-group" key={templateKey}>
                    <header><span>{templateKey}</span><small>{rows.length} doc{rows.length === 1 ? '' : 's'}</small></header>
                    {rows.map((doc) => (
                      <button type="button" key={doc.id} onClick={() => navigate(`/strategies/context/${doc.id}`)}>
                        <span className="vnext-strategy-context-group__copy">
                          <strong>{doc.title}</strong>
                          <small>{contextMeta(doc, clientName(doc.clientId))}</small>
                        </span>
                        <span className="vnext-strategy-context-group__state">
                          <span className={`state-${doc.state}`}>{capitalize(doc.state)}</span>
                          {isContextDocStale(doc) ? <span className="is-stale">Stale</span> : null}
                        </span>
                        <span className="vnext-strategy-context-group__updated">Updated {relativeTime(doc.updatedAt)}</span>
                        <span aria-hidden="true">›</span>
                      </button>
                    ))}
                  </section>
                ))
              )}
            </div>
          </section>

          <aside className="vnext-strategy-context-guide">
            <div className="vnext-strategy-section-label">Document contract</div>
            <h2>What every context document carries</h2>
            <GuideItem title="Typed front matter" detail="Template key, scope, client and authority." />
            <GuideItem title="Validity window" detail="As-of and valid-until dates drive staleness." />
            <GuideItem title="Supersession chain" detail="New versions never erase prior evidence." />
            <GuideItem title="Exact provenance" detail="Facts point back to source document lines." />
            <button className="vnext-strategy-button" type="button" onClick={() => setUploadOpen(true)}>
              <DownloadOutlined /> Use markdown upload
            </button>
          </aside>
        </div>
      </main>

      {uploadOpen ? <ContextUploadModal clients={clients.data ?? []} onClose={() => setUploadOpen(false)} /> : null}
    </div>
  );
}

function ContextBarChip({ label, value }: { label: string; value: string }) {
  return <span className="vnext-strategy-contextbar__chip"><small>{label}</small><strong>{value}</strong></span>;
}

function ContextMetric({ value, label, detail, tone }: { value: number; label: string; detail: string; tone: 'accent' | 'success' | 'warning' }) {
  return (
    <article className={`vnext-strategy-context-metric tone-${tone}`}>
      <strong>{value}</strong>
      <div><span>{label}</span><small>{detail}</small></div>
    </article>
  );
}

function GuideItem({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="vnext-strategy-context-guide__item">
      <span><CheckOutlined /></span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

function ContextEmpty({ title }: { title: string }) {
  return <div className="vnext-strategy-context-empty">{title}</div>;
}

function contextMeta(doc: ContextDocumentListItem, client: string): string {
  const asOf = fmScalar(doc.frontmatter, 'as_of');
  const validUntil = doc.validUntil ?? fmScalar(doc.frontmatter, 'valid_until');
  return [client.toUpperCase(), doc.scope.toUpperCase(), asOf ? `AS OF ${asOf}` : null, validUntil ? `VALID TO ${validUntil.slice(0, 10)}` : null]
    .filter(Boolean)
    .join(' · ');
}

function capitalize(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function ContextUploadModal({
  clients,
  onClose,
}: {
  clients: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const upload = useUploadContextDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [clientId, setClientId] = useState('');
  const [errors, setErrors] = useState<UploadErrorView | null>(null);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setContent(await file.text());
      setErrors(null);
    } catch {
      message.error(`Could not read ${file.name}.`);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    if (!content.trim() || upload.isPending) return;
    try {
      await upload.mutateAsync({ content, clientId: clientId || undefined });
      message.success('Context document uploaded.');
      onClose();
    } catch (error) {
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      setErrors(status === 400 ? parseUploadError(error) : { general: 'The upload failed. Please try again.', fields: [] });
    }
  };

  return (
    <div className="vnext-strategy-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="vnext-strategy-upload-modal" role="dialog" aria-modal="true" aria-label="Upload context document" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>Grounded agent context</span><h2>Upload document</h2></div><button type="button" onClick={onClose}>×</button></header>
        <div className="vnext-strategy-upload-modal__body">
          <label>Client scope<select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Firm / inferred from front matter</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label>Markdown document<textarea value={content} onChange={(event) => { setContent(event.target.value); setErrors(null); }} placeholder="Paste the completed context pack markdown, including front matter…" /></label>
          <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" onChange={readFile} hidden />
          <button className="vnext-strategy-button" type="button" onClick={() => fileRef.current?.click()}>Choose .md file</button>
          {errors ? <div className="vnext-strategy-upload-errors"><strong>{errors.general}</strong>{errors.fields.map((field, index) => <span key={`${field.field}-${index}`}>{field.field}: {field.message}</span>)}</div> : null}
        </div>
        <footer><button className="vnext-strategy-button" type="button" onClick={onClose}>Cancel</button><button className="vnext-strategy-button is-primary" type="button" disabled={!content.trim() || upload.isPending} onClick={submit}>{upload.isPending ? 'Uploading…' : 'Upload document'}</button></footer>
      </section>
    </div>
  );
}
