import { CapiroButton } from '../../components/actions/index.js';
import { formatSourceDate } from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import {
  formatDibbsPartIdentity,
  formatDibbsQuantity,
  type DibbsAwardContext,
  type DibbsSolicitationFacts,
} from '../../../pages/intelligence/opportunities/dibbs-card-shared.js';
import { FovCard, FovPill } from './fov-ui.js';

/**
 * One DLA bid-board item — vNext port of the canonical DibbsOpportunityCard.
 *
 * The two structural rules survive intact:
 *
 * 1. AN AWARD IS NOT A PURSUIT. Awards render through
 *    {@link DibbsAwardIntelligenceRow}, which has no action slot, and the
 *    solicitation card's actions are only rendered for `rfq`/`rfp`.
 * 2. UNKNOWN STAYS UNKNOWN. Every numeric field is nullable at the source,
 *    and a null must never render as `0`, `$0`, or a dash that reads like a
 *    real value.
 *
 * `formatDibbsQuantity` / `formatDibbsPartIdentity` are imported from the
 * UI-free extraction (dibbs-card-shared.ts) the canonical card also renders
 * from, so the two surfaces cannot drift on the RFP-vs-RFQ absence sentences.
 */
export type { DibbsAwardContext, DibbsSolicitationFacts };

const DOCUMENT_TYPE_LABELS: Readonly<Record<DibbsSolicitationFacts['documentType'], string>> = {
  rfq: 'DLA request for quote',
  rfp: 'DLA request for proposal',
};

