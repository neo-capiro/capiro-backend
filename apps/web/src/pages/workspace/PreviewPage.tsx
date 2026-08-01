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
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { Icon, Ava } from './kit.js';
import { StepsRail } from './StepsRail.js';
import {
  initials as initialsOf,
  useContextUsed,
  useCreateVersion,
  useDraft,
  useDraftChecks,
  useExportDocx,
  useExportPdf,
  usePromoteMemory,
} from './api.js';
import { useMe } from '../../lib/me.js';
import { sectionViews } from './editor/section-model.js';
import { budgetFrom } from './editor/BudgetBlock.js';
import { anonymizeMap, anonText } from './editor/anonymize.js';
import type { StoredRedaction } from './editor/anonymize.js';
import { sanitizeWorkspaceBody as sanitizeHtml } from './editor/workspace-richtext.js';
import { InsertedBlock } from './editor/canvas-blocks.js';
import type { WsAsk, WsBlock, WsCheckResult, WsCheckSeverity } from './types.js';
import { deriveVerificationDisplay, VerificationStatus } from '../../components/trust/VerificationStatus.js';

type ViewKey = 'cover' | 'paper' | 'packet';
type Fmt = 'pdf' | 'word';
type Bundle = 'separate' | 'packet';

export function PreviewPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const { data: draft, isLoading } = useDraft(draftId ?? null);
  const { data: me } = useMe();
  const { data: checks } = useDraftChecks(draftId ?? null);
  const { data: contextUsed } = useContextUsed(draftId ?? null);
  const exportDocx = useExportDocx(draftId ?? '');
  const exportPdf = useExportPdf(draftId ?? '');
  const createVersion = useCreateVersion(draftId ?? '');
  const promoteMemory = usePromoteMemory(draftId ?? null);

  const [view, setView] = useState<ViewKey>('packet');
  const [fmt, setFmt] = useState<Fmt>('pdf');
  const [bundle, setBundle] = useState<Bundle>('separate');
  const [officeIdx, setOfficeIdx] = useState(0);
  const [officeMenu, setOfficeMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Two SEPARATE acknowledgements. Confirming that you have read the critical
  // findings is not the same as accepting that verification is out of date, so one
  // checkbox must not silently satisfy the other.
  const [ackCritical, setAckCritical] = useState(false);
  const [ackStale, setAckStale] = useState(false);
  // Phase 3.4 memory write-back: the optional key-fact note + proposed state.
  const [promoteNote, setPromoteNote] = useState('');
  const [promoted, setPromoted] = useState(false);
  // Measured number of letter-size pages the white paper paginates into.
  const [paperPageCount, setPaperPageCount] = useState(1);

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
  // Inserted media (photo/table/logo) live in cfg.mainBlocks — render them in the
  // preview/export sheet too, not just the editor (they were silently dropped).
  const mainBlocks = (cfg.mainBlocks as WsBlock[] | undefined) ?? [];
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

  // ── Rule-based checks (live; advisory only — human sign-off gates removed) ────
  const openChecks: WsCheckResult[] = (checks?.checks ?? []).filter((c) => c.status !== 'success');

  // Group by severity so a funding-direction error does not sit in the same
  // undifferentiated list as an unexpanded acronym.
  const SEVERITY_ORDER: WsCheckSeverity[] = ['critical', 'high', 'medium', 'low'];
  const severityOf = (check: WsCheckResult): WsCheckSeverity =>
    check.severity ?? (check.status === 'critical' ? 'critical' : 'medium');
  const groupedChecks = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: openChecks.filter((check) => severityOf(check) === severity),
  })).filter((group) => group.items.length > 0);
  const criticalChecks = openChecks.filter((check) => {
    const severity = severityOf(check);
    return severity === 'critical' || severity === 'high';
  });

  // Server-owned verification verdict. An older server that omits the field is
  // treated as never-verified rather than assumed clean.
  const verification = checks?.verification ?? null;
  const verificationDisplay = deriveVerificationDisplay({
    verification: verification
      ? {
          totalCount: verification.supportedCount + verification.unsupportedCount,
          unsupportedCount: verification.unsupportedCount,
        }
      : null,
    findings: criticalChecks.map((check) => ({
      check: check.id,
      severity: severityOf(check),
      detail: check.detail || check.label,
      section: check.section ?? undefined,
    })),
    ran: verification?.ran ?? false,
  });
  const checksContext = checks?.context ?? null;
  const staleness = checks?.staleness ?? null;
  const staleVerification = Boolean(staleness?.changedAfterVerification && verification?.ran);

  // Export gates. Advisory checks NEVER block on their own — only an
  // un-acknowledged critical finding or un-acknowledged stale verification does,
  // and both are satisfied by an explicit checkbox rather than a hard stop.
  const needsCriticalAck = criticalChecks.length > 0 && !ackCritical;
  const needsStaleAck = staleVerification && !ackStale;
  const exportBlockedReason = needsCriticalAck
    ? `Acknowledge ${criticalChecks.length} critical finding${criticalChecks.length === 1 ? '' : 's'} before exporting.`
    : needsStaleAck
      ? 'This document changed after it was last verified. Re-run verification or acknowledge the risk.'
      : null;

  const fixWithMeri = (check: WsCheckResult) => {
    // A BOUNDED prompt: it names the finding and the section and asks for proposed
    // edits only. The editor consumes it once and Meri still proposes rather than
    // applying, so this never becomes a way to mutate the document from Preview.
    const where = check.section ? ` in the section "${check.section}"` : '';
    const prompt =
      `A pre-export check flagged this document${where}: "${check.label}"` +
      (check.detail ? ` — ${check.detail}.` : '.') +
      ' Review that specific issue against retrieved sources and propose section edits to resolve it.' +
      ' Do not change the document until I approve the edits.';
    navigate(`/workspace/draft/${draftId}`, {
      state: { fixWithMeri: { prompt, section: check.section ?? undefined } },
    });
  };

  const docTitle = draft.docTitle || draft.product || 'Document';

  // ── View tab page counts ────────────────────────────────────────────────────
  // The white paper paginates; its count is measured by PaginatedPaper below.
  const paperPages = paperPageCount;
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
        ? `White paper · ${paperPages} page${paperPages === 1 ? '' : 's'}`
        : `Full packet · ${coverPages + paperPages} pages`;

  // ── Export wiring ───────────────────────────────────────────────────────────
  const exportLabel = `Export ${fmt === 'pdf' ? 'PDF' : 'Word'}${
    bulk ? ` · all ${offices.length} offices (.zip)` : ''
  }`;

  // The draft's genuine packet add-on documents (cover letter, appendix, …) —
  // EXCLUDES the vestigial primary WsDocument (lowest ordinal) that every
  // draft has but the editor never surfaces as its own tab; main content
  // lives in cfg.sections/sectionContent instead. Mirrors the server's own
  // ExportService.packetDocs() and EditorPage's sortedDocs filter.
  const packetDocs = useMemo(() => (draft?.documents ?? []).slice(1), [draft]);

  // What "Separate files" vs "Combined packet" actually produces: previously
  // this toggle had no effect at all (every export silently combined
  // everything, and packet documents like a cover letter were dropped
  // entirely). Combined = one file with every packet doc then the main
  // content (server default, part omitted). Separate = one file per packet
  // document plus one for the main content alone.
  const exportParts = (): Array<{ part?: string; suffix: string }> => {
    if (!hasCover || bundle === 'packet' || packetDocs.length === 0) {
      return [{ suffix: '' }];
    }
    return [
      ...packetDocs.map((d) => ({ part: d.id, suffix: `-${d.name}` })),
      { part: 'main', suffix: '-white-paper' },
    ];
  };

  const doExportPdf = async () => {
    // PDF = a SERVER-RENDERED .pdf (deterministic; no browser print pipeline).
    setExporting(true);
    try {
      const parts = exportParts();
      const targets = bulk ? offices : [null];
      for (const o of targets) {
        for (const p of parts) {
          const hint = `${docTitle}${o ? `-${o}` : ''}${p.suffix}`;
          // eslint-disable-next-line no-await-in-loop
          await exportPdf.mutateAsync({ filenameHint: hint, part: p.part });
        }
      }
      const total = targets.length * parts.length;
      message.success(total > 1 ? `Exported ${total} PDF files` : 'PDF downloaded');
    } catch {
      message.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const doExportWord = async () => {
    setExporting(true);
    try {
      const parts = exportParts();
      // Per-office/per-part Word: sequential downloads. A real single .zip
      // bundle needs a new dependency (jszip) — deferred.
      // TODO(phase): bundle multi-file exports as a single .zip.
      const targets = bulk ? offices : [null];
      for (const o of targets) {
        for (const p of parts) {
          const hint = `${docTitle}${o ? `-${o}` : ''}${p.suffix}`;
          // eslint-disable-next-line no-await-in-loop
          await exportDocx.mutateAsync({ filenameHint: hint, part: p.part });
        }
      }
      const total = targets.length * parts.length;
      message.success(total > 1 ? `Exported ${total} Word documents` : 'Word document downloaded');
    } catch {
      message.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const runExport = () => {
    if (fmt === 'pdf') void doExportPdf();
    else void doExportWord();
  };

  /**
   * Export remains advisory for ordinary style checks (Ninja D1: Workspace is
   * gate-less). What it will NOT do is let a critical finding or a stale
   * verification leave the building unnoticed: those require an explicit
   * acknowledgement first, which is a different thing from blocking.
   *
   * This gate covers EXPORT only. External send is a different risk class and is
   * gated server-side; nothing here weakens or substitutes for that.
   */
  const onExport = () => {
    if (exportBlockedReason) {
      message.warning(exportBlockedReason);
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
            {/* The white paper paginates into real letter-size pages (print
                preview): content is measured and split across page sheets. */}
            {(view === 'packet' || view === 'paper') && (
              <PaginatedPaper
                custom={lhCustom}
                logoDataUrl={firmLogo}
                firmName={firmName}
                firmAddr={firmAddr}
                firmMark={firmMark}
                title={ax(docTitle)}
                metaLine={ax(metaLine)}
                sections={views.map((s) => ({
                  name: ax(s.name),
                  html: anonOn ? anonText(s.content, true, anonMap) : s.content,
                }))}
                blocks={mainBlocks}
                onPageCount={setPaperPageCount}
              />
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
            {/* Rule-based checks (live, advisory — never block export). */}
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
                <span>Checks</span>
                {checks?.score && (
                  <span
                    className="num"
                    style={{
                      color: openChecks.length ? 'var(--notable)' : 'var(--success)',
                      fontWeight: 600,
                    }}
                  >
                    {checks.score.passed}/{checks.score.total}
                  </span>
                )}
              </div>

              {/* Verification verdict FIRST. "All checks pass" says nothing about
                  whether any claim was ever verified, and reading the two as one
                  statement is the misreading Step 6 exists to prevent. */}
              <div style={{ marginBottom: 9 }}>
                <VerificationStatus display={verificationDisplay} compact />
                {verification?.capturedAt && (
                  <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 4 }}>
                    Verified as of {new Date(verification.capturedAt).toLocaleString()}
                  </div>
                )}
              </div>

              {/* The document moved on after verification. Shown whether or not
                  any check is currently failing. */}
              {staleVerification && (
                <div
                  role="alert"
                  style={{
                    border: '1px solid var(--notable)',
                    background: 'var(--notable-soft)',
                    color: 'var(--notable)',
                    borderRadius: 6,
                    padding: '7px 9px',
                    fontSize: 11.5,
                    marginBottom: 9,
                  }}
                >
                  <strong>Verification is out of date.</strong> This document was edited after it
                  was last verified
                  {staleness?.verifiedAt
                    ? ` (${new Date(staleness.verifiedAt).toLocaleDateString()})`
                    : ''}
                  . Re-run generation to re-verify, or acknowledge the risk below.
                </div>
              )}

              {openChecks.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                  No advisory check is currently failing.
                </div>
              ) : (
                groupedChecks.map((group) => (
                  <div key={group.severity} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 700,
                        color:
                          group.severity === 'critical' || group.severity === 'high'
                            ? 'var(--critical)'
                            : 'var(--ink-3)',
                        marginBottom: 3,
                      }}
                    >
                      {group.severity} · {group.items.length}
                    </div>
                    {group.items.map((c) => (
                      <div
                        key={c.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '4px 0',
                          fontSize: 12,
                        }}
                      >
                        <span className={`dot ${c.status}`} style={{ marginTop: 5 }} />
                        <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-2)' }}>
                          <span>{c.label}</span>
                          {c.detail && (
                            <span style={{ color: 'var(--ink-3)' }}> — {c.detail}</span>
                          )}
                          {c.section && (
                            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--ink-3)' }}>
                              Section: {c.section}
                            </span>
                          )}
                        </span>
                        {c.fixable && (
                          <button
                            className="btn sm btn-ghost"
                            style={{ flex: 'none', fontSize: 10.5, padding: '2px 7px' }}
                            onClick={() => fixWithMeri(c)}
                            title="Open the editor with a bounded prompt for this finding"
                          >
                            Fix with Meri
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}

              {/* The two acknowledgements. Rendered next to the findings they refer
                  to, and each gates export independently. */}
              {criticalChecks.length > 0 && (
                <label
                  style={{
                    display: 'flex',
                    gap: 7,
                    alignItems: 'flex-start',
                    fontSize: 11.5,
                    marginTop: 7,
                    color: 'var(--ink-2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ackCritical}
                    onChange={(e) => setAckCritical(e.currentTarget.checked)}
                  />
                  <span>
                    I reviewed the {criticalChecks.length} critical finding
                    {criticalChecks.length === 1 ? '' : 's'} above and accept exporting anyway.
                  </span>
                </label>
              )}
              {staleVerification && (
                <label
                  style={{
                    display: 'flex',
                    gap: 7,
                    alignItems: 'flex-start',
                    fontSize: 11.5,
                    marginTop: 5,
                    color: 'var(--ink-2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ackStale}
                    onChange={(e) => setAckStale(e.currentTarget.checked)}
                  />
                  <span>I accept exporting content whose verification is out of date.</span>
                </label>
              )}

              {/* Context that grounded the text, plus what was left out. */}
              {checksContext && (
                <div style={{ marginTop: 9, fontSize: 11 }}>
                  {checksContext.degraded && (
                    <div role="alert" style={{ color: 'var(--critical)', marginBottom: 3 }}>
                      Context was degraded during the last generation.
                    </div>
                  )}
                  <div style={{ color: 'var(--ink-3)' }}>
                    Grounded on {checksContext.itemCount} context item
                    {checksContext.itemCount === 1 ? '' : 's'}
                    {checksContext.memoryFileCount
                      ? `, ${checksContext.memoryFileCount} memory file${checksContext.memoryFileCount === 1 ? '' : 's'}`
                      : ''}
                    {checksContext.linkedPeCount
                      ? `, ${checksContext.linkedPeCount} program element${checksContext.linkedPeCount === 1 ? '' : 's'}`
                      : ''}
                    {checksContext.capturedAt
                      ? ` · as of ${new Date(checksContext.capturedAt).toLocaleDateString()}`
                      : ''}
                  </div>
                  {checksContext.exclusions.map((exclusion, index) => (
                    <div key={index} style={{ color: 'var(--ink-3)' }}>
                      Excluded: {exclusion.label} — {exclusion.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Context used in this draft (Phase 3.3): the provenance snapshot
                from the last generation — what actually grounded the text. Only
                shown once a draft has been generated (contextUsed != null). */}
            {contextUsed && (
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
                  Context used
                </div>
                {contextUsed.memoryFiles.length === 0 &&
                contextUsed.contextItems.length === 0 &&
                contextUsed.linkedPeCodes.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                    No firm/client context grounded this draft.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {contextUsed.memoryFiles.map((m) => (
                      <div key={`mem-${m.id}`} style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                        <span style={{ color: 'var(--ink-3)' }}>Memory · </span>
                        {m.label}
                      </div>
                    ))}
                    {contextUsed.contextItems.map((c) => (
                      <div key={`ctx-${c.id}`} style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                        <span style={{ color: 'var(--ink-3)' }}>{c.kind} · </span>
                        {c.label}
                      </div>
                    ))}
                    {contextUsed.linkedPeCodes.map((pe) => (
                      <div key={`pe-${pe}`} style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                        <span style={{ color: 'var(--ink-3)' }}>Program element · </span>
                        {pe}
                      </div>
                    ))}
                  </div>
                )}
                {contextUsed.generatedAt && (
                  <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 7 }}>
                    as of last generation ({contextUsed.generatedAt.slice(0, 10)})
                  </div>
                )}
              </div>
            )}

            {/* Phase 3.4 memory write-back (blueprint §6.4): promote this
                artifact's key fact into FIRM institutional memory — a decision
                deliberately separate from export/approve. Lands as a PENDING
                memory_candidate in the admin review queue, never auto-committed. */}
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
                Firm memory
              </div>
              {promoted ? (
                <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                  Proposed — pending review in the firm-memory candidate queue.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <textarea
                    value={promoteNote}
                    onChange={(e) => setPromoteNote(e.target.value)}
                    maxLength={4000}
                    rows={2}
                    placeholder="Key fact or position to remember (optional — defaults to a summary of this draft)"
                    style={{
                      resize: 'vertical',
                      fontSize: 12,
                      fontFamily: 'var(--font-sans)',
                      color: 'var(--ink-1)',
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-1)',
                      borderRadius: 8,
                      padding: '7px 9px',
                    }}
                  />
                  <button
                    className="btn"
                    style={{ justifyContent: 'center' }}
                    disabled={promoteMemory.isPending}
                    onClick={async () => {
                      try {
                        await promoteMemory.mutateAsync(
                          promoteNote.trim() ? { note: promoteNote.trim() } : {},
                        );
                        setPromoted(true);
                        message.success('Proposed for firm memory — pending review.');
                      } catch {
                        message.error('Could not propose this for firm memory. Try again.');
                      }
                    }}
                  >
                    {promoteMemory.isPending ? 'Proposing…' : 'Propose for firm memory'}
                  </button>
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
              {/* Why export is held, stated where the user is about to click. The
                  button stays enabled so the reason is discoverable by keyboard —
                  a disabled control is not focusable and would announce nothing. */}
              {exportBlockedReason && (
                <div
                  id="ws-export-gate"
                  role="status"
                  style={{ fontSize: 11, color: 'var(--notable)', lineHeight: 1.4 }}
                >
                  {exportBlockedReason}
                </div>
              )}
              <button
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={onExport}
                disabled={exporting}
                aria-describedby={exportBlockedReason ? 'ws-export-gate' : undefined}
                title={exportBlockedReason ?? undefined}
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
        <FirmLetterhead
          logoDataUrl={logoDataUrl}
          firmName={firmName}
          firmAddr={firmAddr}
          firmMark={firmMark}
        />
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

/** Firm letterhead chrome (shared by the cover PageSheet and the paginated paper
 *  so both render an identical header). Renders only when a custom letterhead was
 *  opted into; shows the firm's logo (or initials) + name/address — never the client. */
function FirmLetterhead({
  logoDataUrl,
  firmName,
  firmAddr,
  firmMark,
}: {
  logoDataUrl?: string;
  firmName: string;
  firmAddr: string;
  firmMark: string;
}) {
  return (
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
  );
}

/** White-paper title + budget-identifier meta line (one flow block). */
function PaperTitle({ title, metaLine }: { title: string; metaLine: string }) {
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
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--ink-3)' }}>
        {metaLine}
      </div>
    </div>
  );
}

/** One white-paper section (heading + sanitized body) — one flow block. */
function PaperSection({ name, html }: { name: string; html: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{name}</div>
      {html.trim() ? (
        <div
          style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--ink-2)' }}
          // Section bodies are stored as sanitized HTML; re-sanitize on render.
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
        />
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--ink-4)', fontStyle: 'italic' }}>
          Not yet drafted.
        </div>
      )}
    </div>
  );
}

/** Shallow equality for the page→item-index assignment (avoids setState loops). */
function sameLayout(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

/**
 * White paper paginated into real letter-size page sheets (a print preview). The
 * content (letterhead → title → each section → each inserted media block) is
 * rendered once in a hidden measuring layer at the exact content width; each
 * block's height is measured and blocks are greedily packed into pages of the
 * printable height (letter minus 1in-ish margins). Blocks are atomic in v1 (a
 * single over-tall block simply gets its own, taller page). The measured page
 * count is reported up via onPageCount to drive the view-tab badges.
 */
function PaginatedPaper({
  custom,
  logoDataUrl,
  firmName,
  firmAddr,
  firmMark,
  title,
  metaLine,
  sections,
  blocks = [],
  onPageCount,
}: {
  custom: boolean;
  logoDataUrl?: string;
  firmName: string;
  firmAddr: string;
  firmMark: string;
  title: string;
  metaLine: string;
  sections: Array<{ name: string; html: string }>;
  blocks?: WsBlock[];
  onPageCount?: (n: number) => void;
}) {
  // Flow items in document order. Letterhead appears once (page 1 only) because
  // it is a flow block, not per-sheet chrome.
  const items: Array<{ key: string; node: ReactNode }> = [];
  if (custom) {
    items.push({
      key: '__lh',
      node: (
        <FirmLetterhead
          logoDataUrl={logoDataUrl}
          firmName={firmName}
          firmAddr={firmAddr}
          firmMark={firmMark}
        />
      ),
    });
  }
  items.push({ key: '__title', node: <PaperTitle title={title} metaLine={metaLine} /> });
  if (sections.length === 0) {
    items.push({
      key: '__empty',
      node: (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
          No sections yet — add and draft sections in the editor.
        </div>
      ),
    });
  }
  sections.forEach((s, i) =>
    items.push({ key: `sec-${i}-${s.name}`, node: <PaperSection name={s.name} html={s.html} /> }),
  );
  blocks
    .filter((b) => b.type !== 'section')
    .forEach((b) =>
      items.push({
        key: `blk-${b.id}`,
        node: <InsertedBlock block={b} onRemove={() => {}} readOnly />,
      }),
    );

  const measureRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pages, setPages] = useState<number[][]>([items.map((_, i) => i)]);
  const lastCount = useRef(1);

  // A content signature so the (re)measure only runs when the rendered content
  // actually changes — not on every parent re-render (which would loop).
  const sig =
    `${custom}|${title}|${metaLine}|` +
    sections.map((s) => `${s.name}:${s.html.length}`).join('|') +
    '#' +
    blocks
      .map((b) => `${b.id}:${b.type}:${b.src ? 1 : 0}:${b.cells ? b.cells.length : 0}`)
      .join('|');

  useLayoutEffect(() => {
    const USABLE = 792 - 80; // letter height (792pt) minus 40px top + 40px bottom padding
    const GAP = 14; // matches the per-block marginBottom
    const heights = items.map((_, i) => measureRefs.current[i]?.offsetHeight ?? 0);
    const result: number[][] = [];
    let cur: number[] = [];
    let used = 0;
    items.forEach((_, i) => {
      const h = heights[i] ?? 0;
      const add = h + (cur.length ? GAP : 0);
      if (cur.length && used + add > USABLE) {
        result.push(cur);
        cur = [i];
        used = h;
      } else {
        cur.push(i);
        used += add;
      }
    });
    if (cur.length) result.push(cur);
    const next = result.length ? result : [items.map((_, i) => i)];
    setPages((prev) => (sameLayout(prev, next) ? prev : next));
    if (next.length !== lastCount.current) {
      lastCount.current = next.length;
      onPageCount?.(next.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return (
    <>
      {/* Hidden measuring layer at the exact page content width (612 − 2×48). */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 516,
          height: 0,
          overflow: 'hidden',
          visibility: 'hidden',
          pointerEvents: 'none',
          zIndex: -1,
        }}
      >
        {items.map((it, i) => (
          <div
            key={it.key}
            ref={(el) => {
              measureRefs.current[i] = el;
            }}
            style={{ marginBottom: 14 }}
          >
            {it.node}
          </div>
        ))}
      </div>
      {pages.map((idxs, p) => (
        <div
          key={p}
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
          {idxs.map((i) =>
            items[i] ? (
              <div key={items[i]!.key} style={{ marginBottom: 14 }}>
                {items[i]!.node}
              </div>
            ) : null,
          )}
        </div>
      ))}
    </>
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
