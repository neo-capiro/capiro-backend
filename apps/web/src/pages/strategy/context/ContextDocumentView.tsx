/*
 * Stage D context-document view (/strategies/context/:id): front-matter badge
 * strip (scope/authority/state/as_of/valid_until + derived STALE), the raw
 * markdown body as PLAIN preformatted text (deliberately no markdown renderer
 * — what the agents read is exactly what you see), and a Sections panel whose
 * entries call GET …/locate?ref=… and highlight the returned exact lines in
 * the body — provenance without an LLM. Archive retires the document.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, btnGhost } from '../strategy-ui.js';
import {
  useArchiveContextDocument,
  useContextDocument,
  useContextLocate,
  useContextSections,
  useExtractContextFacts,
} from '../api.js';
import { useClientsLite } from '../clients-lite.js';
import { useMe } from '../../../lib/me.js';
import { DocStateChips } from './ContextLibrary.js';
import { errorMessage } from '../../../lib/error-message.js';
import {
  canArchiveContextDoc,
  canExtractContextFacts,
  fmScalar,
  isContextDocStale,
  resolveHighlight,
  templateLabel,
} from './context-utils.js';

export function ContextDocumentView() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const doc = useContextDocument(id);
  const sections = useContextSections(id);
  const clients = useClientsLite();
  const archive = useArchiveContextDocument();
  const extract = useExtractContextFacts();
  const me = useMe();

  const [activeRef, setActiveRef] = useState<string | null>(null);
  const locate = useContextLocate(id, activeRef);
  const firstHitRef = useRef<HTMLDivElement | null>(null);

  const contentLines = useMemo(() => (doc.data?.content ?? '').split('\n'), [doc.data?.content]);
  const highlight = useMemo(
    () => (locate.data ? resolveHighlight(contentLines, locate.data) : null),
    [contentLines, locate.data],
  );

  // Bring the located lines into view once the locate result lands.
  useEffect(() => {
    if (highlight) firstHitRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  if (doc.isLoading) {
    return <div style={{ padding: 40, color: 'var(--ink-3)' }}>Loading document…</div>;
  }
  if (doc.isError || !doc.data) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={() => navigate('/strategies/context')} style={{ ...btnGhost, marginBottom: 16 }}>
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Back to context library
        </button>
        <div style={{ color: 'var(--ink-3)' }}>This context document could not be loaded.</div>
      </div>
    );
  }

  const d = doc.data;
  const stale = isContextDocStale(d);
  const clientName = d.clientId
    ? (clients.data?.find((c) => c.id === d.clientId)?.name ?? 'Client')
    : 'Firm-wide';
  const authority = fmScalar(d.frontmatter, 'authority');
  const asOf = fmScalar(d.frontmatter, 'as_of');
  const validUntil = d.validUntil ?? fmScalar(d.frontmatter, 'valid_until');

  // Stage E: run the Steward's structured extraction over this document. UI
  // belt = agenticMeri AND contextSteward (the route stacks ContextStewardGuard
  // on top of AgenticGuard, so either bit missing is a guaranteed 403) AND an
  // active document (the server 409s on draft/superseded/archived). The route
  // stays gated server-side; a race there still surfaces via errorMessage.
  const showExtract = canExtractContextFacts(me.data?.features, d.state);
  const onExtract = () => {
    if (extract.isPending) return;
    extract.mutate(d.id, {
      onSuccess: (r) => {
        const parts = [`Steward extracted ${r.inserted} fact${r.inserted === 1 ? '' : 's'}`];
        if (r.droppedRefs > 0) {
          parts.push(`dropped ${r.droppedRefs} unlocatable ref${r.droppedRefs === 1 ? '' : 's'}`);
        }
        if (r.conflicts > 0) {
          parts.push(`flagged ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}`);
        }
        message.success(`${parts.join(', ')}.`);
      },
      onError: (err) => message.error(errorMessage(err, 'The Steward could not extract facts from this document.')),
    });
  };

  const onArchive = () => {
    modal.confirm({
      title: 'Archive this document?',
      content: `“${d.title}” will no longer ground new agent work. Its history is retained.`,
      okText: 'Archive',
      okButtonProps: { danger: true },
      onOk: () =>
        new Promise<void>((resolve, reject) => {
          archive.mutate(d.id, {
            onSuccess: () => {
              message.success('Document archived.');
              resolve();
            },
            onError: (err) => {
              // Surface the server's reason (e.g. the 409 "archive the active
              // document instead") rather than a generic failure line.
              message.error(errorMessage(err, 'Could not archive the document.'));
              reject(new Error('archive failed'));
            },
          });
        }),
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-canvas)' }}>
      <div
        style={{
          padding: '16px 28px 14px',
          borderBottom: '1px solid var(--border-1)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/strategies/context')} style={{ ...btnGhost, padding: '6px 12px' }}>
            <Icon name="chevleft" size={14} color="var(--ink-2)" /> Context library
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-4)',
                fontWeight: 600,
              }}
            >
              {d.templateKey} · {clientName.toUpperCase()}
            </div>
            <div
              style={{
                fontSize: 'var(--text-lg)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.01em',
                marginTop: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {d.title}
            </div>
          </div>
          {showExtract && (
            <button onClick={onExtract} disabled={extract.isPending} style={btnGhost}>
              <Icon name="spark" size={14} color="var(--ink-2)" />
              {extract.isPending ? 'Extracting…' : 'Extract facts'}
            </button>
          )}
          {canArchiveContextDoc(d.state) && (
            <button onClick={onArchive} disabled={archive.isPending} style={btnGhost}>
              <Icon name="folder" size={14} color="var(--ink-2)" />
              {archive.isPending ? 'Archiving…' : 'Archive'}
            </button>
          )}
        </div>

        {/* Front-matter badge strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          <Chip tone="accent">{d.scope} scope</Chip>
          {authority && <Chip tone="ink">{authority.replace(/_/g, ' ')}</Chip>}
          <DocStateChips doc={d} />
          {asOf && <Chip tone="ink">as of {asOf.slice(0, 10)}</Chip>}
          {validUntil && (
            <Chip tone={stale ? 'notable' : 'ink'}>valid until {validUntil.slice(0, 10)}</Chip>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Markdown body — plain preformatted text, per-line for highlighting */}
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 20px 40px 12px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', lineHeight: 1.65 }}>
            {contentLines.map((line, i) => {
              const n = i + 1;
              const hit = !!highlight && n >= highlight.start && n <= highlight.end;
              return (
                <div
                  key={i}
                  ref={highlight && n === highlight.start ? firstHitRef : undefined}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '0 10px',
                    borderRadius: hit ? 4 : 0,
                    background: hit ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 34,
                      flexShrink: 0,
                      textAlign: 'right',
                      color: hit ? 'var(--accent-ink)' : 'var(--ink-4)',
                      userSelect: 'none',
                    }}
                  >
                    {n}
                  </span>
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, color: 'var(--ink-1)' }}>
                    {line || ' '}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sections panel — exact-source provenance without an LLM */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            borderLeft: '1px solid var(--border-1)',
            background: 'var(--bg-surface)',
            overflow: 'auto',
            padding: '16px 14px 28px',
          }}
        >
          <div
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 700,
              color: 'var(--ink-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Sections
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginTop: 4, lineHeight: 1.5 }}>
            Click a section to locate its exact source lines — retrieved deterministically, no AI
            involved.
          </div>

          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {sections.isLoading && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>Loading sections…</span>
            )}
            {sections.isError && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                Sections could not be loaded.
              </span>
            )}
            {sections.data?.map((s, i) => {
              const active = s.ref === activeRef;
              return (
                <button
                  key={`${s.ref}-${i}`}
                  onClick={() => setActiveRef(active ? null : s.ref)}
                  style={{
                    textAlign: 'left',
                    border: 'none',
                    borderRadius: 7,
                    padding: '6px 9px',
                    paddingLeft: 9 + Math.max(0, Math.min(s.level - 1, 4)) * 10,
                    cursor: 'pointer',
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: active ? 700 : 500,
                    color: active ? 'var(--accent-ink)' : 'var(--ink-2)',
                    background: active ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  {s.heading}
                  {active && locate.isFetching ? '…' : ''}
                </button>
              );
            })}
            {sections.isSuccess && (sections.data?.length ?? 0) === 0 && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
                No sections in this document.
              </span>
            )}
          </div>

          {activeRef && locate.isError && (
            <div style={{ marginTop: 12, fontSize: 'var(--text-xs)', color: 'var(--critical)' }}>
              Could not locate this section in the source.
            </div>
          )}
          {activeRef && locate.isSuccess && !highlight && (
            <div style={{ marginTop: 12, fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
              The exact source lines for this section could not be anchored in the current body.
            </div>
          )}
          {highlight && (
            <div
              style={{
                marginTop: 12,
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-3)',
              }}
            >
              Lines {highlight.start}–{highlight.end}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
