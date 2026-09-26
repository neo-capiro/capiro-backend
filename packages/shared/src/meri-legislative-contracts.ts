/**
 * Advisory descriptions for a narrow legislative read slice. These are not
 * authorization rules and deliberately do not claim fields absent from the
 * backing payloads.
 */
export interface MeriLegislativeReadContract {
  readonly purpose: string;
  readonly exclusions: readonly string[];
  readonly requiredInputs: readonly string[];
  readonly supportedScope: readonly string[];
  readonly evidenceAuthority: string;
  readonly dependencies: readonly string[];
  readonly effectClass: 'read_only';
  readonly availability: string;
  readonly pagination: string;
  readonly freshness: string;
  readonly partialAndUnavailable: string;
}

export const MERI_LEGISLATIVE_READ_CONTRACTS = {
  resolve_entity: {
    purpose:
      'Resolve a federal or state bill, committee, member, or legislator to a canonical Capiro identity before an ambiguous exact read.',
    exclusions: [
      'Does not establish current bill status, vote outcome, committee membership, or authorization to act for an entity.',
      'A generatedAt timestamp is not a source freshness timestamp.',
    ],
    requiredInputs: ['query'],
    supportedScope: [
      'Federal identities are selected with type/jurisdiction/congress context where required.',
      'State bill and legislator identities may require state and sessionKey; state is not inferred from a reused bill designation.',
      'No client scope is accepted or implied.',
    ],
    evidenceAuthority:
      'Canonical Capiro registry rows; matches may include sourceRef namespace, record id, URL, source dates and crosswalk provenance when available.',
    dependencies: [],
    effectClass: 'read_only',
    availability:
      'Registered native Meri full_chat read schema; callable-schema/surface gating remains authoritative and does not prove source availability or caller authorization.',
    pagination:
      'limit is clamped to 1–10 (default 5); no continuation cursor is returned. Ambiguous results must not be treated as exhaustive.',
    freshness:
      'The result includes generatedAt; sourceRef date fields can be null or absent. Do not interpret generatedAt as source freshness.',
    partialAndUnavailable:
      'Observed resolution values include resolved, ambiguous, not_found, needs_context and invalid_context. There is no declared uniform unavailable/partial envelope.',
  },
  get_bill_status: {
    purpose:
      'Read one federal bill record and its stored status, recent actions, roll-call votes and governing-rule outcomes.',
    exclusions: [
      'Does not resolve an unqualified bill designation by assuming the current Congress.',
      'Does not guarantee live Congress.gov retrieval or source freshness.',
      'No client scope is accepted or implied.',
    ],
    requiredInputs: ['billId'],
    supportedScope: [
      'Federal Congress bill identity; provide a canonical bill id or an explicit Congress when designation is ambiguous.',
    ],
    evidenceAuthority:
      'Capiro local Congress bill/action/roll-call-vote/rule-link records. Returned status and timeline fields are stored values, not a live-source confirmation.',
    dependencies: [
      'If bill identity is ambiguous, resolve_entity with type=bill and federal/congress context; then pass the returned canonical id.',
    ],
    effectClass: 'read_only',
    availability:
      'Registered native Meri full_chat read schema; callable-schema/surface gating remains authoritative and does not prove source availability or caller authorization.',
    pagination:
      'The handler returns at most 15 recent actions and 15 recent votes plus governing-rule links; no continuation cursor is returned.',
    freshness:
      'Returns generatedAt and statusAt/latestActionDate where present. These are distinct fields; generatedAt is not source freshness.',
    partialAndUnavailable:
      'Unresolvable input and not-found records return found=false with a note. The payload has no uniform partial/unavailable state.',
  },
  search_floor_votes: {
    purpose:
      'Search stored federal House and Senate roll-call votes by bill, Congress, chamber, title/question or member.',
    exclusions: [
      'Does not infer a vote outcome or treat no matching rows as proof that no vote occurred outside the stored records.',
      'A member-name ambiguity or failed member lookup does not produce member-scoped results.',
      'No client scope is accepted or implied.',
    ],
    requiredInputs: [],
    supportedScope: [
      'Federal roll-call vote records; optional billId, congress, chamber, query and member filters.',
    ],
    evidenceAuthority:
      'Capiro local roll-call-vote records; returned vote rows may carry sourceUrl and voteDate.',
    dependencies: [
      'For an ambiguous bill designation, resolve_entity with type=bill and federal/congress context first; do not issue an unscoped vote search.',
    ],
    effectClass: 'read_only',
    availability:
      'Registered native Meri full_chat read schema; callable-schema/surface gating remains authoritative and does not prove source availability or caller authorization.',
    pagination:
      'limit is clamped to 1–25 (default 10); no page or continuation cursor is returned.',
    freshness:
      'Returns generatedAt; voteDate/sourceUrl on rows are not a uniform freshness guarantee.',
    partialAndUnavailable:
      'An unresolved supplied bill returns resolution=needs_context and zero votes. No matching result is not evidence of absence outside the indexed records; there is no uniform partial/unavailable envelope.',
  },
  get_committee_roster: {
    purpose: 'Read one federal or state committee roster in an explicitly selected jurisdiction.',
    exclusions: [
      'Does not infer jurisdiction or state from a committee name.',
      'Federal roster member state is not a congressional district; no member–district relationship is established.',
      'No client scope is accepted or implied.',
    ],
    requiredInputs: ['committee', 'jurisdiction'],
    supportedScope: [
      'jurisdiction is federal or state; state is required for state committees; optional chamber filters remain jurisdiction-specific.',
    ],
    evidenceAuthority:
      'Capiro local committee and membership records. Federal lookup restricts committee candidates to isCurrent=true; state lookup is scoped by the supplied state.',
    dependencies: [
      'For an ambiguous entity name, resolve_entity with type=committee plus jurisdiction (and state when relevant); roster lookup independently enforces jurisdiction and may report unmatched ambiguity.',
    ],
    effectClass: 'read_only',
    availability:
      'Registered native Meri full_chat read schema; callable-schema/surface gating remains authoritative and does not prove source availability or caller authorization.',
    pagination:
      'Returns the matched roster without a page/continuation cursor; no roster completeness or count field is declared.',
    freshness: 'Returns generatedAt but no uniform source freshness/version field.',
    partialAndUnavailable:
      'Missing required context and unmatched committees return empty members with explanatory notes. The payload has no uniform partial/unavailable envelope.',
  },
} as const satisfies Readonly<Record<string, MeriLegislativeReadContract>>;
