/*
 * Stage D context-document library (/strategies/context) — the browsable
 * store behind the agentic pack (sp_context_document). Lists the tenant's
 * documents grouped by pack template (00–13 contract) with a client filter,
 * state chips + a derived STALE amber chip, and an upload affordance (paste
 * or read a .md file) that renders the server's field-level validation
 * errors. Gated by /me features.agenticMeri (route-level in StrategyRoutes).
 * Mirrors the StrategyLibraryPage idioms: inline var(--*) styles on .sp-root
 * tokens, Overlay modal, Chip/Icon primitives.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, Overlay, btnGhost, btnPrimary, iconBtn, lbl } from '../strategy-ui.js';
import { useContextDocuments, useUploadContextDocument } from '../api.js';
import { useClientsLite } from '../clients-lite.js';
import { relativeTime } from '../constants.js';
import {
  fmScalar,
  isContextDocStale,
  parseUploadError,
  templateLabel,
  type UploadErrorView,
} from './context-utils.js';
import type { ClientLite } from '../clients-lite.js';
import type { ContextDocState, ContextDocumentDetail, ContextDocumentListItem } from '../types.js';

const selS: React.CSSProperties = {
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  background: 'var(--bg-surface)',
  cursor: 'pointer',
};

const STATE_TONE: Record<ContextDocState, 'success' | 'info' | 'ink'> = {
  active: 'success',
  draft: 'info',
  superseded: 'ink',
  archived: 'ink',
};

/** State chip + the derived STALE amber chip — shared with the document view. */
export function DocStateChips({ doc }: { doc: ContextDocumentListItem }) {
  return (
    <>
      <Chip tone={STATE_TONE[doc.state] ?? 'ink'}>{doc.state}</Chip>
      {isContextDocStale(doc) && <Chip tone="notable">Stale</Chip>}
    </>
  );
}

