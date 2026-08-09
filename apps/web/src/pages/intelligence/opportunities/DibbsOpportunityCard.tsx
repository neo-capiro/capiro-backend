import { Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import { formatSourceDate } from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * One DLA bid-board item (Funding Opportunities P41).
 *
 * ── Two rules this component exists to enforce ───────────────────────────────
 *
 * 1. AN AWARD IS NOT A PURSUIT. P40 put awards in their own table so they could
 *    not leak into a pursuable surface through a forgotten predicate, and this
 *    card continues that structurally: awards render through
 *    {@link DibbsAwardIntelligenceRow}, which has no action slot, and the
 *    solicitation card's actions are only rendered for `rfq`/`rfp`. There is no
 *    prop by which an award could be given a Pursue button.
 *
 * 2. UNKNOWN STAYS UNKNOWN. Every numeric field here is nullable at the source,
 *    and a null must never render as `0`, `$0`, or an em dash that reads like a
 *    real value. P49's canary already produced the failure this avoids: three
 *    broken queries rendered as an em dash, indistinguishable from genuine
 *    absence. So each absence says whose gap it is.
 *
 * ── Why quantity absence is TWO different sentences ─────────────────────────
 *
 * An RFQ states a quantity and a unit of issue. An RFP/IFB states neither — not
 * "zero", not "unknown", it is simply not part of that document type. Rendering
 * one sentence for both would tell a reader that a specific RFP failed to state
 * something it was never going to state. So the RFP case names the document
 * type, and only the RFQ case is a source gap.
 *
 * P40's mapper additionally drops a quantity whose unit of issue is missing,
 * because 500 of an unknown unit is not 500 — so a quantity arriving here
 * without a unit should be impossible. It is still handled rather than trusted:
 * the fallback treats it as unstated, which is what it is.
 *
 * ── The part/NSN gap is a review link, not a low score ──────────────────────
 *
 * Nothing in this schema stores a client's reviewed NSNs or part numbers, so
 * P41's strongest signal has nothing to match against. A card that quietly
 * showed a weak relevance would be telling the reader the parts did not match.
 * `partProfileGap` instead surfaces the missing input and offers the review
 * route, which is P41's own "add part/NSN profile gaps and review links" line.
 */

/** The stored DIBBS solicitation facts this card renders. Mirrors `tango_dibbs_solicitation`. */
export interface DibbsSolicitationFacts {
  /** `'rfq' | 'rfp'`. An award is not a value here — awards have their own row component. */
  documentType: 'rfq' | 'rfp';
  solicitation: string;
  /** The provider's own display spelling, when it gave one. Never parsed. */
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  /** RFQ only, exact decimal as a string. Never a float — see the mapper. */
  quantity: string | null;
  /** RFQ only. The unit `quantity` is counted in. */
  unitOfIssue: string | null;
  /** RFQ only. */
  setAside: string | null;
  /** RFP only. */
  buyerCode: string | null;
  closesDate: string | null;
  /** The provider's own judgement. `null` says nothing and is rendered as nothing. */
  isOpen: boolean | null;
  documentUrl: string | null;
  /** RFP only. */
  techDocsUrl: string | null;
}

/** What `describeDibbsAwardIntelligence` returned for a prior award on this item. */
export interface DibbsAwardContext {
  awardNumber: string;
  awardeeLegalBusinessName: string | null;
  isOwnAward: boolean;
  /** True when the numeric price is absent, whatever the display text says. */
  priceIsUnknown: boolean;
  /** The provider's own rendering, kept verbatim. May exist while the numeric price does not. */
  totalContractPriceText: string | null;
  awardDate: string | null;
}

const DOCUMENT_TYPE_LABELS: Readonly<Record<DibbsSolicitationFacts['documentType'], string>> = {
  rfq: 'DLA request for quote',
  rfp: 'DLA request for proposal',
};

/**
 * Quantity and unit as one phrase, or the reason there isn't one.
 *
 * Exported so the test asserts the same function the card renders, rather than
 * a re-implementation of the rule that could drift from it.
 */
export function formatDibbsQuantity(facts: DibbsSolicitationFacts): string {
  if (facts.documentType === 'rfp') return 'Not stated on a request for proposal';
  if (facts.quantity == null || facts.quantity === '') return 'Not stated by the source';
  // A quantity without its unit should be impossible; treated as unstated, not guessed.
  if (facts.unitOfIssue == null || facts.unitOfIssue === '') return 'Not stated by the source';
  return `${facts.quantity} ${facts.unitOfIssue}`;
}

/** The line-item identity, or an explicit statement that the provider gave none. */
export function formatDibbsPartIdentity(facts: DibbsSolicitationFacts): string {
  const parts: string[] = [];
  if (facts.nsn) parts.push(`NSN ${facts.nsn}`);
  if (facts.partNumber) parts.push(`Part ${facts.partNumber}`);
  if (parts.length === 0) return 'No NSN or part number stated';
  return parts.join(' · ');
}

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
  /**
   * Optional. When absent no pursuit control is rendered at all rather than
   * rendered inert — the same rule ForecastOpportunityCard follows.
   */
  onPursue?: () => void;
}) {
  return (
    <Card size="small" className="fo-card fo-card--dibbs" data-testid={`fo-dibbs-row-${facts.solicitation}`}>
      <div className="fo-inbox-row__head">
        <Space size={6} wrap>
          <Button
            type="link"
            size="small"
            className="fo-inbox-row__client"
            onClick={onSelectClient}
            aria-label={`Show only ${clientName}`}
          >
            {clientName}
          </Button>
          {/*
            The label names the document type, because "DIBBS" alone does not
            tell a reader whether this is something to quote or something that
            already happened.
          */}
          <Tooltip title="A Defense Logistics Agency bid-board item, at line-item grain.">
            <Tag color="geekblue" data-testid="fo-dibbs-label">
              {DOCUMENT_TYPE_LABELS[facts.documentType]}
            </Tag>
          </Tooltip>
          {/*
            Only the provider's own `false` can say closed. `null` says nothing
            and renders as nothing — never as "open".
          */}
          {facts.isOpen === false ? (
            <Tooltip title="The provider reports this item as no longer open.">
              <Tag color="red" data-testid="fo-dibbs-closed">
                Closed
              </Tag>
            </Tooltip>
          ) : null}
          {facts.setAside ? (
            <Tooltip title="The provider's own set-aside wording, verbatim.">
              <Tag data-testid="fo-dibbs-set-aside">{facts.setAside}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      </div>

      <div className="fo-card__title">
        <Button
          type="link"
          className="fo-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open bid-board detail for ${facts.solicitation}`}
        >
          {/* The provider's display spelling when it gave one, else the raw number. */}
          {facts.solicitationFormatted ?? facts.solicitation}
        </Button>
      </div>
      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-dibbs-nomenclature">
          {facts.nomenclature ?? 'No nomenclature stated'}
        </Text>
      </div>

      <div className="fo-card__facts">
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Line item
          </Text>
          <Text className="fo-fact__value" data-testid="fo-dibbs-part">
            {formatDibbsPartIdentity(facts)}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Quantity
          </Text>
          <Text className="fo-fact__value" data-testid="fo-dibbs-quantity">
            {formatDibbsQuantity(facts)}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Quotes close
          </Text>
          <Text className="fo-fact__value" data-testid="fo-dibbs-closes">
            {formatSourceDate(facts.closesDate, 'Not stated by the source')}
          </Text>
        </span>

        {/*
          RFP-only. Rendered only when the document type can carry it, so an RFQ
          does not show a buyer row that could never be filled.
        */}
        {facts.documentType === 'rfp' ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Buyer
            </Text>
            <Text className="fo-fact__value" data-testid="fo-dibbs-buyer">
              {facts.buyerCode ?? 'Not stated by the source'}
            </Text>
          </span>
        ) : null}

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Relevance
          </Text>
          {/* "Not scored yet" and a score of 0 are different facts. */}
          <Text className="fo-fact__value" data-testid="fo-dibbs-relevance">
            {relevanceScore ?? 'Not scored yet'}
          </Text>
        </span>
      </div>

      {/*
        The profile gap. Deliberately NOT phrased as a weak match: Capiro holds
        no parts for this client, so no part-level comparison happened at all.
      */}
      {partProfileGap === 'no_client_parts_recorded' ? (
        <div className="fo-card__meta" data-testid="fo-dibbs-part-gap">
          <Text type="secondary" style={{ fontSize: 11 }}>
            No NSNs or part numbers are recorded for this client, so no part-level match was attempted.
          </Text>
          {onReviewClientParts ? (
            <Button type="link" size="small" onClick={onReviewClientParts} data-testid="fo-dibbs-review-parts">
              Record this client&apos;s parts
            </Button>
          ) : null}
        </div>
      ) : null}

      {awards.length > 0 ? (
        <div className="fo-card__meta" data-testid="fo-dibbs-award-intel">
          <Text type="secondary" style={{ fontSize: 11 }}>
            Prior awards on this item
          </Text>
          {awards.map((award) => (
            <DibbsAwardIntelligenceRow key={award.awardNumber} award={award} />
          ))}
        </div>
      ) : null}

      {onPursue ? (
        <div className="fo-card__actions" data-testid="fo-dibbs-actions">
          <Space size={6} wrap>
            <Button size="small" onClick={onPursue} disabled={facts.isOpen === false}>
              {facts.documentType === 'rfq' ? 'Quote this item' : 'Consider a proposal'}
            </Button>
            {facts.documentUrl ? (
              <Button size="small" type="link" href={facts.documentUrl} target="_blank" rel="noreferrer">
                Solicitation document
              </Button>
            ) : null}
            {facts.techDocsUrl ? (
              <Button size="small" type="link" href={facts.techDocsUrl} target="_blank" rel="noreferrer">
                Technical documents
              </Button>
            ) : null}
          </Space>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One prior award, INFORMATIONAL.
 *
 * No action slot, no props that could supply one. P41's acceptance is "awards
 * never offer Pursue", and the way to guarantee it is for the award renderer to
 * have nowhere to put one.
 *
 * Never renders a total across awards. `tango_dibbs_award` rows are line-item
 * grain, so summing them double-counts by construction — P40 prohibits an
 * aggregate outright, and a UI total would be exactly that aggregate.
 */
export function DibbsAwardIntelligenceRow({ award }: { award: DibbsAwardContext }) {
  const who = award.isOwnAward
    ? 'This client'
    : (award.awardeeLegalBusinessName?.trim() || 'Another supplier');

  return (
    <div className="fo-fact" data-testid={`fo-dibbs-award-${award.awardNumber}`}>
      <Text type="secondary" className="fo-fact__label">
        {award.awardNumber}
      </Text>
      <Text className="fo-fact__value">
        {who}
        {' · '}
        {/*
          A null numeric price is never rendered as $0. The provider's own
          display text is shown when it exists, because it is the only evidence
          of what the source displayed; otherwise the absence is stated.

          The text is the ONLY price this component receives, so it is the
          fallback in both branches. A numeric price with no display text used to
          render an empty slot between two separators — a gap that reads as a
          rendering fault rather than as a fact about the source.
        */}
        {award.totalContractPriceText ?? 'No award price stated'}
        {' · '}
        {formatSourceDate(award.awardDate, 'No award date stated')}
      </Text>
    </div>
  );
}
