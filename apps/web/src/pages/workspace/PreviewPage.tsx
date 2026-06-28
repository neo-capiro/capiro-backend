/**
 * Workspace › Preview & Save — ported to full fidelity from the locked prototype
 * (WsPreview, asset_10) with the Phase-final LOCKED decisions:
 *
 *  - Left = StepsRail active="preview"; main = controls bar + preview stage +
 *    right export panel (a 1fr / 300px grid).
 *  - Renders REAL draft content inside the page-sheet chrome (NOT greeked
 *    skeletons): reads useDraft, derives the section view-models exactly like the
 *    editor (sectionViews + budgetFrom + ask + anonymize) and prints each
 *    section's sanitized HTML.
 *  - D1 FIX: the "White paper" view renders ONE paper page, not two.
 *  - View toggle: Cover letter (only when cfg.coverLetter) / White paper / Full packet.
 *  - Office selector: shown only when cfg.personalize && cfg.offices.length > 1
 *    (Q-ED-1 predicate). Selects which office's cover/variant previews.
 *  - Export panel: PDF / Word toggle; Separate files / Combined packet bundle;
 *    Export label reflects format and, when personalized + bulk, "all N offices (.zip)".
 *      · Word  = useExportDocx (real .docx). Per-office → sequential downloads
 *        (a real .zip would need a dep — TODO(phase) below). Combined packet for a
 *        single office is the engine's whole-draft .docx.
 *      · PDF   = window.print() against the rendered preview (the @media print CSS
 *        in workspace.css emits only the .ws-print-sheet pages — no new dep).
 *  - Sign-off gates WARN, never block (Q-PV-2): useDraftChecks → the 3 gates + any
 *    non-success checks render as a non-blocking warning surface near Export.
 *    Export proceeds after a confirm that lists the unmet gates.
 *  - "Save" = a named checkpoint/version (useCreateVersion) while autosave continues
 *    (Q-PV-3).
 *  - Autosaved stamp from draft.updatedAt.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { Icon, Ava } from './kit.js';
import { StepsRail } from './StepsRail.js';
import {
  initials as initialsOf,
  useCreateVersion,
  useDraft,
  useDraftChecks,
  useExportDocx,
} from './api.js';
import { useMe } from '../../lib/me.js';
import { sectionViews } from './editor/section-model.js';
import { budgetFrom } from './editor/BudgetBlock.js';
import { anonymizeMap, anonText } from './editor/anonymize.js';
import type { StoredRedaction } from './editor/anonymize.js';
import { sanitizeWorkspaceBody as sanitizeHtml } from './editor/workspace-richtext.js';
import type { WsAsk, WsCheckResult, WsGateResult } from './types.js';

type ViewKey = 'cover' | 'paper' | 'packet';
type Fmt = 'pdf' | 'word';
type Bundle = 'separate' | 'packet';

export function PreviewPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();

  const { data: draft, isLoading } = useDraft(draftId ?? null);
  const { data: me } = useMe();
  const { data: checks } = useDraftChecks(draftId ?? null);
  const exportDocx = useExportDocx(draftId ?? '');
  const createVersion = useCreateVersion(draftId ?? '');

  const [view, setView] = useState<ViewKey>('packet');
  const [fmt, setFmt] = useState<Fmt>('pdf');
  const [bundle, setBundle] = useState<Bundle>('separate');
  const [officeIdx, setOfficeIdx] = useState(0);
  const [officeMenu, setOfficeMenu] = useState(false);
  const [exporting, setExporting] = useState(false);

  const cfg = draft?.config;
  const offices = useMemo(() => (cfg?.offices as string[] | undefined) ?? [], [cfg]);
  // Q-ED-1 predicate: the office selector appears only for a personalized,
  // multi-office draft (NOT the old offices>1 alone).
  const showOfficeSelector = !!cfg?.personalize && offices.length > 1;
  const bulk = showOfficeSelector;
  const hasCover = !!cfg?.coverLetter;

  // If the draft has no cover letter, the cover/packet views collapse to the
  // white paper. Keep the active view valid as the config loads.
  useEffect(() => {
    if (!hasCover && (view === 'cover' || view === 'packet')) setView('paper');
  }, [hasCover, view]);

  if (isLoading || !draft || !cfg) {
    return (
      <div className="ws-shell">
        <StepsRail active="preview" draftId={draftId} />
        <div className="ws-stage" style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  const office = offices[Math.min(officeIdx, Math.max(0, offices.length - 1))] ?? null;

  // ── Real content view-models (mirrors EditorPage) ───────────────────────────
  const views = sectionViews(cfg);
  const storedRedactions = (cfg.anonymizeMap as { redactions?: StoredRedaction[] } | undefined)
    ?.redactions;
  const anonOn = !!cfg.anonymize;
  const anonMap = anonymizeMap(draft.client, draft.product, storedRedactions);
  const ask: WsAsk =
    (cfg.ask as WsAsk | undefined) ??
    (draft.ask && draft.ask !== 'n/a' ? (draft.ask as WsAsk) : {});
  const budget = budgetFrom(cfg);

  // Letterhead = the FIRM's branding, shown ONLY when the user opted into a
  // custom letterhead in Setup. Never the client (no draft.client fallback).
  const lhCustom = !!cfg.letterhead?.custom;
  const firmLogo = cfg.letterhead?.logoDataUrl;
  const firmName = cfg.letterhead?.firmName || 'Your firm';
  const firmAddr = cfg.letterhead?.firmAddr || '';
  const firmMark = (firmName || 'C').trim().slice(0, 1).toUpperCase();
  const signer =
    `${me?.user.firstName ?? ''} ${me?.user.lastName ?? ''}`.trim() ||
    me?.user.email ||
    'Your name';

  const metaParts = [
    draft.client,
    budget.account,
    budget.pe ? `PE ${budget.pe}` : null,
    budget.upl,
  ].filter(Boolean) as string[];
  const metaLine = metaParts.length ? metaParts.join(' · ') : (draft.product ?? '');

  const ax = (t: string | null | undefined) =>
    anonOn ? anonText(t ?? '', true, anonMap) : (t ?? '');

  // ── Checks / gates (warn, never block — Q-PV-2) ─────────────────────────────
  const gates: WsGateResult[] = checks?.gates ?? [];
  const unmetGates = gates.filter((g) => g.status !== 'success');
  const openChecks: WsCheckResult[] = (checks?.checks ?? []).filter((c) => c.status !== 'success');

  const docTitle = draft.docTitle || draft.product || 'Document';

  // ── View tab page counts (D1: paper = 1 page) ───────────────────────────────
  const paperPages = 1;
  const coverPages = 1;
  const viewTabs: Array<[ViewKey, string, string]> = [
    ...(hasCover
      ? ([['cover', 'Cover letter', `${coverPages} p`]] as Array<[ViewKey, string, string]>)
      : []),
    ['paper', 'White paper', `${paperPages} pp`],
    ...(hasCover
      ? ([['packet', 'Full packet', `${coverPages + paperPages} pp`]] as Array<
          [ViewKey, string, string]
        >)
      : []),
  ];

  const stageCaption =
    view === 'cover'
      ? 'Cover letter · 1 page'
      : view === 'paper'
        ? 'White paper · letter'
        : 'Full packet · cover + white paper';

  // ── Export wiring ───────────────────────────────────────────────────────────
  const exportLabel = `Export ${fmt === 'pdf' ? 'PDF' : 'Word'}${
    bulk ? ` · all ${offices.length} offices (.zip)` : ''
  }`;

  const doExportPdf = () => {
    // PDF = print the rendered preview. The @media print CSS emits only the
    // page-sheets. The browser's "Save as PDF" target produces the file; no dep.
    window.print();
  };

  const doExportWord = async () => {
    setExporting(true);
    try {
      if (bulk) {
        // Per-office Word: sequential downloads, one .docx per office. A real
        // single .zip bundle needs a new dependency (jszip) — deferred.
        // TODO(phase): bundle the per-office .docx files as a single .zip.
        for (const o of offices) {
          // eslint-disable-next-line no-await-in-loop
          await exportDocx.mutateAsync(`${docTitle}-${o}`);
        }
        message.success(`Exported ${offices.length} office documents`);
      } else {
        await exportDocx.mutateAsync(docTitle);
        message.success('Word document downloaded');
      }
    } catch {
      message.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const runExport = () => {
    if (fmt === 'pdf') doExportPdf();
    else void doExportWord();
  };

  const onExport = () => {
    // Gates WARN, never block: if any gate is unmet, confirm (listing them) and
    // proceed on OK.
    if (unmetGates.length > 0) {
      modal.confirm({
        title: 'Some sign-off gates are not met',
        content: (
          <div>
            <div style={{ marginBottom: 8 }}>
              You can export anyway, but these gates are still open:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmetGates.map((g) => (
                <li key={g.id} style={{ marginBottom: 2 }}>
                  {g.label}
                </li>
              ))}
            </ul>
          </div>
        ),
        okText: 'Export anyway',
        cancelText: 'Review first',
        // Defer so the confirm modal fully unmounts before runExport →
        // window.print() snapshots the page; otherwise the PDF captures the
        // modal's backdrop instead of the document (the @media print rules also
        // hide modal layers as a guarantee). This is what makes "Export anyway"
        // actually produce the document after acknowledging the warning.
        onOk: () => {
          window.setTimeout(runExport, 150);
        },
      });
      return;
    }
    runExport();
  };

  const onSaveCheckpoint = () => {
    if (!draftId) return;
    createVersion.mutate(
      { label: 'Preview checkpoint' },
      {
        onSuccess: () => message.success('Checkpoint saved to version history'),
        onError: () => message.error('Could not save checkpoint'),
      },
    );
  };

  const savedAt = relativeStamp(draft.updatedAt);

  return (
    <div className="ws-shell">
      <StepsRail active="preview" draftId={draftId} product={draft.product} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Controls bar */}
        <div
          className="ws-preview-controls"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '11px 30px',
            borderBottom: '1px solid var(--border-1)',
            background: 'var(--bg-surface)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14 }}>Preview &amp; Save</div>
          <button className="btn sm" onClick={() => navigate(`/workspace/draft/${draftId}`)}>
            <Icon name="ArrowLeft" size={13} />
            Back to editor
          </button>

          {showOfficeSelector && office && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, position: 'relative' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600 }}>Office</span>
              <button
                className="field"
                onClick={() => setOfficeMenu((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5px 10px',
                  fontSize: 12,
                  width: 'auto',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <Ava x={initialsOf(office)} size={18} />
                <span>{office}</span>
                <Icon name="ChevronDown" size={13} style={{ color: 'var(--ink-3)' }} />
              </button>
              {officeMenu && (
                <div
                  className="card"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 44,
                    width: 240,
                    zIndex: 40,
                    padding: 5,
                    boxShadow: 'var(--shadow-2)',
                  }}
                >
                  {offices.map((o, i) => (
                    <button
                      key={o}
                      onClick={() => {
                        setOfficeIdx(i);
                        setOfficeMenu(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: 'none',
                        background: i === officeIdx ? 'var(--accent-soft)' : 'transparent',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 12.5,
                      }}
                    >
                      <Ava x={initialsOf(o)} size={20} />
                      <span style={{ fontWeight: i === officeIdx ? 600 : 400 }}>{o}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 2,
              background: 'var(--bg-sunken)',
              borderRadius: 8,
              padding: 3,
            }}
          >
            {viewTabs.map(([k, l, pp]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 6,
                  background: view === k ? 'var(--bg-surface)' : 'transparent',
                  color: view === k ? 'var(--ink-1)' : 'var(--ink-3)',
                  boxShadow: view === k ? 'var(--shadow-1)' : 'none',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {l} <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>· {pp}</span>
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }} className="num">
            Autosaved · {savedAt}
          </span>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            display: 'grid',
            gridTemplateColumns: '1fr 300px',
          }}
        >
          {/* Preview stage */}
          <div
            className="ws-print-stage"
            style={{ overflow: 'auto', padding: '26px 20px', background: 'var(--bg-sunken)' }}
          >
            {(view === 'packet' || view === 'cover') && hasCover && (
              <PageSheet
                custom={lhCustom}
                logoDataUrl={firmLogo}
                firmName={firmName}
                firmAddr={firmAddr}
                firmMark={firmMark}
              >
                <CoverLetterContent
                  office={office}
                  client={ax(draft.client)}
                  ask={ax(ask.amount || '—')}
                  delta={ax(ask.delta || '')}
                  account={budget.account ?? ''}
                  signer={signer}
                  firmName={firmName}
                />
              </PageSheet>
            )}
            {/* D1: the white-paper view renders exactly ONE paper page. */}
            {(view === 'packet' || view === 'paper') && (
              <PageSheet
                custom={lhCustom}
                logoDataUrl={firmLogo}
                firmName={firmName}
                firmAddr={firmAddr}
                firmMark={firmMark}
              >
                <WhitePaperContent
                  title={ax(docTitle)}
                  metaLine={ax(metaLine)}
                  sections={views.map((s) => ({
                    name: ax(s.name),
                    html: anonOn ? anonText(s.content, true, anonMap) : s.content,
                  }))}
                />
              </PageSheet>
            )}
            <div
              style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-3)' }}
              className="num"
            >
              {stageCaption}
            </div>
          </div>

          {/* Right: gates + export */}
          <div
            className="ws-preview-aside"
            style={{
              borderLeft: '1px solid var(--border-1)',
              background: 'var(--bg-surface)',
              padding: 16,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {/* Sign-off gates (warn, never block) */}
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  marginBottom: 9,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>Sign-off</span>
                {checks?.score && (
                  <span
                    className="num"
                    style={{
                      color: unmetGates.length ? 'var(--notable)' : 'var(--success)',
                      fontWeight: 600,
                    }}
                  >
                    {checks.score.passed}/{checks.score.total}
                  </span>
                )}
              </div>
              {gates.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>No gates to check.</div>
              )}
              {gates.map((g) => (
                <div
                  key={g.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 0',
                    fontSize: 12.5,
                  }}
                >
                  <span className={`dot ${g.status === 'success' ? 'success' : g.status}`} />
                  <span
                    style={{
                      flex: 1,
                      color: g.status === 'success' ? 'var(--ink-2)' : 'var(--ink-1)',
                      fontWeight: g.status === 'success' ? 400 : 500,
                    }}
                  >
                    {g.label}
                  </span>
                  {g.status === 'success' ? (
                    <Icon name="Check" size={13} style={{ color: 'var(--success)' }} />
                  ) : (
                    <span className={`pill ${g.status}`}>
                      {g.status === 'critical' ? 'Required' : 'Review'}
                    </span>
                  )}
                </div>
              ))}
              {openChecks.length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--border-1)',
                  }}
                >
                  {openChecks.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 0',
                        fontSize: 12,
                      }}
                    >
                      <span className={`dot ${c.status}`} />
                      <span style={{ flex: 1, color: 'var(--ink-2)' }}>{c.label}</span>
                    </div>
                  ))}
                </div>
              )}
              {unmetGates.length > 0 && (
                <div
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    gap: 7,
                    alignItems: 'flex-start',
                    fontSize: 11,
                    color: 'var(--notable)',
                    background: 'var(--notable-soft)',
                    border: '1px solid var(--notable)',
                    borderRadius: 8,
                    padding: '8px 10px',
                  }}
                >
                  <Icon name="TriangleAlert" size={13} style={{ flex: 'none', marginTop: 1 }} />
                  <span>
                    Exporting is allowed, but {unmetGates.length} sign-off gate
                    {unmetGates.length === 1 ? '' : 's'} {unmetGates.length === 1 ? 'is' : 'are'}{' '}
                    still open.
                  </span>
                </div>
              )}
            </div>

            {/* Export */}
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  marginBottom: 9,
                }}
              >
                Export
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 2,
                  background: 'var(--bg-sunken)',
                  borderRadius: 8,
                  padding: 3,
                  marginBottom: 10,
                }}
              >
                {(
                  [
                    ['pdf', 'PDF'],
                    ['word', 'Word'],
                  ] as Array<[Fmt, string]>
                ).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => setFmt(k)}
                    style={{
                      flex: 1,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '6px 0',
                      borderRadius: 6,
                      background: fmt === k ? 'var(--bg-surface)' : 'transparent',
                      color: fmt === k ? 'var(--ink-1)' : 'var(--ink-3)',
                      boxShadow: fmt === k ? 'var(--shadow-1)' : 'none',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {hasCover &&
                (
                  [
                    ['separate', 'Separate files', 'White paper + cover letter as two files'],
                    ['packet', 'Combined packet', 'Cover letter, then white paper, in one file'],
                  ] as Array<[Bundle, string, string]>
                ).map(([k, l, d]) => (
                  <label
                    key={k}
                    style={{
                      display: 'flex',
                      gap: 9,
                      padding: '9px 10px',
                      border: '1px solid ' + (bundle === k ? 'var(--accent)' : 'var(--border-1)'),
                      background: bundle === k ? 'var(--accent-soft)' : 'var(--bg-surface)',
                      borderRadius: 8,
                      marginBottom: 7,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      checked={bundle === k}
                      onChange={() => setBundle(k)}
                      style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{l}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{d}</div>
                    </div>
                  </label>
                ))}
            </div>

            {/* E-22: sticky to the bottom of the scrolling aside so the two
                primary actions stay in view instead of below the fold. */}
            <div
              style={{
                position: 'sticky',
                bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px solid var(--border-1)',
                background: 'var(--bg-surface)',
              }}
            >
              <button className="btn" onClick={onSaveCheckpoint} disabled={createVersion.isPending}>
                <Icon name="Save" size={14} />
                Save checkpoint
              </button>
              <button
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={onExport}
                disabled={exporting}
              >
                <Icon name="Download" size={14} />
                {exporting ? 'Exporting…' : exportLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A print-style letter page sheet. The firm letterhead chrome renders ONLY when
 * the user opted into a custom branded letterhead in Setup (`custom`); it shows
 * the firm's uploaded logo (or initials) + firm name/address — never the client.
 * (Mirrors the editor Letterhead and the server-side DOCX export.)
 */
function PageSheet({
  custom,
  logoDataUrl,
  firmName,
  firmAddr,
  firmMark,
  children,
}: {
  custom: boolean;
  logoDataUrl?: string;
  firmName: string;
  firmAddr: string;
  firmMark: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="ws-print-sheet"
      style={{
        width: 612,
        maxWidth: '100%',
        minHeight: 792,
        background: '#fff',
        boxShadow: 'var(--shadow-2)',
        borderRadius: 2,
        padding: '40px 48px',
        margin: '0 auto 20px',
      }}
    >
      {custom && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            paddingBottom: 11,
            borderBottom: '2px solid var(--ink-1)',
            marginBottom: 18,
          }}
        >
          {logoDataUrl ? (
            <img
              src={logoDataUrl}
              alt={`${firmName} logo`}
              style={{ width: 30, height: 30, borderRadius: 5, objectFit: 'contain', flex: 'none' }}
            />
          ) : (
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 5,
                background: 'var(--ink-1)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontFamily: 'var(--font-serif)',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {firmMark}
            </span>
          )}
          <div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 14, fontWeight: 600 }}>
              {firmName}
            </div>
            {firmAddr && (
              <div style={{ fontSize: 9, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
                {firmAddr}
              </div>
            )}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

/** Cover-letter body rendered from the real draft (client / ask / signer / office). */
function CoverLetterContent({
  office,
  client,
  ask,
  delta,
  account,
  signer,
  firmName,
}: {
  office: string | null;
  client: string;
  ask: string;
  delta: string;
  account: string;
  signer: string;
  firmName: string;
}) {
  const today = new Date().toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--ink-1)' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--ink-3)',
          marginBottom: 14,
        }}
      >
        {today}
        {office ? ` · Attn: ${office}` : ''}
      </div>
      <div style={{ marginBottom: 10 }}>Dear {office || 'Member'},</div>
      <div style={{ marginBottom: 10 }}>
        On behalf of {client || 'our client'}, I write to respectfully request{' '}
        <b className="num">{ask}</b>
        {account ? ` in ${account}` : ''}
        {delta ? `, a ${delta} adjustment above the President's Budget` : ''}. The enclosed white
        paper details the operational need, funding history, and execution plan.
      </div>
      <div style={{ marginBottom: 14 }}>
        Thank you for your consideration. I am glad to provide any further detail your staff may
        need.
      </div>
      <div>Respectfully,</div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>{signer}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{firmName}</div>
    </div>
  );
}

/** White-paper body rendered from the real section view-models (sanitized HTML). */
function WhitePaperContent({
  title,
  metaLine,
  sections,
}: {
  title: string;
  metaLine: string;
  sections: Array<{ name: string; html: string }>;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 18,
          fontWeight: 600,
          lineHeight: 1.15,
          marginBottom: 5,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'var(--ink-3)',
          marginBottom: 18,
        }}
      >
        {metaLine}
      </div>
      {sections.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
          No sections yet — add and draft sections in the editor.
        </div>
      )}
      {sections.map((s, i) => (
        <div key={s.name + i} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{s.name}</div>
          {s.html.trim() ? (
            <div
              style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--ink-2)' }}
              // Section bodies are stored as sanitized HTML; re-sanitize on render.
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(s.html) }}
            />
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--ink-4)', fontStyle: 'italic' }}>
              Not yet drafted.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Compact "saved 2h ago" style relative stamp. */
function relativeStamp(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'just now';
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