export function ContextLibrary() {
  const navigate = useNavigate();
  const docs = useContextDocuments();
  const clients = useClientsLite();

  const [fc, setFc] = useState('all'); // 'all' | 'firm' | clientId
  const [uploadOpen, setUploadOpen] = useState(false);
  const [lastUpload, setLastUpload] = useState<ContextDocumentDetail | null>(null);

  const clientName = (id: string | null) =>
    id === null ? 'Firm-wide' : (clients.data?.find((c) => c.id === id)?.name ?? 'Client');

  const clientFilterOptions = useMemo(
    () => [...new Set((docs.data ?? []).map((d) => d.clientId).filter((c): c is string => !!c))],
    [docs.data],
  );
  const hasFirmDocs = (docs.data ?? []).some((d) => d.clientId === null);

  const groups = useMemo(() => {
    const rows = (docs.data ?? []).filter(
      (d) => fc === 'all' || (fc === 'firm' ? d.clientId === null : d.clientId === fc),
    );
    const byKey = new Map<string, ContextDocumentListItem[]>();
    for (const row of rows) {
      const list = byKey.get(row.templateKey) ?? [];
      list.push(row);
      byKey.set(row.templateKey, list);
    }
    const stateOrder: Record<ContextDocState, number> = {
      active: 0,
      draft: 1,
      superseded: 2,
      archived: 3,
    };
    for (const list of byKey.values()) {
      list.sort(
        (a, b) =>
          (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9) ||
          (a.updatedAt < b.updatedAt ? 1 : -1),
      );
    }
    return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [docs.data, fc]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-canvas)', height: '100%' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 40px 60px' }}>
        <button onClick={() => navigate('/strategies')} style={{ ...btnGhost, marginBottom: 14 }}>
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Strategies
        </button>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h1
              style={{
                fontSize: 'var(--text-xl)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              Context library
            </h1>
            <p
              style={{
                fontSize: 'var(--text-md)',
                color: 'var(--ink-2)',
                marginTop: 4,
                maxWidth: 640,
              }}
            >
              Durable, typed context documents that ground Meri's agents — pack templates with
              validated front-matter, supersession history, and exact source provenance.
            </p>
          </div>
          <button onClick={() => setUploadOpen(true)} style={btnPrimary}>
            <Icon name="upload" size={15} color="#fff" /> Upload document
          </button>
        </div>

        {lastUpload?.supersedesId && (
          <div
            style={{
              marginTop: 18,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--info-soft)',
              border: '1px solid var(--info)',
              borderRadius: 10,
              padding: '10px 15px',
            }}
          >
            <Icon name="refresh" size={15} color="var(--info)" />
            <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--info)', fontWeight: 600 }}>
              “{lastUpload.title}” replaced the previously active {templateLabel(lastUpload.templateKey)}{' '}
              document — the old version is retained as superseded.
            </span>
            <button onClick={() => setLastUpload(null)} style={iconBtn}>
              <Icon name="x" size={13} color="var(--info)" />
            </button>
          </div>
        )}

        <div style={{ marginTop: 28, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 700,
              color: 'var(--ink-1)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Documents
          </span>
          <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
            {total}
          </span>
          <span style={{ flex: 1 }} />
          <select value={fc} onChange={(e) => setFc(e.target.value)} style={selS}>
            <option value="all">All clients</option>
            {hasFirmDocs && <option value="firm">Firm-wide</option>}
            {clientFilterOptions.map((c) => (
              <option key={c} value={c}>
                {clientName(c)}
              </option>
            ))}
          </select>
        </div>

        {docs.isLoading && (
          <div
            style={{
              padding: 28,
              textAlign: 'center',
              fontSize: 'var(--text-sm)',
              color: 'var(--ink-3)',
              border: '1px dashed var(--border-2)',
              borderRadius: 12,
            }}
          >
            Loading context documents…
          </div>
        )}

        {!docs.isLoading && docs.isError && (
          <div
            style={{
              padding: 28,
              textAlign: 'center',
              fontSize: 'var(--text-sm)',
              color: 'var(--critical)',
              border: '1px dashed var(--critical)',
              borderRadius: 12,
            }}
          >
            The context library could not be loaded — you may not have access, or the request
            failed. Refresh to try again.
          </div>
        )}

        {!docs.isLoading &&
          groups.map(([templateKey, list]) => (
            <div key={templateKey} style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontWeight: 700,
                    color: 'var(--ink-1)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {templateLabel(templateKey)}
                </span>
                <span
                  style={{
                    fontSize: 'var(--text-2xs)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--ink-4)',
                  }}
                >
                  {templateKey} · {list.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map((d) => (
                  <DocumentRow
                    key={d.id}
                    doc={d}
                    clientName={clientName(d.clientId)}
                    onOpen={() => navigate(`/strategies/context/${d.id}`)}
                  />
                ))}
              </div>
            </div>
          ))}

        {!docs.isLoading && !docs.isError && total === 0 && (
          <div
            style={{
              padding: 28,
              textAlign: 'center',
              fontSize: 'var(--text-sm)',
              color: 'var(--ink-3)',
              border: '1px dashed var(--border-2)',
              borderRadius: 12,
            }}
          >
            {docs.data && docs.data.length > 0
              ? 'No context documents match this filter.'
              : 'No context documents yet — upload a completed pack template to get started.'}
          </div>
        )}
      </div>

      {uploadOpen && (
        <UploadContextModal
          clients={clients.data ?? []}
          onClose={() => setUploadOpen(false)}
          onUploaded={(doc) => {
            setUploadOpen(false);
            setLastUpload(doc);
          }}
        />
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  clientName,
  onOpen,
}: {
  doc: ContextDocumentListItem;
  clientName: string;
  onOpen: () => void;
}) {
  const asOf = fmScalar(doc.frontmatter, 'as_of');
  const validUntil = doc.validUntil ?? fmScalar(doc.frontmatter, 'valid_until');
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '11px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
      }}
    >
      <Icon name="doc" size={16} color="var(--ink-3)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--ink-1)', letterSpacing: '-0.01em' }}>
          {doc.title}
        </div>
        <div
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--ink-3)',
            marginTop: 3,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--ink-2)',
              fontSize: 'var(--text-2xs)',
            }}
          >
            {clientName}
          </span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span>{doc.scope} scope</span>
          {asOf && (
            <>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span>as of {asOf}</span>
            </>
          )}
          {validUntil && (
            <>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span>valid until {validUntil.slice(0, 10)}</span>
            </>
          )}
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span>updated {relativeTime(doc.updatedAt)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <DocStateChips doc={doc} />
      </div>
      <Icon name="chevron" size={15} color="var(--ink-4)" />
    </div>
  );
}

