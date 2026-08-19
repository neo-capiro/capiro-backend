/**
 * Remaining profile panels — native vNext ports of the canonical panel modules
 * (re-skin: identical props, copy, ordering, honesty rules):
 *   DescriptionPanel, WhatChangedPanel, ProcurementActivityPanel,
 *   ProjectsPanel, PdocDetailPanel, ProgramsPanel, RelatedPesPanel,
 *   ClientRelevancePanel (+ RelevanceEvidence), ProofPackPanel.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DescriptionSource } from '../../../../pages/program-element/DescriptionPanel.js';
import type { PdocDetail } from '../../../../pages/program-element/PdocDetailPanel.js';
import type {
  OpportunityItem,
  ProgramElementDelta,
  ProgramElementProject,
  ProgramElementRelatedResponse,
  ProgramElementSourceItem,
} from '../../../../pages/program-element/types.js';
import type {
  PeProgramMatchRow,
  ProgramConfidenceBand,
  ProgramEvidenceItem,
  ProgramsForPeResponse,
} from '../../../../pages/program-element/programs-api.js';
import {
  RELEVANCE_PATH_COLOR,
  RELEVANCE_PATH_LABEL,
  formatScorePct,
  scoreBandColor,
  type PathResult,
  type RelevantClientRow,
} from '../../../../pages/clients/relevance-api.js';
import {
  formatPdocSourceLine,
  proofFingerprintLabel,
} from '../../../../pages/program-element/trust-model.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../../components/tables/index.js';
import {
  PeFbEmpty,
  PeFbExpandableText,
  PeFbNotice,
  PeFbPanel,
  PeFbSecondaryFailed,
  PeFbSkeleton,
  PeFbTag,
} from './pe-fallback-ui.js';

/* ── "What this program does" narrative (Overview) ─────────────────────────── */

export function PeDescriptionPanelVNext({
  description,
  source,
}: {
  description: string | null | undefined;
  source?: DescriptionSource;
}) {
  const text = (description ?? '').trim();
  if (!text) return null;

  const op5 = source?.op5Detail;
  const citation = op5?.book
    ? `Source: FY2027 ${op5.book.replace(/_/g, ' ')} OP-5 exhibit${op5.sag ? `, SAG ${op5.sag}` : ''}${
        op5.pageStart ? `, p.${op5.pageStart}${op5.pageEnd && op5.pageEnd !== op5.pageStart ? `-${op5.pageEnd}` : ''}` : ''
      }`
    : source?.pDocSourceBookOnly
      ? `Source: FY2027 ${source.pDocSourceBookOnly.replace(/_/g, ' ')} P-40 exhibit`
      : null;

  return (
    <div className="pe-fb-desc-panel">
      <div className="pe-fb-panel-head">
        <h3>What this program does</h3>
      </div>
      <div style={{ padding: '0 18px 16px' }}>
        <PeFbExpandableText text={text} rows={4} symbol="Read more" className="pe-fb-desc-text" />
        {citation ? <div className="pe-fb-desc-citation">{citation}</div> : null}
      </div>
    </div>
  );
}

/* ── "What changed" deltas (Step 1.4) ──────────────────────────────────────── */

export interface WhatChangedPanelVNextProps {
  deltas: ProgramElementDelta[] | null | undefined;
  loading?: boolean;
  max?: number;
  errored?: boolean;
  onRetry?: () => void;
}

const DELTA_TYPE_LABEL: Record<string, string> = {
  pb_vs_prior_pb: 'PB vs prior PB',
  mark_vs_request: 'Mark vs request',
  mark_vs_mark: 'Mark divergence',
  conference_vs_marks: 'Conference',
  enacted_vs_request: 'Enacted vs request',
  new_start: 'New start',
  termination: 'Termination',
  zeroed: 'Zeroed',
  transfer_candidate: 'Transfer (candidate)',
  quantity_change: 'Quantity',
  unit_cost_change: 'Unit cost',
  outyear_shift: 'Outyear shift',
  project_level_change: 'Project change',
};

