import {
  BUDGET_VEHICLE_CLASS_LABELS,
  FUNDING_STAGE_LABELS,
  FUNDING_VERIFICATION_STATUS_LABELS,
} from '@capiro/shared';
import { fmtAmt, fmtDelta, scopeLabel, scopeShort } from '../../../components/dossier/dossier-format.js';
import type { FundingBlock } from '../../../pages/bills/bill-360.types.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { FundingPositionTable, Pill, deltaColorVNext } from './dossier-primitives.js';

/**
 * Funding tab — vNext re-skin of pages/bills/BillFundingTab.tsx. Shows only
 * funding associated with the selected bill/vehicle: the topline position (big
 * mono amount + scope chip + same-scope Δ vs request), an optional like-for-like
 * comparison, the scope guardrail, and the Program Element impacts table.
 * Grounded empty state (never $0) until funding data ships.
 */
export function BillFundingTab({
  funding,
  onOpenPe,
  onOpenBill,
}: {
  funding: FundingBlock;
  onOpenPe: (pe: string) => void;
  onOpenBill: (billId: string) => void;
}) {
  const pending = funding.analysisStatus === 'analysis_pending';
  const pos =
    funding.positions.find((p) => p.primary) ??
    (funding.analysisStatus == null ? funding.positions[0] ?? null : null);
  const hasAny = funding.positions.length > 0 || funding.programElementImpacts.length > 0;
  // Prefer the full like-for-like set; fall back to the single senate comparison so a
  // cached pre-R4 response still renders (§5 edge case 12).
  const likeForLike =
    funding.comparisons?.length
      ? funding.comparisons
      : funding.senateCompare && funding.senateCompare.comparable
        ? [funding.senateCompare]
        : [];
  if (!hasAny) {
    return (
      <div className="b360-empty">
        <CapiroEmptyState
          title="No funding positions linked yet"
          description={
            funding.status ??
            'This bill is not a funding vehicle, or its positions have not been reviewed. No $0 is shown unless a source states zero.'
          }
        />
      </div>
    );
  }
  const req = funding.reqCompare;
  return (
    <>
      {pending && !pos ? (
        <div className="b360-fund-card">
          <div className="b360-fund-row">
            <div>
              <div className="b360-fund-line b360-fund-line--eyebrow">
                {funding.vehicle
                  ? fundingStageTrackLabel(funding.vehicle.stage, funding.vehicle.track)
                  : 'Funding analysis'}
              </div>
              <div className="b360-fund-amount">Analysis pending</div>
            </div>
            {funding.vehicle ? (
              <div className="b360-fund-metacol">
                <Pill sev="accent">FY{funding.vehicle.fiscalYear}</Pill>
                <div className="b360-fund-line">
                  {amountTreatmentLabel(funding.vehicle.amountTreatment)}
                </div>
              </div>
            ) : null}
          </div>
          <div className="b360-fund-source">
            {funding.status ?? 'Funding tables are available; amounts await verification.'}
            {funding.vehicle ? ` · Source: ${vehicleSourceCitation(funding.vehicle)}` : ''}
          </div>
        </div>
      ) : null}
      {pos ? (
        <div className="b360-fund-card">
          <div className="b360-fund-row">
            <div>
              <div className="b360-fund-line b360-fund-line--eyebrow">
                {fundingStageTrackLabel(pos.stage, pos.vehicleClass)}
              </div>
              <div className="b360-fund-amount">{fmtAmt(pos.amountMillions)}</div>
            </div>
            <div className="b360-fund-metacol">
              <Pill sev="accent">{scopeLabel(pos.scope)}</Pill>
              <div className="b360-fund-line">
                {[
                  FUNDING_STAGE_LABELS[pos.stage],
                  BUDGET_VEHICLE_CLASS_LABELS[pos.vehicleClass],
                  `FY${pos.fiscalYear ?? funding.vehicle?.fiscalYear ?? '—'}`,
                  amountTreatmentLabel(pos.amountTreatment),
                  FUNDING_VERIFICATION_STATUS_LABELS[pos.verification],
                ].join(' · ')}
              </div>
            </div>
            {req ? (
              <div className="b360-fund-delta-col">
                <div className="b360-fund-line b360-fund-line--eyebrow">
                  Δ vs request ({scopeShort(req.scope)})
                </div>
                <div className="b360-fund-delta" style={{ color: deltaColorVNext(req.deltaMillions) }}>
                  {fmtDelta(req.deltaMillions)}
                  {req.pct != null ? ` (${req.pct > 0 ? '+' : ''}${req.pct}%)` : ''}
                </div>
                <div className="b360-fund-line b360-fund-line--req">
                  req {fmtAmt(req.amountMillions)}
                </div>
              </div>
            ) : null}
          </div>
          {pos.source || pos.note || pos.sourcePage != null ? (
            <div className="b360-fund-source">
              {/* Source document AND page (§4.1) — one line, exactly as the
                  prototype renders it, with the page appended to the citation. */}
              Source: {sourceCitation(pos)}
              {pos.note ? ` · ${pos.note}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}

      {funding.overrideReconciliation === 'reconciled' ? (
        <div className="dsr-guardrail">
          <div>
            <div className="dsr-guardrail-eyebrow">Override reconciliation</div>
            <span className="dsr-guardrail-text">
              Verified against the bill&apos;s amount-changing provisions.
            </span>
          </div>
        </div>
      ) : null}

      {/* Like-for-like set (§4.1): House / Senate / conference figures that share the
          primary's fiscal year AND scope. The prototype has one such bar; N
          comparable figures render as N identical bars. `senateCompare` is used as
          the fallback for a response that predates `comparisons`. */}
      {likeForLike.map((c, i) => (
        <div className="b360-likebar" key={`${c.label}-${i}`}>
          <span className="b360-likebar-caption">
            Like-for-like comparison — same scope ({scopeShort(c.scope)})
          </span>
          <span className="b360-likebar-label">{c.label}</span>
          <span className="b360-likebar-amount">{fmtAmt(c.amountMillions)}</span>
          {c.deltaMillions != null ? (
            <span className="b360-likebar-delta" style={{ color: deltaColorVNext(c.deltaMillions) }}>
              {fmtDelta(c.deltaMillions)}
            </span>
          ) : null}
          {c.billId ? (
            <button
              type="button"
              className="b360-likebar-open"
              onClick={() => onOpenBill(c.billId as string)}
            >
              Open →
            </button>
          ) : null}
        </div>
      ))}

      {funding.guardrail ? (
        <div className="b360-guardrail">
          <div>
            <div className="b360-guardrail-eyebrow">Scope guardrail</div>
            <span className="b360-guardrail-text">{funding.guardrail}</span>
          </div>
        </div>
      ) : null}

      {funding.programElementImpacts.length ? (
        <FundingPositionTable
          title="Program Element impacts"
          rows={funding.programElementImpacts}
          onOpenPe={onOpenPe}
        />
      ) : null}

      {/* Parent Budget Package (§4.1). The prototype renders this as a button into a
          package workspace; that workspace is Budget Cycle 360 (R7), and §4.1
          explicitly permits "a labeled non-navigation reference" until it exists —
          so this is the prototype's chip treatment WITHOUT a click affordance. It is
          deliberately NOT a link to a hidden fake portfolio. */}
      {funding.parentPackageLabel ? (
        <div
          className="b360-parent-package"
          title="The package-level funding workspace (Budget Cycle 360) is not available yet."
        >
          Part of {funding.parentPackageLabel}
        </div>
      ) : null}
    </>
  );
}

/**
 * One-line source citation for a position: the document, then the page when the
 * loader captured one. Matches the prototype's single "Source: …" line while
 * satisfying §4.1's "source document and page".
 */
function sourceCitation(pos: {
  source: string | null;
  sourcePage: number | null;
  sourceDocumentTitle?: string | null;
  sourceDocumentKey?: string | null;
  sourceDocumentVersion?: string | null;
  sourceDocumentCurrent?: boolean | null;
}): string {
  const parts = [pos.sourceDocumentTitle ?? pos.source ?? '—'];
  if (pos.sourceDocumentKey) parts.push(pos.sourceDocumentKey);
  if (pos.sourceDocumentVersion) parts.push(`version ${pos.sourceDocumentVersion.slice(0, 12)}`);
  if (pos.sourceDocumentCurrent === true) parts.push('current source version');
  if (pos.sourceDocumentCurrent === false) parts.push('superseded source version');
  if (pos.sourcePage != null) parts.push(`p. ${pos.sourcePage}`);
  return parts.join(' · ');
}

function fundingStageTrackLabel(stage: string, track: string): string {
  const stageLabel = FUNDING_STAGE_LABELS[stage as keyof typeof FUNDING_STAGE_LABELS] ?? stage;
  const trackLabel =
    BUDGET_VEHICLE_CLASS_LABELS[track as keyof typeof BUDGET_VEHICLE_CLASS_LABELS] ??
    track.replaceAll('_', ' ');
  return `${stageLabel} ${trackLabel.toLowerCase()}`;
}

function amountTreatmentLabel(treatment: string | null | undefined): string {
  switch (treatment) {
    case 'proposed_authorization':
      return 'Proposed authorization level — not appropriated funding';
    case 'appropriated_funding':
      return 'Appropriated funding';
    case 'request':
      return 'Executive budget request';
    case 'unknown':
    case null:
    case undefined:
      return 'Funding treatment not verified';
    default:
      return treatment.replaceAll('_', ' ');
  }
}

function vehicleSourceCitation(vehicle: NonNullable<FundingBlock['vehicle']>): string {
  const parts = [vehicle.sourceDocumentTitle ?? vehicle.label];
  if (vehicle.sourceDocumentKey) parts.push(vehicle.sourceDocumentKey);
  if (vehicle.sourceDocumentVersion) parts.push(`version ${vehicle.sourceDocumentVersion.slice(0, 12)}`);
  if (vehicle.sourceDocumentCurrent === true) parts.push('current source version');
  if (vehicle.sourceDocumentCurrent === false) parts.push('superseded source version');
  return parts.join(' · ');
}
