import { Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import { formatSourceDate } from './funding-opportunities-api.js';
import {
  SBIR_ACTION_LABELS,
  describeSbirCycle,
  sbirProgramLabel,
  type SbirAction,
  type SbirCycleFacts,
  type SbirTopicFacts,
} from './sbir-card-shared.js';

// The UI-free types, labels and description rules moved to sbir-card-shared.ts
// so the vNext presentation can consume them without reaching this antd file
// (Phase 2 extraction pattern). Re-exported here so this file's public API is
// unchanged.
export { SBIR_ACTION_LABELS, describeSbirCycle, sbirProgramLabel } from './sbir-card-shared.js';
export type { SbirAction, SbirCycleFacts, SbirTopicFacts } from './sbir-card-shared.js';

const { Text } = Typography;

/**
 * One SBIR/STTR topic (Funding Opportunities P43).
 *
 * ── FOUR THINGS P43 ASKS THIS CARD TO LABEL HONESTLY ────────────────────────
 *
 * The phase's acceptance is "UI labels source, phase, cycle, and deadlines
 * honestly". Three of those four are harder than they look:
 *
 * 1. SOURCE. **SBIR and STTR are not a property of the topic.** `program` lives
 *    on the parent CYCLE (`tango_sbir_solicitation`), and a topic carries only
 *    a `solicitationNumber` pointing at one. So when Capiro does not hold the
 *    cycle, this card CANNOT say which program the topic belongs to — and it
 *    does not. The rail is named "SBIR/STTR", which makes labelling every topic
 *    "SBIR" the easy mistake; the label here comes from the cycle or not at all.
 *
 * 2. PHASE. There is no phase field on either SBIR endpoint (P42's migration
 *    header records this). The card renders the GAP's own sentence rather than
 *    omitting a phase row, because an omission lets a reader assume a phase was
 *    evaluated and found unremarkable. It never parses one out of the title:
 *    "Direct to Phase II" in free text is the provider describing a topic, not
 *    a structured field.
 *
 * 3. CYCLE. Three genuinely different states, and they get three sentences:
 *    the topic states no cycle at all; it states one Capiro does not hold (an
 *    orphan — P42 deliberately has no FK, so this is legal and expected); or the
 *    cycle is held and can be named. Collapsing the first two into "Unknown"
 *    would merge a fact about the SOURCE with a fact about CAPIRO'S SYNC.
 *
 * 4. DEADLINES. A close date is a calendar day from a DATE column. Formatted
 *    via `formatSourceDate` so a date-only value is never shifted a day by local
 *    time, and a null says the source stated none.
 *
 * ── ELIGIBILITY IS DISPLAYED, NEVER DECIDED ─────────────────────────────────
 *
 * `scoreSbirRelevance` returns a constant `needs_review` and a reason. This card
 * renders that reason verbatim rather than summarising it, because the summary
 * anyone would write ("eligibility unknown") drops the part that matters: WHICH
 * facts are missing, and that a small-business certification is not the same
 * question.
 *
 * ── A CLOSED TOPIC HAS NO ACTION ROW AT ALL ─────────────────────────────────
 *
 * P43's acceptance is that closed topics do not offer Pursue. The scorer
 * enforces it by returning an empty `actions` list, and this card renders no
 * action row when the list is empty — absent rather than disabled, the same rule
 * ForecastOpportunityCard and DibbsOpportunityCard follow. There is no prop by
 * which a closed topic could be given a control.
 */

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
    <Card size="small" className="fo-card fo-card--sbir" data-testid={`fo-sbir-row-${facts.topicNumber ?? 'unnumbered'}`}>
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
            The program tag renders ONLY when the cycle supplied one. SBIR and
            STTR differ in whether a research partner is required, so guessing
            would assert the absence of a requirement.
          */}
          {program ? (
            <Tooltip title="The parent solicitation cycle's own program value.">
              <Tag color="purple" data-testid="fo-sbir-program">
                {program}
              </Tag>
            </Tooltip>
          ) : (
            <Tooltip title="SBIR and STTR are stated on the solicitation cycle, which Capiro does not hold for this topic.">
              <Tag data-testid="fo-sbir-program-unknown">Program not stated</Tag>
            </Tooltip>
          )}
          {facts.solicitationStatus ? (
            <Tooltip title="The provider's own status wording, verbatim.">
              <Tag data-testid="fo-sbir-status">{facts.solicitationStatus}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      </div>

      <div className="fo-card__title">
        <Button
          type="link"
          className="fo-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open topic detail for ${facts.topicNumber ?? 'this topic'}`}
        >
          {facts.title ?? facts.topicNumber ?? 'Untitled topic'}
        </Button>
      </div>
      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-sbir-identity">
          {facts.topicNumber ?? 'No topic number stated'}
          {facts.agency ? ` · ${facts.agency}` : ' · No agency stated'}
        </Text>
      </div>

      <div className="fo-card__facts">
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Cycle
          </Text>
          <Text className="fo-fact__value" data-testid="fo-sbir-cycle">
            {describeSbirCycle(facts, cycle)}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Opens
          </Text>
          <Text className="fo-fact__value" data-testid="fo-sbir-opens">
            {formatSourceDate(facts.openDate, 'Not stated by the source')}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Closes
          </Text>
          <Text className="fo-fact__value" data-testid="fo-sbir-closes">
            {formatSourceDate(facts.closeDate, 'Not stated by the source')}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Relevance
          </Text>
          {/* "Not scored yet" and a score of 0 are different facts. */}
          <Text className="fo-fact__value" data-testid="fo-sbir-relevance">
            {relevanceScore ?? 'Not scored yet'}
          </Text>
        </span>
      </div>

      {/*
        The phase gap. A ROW rather than an omission: showing no phase would let
        a reader assume one was evaluated and found unremarkable.
      */}
      {phaseGapExplanation ? (
        <div className="fo-card__meta" data-testid="fo-sbir-phase-gap">
          <Text type="secondary" style={{ fontSize: 11 }}>
            {phaseGapExplanation}
          </Text>
        </div>
      ) : null}

      {/*
        Verbatim from the scorer. The obvious summary — "eligibility unknown" —
        drops which facts are missing and that a small-business certification is
        a different question.
      */}
      <div className="fo-card__meta" data-testid="fo-sbir-eligibility">
        <Text type="secondary" style={{ fontSize: 11 }}>
          {eligibilityReason}
        </Text>
      </div>

      {actions.length > 0 && onAction ? (
        <div className="fo-card__actions" data-testid="fo-sbir-actions">
          <Space size={6} wrap>
            {actions.map((action) => (
              <Button key={action} size="small" onClick={() => onAction(action)}>
                {SBIR_ACTION_LABELS[action]}
              </Button>
            ))}
            {facts.topicUrl ? (
              <Button size="small" type="link" href={facts.topicUrl} target="_blank" rel="noreferrer">
                Topic on the source
              </Button>
            ) : null}
            {facts.officialSolicitationUrl ? (
              <Button
                size="small"
                type="link"
                href={facts.officialSolicitationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Official solicitation
              </Button>
            ) : null}
          </Space>
        </div>
      ) : null}
    </Card>
  );
}