function num(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function m(v: string | number | null): string {
  const n = num(v);
  return n === null ? '—' : `$${n.toFixed(0)}M`;
}
/** Materiality band → tag color (≥0.7 critical, ≥0.4 notable). */
export function materialityColor(score: number): string {
  if (score >= 0.7) return 'red';
  if (score >= 0.4) return 'orange';
  return 'default';
}

export function PeWhatChangedPanelVNext({
  deltas,
  loading = false,
  max = 5,
  errored = false,
  onRetry,
}: WhatChangedPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="What changed">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="what changed deltas" testId="pe-secondary-failed-deltas" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(deltas) ? deltas.slice(0, max) : [];
  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-whatchanged-card" title="What changed">
        <PeFbEmpty description="No scored budget changes for this PE yet — populated once the delta engine runs." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-whatchanged-card" title="What changed">
      <div className="pe-fb-row-list">
        {rows.map((d) => {
          const pct = d.deltaPct !== null ? ` (${d.deltaPct >= 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)` : '';
          return (
            <div key={d.id} className="pe-fb-row-item">
              <div className="pe-fb-tag-row">
                <PeFbTag color="blue">{DELTA_TYPE_LABEL[d.deltaType] ?? d.deltaType}</PeFbTag>
                <PeFbTag>FY{d.assertedFy}</PeFbTag>
                <span>
                  {m(d.amountFrom)} → <b>{m(d.amountTo)}</b>
                  {pct}
                </span>
                <PeFbTag color={materialityColor(d.materialityScore)} title={`Materiality ${d.materialityScore.toFixed(2)}`}>
                  {(d.materialityScore * 100).toFixed(0)}
                </PeFbTag>
              </div>
            </div>
          );
        })}
      </div>
    </PeFbPanel>
  );
}

/* ── Procurement activity (Step 3.1) ───────────────────────────────────────── */

