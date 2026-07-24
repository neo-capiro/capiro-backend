import {
  BUDGET_VEHICLE_CLASS_LABELS,
  FUNDING_STAGE_LABELS,
  FUNDING_VERIFICATION_STATUS_LABELS,
} from '@capiro/shared';
import { Pill } from '../../components/dossier/EvidenceBadge.js';
import { FundingPositionTable } from '../../components/dossier/FundingPositionTable.js';
import { deltaColor, fmtAmt, fmtDelta, scopeLabel, scopeShort } from '../../components/dossier/dossier-format.js';
import type { FundingBlock } from './bill-360.types.js';

/**
 * Funding tab. Shows only funding associated with the selected bill/vehicle:
 * the topline position (big mono amount + scope chip + same-scope Δ vs request),
 * an optional like-for-like comparison, the scope guardrail, and the Program
 * Element impacts table. Grounded empty state (never $0) until funding data ships.
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
  const pos = funding.positions.find((p) => p.primary) ?? funding.positions[0] ?? null;
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
      <div className="dsr-empty">
        <div className="dsr-empty-title">No funding positions linked yet</div>
        <div>
          {funding.status ??
            'This bill is not a funding vehicle, or its positions have not been reviewed. No $0 is shown unless a source states zero.'}
        </div>
      </div>
    );
  }
  const req = funding.reqCompare;
  const sen = funding.senateCompare;
  return (
    <>
      {pos ? (
        <div className="dsr-fund-card">
          <div className="dsr-fund-row">
            <div>
              <div className="dsr-fund-line" style={{ marginBottom: 5 }}>
                Funding position
              </div>
              <div className="dsr-fund-amount">{fmtAmt(pos.amountMillions)}</div>
            </div>
            <div className="dsr-fund-metacol">
              <Pill sev="accent">{scopeLabel(pos.scope)}</Pill>
              <div className="dsr-fund-line">
                {[
                  FUNDING_STAGE_LABELS[pos.stage],
                  BUDGET_VEHICLE_CLASS_LABELS[pos.vehicleClass],
                  FUNDING_VERIFICATION_STATUS_LABELS[pos.verification],
                ].join(' · ')}
              </div>
            </div>
            {req ? (
              <div className="dsr-fund-delta-col">
                <div className="dsr-fund-line" style={{ marginBottom: 5 }}>
                  Δ vs request ({scopeShort(req.scope)})
                </div>
                <div className="dsr-fund-delta" style={{ color: deltaColor(req.deltaMillions) }}>
                  {fmtDelta(req.deltaMillions)}
                  {req.pct != null ? ` (${req.pct > 0 ? '+' : ''}${req.pct}%)` : ''}
                </div>
                <div className="dsr-fund-line" style={{ marginTop: 3 }}>
                  req {fmtAmt(req.amountMillions)}
                </div>
              </div>
            ) : null}
          </div>
          {pos.source || pos.note || pos.sourcePage != null ? (
            <div className="dsr-fund-source">
              {/* Source document AND page (§4.1) — one line, exactly as the
                  prototype renders it, with the page appended to the citation. */}
              Source: {sourceCitation(pos)}
              {pos.note ? ` · ${pos.note}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Like-for-like set (§4.1): House / Senate / conference figures that share the
          primary's fiscal year AND scope. The prototype has one such bar; N
          comparable figures render as N identical bars. `senateCompare` is used as
          the fallback for a response that predates `comparisons`. */}
      {likeForLike.map((c, i) => (
        <div className="dsr-likebar" key={`${c.label}-${i}`}>
          <span style={{ fontSize: 12, color: 'var(--ink-2)', flex: 1 }}>
            Like-for-like comparison — same scope ({scopeShort(c.scope)})
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{c.label}</span>
          <span style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 14, fontWeight: 600 }}>
            {fmtAmt(c.amountMillions)}
          </span>
          {c.deltaMillions != null ? (
            <span
              style={{
                fontFamily: 'var(--font-mono-rd)',
                fontSize: 12.5,
                fontWeight: 600,
                color: deltaColor(c.deltaMillions),
              }}
            >
              {fmtDelta(c.deltaMillions)}
            </span>
          ) : null}
          {c.billId ? (
            <button
              type="button"
              onClick={() => onOpenBill(c.billId as string)}
              style={{
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--accent-ink)',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Open →
            </button>
          ) : null}
        </div>
      ))}

      {funding.guardrail ? (
        <div className="dsr-guardrail">
          <div>
            <div className="dsr-guardrail-eyebrow">Scope guardrail</div>
            <span className="dsr-guardrail-text">{funding.guardrail}</span>
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
          className="dsr-parent-package"
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
}): string {
  const parts = [pos.source ?? '—'];
  if (pos.sourcePage != null) parts.push(`p. ${pos.sourcePage}`);
  return parts.join(' · ');
}