/**
 * Upload modal: paste markdown (front-matter block included) or read a local
 * .md file into the textarea. A 400 renders the server's field-level errors
 * under a general failure banner; nothing closes until the upload succeeds.
 */
function UploadContextModal({
  clients,
  onClose,
  onUploaded,
}: {
  clients: ClientLite[];
  onClose: () => void;
  onUploaded: (doc: ContextDocumentDetail) => void;
}) {
  const { message } = App.useApp();
  const upload = useUploadContextDocument();
  const [content, setContent] = useState('');
  const [client, setClient] = useState('');
  const [errView, setErrView] = useState<UploadErrorView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      setContent(await file.text());
      setErrView(null);
    } catch {
      message.error(`Could not read ${file.name}.`);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    if (!content.trim() || upload.isPending) return;
    try {
      const doc = await upload.mutateAsync({
        content,
        clientId: client || undefined,
      });
      message.success('Context document uploaded.');
      onUploaded(doc);
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 400) {
        setErrView(parseUploadError(err));
      } else {
        setErrView({ general: 'The upload failed. Please try again.', fields: [] });
      }
    }
  };

  const field: React.CSSProperties = {
    width: '100%',
    border: '1px solid var(--border-2)',
    borderRadius: 9,
    padding: '9px 13px',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
    background: 'var(--bg-surface)',
    boxSizing: 'border-box',
  };

  return (
    <Overlay onClose={upload.isPending ? () => {} : onClose}>
      <div
        style={{
          width: 620,
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-4)',
                fontWeight: 600,
              }}
            >
              CONTEXT LIBRARY
            </div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)', marginTop: 2 }}>
              Upload a context document
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <label style={lbl}>
            Client{' '}
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--ink-3)' }}>
              · optional — leave empty for firm-wide
            </span>
          </label>
          <select value={client} onChange={(e) => setClient(e.target.value)} style={{ ...field, marginBottom: 18 }}>
            <option value="">Firm-wide (no client)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label style={lbl}>
            Markdown{' '}
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--ink-3)' }}>
              · include the YAML front-matter block from the pack template
            </span>
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder={'---\ndocument_type: strategy_brief\nscope: strategy\nas_of: 2026-07-24\n---\n\n# Strategy brief\n…'}
            style={{
              ...field,
              resize: 'vertical',
              lineHeight: 1.5,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
            }}
          />
          <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/*" hidden onChange={(e) => readFile(e.target.files)} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            style={{
              ...btnGhost,
              width: '100%',
              justifyContent: 'center',
              borderStyle: 'dashed',
              padding: '9px 13px',
              marginTop: 8,
            }}
          >
            <Icon name="paperclip" size={14} color="var(--ink-2)" /> …or read a .md file into the editor
          </button>

          {errView && (
            <div
              style={{
                marginTop: 14,
                background: 'var(--critical-soft)',
                border: '1px solid var(--critical)',
                borderRadius: 9,
                padding: '10px 13px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="alert" size={14} color="var(--critical)" />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--critical)' }}>
                  {errView.general}
                </span>
              </div>
              {errView.fields.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {errView.fields.map((f, i) => (
                    <div
                      key={`${f.field}-${i}`}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 'var(--text-xs)' }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                          color: 'var(--critical)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {f.field}
                      </span>
                      <span style={{ color: 'var(--ink-1)' }}>{f.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--bg-surface-2)',
          }}
        >
          <button onClick={onClose} style={btnGhost} disabled={upload.isPending}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!content.trim() || upload.isPending}
            title={content.trim() ? '' : 'Paste or read a document first'}
            style={{
              ...btnPrimary,
              opacity: !content.trim() || upload.isPending ? 0.45 : 1,
              cursor: !content.trim() || upload.isPending ? 'not-allowed' : 'pointer',
            }}
          >
            <Icon name="upload" size={14} color="#fff" />
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