export interface ProcurementActivityPanelVNextProps {
  opportunities: OpportunityItem[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

/** Tag color for a SAM.gov notice type (best-effort). */
const NOTICE_TYPE_COLOR: Record<string, string> = {
  solicitation: 'blue',
  'combined synopsis/solicitation': 'blue',
  presolicitation: 'geekblue',
  'sources sought': 'purple',
  'award notice': 'green',
  'special notice': 'gold',
};

export function noticeTypeColor(noticeType: string): string {
  return NOTICE_TYPE_COLOR[noticeType.trim().toLowerCase()] ?? 'default';
}

/**
 * Human deadline countdown from an ISO responseDeadline, relative to `now`.
 * `now` is injectable so the deterministic test does not depend on the wall clock.
 */
export function deadlineCountdown(
  responseDeadline: string | null,
  now: Date = new Date(),
): { label: string; tone: string } {
  if (!responseDeadline) return { label: 'No deadline', tone: 'default' };
  const deadline = new Date(responseDeadline);
  if (Number.isNaN(deadline.getTime())) return { label: 'No deadline', tone: 'default' };

  const ms = deadline.getTime() - now.getTime();
  if (ms < 0) return { label: 'closed', tone: 'default' };

  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return { label: 'closes today', tone: 'red' };
  const label = `closes in ${days}d`;
  if (days <= 3) return { label, tone: 'red' };
  if (days <= 7) return { label, tone: 'orange' };
  return { label, tone: 'green' };
}

/** Display date (YYYY-MM-DD) from an ISO string, or null. */
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function PeProcurementActivityPanelVNext({
  opportunities,
  loading = false,
  errored = false,
  onRetry,
}: ProcurementActivityPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Procurement activity">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="procurement opportunities" testId="pe-secondary-failed-opportunities" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(opportunities) ? opportunities : [];

  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-opportunities-card" title="Procurement activity">
        <PeFbEmpty description="No active procurement notices linked to this PE yet — populated as SAM.gov solicitations are matched." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-opportunities-card" title={`Procurement activity · ${rows.length}`}>
      <p className="pe-fb-muted" style={{ marginBottom: 8, fontSize: 12 }}>
        Active SAM.gov procurement notices that touch this Program Element — the contracting
        opportunity, the issuing office, and how long until it closes. Candidate rows are
        machine-matched and await review.
      </p>

      <div className="pe-fb-row-list">
        {rows.map((o) => {
          const countdown = deadlineCountdown(o.responseDeadline);
          const posted = shortDate(o.postedDate);
          const due = shortDate(o.responseDeadline);
          const orgLine = [o.agency, o.office].filter(Boolean).join(' · ');
          const hasPoc = Boolean(o.pocName || o.pocEmail);
          return (
            <div key={o.id} className="pe-fb-row-item">
              <div className="pe-fb-tag-row" style={{ marginBottom: 4 }}>
                <PeFbTag color={noticeTypeColor(o.noticeType)}>{o.noticeType}</PeFbTag>
                <PeFbTag color={countdown.tone}>{countdown.label}</PeFbTag>
                {o.pscCode ? <PeFbTag>PSC {o.pscCode}</PeFbTag> : null}
                {o.naicsCode ? <PeFbTag>NAICS {o.naicsCode}</PeFbTag> : null}
                {o.reviewStatus === 'candidate' ? <PeFbTag color="gold">Candidate — review</PeFbTag> : null}
              </div>

              <div>
                {o.sourceUrl ? (
                  <a href={o.sourceUrl} target="_blank" rel="noreferrer">
                    <strong>{o.title}</strong>
                  </a>
                ) : (
                  <strong>{o.title}</strong>
                )}
              </div>

              {orgLine ? (
                <div>
                  <span className="pe-fb-muted" style={{ fontSize: 13 }}>
                    {orgLine}
                  </span>
                </div>
              ) : null}

              <div className="pe-fb-muted" style={{ fontSize: 12, marginTop: 2 }}>
                {posted ? `Posted ${posted}` : null}
                {posted && due ? ' · ' : null}
                {due ? `Response due ${due}` : null}
              </div>

              {hasPoc ? (
                <div style={{ marginTop: 6 }}>
                  <div className="pe-fb-tag-row" style={{ marginBottom: 2 }}>
                    <PeFbTag title="Procurement contact — not a lobbying target">
                      Official procurement POC
                    </PeFbTag>
                    {o.pocName ? <span style={{ fontSize: 13 }}>{o.pocName}</span> : null}
                    {o.pocEmail ? (
                      <span className="pe-fb-muted" style={{ fontSize: 13 }}>
                        {o.pocEmail}
                      </span>
                    ) : null}
                  </div>
                  <PeFbNotice
                    tone="info"
                    message="This is the official procurement contact — not a lobbying target."
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </PeFbPanel>
  );
}

/* ── Projects (R-2A, Step 1.2) ─────────────────────────────────────────────── */

export interface ProjectsPanelVNextProps {
  projects: ProgramElementProject[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

/** Open-at-page deep link for a project's R-2A citation. */
export function projectSourceHref(p: Pick<ProgramElementProject, 'sourceUrl' | 'pageNumber'>): string | null {
  if (!p.sourceUrl) return null;
  return p.pageNumber ? `${p.sourceUrl}#page=${p.pageNumber}` : p.sourceUrl;
}

export function PeProjectsPanelVNext({ projects, loading = false, errored = false, onRetry }: ProjectsPanelVNextProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (loading) {
    return (
      <PeFbPanel title="Projects (R-2A)">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="R-2A projects" testId="pe-secondary-failed-projects" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(projects) ? projects : [];
  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-projects-card" title="Projects (R-2A)">
        <PeFbEmpty description="No R-2A projects extracted for this PE — it may be procurement-only or pre-FY27." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-projects-card" title={`Projects (R-2A) · ${rows.length}`}>
      <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Sub-elements from the Service&apos;s R-2A justification exhibit. Expand a row for its mission
        narrative; the source chip opens the exact exhibit page.
      </span>
      <CapiroTableWrap>
        <CapiroTable>
          <CapiroTableHead>
            <tr>
              <CapiroTableHeaderCell style={{ width: 40 }} />
              <CapiroTableHeaderCell>Project</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Title</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>FY</CapiroTableHeaderCell>
              <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Source</CapiroTableHeaderCell>
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {rows.map((p) => {
              const href = projectSourceHref(p);
              const label = `R-2A${p.pageNumber ? ` p.${p.pageNumber}` : ''}`;
              const isOpen = Boolean(expanded[p.id]);
              return (
                <>
                  <tr key={p.id}>
                    <CapiroTableCell>
                      {p.mission ? (
                        <button
                          type="button"
                          className="pe-fb-expand-toggle"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.projectCode}`}
                          onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))}
                        >
                          {isOpen ? '−' : '+'}
                        </button>
                      ) : null}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <code className="pe-fb-code">{p.projectCode}</code>
                    </CapiroTableCell>
                    <CapiroTableCell>{p.title}</CapiroTableCell>
                    <CapiroTableCell>{p.fy ? <PeFbTag>FY{p.fy}</PeFbTag> : '—'}</CapiroTableCell>
                    <CapiroTableCell style={{ textAlign: 'right' }}>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          <PeFbTag color="green">{label}</PeFbTag>
                        </a>
                      ) : (
                        <PeFbTag>{label}</PeFbTag>
                      )}
                    </CapiroTableCell>
                  </tr>
                  {isOpen ? (
                    <tr key={`${p.id}-mission`} className="pe-fb-expanded-row">
                      <CapiroTableCell colSpan={5}>
                        {p.mission ? (
                          <p style={{ margin: 0 }}>{p.mission}</p>
                        ) : (
                          <span className="pe-fb-muted">No mission narrative extracted.</span>
                        )}
                      </CapiroTableCell>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
    </PeFbPanel>
  );
}

/* ── P-40 exhibit detail (F1 enrichment block) ─────────────────────────────── */

function last<T>(xs: T[] | null | undefined): T | undefined {
  return xs && xs.length > 0 ? xs[xs.length - 1] : undefined;
}

export function PePdocDetailPanelVNext({
  detail,
  onOpenPe,
}: {
  detail: PdocDetail | null | undefined;
  onOpenPe?: (peCode: string) => void;
}) {
  if (!detail) return null;
  const relateds = (detail.relatedPEs ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9]{7}[A-Z]/.test(s));
  const qtyTotal = last(detail.procurementQty);
  const netTotal = last(detail.netProcurementM);
  const unitCost = last(detail.unitCostK) ?? last(detail.unitCostM);
  const unitCostUnit = detail.unitCostK?.length ? '$K' : detail.unitCostM?.length ? '$M' : null;
  const llm = detail.llm;
  const contractors = (llm?.contractors ?? []).filter(Boolean);
  const milestones = (llm?.milestones ?? []).filter(Boolean);
  const risks = (llm?.risks ?? []).filter(Boolean);
  const hasLlm =
    !!llm?.acquisitionStrategy || !!llm?.programOffice || contractors.length > 0 || milestones.length > 0 || risks.length > 0;
  const hasAnything =
    qtyTotal || netTotal || unitCost || relateds.length > 0 || detail.mdapCode || detail.idCode || hasLlm;
  if (!hasAnything) return null;

  const items: Array<{ label: string; value: React.ReactNode }> = [];
  if (qtyTotal) items.push({ label: 'Total quantity', value: qtyTotal });
  if (netTotal) items.push({ label: 'Net procurement (total, $M)', value: netTotal });
  if (unitCost) items.push({ label: `Unit cost (${unitCostUnit})`, value: unitCost });
  if (detail.mdapCode) items.push({ label: 'MDAP/MAIS code', value: detail.mdapCode });
  if (detail.idCode) {
    items.push({
      label: 'ID code',
      value: detail.idCode === 'A' ? 'A — service ready' : `${detail.idCode} — not service ready`,
    });
  }
  if (relateds.length > 0) {
    items.push({
      label: 'Related RDT&E PEs',
      value: (
        <>
          {relateds.map((pe, i) => (
            <span key={pe}>
              {i > 0 ? ', ' : ''}
              <button
                type="button"
                className="pe-fb-related-pe-link"
                data-testid={`pe-pdoc-related-${pe}`}
                onClick={() => onOpenPe?.(pe)}
              >
                {pe}
              </button>
            </span>
          ))}
        </>
      ),
    });
  }
  if (detail.lineItem) items.push({ label: 'P-40 line item', value: detail.lineItem });
  if (detail.appropriation) items.push({ label: 'P-40 appropriation', value: detail.appropriation });

  return (
    <PeFbPanel title="P-40 exhibit detail" className="pe-fb-pdoc-detail" testId="pe-pdoc-detail">
      <dl className="pe-fb-dl">
        {items.map((item) => (
          <div key={item.label} className="pe-fb-dl-item">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {hasLlm ? (
        <div className="pe-fb-pdoc-llm">
          {llm?.acquisitionStrategy ? (
            <div className="pe-fb-pdoc-llm-row">
              <span className="pe-fb-pdoc-llm-label">Acquisition strategy</span>
              <span>{llm.acquisitionStrategy}</span>
            </div>
          ) : null}
          {llm?.programOffice ? (
            <div className="pe-fb-pdoc-llm-row">
              <span className="pe-fb-pdoc-llm-label">Program office</span>
              <span>{llm.programOffice}</span>
            </div>
          ) : null}
          {contractors.length > 0 ? (
            <div className="pe-fb-pdoc-llm-row">
              <span className="pe-fb-pdoc-llm-label">Named contractors</span>
              <span className="pe-fb-tag-row">
                {contractors.map((c) => (
                  <PeFbTag key={c}>{c}</PeFbTag>
                ))}
              </span>
            </div>
          ) : null}
          {milestones.length > 0 ? (
            <div className="pe-fb-pdoc-llm-row">
              <span className="pe-fb-pdoc-llm-label">Milestones</span>
              <ul className="pe-fb-pdoc-llm-list">
                {milestones.map((mi) => (
                  <li key={mi}>{mi}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {risks.length > 0 ? (
            <div className="pe-fb-pdoc-llm-row">
              <span className="pe-fb-pdoc-llm-label">Risks</span>
              <ul className="pe-fb-pdoc-llm-list">
                {risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div
            className="pe-fb-pdoc-llm-note"
            title="Every value in this section was independently re-validated as a verbatim substring of the line's own P-40 narrative before load — nothing here was inferred beyond what the source document states."
          >
            Extracted &amp; verbatim-validated from the source narrative
          </div>
        </div>
      ) : null}
      {detail.sourceBook ? (
        <div className="pe-fb-pdoc-source" data-testid="pe-pdoc-source">
          {formatPdocSourceLine(detail.sourceBook)}
        </div>
      ) : (
        <div className="pe-fb-pdoc-source" data-testid="pe-pdoc-source">
          Source: P-40 exhibit (source book / FY not recorded on enrichment payload)
        </div>
      )}
    </PeFbPanel>
  );
}

/* ── Programs (Step 2.1) ───────────────────────────────────────────────────── */

export interface ProgramsPanelVNextProps {
  programs: ProgramsForPeResponse | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

const BAND_COLOR: Record<ProgramConfidenceBand, string> = {
  high: 'green',
  medium: 'gold',
  low: 'orange',
  weak: 'default',
};

const BAND_LABEL: Record<ProgramConfidenceBand, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  weak: 'Weak signal',
};

/** Open-at-page deep link for an evidence item ({ sourceUrl, pageNumber }). */
function evidenceHref(item: ProgramEvidenceItem): string | null {
  if (!item.sourceUrl) return null;
  return item.pageNumber ? `${item.sourceUrl}#page=${item.pageNumber}` : item.sourceUrl;
}

/** Render the source-evidence links for a match (deduped, deep-linked). */
function EvidenceLinks({ evidence }: { evidence: ProgramEvidenceItem[] }) {
  const linked = (Array.isArray(evidence) ? evidence : []).filter((e) => e.sourceUrl);
  if (linked.length === 0) return <span className="pe-fb-muted">—</span>;
  return (
    <span className="pe-fb-tag-row">
      {linked.map((e, i) => {
        const href = evidenceHref(e);
        const label = `${e.kind ?? 'source'}${e.pageNumber ? ` p.${e.pageNumber}` : ''}`;
        return href ? (
          <a key={`${href}-${i}`} href={href} target="_blank" rel="noreferrer">
            <PeFbTag color="green" title={e.quote ?? e.sourceUrl ?? undefined}>
              {label}
            </PeFbTag>
          </a>
        ) : (
          <PeFbTag key={`${label}-${i}`}>{label}</PeFbTag>
        );
      })}
    </span>
  );
}

function formatReviewed(value: string | null): string {
  if (!value) return 'Not yet reviewed';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Not yet reviewed';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ProgramsTable({ rows, showCandidateBadge }: { rows: PeProgramMatchRow[]; showCandidateBadge: boolean }) {
  return (
    <CapiroTableWrap className="pe-fb-scroll">
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Program</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Confidence</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Why shown</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {rows.map((r) => (
            <tr key={r.id}>
              <CapiroTableCell>
                <div>
                  <strong>{r.program?.canonicalName ?? '(unknown program)'}</strong>
                  {showCandidateBadge ? (
                    <PeFbTag color="gold" style={{ marginLeft: 8 }}>
                      Candidate — requires review
                    </PeFbTag>
                  ) : null}
                  <div className="pe-fb-muted" style={{ fontSize: 12 }}>
                    {[r.program?.mdapCode ? `MDAP ${r.program.mdapCode}` : null, r.program?.component]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </div>
                </div>
              </CapiroTableCell>
              <CapiroTableCell>
                <PeFbTag color={BAND_COLOR[r.confidenceBand] ?? 'default'}>
                  {BAND_LABEL[r.confidenceBand] ?? r.confidenceBand}
                </PeFbTag>
              </CapiroTableCell>
              <CapiroTableCell>
                {r.whyShown ? <span>{r.whyShown}</span> : <span className="pe-fb-muted">—</span>}
              </CapiroTableCell>
              <CapiroTableCell>
                <EvidenceLinks evidence={r.evidence} />
              </CapiroTableCell>
              <CapiroTableCell>
                <div>
                  <PeFbTag color={r.status === 'accepted' ? 'green' : 'gold'}>{r.status}</PeFbTag>
                  <div className="pe-fb-muted" style={{ fontSize: 11 }}>{formatReviewed(r.resolvedAt)}</div>
                </div>
              </CapiroTableCell>
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

export function PeProgramsPanelVNext({
  programs,
  loading = false,
  errored = false,
  onRetry,
}: ProgramsPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Programs">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="programs" testId="pe-secondary-failed-programs" onRetry={onRetry} />
    );
  }

  const accepted = Array.isArray(programs?.acceptedMatches) ? programs!.acceptedMatches : [];
  const candidates = Array.isArray(programs?.candidateMatches) ? programs!.candidateMatches : [];

  if (accepted.length === 0 && candidates.length === 0) {
    return (
      <PeFbPanel className="pe-fb-programs-card" title="Programs">
        <PeFbEmpty description="No programs linked to this Program Element yet. Matches appear here once the Program graph links this PE — accepted links show directly; proposed links wait for review." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-programs-card" title={`Programs · ${accepted.length}`}>
      <p className="pe-fb-muted" style={{ marginBottom: 8, fontSize: 12 }}>
        Programs this Program Element rolls up to in the Capiro Program graph. Each row shows why
        the match was made, the source evidence, and the review status. Source chips open the exact
        exhibit page.
      </p>

      {accepted.length > 0 ? (
        <ProgramsTable rows={accepted} showCandidateBadge={false} />
      ) : (
        <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8 }}>
          No accepted program links yet — see proposed candidates below.
        </span>
      )}

      {candidates.length > 0 ? (
        <div style={{ marginTop: accepted.length > 0 ? 20 : 0 }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Proposed candidates (awaiting review)
          </strong>
          <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            Machine-proposed links that a reviewer has not yet confirmed. Shown for transparency —
            they are not treated as established until accepted in the review queue.
          </span>
          <ProgramsTable rows={candidates} showCandidateBadge />
        </div>
      ) : null}
    </PeFbPanel>
  );
}

/* ── Related PEs (similarity suggestions) ──────────────────────────────────── */

export interface RelatedPesPanelVNextProps {
  related: ProgramElementRelatedResponse | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

// Similarity → color band. Kept conservative: these are suggestions, so we don't
// imply certainty with green unless the missions are genuinely close.
function similarityColor(similarity: number): string {
  if (similarity >= 0.85) return 'green';
  if (similarity >= 0.78) return 'gold';
  return 'default';
}

export function PeRelatedPesPanelVNext({ related, loading = false, errored = false, onRetry }: RelatedPesPanelVNextProps) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <PeFbPanel title="Related program elements">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="related program elements" testId="pe-secondary-failed-related" onRetry={onRetry} />
    );
  }

  const rows = related?.related ?? [];

  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-related-card" title="Related program elements">
        <PeFbEmpty
          description={
            related?.todo ??
            'No related program elements yet — similarity suggestions appear once mission embeddings are generated.'
          }
        />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel
      className="pe-fb-related-card"
      title="Related program elements"
      extra={
        <span
          className="pe-fb-muted"
          title="PEs whose mission text is semantically similar to this one. These are suggestions based on description similarity — not a documented funding or program relationship."
        >
          Suggested · by mission similarity
        </span>
      }
    >
      <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Suggestions only — PEs with similar mission descriptions. Not a documented
        program or funding link; use as a starting point for related-program research.
      </span>
      <div className="pe-fb-scroll">
        <div className="pe-fb-related-list">
          {rows.map((pe) => (
            <button
              type="button"
              key={pe.peCode}
              className="pe-fb-related-row"
              onClick={() => navigate(`/program-elements/${encodeURIComponent(pe.peCode)}`)}
            >
              <span className="pe-fb-related-ident">
                <span className="pe-fb-related-code">{pe.peCode}</span>
                {pe.service ? <span className="pe-fb-related-service">{pe.service}</span> : null}
              </span>
              <span className="pe-fb-related-title">{pe.title}</span>
              <PeFbTag color={similarityColor(pe.similarity)}>
                {Math.round(pe.similarity * 100)}% similar
              </PeFbTag>
            </button>
          ))}
        </div>
      </div>
    </PeFbPanel>
  );
}

/* ── Client relevance (Step 2.3) + shared evidence chips ───────────────────── */

export function PeRelevanceEvidenceVNext({ paths }: { paths: PathResult[] | null | undefined }) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => p && typeof p.path === 'string');
  if (list.length === 0) {
    return <span className="pe-fb-muted">No evidence</span>;
  }
  return (
    <span className="pe-fb-tag-row">
      {list.map((p, i) => {
        const label = RELEVANCE_PATH_LABEL[p.path] ?? p.path;
        const color = RELEVANCE_PATH_COLOR[p.path] ?? 'default';
        const evidence = Array.isArray(p.evidence) ? p.evidence.filter(Boolean) : [];
        const tip = evidence.length ? evidence.join(' · ') : label;
        return (
          <PeFbTag key={`${p.path}-${i}`} color={color} title={tip}>
            {label}
            <span style={{ marginLeft: 6, opacity: 0.75 }}>{formatScorePct(p.score)}</span>
          </PeFbTag>
        );
      })}
    </span>
  );
}

export interface ClientRelevancePanelVNextProps {
  /** Tenant clients relevant to this PE (already filtered to minScore by the API). */
  clients: RelevantClientRow[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

export function PeClientRelevancePanelVNext({
  clients,
  loading = false,
  errored = false,
  onRetry,
}: ClientRelevancePanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Client relevance">
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="client relevance" testId="pe-secondary-failed-client-relevance" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(clients) ? clients.filter((c) => c && typeof c.clientId === 'string') : [];

  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-client-relevance-card" title="Client relevance">
        <PeFbEmpty description="No clients in your portfolio clear the relevance floor for this Program Element yet. Relevance is explained by capability PE numbers/keywords, prior awards, facility districts, or ecosystem ties." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-client-relevance-card" title={`Client relevance · ${rows.length}`}>
      <p className="pe-fb-muted" style={{ marginBottom: 8, fontSize: 12 }}>
        Your portfolio clients relevant to this Program Element, scored across multiple evidence
        paths. Each chip shows the path and its score; hover a chip to see the supporting evidence.
      </p>
      <CapiroTableWrap className="pe-fb-scroll">
        <CapiroTable>
          <CapiroTableHead>
            <tr>
              <CapiroTableHeaderCell>Client</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Score</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Why relevant</CapiroTableHeaderCell>
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {rows.map((r) => (
              <tr key={r.clientId}>
                <CapiroTableCell>
                  <strong>{r.clientName || '(unnamed client)'}</strong>
                </CapiroTableCell>
                <CapiroTableCell>
                  <PeFbTag
                    color={scoreBandColor(r.score)}
                    title="Combined relevance score across all evidence paths"
                  >
                    {formatScorePct(r.score)}
                  </PeFbTag>
                </CapiroTableCell>
                <CapiroTableCell>
                  <PeRelevanceEvidenceVNext paths={r.paths} />
                </CapiroTableCell>
              </tr>
            ))}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
    </PeFbPanel>
  );
}

/* ── Proof pack (Step 1.2 §11 + Phase 5) ───────────────────────────────────── */

export interface ProofPackPanelVNextProps {
  sources: ProgramElementSourceItem[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

const EXHIBIT_COLOR: Record<string, string> = {
  'R-1': 'blue',
  'R-2': 'cyan',
  'R-2A': 'geekblue',
  'R-3': 'green',
  'P-1': 'purple',
  'P-40': 'purple',
};

/** Open-at-page deep link for a citation. */
export function citationHref(s: Pick<ProgramElementSourceItem, 'sourceUrl' | 'pageNumber'>): string | null {
  if (!s.sourceUrl) return null;
  return s.pageNumber ? `${s.sourceUrl}#page=${s.pageNumber}` : s.sourceUrl;
}

function pageLabel(s: ProgramElementSourceItem): string | null {
  if (!s.pageNumber) return null;
  return s.pageEnd && s.pageEnd !== s.pageNumber ? `pp.${s.pageNumber}–${s.pageEnd}` : `p.${s.pageNumber}`;
}

export function PeProofPackPanelVNext({ sources, loading = false, errored = false, onRetry }: ProofPackPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Sources & evidence">
        <PeFbSkeleton rows={4} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="sources & evidence" testId="pe-secondary-failed-sources" onRetry={onRetry} />
    );
  }

  const rows = Array.isArray(sources) ? sources : [];
  if (rows.length === 0) {
    return (
      <PeFbPanel className="pe-fb-proof-pack-card" title="Sources & evidence">
        <PeFbEmpty description="No source citations recorded for this PE yet." />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel className="pe-fb-proof-pack-card" title={`Sources & evidence · ${rows.length}`}>
      <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        Page-level citations registered for this PE. &quot;Open at page&quot; jumps to the
        linked exhibit URL when one exists. Content fingerprints (sha256) identify the
        ingested source bytes only — they are not a full archive receipt or page-image pack.
      </span>
      <div className="pe-fb-row-list">
        {rows.map((s) => {
          const badge = s.exhibitType ?? s.docType;
          const href = citationHref(s);
          const page = pageLabel(s);
          const fp = proofFingerprintLabel(s.sourceDocument?.sha256);
          return (
            <div key={s.id} className="pe-fb-row-item pe-fb-proof-row">
              <div className="pe-fb-tag-row">
                <PeFbTag color={EXHIBIT_COLOR[badge ?? ''] ?? 'default'}>{badge}</PeFbTag>
                {s.fy ? <PeFbTag>FY{s.fy}</PeFbTag> : null}
                {s.publisher ? <span className="pe-fb-muted">{s.publisher}</span> : null}
                {page ? <span className="pe-fb-muted">{page}</span> : null}
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    Open at page
                  </a>
                ) : (
                  <span className="pe-fb-muted">No openable source URL on this citation</span>
                )}
                {fp ? (
                  <PeFbTag data-testid="pe-proof-fingerprint" title={fp.title}>
                    {fp.short}
                  </PeFbTag>
                ) : null}
              </div>
              {s.sourceDocument?.title ? (
                <span className="pe-fb-muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                  {s.sourceDocument.title}
                  {s.sourceDocument.budgetCycle ? ` · ${s.sourceDocument.budgetCycle}` : ''}
                </span>
              ) : null}
              {s.snippet ? (
                <PeFbExpandableText text={s.snippet} rows={2} className="pe-fb-muted-text" />
              ) : null}
            </div>
          );
        })}
      </div>
    </PeFbPanel>
  );
}