export function DibbsOpportunityCard({
  facts,
  clientName,
  relevanceScore,
  partProfileGap,
  awards = [],
  onSelectClient,
  onOpenDetail,
  onReviewClientParts,
  onPursue,
}: {
  facts: DibbsSolicitationFacts;
  clientName: string;
  /** `null` means not scored yet, which is not the same fact as a score of 0. */
  relevanceScore: number | null;
  /** Set when no part-level match could be attempted at all. */
  partProfileGap: 'no_client_parts_recorded' | null;
  /** Prior awards on this item. Informational — this list never renders an action. */
  awards?: DibbsAwardContext[];
  onSelectClient: () => void;
  onOpenDetail: () => void;
  /** Optional. Absent means the review route is described but not offered as a control. */
  onReviewClientParts?: () => void;
  /** Optional. When absent no pursuit control is rendered at all rather than rendered inert. */
  onPursue?: () => void;
}) {
  return (
    <FovCard className="fov-card--dibbs" testId={`fo-dibbs-row-${facts.solicitation}`}>
      <div className="fov-inbox-row__head">
        <span className="fov-row">
          <button
            type="button"
            className="fov-inbox-row__client"
            onClick={onSelectClient}
            aria-label={`Show only ${clientName}`}
          >
            {clientName}
          </button>
          {/* The label names the document type: "DIBBS" alone does not tell a
              reader whether this is something to quote or something that
              already happened. */}
          <FovPill
            tone="geekblue"
            testId="fo-dibbs-label"
            title="A Defense Logistics Agency bid-board item, at line-item grain."
          >
            {DOCUMENT_TYPE_LABELS[facts.documentType]}
          </FovPill>
          {/* Only the provider's own `false` can say closed. `null` says
              nothing and renders as nothing — never as "open". */}
          {facts.isOpen === false ? (
            <FovPill
              tone="red"
              testId="fo-dibbs-closed"
              title="The provider reports this item as no longer open."
            >
              Closed
            </FovPill>
          ) : null}
          {facts.setAside ? (
            <FovPill testId="fo-dibbs-set-aside" title="The provider's own set-aside wording, verbatim.">
              {facts.setAside}
            </FovPill>
          ) : null}
        </span>
      </div>

      <div className="fov-card__title">
        <button
          type="button"
          className="fov-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open bid-board detail for ${facts.solicitation}`}
        >
          {/* The provider's display spelling when it gave one, else the raw number. */}
          {facts.solicitationFormatted ?? facts.solicitation}
        </button>
      </div>
      <div className="fov-card__meta">
        <span className="fov-muted" data-testid="fo-dibbs-nomenclature">
          {facts.nomenclature ?? 'No nomenclature stated'}
        </span>
      </div>

      <div className="fov-card__facts">
        <span className="fov-fact">
          <span className="fov-fact__label">Line item</span>
          <span className="fov-fact__value" data-testid="fo-dibbs-part">
            {formatDibbsPartIdentity(facts)}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Quantity</span>
          <span className="fov-fact__value" data-testid="fo-dibbs-quantity">
            {formatDibbsQuantity(facts)}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Quotes close</span>
          <span className="fov-fact__value" data-testid="fo-dibbs-closes">
            {formatSourceDate(facts.closesDate, 'Not stated by the source')}
          </span>
        </span>

        {/* RFP-only. Rendered only when the document type can carry it. */}
        {facts.documentType === 'rfp' ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Buyer</span>
            <span className="fov-fact__value" data-testid="fo-dibbs-buyer">
              {facts.buyerCode ?? 'Not stated by the source'}
            </span>
          </span>
        ) : null}

        <span className="fov-fact">
          <span className="fov-fact__label">Relevance</span>
          {/* "Not scored yet" and a score of 0 are different facts. */}
          <span className="fov-fact__value" data-testid="fo-dibbs-relevance">
            {relevanceScore ?? 'Not scored yet'}
          </span>
        </span>
      </div>

      {/* The profile gap. Deliberately NOT phrased as a weak match: Capiro
          holds no parts for this client, so no comparison happened at all. */}
      {partProfileGap === 'no_client_parts_recorded' ? (
        <div className="fov-card__meta" data-testid="fo-dibbs-part-gap">
          <span className="fov-micro">
            No NSNs or part numbers are recorded for this client, so no part-level match was attempted.
          </span>
          {onReviewClientParts ? (
            <CapiroButton
              size="compact"
              variant="quiet"
              onClick={onReviewClientParts}
              data-testid="fo-dibbs-review-parts"
            >
              Record this client&apos;s parts
            </CapiroButton>
          ) : null}
        </div>
      ) : null}

      {awards.length > 0 ? (
        <div className="fov-card__meta" data-testid="fo-dibbs-award-intel">
          <span className="fov-micro">Prior awards on this item</span>
          {awards.map((award) => (
            <DibbsAwardIntelligenceRow key={award.awardNumber} award={award} />
          ))}
        </div>
      ) : null}

      {onPursue ? (
        <div className="fov-card__actions" data-testid="fo-dibbs-actions">
          <span className="fov-row">
            <CapiroButton size="compact" onClick={onPursue} disabled={facts.isOpen === false}>
              {facts.documentType === 'rfq' ? 'Quote this item' : 'Consider a proposal'}
            </CapiroButton>
            {facts.documentUrl ? (
              <a href={facts.documentUrl} target="_blank" rel="noreferrer">
                Solicitation document
              </a>
            ) : null}
            {facts.techDocsUrl ? (
              <a href={facts.techDocsUrl} target="_blank" rel="noreferrer">
                Technical documents
              </a>
            ) : null}
          </span>
        </div>
      ) : null}
    </FovCard>
  );
}

/**
 * One prior award, INFORMATIONAL. No action slot, no props that could supply
 * one — the way to guarantee "awards never offer Pursue" is for the award
 * renderer to have nowhere to put one. Never renders a total across awards:
 * line-item grain sums double-count by construction.
 */
export function DibbsAwardIntelligenceRow({ award }: { award: DibbsAwardContext }) {
  const who = award.isOwnAward
    ? 'This client'
    : (award.awardeeLegalBusinessName?.trim() || 'Another supplier');

  return (
    <div className="fov-fact" data-testid={`fo-dibbs-award-${award.awardNumber}`}>
      <span className="fov-fact__label">{award.awardNumber}</span>
      <span className="fov-fact__value">
        {who}
        {' · '}
        {/* A null numeric price is never rendered as $0. The provider's own
            display text is the ONLY price this component receives, so it is
            the fallback in both branches. */}
        {award.totalContractPriceText ?? 'No award price stated'}
        {' · '}
        {formatSourceDate(award.awardDate, 'No award date stated')}
      </span>
    </div>
  );
}
