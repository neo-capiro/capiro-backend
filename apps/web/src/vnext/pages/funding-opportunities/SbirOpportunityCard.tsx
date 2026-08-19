import { CapiroButton } from '../../components/actions/index.js';
import { formatSourceDate } from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import {
  SBIR_ACTION_LABELS,
  describeSbirCycle,
  sbirProgramLabel,
  type SbirAction,
  type SbirCycleFacts,
  type SbirTopicFacts,
} from '../../../pages/intelligence/opportunities/sbir-card-shared.js';
import { FovCard, FovPill } from './fov-ui.js';

/**
 * One SBIR/STTR topic — vNext port of the canonical SbirOpportunityCard.
 *
 * The four honesty rules (source, phase, cycle, deadlines) are unchanged; the
 * description rules live in sbir-card-shared.ts, which BOTH surfaces render
 * from, so they cannot drift:
 *
 *   - the program tag renders ONLY when the parent cycle supplied one — SBIR
 *     and STTR differ in whether a research partner is required, so guessing
 *     would assert the absence of a requirement;
 *   - the phase gap renders as a ROW rather than an omission;
 *   - eligibility is displayed verbatim from the scorer, never summarised;
 *   - a closed topic has no action row at all (empty `actions` renders none).
 */
export type { SbirAction, SbirCycleFacts, SbirTopicFacts };

export function SbirOpportunityCard({
  facts,
  cycle = null,
  clientName,
  relevanceScore,
  phaseGapExplanation,
  eligibilityReason,
  actions = [],
  onSelectClient,
  onOpenDetail,
  onAction,
}: {
  facts: SbirTopicFacts;
  /** The parent cycle when held. Null means NOT HELD — not "no cycle stated". */
  cycle?: SbirCycleFacts | null;
  clientName: string;
  /** `null` means not scored yet, which is not the same fact as a score of 0. */
  relevanceScore: number | null;
  /**
   * `describeSbirPhaseGap`'s own sentence, passed in rather than composed here
   * so the API and the UI cannot drift on why a phase is missing.
   */
  phaseGapExplanation: string | null;
  /** `scoreSbirRelevance`'s reason, rendered verbatim. Never summarised. */
  eligibilityReason: string;
  /** From the scorer. EMPTY on a closed topic, which renders no action row. */
  actions?: SbirAction[];
  onSelectClient: () => void;
  onOpenDetail: () => void;
  /** Optional. Absent means the actions are described but not offered as controls. */
  onAction?: (action: SbirAction) => void;
}) {
  const program = sbirProgramLabel(cycle);

  return (
    <FovCard className="fov-card--sbir" testId={`fo-sbir-row-${facts.topicNumber ?? 'unnumbered'}`}>
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
          {/* The program tag renders ONLY when the cycle supplied one. */}
          {program ? (
            <FovPill
              tone="purple"
              testId="fo-sbir-program"
              title="The parent solicitation cycle's own program value."
            >
              {program}
            </FovPill>
          ) : (
            <FovPill
              testId="fo-sbir-program-unknown"
              title="SBIR and STTR are stated on the solicitation cycle, which Capiro does not hold for this topic."
            >
              Program not stated
            </FovPill>
          )}
          {facts.solicitationStatus ? (
            <FovPill testId="fo-sbir-status" title="The provider's own status wording, verbatim.">
              {facts.solicitationStatus}
            </FovPill>
          ) : null}
        </span>
      </div>

      <div className="fov-card__title">
        <button
          type="button"
          className="fov-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open topic detail for ${facts.topicNumber ?? 'this topic'}`}
        >
          {facts.title ?? facts.topicNumber ?? 'Untitled topic'}
        </button>
      </div>
      <div className="fov-card__meta">
        <span className="fov-muted" data-testid="fo-sbir-identity">
          {facts.topicNumber ?? 'No topic number stated'}
          {facts.agency ? ` · ${facts.agency}` : ' · No agency stated'}
        </span>
      </div>

      <div className="fov-card__facts">
        <span className="fov-fact">
          <span className="fov-fact__label">Cycle</span>
          <span className="fov-fact__value" data-testid="fo-sbir-cycle">
            {describeSbirCycle(facts, cycle)}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Opens</span>
          <span className="fov-fact__value" data-testid="fo-sbir-opens">
            {formatSourceDate(facts.openDate, 'Not stated by the source')}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Closes</span>
          <span className="fov-fact__value" data-testid="fo-sbir-closes">
            {formatSourceDate(facts.closeDate, 'Not stated by the source')}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Relevance</span>
          {/* "Not scored yet" and a score of 0 are different facts. */}
          <span className="fov-fact__value" data-testid="fo-sbir-relevance">
            {relevanceScore ?? 'Not scored yet'}
          </span>
        </span>
      </div>

      {/* The phase gap. A ROW rather than an omission: showing no phase would
          let a reader assume one was evaluated and found unremarkable. */}
      {phaseGapExplanation ? (
        <div className="fov-card__meta" data-testid="fo-sbir-phase-gap">
          <span className="fov-micro">{phaseGapExplanation}</span>
        </div>
      ) : null}

      {/* Verbatim from the scorer. The obvious summary — "eligibility unknown"
          — drops which facts are missing. */}
      <div className="fov-card__meta" data-testid="fo-sbir-eligibility">
        <span className="fov-micro">{eligibilityReason}</span>
      </div>

      {actions.length > 0 && onAction ? (
        <div className="fov-card__actions" data-testid="fo-sbir-actions">
          <span className="fov-row">
            {actions.map((action) => (
              <CapiroButton key={action} size="compact" onClick={() => onAction(action)}>
                {SBIR_ACTION_LABELS[action]}
              </CapiroButton>
            ))}
            {facts.topicUrl ? (
              <a href={facts.topicUrl} target="_blank" rel="noreferrer">
                Topic on the source
              </a>
            ) : null}
            {facts.officialSolicitationUrl ? (
              <a href={facts.officialSolicitationUrl} target="_blank" rel="noreferrer">
                Official solicitation
              </a>
            ) : null}
          </span>
        </div>
      ) : null}
    </FovCard>
  );
}
