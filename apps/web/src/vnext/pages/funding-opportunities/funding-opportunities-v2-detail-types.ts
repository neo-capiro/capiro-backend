import type { OpportunityDecision, OpportunityWorkflow } from './funding-opportunities-domain.js';
import type {
  FundingOpportunityV2DateFact,
  FundingOpportunityV2DetailRecord,
  FundingOpportunityV2Destination,
  FundingOpportunityV2SourceReference,
  OpportunitySearchRecordV2,
  OpportunitySourceV2,
  OpportunitySourceFreshnessV2,
} from '@capiro/shared';

export type FundingOpportunityV2DetailSource = OpportunitySourceV2;
export type FundingOpportunityV2DetailMode = 'matched' | 'all';
export type FundingOpportunityV2SectionTone =
  | 'plain'
  | 'brand'
  | 'success'
  | 'warning'
  | 'error'
  | 'muted';
export type FundingOpportunityV2DeadlineTone = 'plain' | 'warning' | 'error' | 'success';
export interface FundingOpportunityV2Fact {
  label: string;
  value: string;
  tone?: FundingOpportunityV2SectionTone;
  mono?: boolean;
}
export interface FundingOpportunityV2Bullet {
  label?: string;
  text: string;
  badge?: string;
  quote?: string;
  destinationKind?: string;
  tone?: FundingOpportunityV2SectionTone;
}
export interface FundingOpportunityV2Section {
  id: string;
  title: string;
  lead?: string;
  facts?: FundingOpportunityV2Fact[];
  bullets?: FundingOpportunityV2Bullet[];
  chips?: string[];
  footnote?: string;
  badge?: string;
  badgeTone?: FundingOpportunityV2SectionTone;
  tone?: FundingOpportunityV2SectionTone;
  initiallyOpen?: boolean;
}
export interface FundingOpportunityV2DeadlinePresentation {
  tone: FundingOpportunityV2DeadlineTone;
  label: string;
  value: string;
  compactValue?: string;
  sourceCalendarYear?: number | null;
  sourceTimeLabel?: string | null;
  daysRemaining: number | null;
  note: string;
  /** The source-declared offset when the source supplied one; never browser-local. */
  sourceTimezone: string | null;
  precision?: FundingOpportunityV2DateFact['precision'];
  sourceRaw?: string | null;
}
export interface FundingOpportunityV2ExternalDestination {
  kind: string;
  label?: string;
  url: string | null;
  note: string;
}
export interface FundingOpportunityV2SimilarRow {
  id: string;
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  title: string;
  detail: string;
  url?: string | null;
  type?: import('@capiro/shared').OpportunityTypeV2 | null;
  deadline?: string | null;
}
export interface FundingOpportunityV2DetailActions {
  canSave: boolean;
  canPursue: boolean;
  pursueNote: string | null;
  source: FundingOpportunityV2ExternalDestination | null;
}
export interface FundingOpportunityV2DetailModel {
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  title: string;
  meta: string;
  scopeChip: string;
  tags: Array<{ label: string; tone?: FundingOpportunityV2SectionTone }>;
  stamp: string;
  sections: FundingOpportunityV2Section[];
  deadline: FundingOpportunityV2DeadlinePresentation | null;
  match: {
    score: number | null;
    reason: string;
    signals: Array<{ label: string; value: string; strength: string }>;
  } | null;
  responsePath: FundingOpportunityV2Fact[];
  provenance: FundingOpportunityV2Fact[];
  similar: FundingOpportunityV2SimilarRow[];
  destinations: FundingOpportunityV2ExternalDestination[];
  contacts: Array<{
    key: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    description: string | null;
  }>;
  actions: FundingOpportunityV2DetailActions;
  sourceRecord: FundingOpportunityV2Fact[];
  raw: FundingOpportunityV2DetailInput;
}

export interface FundingOpportunityV2DetailInput {
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  sourceUrl: string | null;
  sourceReference?: string | null;
  type: string | null;
  lifecycle: 'active' | 'forecast' | 'closed' | 'post_award';
  summary: string | null;
  postedDate: string | null;
  deadline: string | null;
  deadlineNote?: string | null;
  closeOrArchiveDate: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedRaw?: string | null;
  /** Canonical catalog-health state when supplied by the owning source-health read. */
  sourceFreshnessState?:
    | 'current'
    | 'degraded'
    | 'stale'
    | 'never_synced'
    | 'initial_partial'
    | 'error_cached'
    | 'unavailable'
    | 'not_enabled'
    | 'unknown'
    | null;
  ingestedAt: string | null;
  isPursuable: boolean;
  eligibility: { state: string; reason: string } | null;
  matchedSignals: Array<{
    signal: string;
    strength: 'strong' | 'moderate' | 'weak';
    matchedOn: string;
    weight?: number;
  }>;
  relevanceScore: number | null;
  mode: FundingOpportunityV2DetailMode;
  clientId: string | null;
  clientName?: string | null;
  naicsCodes: string[];
  pscCodes: string[];
  classification?: FundingOpportunityV2Fact[];
  setAside: string | null;
  applicantTypes: string[];
  eligibilitySourceText?: string | null;
  eligibilityClientReason?: string | null;
  geography: string[];
  value: (FundingOpportunityV2Fact & { sourceBacked?: boolean }) | null;
  economics?: FundingOpportunityV2Fact[] | null;
  scope: string[];
  evaluation?: FundingOpportunityV2Fact[] | null;
  responsePath: (FundingOpportunityV2Fact & { detail?: string }) | null;
  responseInstructions?: string[];
  documents?: string[];
  activity?: FundingOpportunityV2Bullet[];
  activityCoverage?: string | null;
  changeNotes?: FundingOpportunityV2Bullet[];
  provenance: FundingOpportunityV2Fact[];
  similar: FundingOpportunityV2SimilarRow[];
  workflowStatus?: string | null;
  workflowStage?: string | null;
  bookmarkSaved?: boolean;
  humanDecision?: string | null;
  workflow?: OpportunityWorkflow | null;
  decision?: OpportunityDecision | null;
  actionNote?: string | null;
  clientCapability?: {
    state: 'eligible' | 'ineligible' | 'needs_review' | 'unknown';
    allowed: boolean;
    reason: string;
  } | null;
  actionCapability?: { allowed: boolean; reason: string } | null;
  recordType?: string | null;
  displayReference?: { label: string; value: string; sourceField: string } | null;
  sourceReferenceDetail?: FundingOpportunityV2SourceReference | null;
  sourceFacts?: Record<string, unknown>;
  scopeContent?: Array<{
    label: string;
    statement: string;
    kind: string;
    sourceExcerpt?: string | null;
    sourceDocument?: string | null;
    sourcePage?: number | null;
    reviewStatus?: string | null;
    supersededAt?: string | null;
  }>;
  responseInstructionDetails?: Array<{
    label: string;
    statement: string;
    kind: string;
    sourceExcerpt?: string | null;
    sourceDocument?: string | null;
    sourcePage?: number | null;
    reviewStatus?: string | null;
    supersededAt?: string | null;
  }>;
  dateFacts?: {
    posted: FundingOpportunityV2DateFact;
    responseDeadline: FundingOpportunityV2DateFact;
    closeOrArchive: FundingOpportunityV2DateFact;
    forecast: {
      anticipatedAwardDate: FundingOpportunityV2DateFact;
      estimatedPeriod: string | null;
      unavailableReason: string | null;
    };
  } | null;
  destinations?: FundingOpportunityV2Destination[];
  contacts?: Array<{
    key: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    description: string | null;
  }>;
  similarUnavailableReason?: string | null;
  forecastDate?: string | null;
}

export type FundingOpportunityV2WorkflowAction = 'save' | 'pursue' | 'not_fit';
export type FundingOpportunityV2ExternalAudit = (event: {
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  clientId: string | null;
  destinationKind: string;
}) => Promise<{ authoritativeUrl: string }>;
export type FundingOpportunityV2Action = (event: {
  action: FundingOpportunityV2WorkflowAction;
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  clientId: string | null;
}) => void | Promise<void>;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  sourceTimezone: string | null;
}

function parseCalendarDate(value: string): CalendarDate | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (match[4] == null) return { year, month, day, sourceTimezone: null };
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] == null ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = match[7] ?? null;
  if (offset !== 'Z') {
    const offsetMatch = offset ? /^[+-](\d{2}):?(\d{2})$/.exec(offset) : null;
    if (!offsetMatch || Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) return null;
  }
  return { year, month, day, sourceTimezone: offset };
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function calendarDayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function calendarDateForNow(now: Date, sourceTimezone: string | null): CalendarDate {
  let adjusted = now;
  if (sourceTimezone && sourceTimezone !== 'Z') {
    const namedOffsets: Record<string, number> = {
      EST: -300,
      EDT: -240,
      CST: -360,
      CDT: -300,
      MST: -420,
      MDT: -360,
      PST: -480,
      PDT: -420,
      UTC: 0,
    };
    const namedMinutes = namedOffsets[sourceTimezone.toUpperCase()];
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(sourceTimezone);
    const minutes =
      namedMinutes ??
      (match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1) : null);
    if (minutes != null) adjusted = new Date(now.getTime() + minutes * 60_000);
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).formatToParts(adjusted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    sourceTimezone: sourceTimezone ?? null,
  };
}
export type FundingOpportunityV2SourceTone = 'purple' | 'cyan' | 'indigo' | 'warning';
export interface FundingOpportunityV2SourcePresentation {
  label: string;
  tone: FundingOpportunityV2SourceTone;
}
export const FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION: Record<
  FundingOpportunityV2DetailSource,
  FundingOpportunityV2SourcePresentation
> = {
  grants_gov: { label: 'Grants.gov', tone: 'purple' },
  sam_gov: { label: 'SAM.gov', tone: 'cyan' },
  agency_forecast: { label: 'Agency forecast', tone: 'warning' },
  dibbs: { label: 'DLA bid board', tone: 'cyan' },
  sbir_sttr: { label: 'SBIR / STTR', tone: 'indigo' },
  ca_portal: { label: 'California Grants Portal', tone: 'indigo' },
};
function sourceName(source: FundingOpportunityV2DetailSource): string {
  return FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[source]?.label ?? source;
}
function dateText(value: string | null): string {
  if (!value) return 'Not provided by source';
  const date = parseCalendarDate(value);
  return date ? formatCalendarDate(date.year, date.month, date.day) : value;
}
function nonEmpty(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}
function facts(
  ...groups: Array<FundingOpportunityV2Fact[] | null | undefined>
): FundingOpportunityV2Fact[] {
  return groups.flatMap((group) => group ?? []).filter((fact) => nonEmpty(fact.value));
}
export interface FundingOpportunityV2MatchSignalPresentation {
  label: string;
  value: string;
  strength: 'strong' | 'moderate' | 'weak';
}

const MATCH_SIGNAL_LABELS: Record<string, string> = {
  naicsExact: 'NAICS match',
  pscExact: 'PSC match',
  agency: 'Agency history',
  capabilityKeyword: 'Capability match',
  capabilityKeywordModerate: 'Capability match',
  genericTopicalWeak: 'Topical overlap',
  genericTopical: 'Topical overlap',
  sector: 'Sector alignment',
  eligibility: 'Eligibility',
};

export function fundingOpportunityMatchSignalLabel(signal: string): string {
  return (
    MATCH_SIGNAL_LABELS[signal] ?? signal.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
  );
}

export interface FundingOpportunityV2StatusTag {
  label: string;
  tone: FundingOpportunityV2SectionTone;
}

export function getFundingOpportunityV2StatusTags(input: {
  mode: FundingOpportunityV2DetailMode;
  lifecycle: FundingOpportunityV2DetailInput['lifecycle'];
  matchBand: 'strong' | 'moderate' | 'weak' | null;
  eligibilityState: string | null;
  workflowStatus?: string | null;
  workflowStage?: string | null;
  bookmarkSaved?: boolean;
  humanDecision?: string | null;
}): FundingOpportunityV2StatusTag[] {
  const tags: FundingOpportunityV2StatusTag[] = [];
  const workflow = (input.workflowStatus ?? input.workflowStage ?? '').toLowerCase();
  const decision = (input.humanDecision ?? '').toLowerCase();
  const tracked = Boolean(input.bookmarkSaved || workflow || decision);
  if (input.bookmarkSaved) tags.push({ label: 'Saved', tone: 'brand' });
  if (
    workflow === 'pursuing' ||
    workflow === 'in_progress' ||
    decision === 'pursuing' ||
    decision === 'pursue'
  )
    tags.push({ label: 'Pursued', tone: 'brand' });
  if (input.eligibilityState === 'ineligible')
    tags.push({ label: 'Eligibility gap', tone: 'error' });
  else if (input.eligibilityState === 'unknown' || input.eligibilityState === 'needs_review')
    tags.push({ label: 'Partial data', tone: 'warning' });
  else if (
    input.mode === 'matched' &&
    input.lifecycle === 'active' &&
    input.matchBand === 'strong' &&
    input.eligibilityState === 'eligible' &&
    !tracked
  )
    tags.push({ label: 'Recommended', tone: 'brand' });
  return tags;
}

export function getFundingOpportunityMatchPresentation(
  signals: ReadonlyArray<{
    signal: string;
    strength: 'strong' | 'moderate' | 'weak';
    matchedOn: string;
  }>,
): {
  band: 'strong' | 'moderate' | 'weak' | null;
  label: string | null;
  reason: string;
  signals: FundingOpportunityV2MatchSignalPresentation[];
} {
  const presented = signals.map((signal) => ({
    label: fundingOpportunityMatchSignalLabel(signal.signal),
    value: signal.matchedOn,
    strength: signal.strength,
  }));
  const hasStrong = signals.some(
    (signal) => signal.strength === 'strong' && signal.signal !== 'genericTopical',
  );
  const hasModerate = signals.some((signal) => signal.strength === 'moderate');
  const band = hasStrong ? 'strong' : hasModerate ? 'moderate' : signals.length ? 'weak' : null;
  const label =
    band === 'strong'
      ? 'Strong fit'
      : band === 'moderate'
        ? 'Potential fit'
        : band === 'weak'
          ? 'Weak signal'
          : null;
  const strongest = presented.filter((signal) => signal.strength !== 'weak').slice(0, 2);
  const evidence = strongest.length ? strongest : presented.slice(0, 1);
  const reason =
    evidence.length === 0
      ? 'No match evidence was returned for this client.'
      : evidence.length === 1
        ? `${evidence[0]!.label} supports this match.`
        : `${evidence[0]!.label} and ${evidence[1]!.label} support this match.`;
  return { band, label, reason, signals: presented };
}
function sourceRecordFacts(input: FundingOpportunityV2DetailInput): FundingOpportunityV2Fact[] {
  return facts([
    { label: 'Source', value: sourceName(input.source) },
    { label: 'Source record id', value: input.sourceRecordId, mono: true },
    { label: 'Source reference', value: input.sourceReference ?? '' },
    { label: 'Notice type', value: input.type ?? '' },
    {
      label: 'Status',
      value:
        input.lifecycle === 'closed'
          ? 'Closed'
          : input.lifecycle === 'forecast'
            ? 'Forecast'
            : input.lifecycle === 'post_award'
              ? 'Post-award'
              : 'Active',
    },
    { label: 'Source URL', value: input.sourceUrl ?? '' },
  ]);
}

function evidenceLabel(kind: string): string {
  const labels: Record<string, string> = {
    source_description: 'Source description',
    submission: 'Submission requirement',
    question_deadline: 'Questions deadline',
    key_date: 'Key date',
    response_guidance: 'Response guidance',
    notice_history: 'Notice history',
  };
  return labels[kind] ?? kind.replaceAll('_', ' ').replace(/\w/g, (letter) => letter.toUpperCase());
}
function evidenceBadge(item: {
  kind: string;
  reviewStatus?: string | null;
  supersededAt?: string | null;
}): string | undefined {
  if (item.supersededAt) return 'Superseded';
  if (item.reviewStatus && item.reviewStatus !== 'accepted')
    return item.reviewStatus === 'pending' ? 'Pending review' : 'Rejected';
  const semanticLabels: Record<string, string> = {
    submission: 'Response',
    response_guidance: 'Response',
    question_deadline: 'Deadline',
    key_date: 'Deadline',
    prerequisite: 'Prerequisite',
    source_requirement: 'Prerequisite',
  };
  return semanticLabels[item.kind];
}
function destinationGuidance(kind: string | undefined): string {
  if (kind?.startsWith('application:'))
    return 'Use the linked application destination to submit a response. Capiro does not submit responses.';
  if (kind === 'source_page')
    return 'The destination is the authoritative source record. Capiro does not record a submission.';
  return kind ? 'Follow the linked source destination for response instructions.' : '';
}
function catalogState(lifecycle: FundingOpportunityV2DetailInput['lifecycle']): string {
  switch (lifecycle) {
    case 'active':
      return 'Active';
    case 'forecast':
      return 'Forecast — early signal';
    case 'closed':
      return 'Closed — retained for history';
    case 'post_award':
      return 'Post-award — retained for history';
    default:
      return 'Catalog state unavailable';
  }
}
function freshnessLabel(state: FundingOpportunityV2DetailInput['sourceFreshnessState']): string {
  switch (state) {
    case 'current':
      return 'Current';
    case 'degraded':
      return 'Degraded';
    case 'stale':
      return 'Stale';
    case 'never_synced':
      return 'Never synced';
    case 'initial_partial':
      return 'Initial sync — partial';
    case 'error_cached':
      return 'Error — cached record';
    case 'unavailable':
      return 'Unavailable';
    case 'not_enabled':
      return 'Not enabled';
    case 'unknown':
    case null:
    case undefined:
    default:
      return 'Unavailable — source health was not provided';
  }
}

export function getFundingOpportunityDeadlinePresentation({
  deadline,
  lifecycle,
  workflowStatus,
  workflowStage,
  dateFact,
  source,
  dateKind = 'response',
  now = new Date(),
}: {
  deadline: string | null;
  lifecycle: FundingOpportunityV2DetailInput['lifecycle'];
  workflowStatus?: string | null;
  workflowStage?: string | null;
  dateFact?: FundingOpportunityV2DateFact | null;
  source?: FundingOpportunityV2DetailSource;
  dateKind?: 'response' | 'forecast';
  now?: Date;
}): FundingOpportunityV2DeadlinePresentation {
  const status = workflowStatus?.toLowerCase() ?? null;
  const stage = workflowStage?.toLowerCase() ?? null;
  const won = status === 'won' || stage === 'won';
  const lost = status === 'lost' || stage === 'lost';
  const sourceValue = dateFact?.value ?? deadline;
  const date = sourceValue ? parseCalendarDate(sourceValue) : null;
  const rawOnly =
    !date && nonEmpty(dateFact?.sourceRaw)
      ? dateFact!.sourceRaw
      : !date && dateKind === 'forecast' && nonEmpty(sourceValue)
        ? sourceValue
        : null;
  const effectiveTimezone = dateFact?.timezone ?? date?.sourceTimezone ?? null;
  const sourceCalendar =
    date && sourceValue ? calendarDateForNow(new Date(sourceValue), effectiveTimezone) : null;
  const today = calendarDateForNow(now, effectiveTimezone);
  const terminal =
    won ||
    lost ||
    status === 'passed' ||
    stage === 'passed' ||
    stage === 'dismissed' ||
    lifecycle === 'closed';
  const daysRemaining =
    date && !terminal && dateKind !== 'forecast'
      ? calendarDayNumber(
          sourceCalendar?.year ?? date.year,
          sourceCalendar?.month ?? date.month,
          sourceCalendar?.day ?? date.day,
        ) - calendarDayNumber(today.year, today.month, today.day)
      : null;
  const tone: FundingOpportunityV2DeadlineTone = won
    ? 'success'
    : terminal
      ? 'error'
      : dateKind === 'forecast'
        ? 'plain'
        : daysRemaining != null && daysRemaining <= 30
          ? 'warning'
          : 'plain';
  const label = won
    ? 'WON'
    : status === 'passed' || stage === 'passed' || stage === 'dismissed'
      ? 'PASSED'
      : lost || lifecycle === 'closed'
        ? 'CLOSED'
        : dateKind === 'forecast'
          ? 'AWARD EXPECTED'
          : source === 'grants_gov' || source === 'ca_portal'
            ? 'APPLICATION DEADLINE'
            : source === 'dibbs'
              ? 'QUOTE DEADLINE'
              : 'RESPONSE DEADLINE';
  const value = date
    ? formatCalendarDate(date.year, date.month, date.day)
    : (rawOnly ?? 'Not provided by source');
  const displayCalendar = sourceCalendar ?? date;
  const compactValue = displayCalendar
    ? `${formatCalendarDate(displayCalendar.year, displayCalendar.month, displayCalendar.day).replace(/, \d{4}$/, '')}`
    : value;
  const sourceCalendarYear = displayCalendar?.year ?? null;
  const sourceTimeLabel =
    dateFact?.precision === 'date'
      ? null
      : (dateFact?.sourceRaw
          ?.match(/(?:T|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([A-Z]{2,5}|[+-]\d{2}:?\d{2}))?$/)
          ?.slice(1)
          .filter(Boolean)
          .join(' ') ?? (rawOnly ? null : (dateFact?.sourceRaw ?? null)));
  const note = won
    ? 'This opportunity is marked Won.'
    : terminal
      ? 'This record is terminal; the historical source date remains available.'
      : dateKind === 'forecast'
        ? rawOnly
          ? 'Forecast timing is an early source estimate; no response deadline exists.'
          : date
            ? 'Forecast timing is an anticipated award estimate; no response deadline exists.'
            : 'The source did not state anticipated award timing.'
        : date
          ? `${daysRemaining! < 0 ? 'Deadline passed' : daysRemaining === 0 ? 'Due today' : `${daysRemaining} days remaining`} · source-backed date`
          : rawOnly
            ? 'The source supplied a response deadline without a calendar date.'
            : 'The source did not state a response deadline.';
  return {
    tone,
    label,
    value,
    compactValue,
    sourceCalendarYear,
    sourceTimeLabel,
    daysRemaining,
    note,
    sourceTimezone: effectiveTimezone,
    precision: dateFact?.precision ?? (date ? 'date' : null),
    sourceRaw: dateFact?.sourceRaw ?? null,
  };
}

export function buildFundingOpportunityV2DetailModel(
  input: FundingOpportunityV2DetailInput,
): FundingOpportunityV2DetailModel {
  const deadlineValue =
    input.lifecycle === 'forecast'
      ? (input.forecastDate ?? input.dateFacts?.forecast.estimatedPeriod ?? input.deadline)
      : input.deadline;
  const deadlineDateFact =
    input.lifecycle === 'forecast'
      ? input.dateFacts?.forecast.anticipatedAwardDate
      : input.dateFacts?.responseDeadline;
  const deadline = deadlineValue
    ? getFundingOpportunityDeadlinePresentation({
        deadline: deadlineValue,
        dateFact: deadlineDateFact,
        source: input.source,
        dateKind: input.lifecycle === 'forecast' ? 'forecast' : 'response',
        workflowStage: input.workflowStage,
        lifecycle: input.lifecycle,
        workflowStatus: input.workflowStatus,
      })
    : null;
  const matching = input.mode === 'matched' && input.clientId != null;
  const matchPresentation = getFundingOpportunityMatchPresentation(input.matchedSignals);
  const statusTags = getFundingOpportunityV2StatusTags({
    mode: input.mode,
    lifecycle: input.lifecycle,
    matchBand: matchPresentation.band,
    eligibilityState: input.eligibility?.state ?? input.clientCapability?.state ?? null,
    workflowStatus: input.workflowStatus,
    workflowStage: input.workflowStage,
    bookmarkSaved: input.bookmarkSaved,
    humanDecision: input.humanDecision ?? input.decision?.decision ?? null,
  });
  const match = matching
    ? {
        score: input.relevanceScore,
        reason: matchPresentation.reason,
        signals: matchPresentation.signals,
      }
    : null;
  const sections: FundingOpportunityV2Section[] = [];
  if (nonEmpty(input.summary))
    sections.push({
      id: 'summary',
      title: 'Summary and purpose',
      lead: input.summary,
      chips: [
        ...(input.classification ?? [])
          .filter((item) => !['agency', 'program area'].includes(item.label.toLowerCase()))
          .map((item) => `${item.label} ${item.value}`),
        ...input.naicsCodes.map((code) => `NAICS ${code}`),
        ...input.pscCodes.map((code) => `PSC ${code}`),
      ].filter(nonEmpty),
      initiallyOpen: true,
      tone: 'muted',
    });
  if (input.scope.some(nonEmpty) || input.scopeContent?.length)
    sections.push({
      id: 'scope',
      title: 'Scope of work',
      bullets: input.scopeContent?.length
        ? input.scopeContent.map((item) => ({
            label: item.label === item.kind ? evidenceLabel(item.kind) : item.label,
            text: item.statement,
            badge: evidenceBadge(item),
            quote: item.sourceExcerpt ?? undefined,
            tone: 'plain' as const,
          }))
        : input.scope.filter(nonEmpty).map((text) => ({ text, tone: 'plain' as const })),
      initiallyOpen: true,
    });
  const eligibilityFacts = facts(
    input.eligibility
      ? [
          {
            label: ['grants_gov', 'ca_portal', 'sbir_sttr'].includes(input.source)
              ? 'Eligible applicant'
              : 'Eligibility',
            value:
              input.eligibilitySourceText ?? input.eligibility.reason ?? input.eligibility.state,
          },
        ]
      : null,
    input.setAside ? [{ label: 'Set-aside', value: input.setAside }] : null,
    input.applicantTypes.length
      ? [{ label: 'Eligible applicant', value: input.applicantTypes.join(', ') }]
      : null,
  );
  const eligibilityCaveat = [
    input.eligibilityClientReason &&
    input.eligibilityClientReason !== (input.eligibilitySourceText ?? input.eligibility?.reason)
      ? `Client eligibility context: ${input.eligibilityClientReason}`
      : null,
    'Eligibility and relevance answer different questions and are never merged. This record can be relevant and still be unresponsive for this client.',
  ]
    .filter(nonEmpty)
    .join(' ');
  if (eligibilityFacts.length)
    sections.push({
      id: 'eligibility',
      title: 'Eligibility and requirements',
      facts: eligibilityFacts,
      tone: input.eligibility?.state === 'ineligible' ? 'error' : undefined,
      footnote: eligibilityCaveat,
      initiallyOpen: true,
    });
  if (input.geography.some(nonEmpty))
    sections.push({
      id: 'geography',
      title: 'Geography and place of performance',
      facts: [
        { label: 'Place of performance', value: input.geography.filter(nonEmpty).join(', ') },
      ],
    });
  if (deadline)
    sections.push({
      id: 'dates',
      title: 'Important dates',
      facts: facts([
        {
          label: deadline.label,
          value: `${deadline.compactValue ?? deadline.value}${deadline.compactValue && deadline.sourceCalendarYear ? ` · ${deadline.sourceCalendarYear}` : ''}${deadline.sourceTimeLabel ? ` · ${deadline.sourceTimeLabel}` : ''}`,
          tone: deadline.tone,
        },
        { label: 'Posted', value: dateText(input.postedDate) },
        ...(input.closeOrArchiveDate &&
        (input.source !== 'sam_gov' || input.closeOrArchiveDate !== input.deadline)
          ? [{ label: 'Closes / archives', value: dateText(input.closeOrArchiveDate) }]
          : []),
        { label: 'Last updated', value: dateText(input.sourceUpdatedAt) },
      ]),
      footnote:
        'Every date carries its source timezone. A date the source never stated renders as not provided — never as a zero or substituted value.',
      initiallyOpen: true,
    });
  const sourceEconomics =
    input.source === 'dibbs'
      ? facts(
          input.sourceFacts?.quantity != null && input.sourceFacts?.unitOfIssue != null
            ? [
                {
                  label: 'Quantity',
                  value: `${input.sourceFacts.quantity} ${input.sourceFacts.unitOfIssue}`,
                },
              ]
            : null,
        )
      : input.sourceFacts && input.source === 'grants_gov'
        ? facts(
            input.sourceFacts.awardCeiling != null
              ? [{ label: 'Ceiling', value: String(input.sourceFacts.awardCeiling) }]
              : null,
            input.sourceFacts.awardFloor != null
              ? [{ label: 'Award floor', value: String(input.sourceFacts.awardFloor) }]
              : null,
            input.sourceFacts.costSharing != null
              ? [
                  {
                    label: 'Cost share',
                    value:
                      input.sourceFacts.costSharing === true
                        ? 'Required'
                        : input.sourceFacts.costSharing === false
                          ? 'Not required'
                          : String(input.sourceFacts.costSharing),
                  },
                ]
              : null,
          )
        : [];
  const economics = facts(input.value ? [input.value] : null, sourceEconomics, input.economics);
  if (economics.length)
    sections.push({
      id: 'economics',
      title: 'Funding and economics',
      facts: economics,
      footnote:
        'Unavailable figures read “not provided” with their provenance. Nothing here is inferred from a similar record.',
      initiallyOpen: true,
    });
  const classification = facts(
    input.classification,
    input.naicsCodes.length
      ? [{ label: 'NAICS', value: input.naicsCodes.join(', '), mono: true }]
      : null,
    input.pscCodes.length ? [{ label: 'PSC', value: input.pscCodes.join(', '), mono: true }] : null,
  );
  if (classification.length)
    sections.push({
      id: 'classification',
      title: 'Classification codes',
      facts: classification,
      chips: [...input.naicsCodes, ...input.pscCodes],
    });
  if (input.evaluation?.length)
    sections.push({ id: 'evaluation', title: 'Evaluation and award', facts: input.evaluation });
  if (input.responsePath || input.responseInstructions?.length)
    sections.push({
      id: 'response',
      title: 'How to respond',
      facts: undefined,
      bullets: input.responseInstructionDetails?.length
        ? input.responseInstructionDetails.map((item) => ({
            label: item.label === item.kind ? evidenceLabel(item.kind) : item.label,
            text: item.statement,
            badge: evidenceBadge(item),
            quote: item.sourceExcerpt ?? undefined,
            tone: 'plain' as const,
          }))
        : input.responseInstructions?.map((text) => ({ text, tone: 'plain' as const })),
      footnote: input.responsePath ? destinationGuidance(input.responsePath.detail) : undefined,
      initiallyOpen: true,
    });
  if (input.documents?.some(nonEmpty))
    sections.push({
      id: 'documents',
      title: 'Required documents and prerequisites',
      bullets: input.documents.filter(nonEmpty).map((text) => ({ text, tone: 'success' })),
    });
  if (match)
    sections.push({
      id: 'match',
      title: 'Client match explanation',
      badge: matchPresentation.label ?? undefined,
      badgeTone:
        matchPresentation.band === 'strong'
          ? 'success'
          : matchPresentation.band === 'moderate'
            ? 'brand'
            : 'muted',
      lead: match.reason,
      bullets: match.signals.map((signal) => ({
        label: signal.label,
        text: signal.value,
        badge: signal.strength,
        tone:
          signal.strength === 'strong'
            ? 'success'
            : signal.strength === 'moderate'
              ? 'brand'
              : 'muted',
      })),
      footnote: `Relevance ${match.score ?? 'not calculated'} of 100 for ${input.clientName ?? 'the selected client'}. Weak generic signals are not sufficient for a strong recommendation.`,
      initiallyOpen: true,
    });
  if (input.activity?.length || input.activityCoverage)
    sections.push({
      id: 'activity',
      title: 'Notice history',
      bullets: input.activity?.map((item) => ({
        label: item.label,
        text: item.text,
        badge: item.badge,
        quote: item.quote,
        tone: item.tone,
      })),
      footnote: input.activityCoverage ?? undefined,
    });
  sections.push({
    id: 'source',
    title: 'Source record and change notes',
    facts: facts(
      sourceRecordFacts(input),
      input.sourceUpdatedAt
        ? [{ label: 'Source updated', value: dateText(input.sourceUpdatedAt) }]
        : null,
      input.ingestedAt ? [{ label: 'Capiro ingested', value: dateText(input.ingestedAt) }] : null,
    ),
    bullets: input.changeNotes,
    footnote: 'Source update time is stored separately from Capiro ingestion time.',
    initiallyOpen: false,
  });
  const capability = input.clientCapability;
  const stage = input.workflowStage?.toLowerCase() ?? null;
  const terminal =
    input.lifecycle === 'closed' ||
    stage === 'won' ||
    stage === 'lost' ||
    stage === 'passed' ||
    stage === 'dismissed';
  const capabilityAllowed =
    input.actionCapability?.allowed ??
    (capability ? capability.allowed && capability.state !== 'ineligible' : input.isPursuable);
  const canPursue = Boolean(input.clientId) && input.isPursuable && !terminal && capabilityAllowed;
  const pursueNote = canPursue
    ? null
    : !input.clientId
      ? 'Select a client to evaluate pursuit.'
      : terminal
        ? `Pursue is unavailable because this opportunity is ${stage ?? input.lifecycle}.`
        : input.lifecycle === 'forecast'
          ? 'Pursue is hidden because a forecast has no response path.'
          : capability?.state === 'needs_review'
            ? `Pursue needs review: ${capability.reason}`
            : (capability?.reason ??
              (input.eligibility?.state === 'ineligible'
                ? 'Pursue is hidden because this client is not eligible to respond as lead applicant.'
                : 'Pursue is unavailable for this source record.'));
  const destinations =
    input.destinations?.map((item) => ({
      kind: item.kind,
      label: item.label,
      url: item.authoritativeUrl,
      note: 'This link leaves Capiro for the source system. Capiro does not record a submission.',
    })) ??
    (input.sourceUrl
      ? [
          {
            kind: 'source_page',
            label: `Open ${sourceName(input.source)} source`,
            url: input.sourceUrl,
            note: 'This link leaves Capiro for the source system. Capiro does not record a submission.',
          },
        ]
      : []);
  const sourceDestination =
    destinations.find((item) => item.kind === 'source_page') ?? destinations[0] ?? null;
  return {
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    title: input.title,
    meta: [input.agency, input.sourceReference].filter(nonEmpty).join(' · ') || 'Agency not stated',
    scopeChip: matching
      ? `Matched to ${input.clientName ?? 'selected client'}`
      : input.clientId
        ? `${input.clientName ?? 'Client'} · all opportunities`
        : 'All opportunities',
    tags: [
      {
        label: sourceName(input.source),
        tone: 'plain',
      },
      ...(input.lifecycle === 'forecast'
        ? []
        : [
            {
              label:
                input.type === 'grant'
                  ? 'Grant'
                  : input.type === 'cooperative_agreement'
                    ? 'Cooperative agreement'
                    : input.type === 'request_for_quote'
                      ? 'Contract · request for quote'
                      : input.type === 'solicitation'
                        ? 'Contract · solicitation'
                        : input.type === 'presolicitation'
                          ? 'Contract · pre-solicitation'
                          : input.type === 'sources_sought'
                            ? 'Contract · sources sought'
                            : input.type === 'award'
                              ? 'Award'
                              : (input.type ?? 'Opportunity'),
            },
          ]),
      {
        label:
          input.lifecycle === 'forecast'
            ? 'Forecast · early signal'
            : input.lifecycle === 'closed'
              ? 'Closed'
              : input.lifecycle === 'post_award'
                ? 'Post-award'
                : 'Open',
        tone:
          input.lifecycle === 'closed'
            ? 'error'
            : input.lifecycle === 'forecast'
              ? 'warning'
              : input.lifecycle === 'post_award'
                ? 'muted'
                : 'success',
      },
      ...statusTags,
    ],
    stamp: `Posted ${dateText(input.postedDate)} · last updated ${dateText(input.sourceUpdatedAt)}`,
    sections,
    deadline,
    match,
    responsePath: input.responsePath
      ? [{ label: input.responsePath.label, value: input.responsePath.value }]
      : [],
    provenance: facts(
      [{ label: 'Source', value: sourceName(input.source) }],
      [{ label: 'Source ID', value: input.sourceReference ?? 'Not provided by source' }],
      [
        {
          label: 'Freshness',
          value: freshnessLabel(input.sourceFreshnessState),
          tone: input.sourceFreshnessState === 'current' ? 'success' : undefined,
        },
      ],
      [{ label: 'Catalog state', value: catalogState(input.lifecycle) }],
    ),
    similar: input.similar,
    destinations,
    contacts: input.contacts ?? [],
    actions: { canSave: true, canPursue, pursueNote, source: sourceDestination },
    sourceRecord: sourceRecordFacts(input),
    raw: input,
  };
}

export function normalizeFundingOpportunityV2Detail(
  value: OpportunitySearchRecordV2 | FundingOpportunityV2DetailRecord,
  options: {
    mode?: FundingOpportunityV2DetailMode;
    clientName?: string | null;
    ingestedAt?: string | null;
    sourceFreshnessState?: OpportunitySourceFreshnessV2['state'] | null;
  } = {},
): FundingOpportunityV2DetailInput {
  const row = value as FundingOpportunityV2DetailRecord;
  const rich =
    'sourceReference' in row &&
    typeof row.sourceReference === 'object' &&
    row.sourceReference !== null;
  const detail = rich ? row : null;
  const source = row.source as FundingOpportunityV2DetailSource;
  const dateValue = (fact: FundingOpportunityV2DateFact | undefined): string | null =>
    fact?.value ?? fact?.sourceRaw ?? null;
  const dateTextValue = (fact: FundingOpportunityV2DateFact | undefined): string | null =>
    dateValue(fact);
  const detailDestination =
    detail?.destinations?.find((item) => item.kind === 'source_page')?.authoritativeUrl ?? null;
  const displayReference = detail?.displayReference?.value ?? null;
  const richScope = detail?.scope;
  const richEligibility = detail?.eligibilityDetail;
  const richDates = detail?.dates;
  const richValue =
    row.value != null
      ? {
          label: 'Value',
          value: row.value.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0,
          }),
          sourceBacked: row.valueBasis === 'source_backed',
        }
      : null;
  const evaluation = detail
    ? [
        detail.evaluation.criteria
          ? { label: 'Award basis', value: detail.evaluation.criteria }
          : null,
        detail.evaluation.awardCategory
          ? { label: 'Award category', value: detail.evaluation.awardCategory }
          : null,
        ...detail.evaluation.costShare.map((item) => ({ label: 'Cost share', value: item })),
        ...detail.evaluation.prerequisites.map((item) => ({ label: 'Prerequisite', value: item })),
      ].filter((item): item is FundingOpportunityV2Fact => item !== null)
    : null;
  const responseDestination =
    detail?.destinations?.find((item) => item.kind.startsWith('application:')) ??
    detail?.destinations?.find((item) => item.kind === 'source_page');
  const contacts = detail?.contacts ?? [];
  const responsePath =
    responseDestination &&
    (detail?.responseInstructions?.steps?.length ||
      responseDestination.kind.startsWith('application:'))
      ? {
          label: responseDestination.label,
          value: responseDestination.kind.startsWith('application:')
            ? 'Use the linked application destination to submit a response.'
            : 'Review the authoritative solicitation record for response instructions. Capiro does not submit responses.',
          detail: responseDestination.kind,
        }
      : null;
  const responseInstructions = detail?.responseInstructions?.steps ?? [];
  const sourceFacts = detail?.provenance.sourceFacts ?? row.sourceFacts ?? {};
  const sourceUpdated = detail?.sourceReference.sourceUpdatedAt ?? null;
  const sourceUpdatedRaw = detail?.sourceReference.sourceUpdatedRaw ?? null;
  const changeNotes =
    detail?.changeNotes?.map((item) => ({
      text: item.text,
      label: item.key,
      badge: item.occurredAt ?? undefined,
      tone: 'brand' as FundingOpportunityV2SectionTone,
    })) ?? [];
  const activity = detail?.activity?.length
    ? detail.activity.map((item) => ({
        label: item.kind === 'notice_history' ? 'Notice history' : item.kind,
        text: item.statement,
        badge: item.reviewStatus ?? undefined,
        quote: item.sourceExcerpt ?? undefined,
        tone: 'brand' as FundingOpportunityV2SectionTone,
      }))
    : detail?.activityCoverage
      ? [
          {
            label: 'Notice history',
            text: detail.activityCoverage,
            tone: 'muted' as FundingOpportunityV2SectionTone,
          },
        ]
      : detail?.decoration?.workflow?.status
        ? [
            {
              label: 'Workflow',
              text: `Current workflow status: ${detail.decoration.workflow.status}`,
              tone: 'brand' as FundingOpportunityV2SectionTone,
            },
          ]
        : [];
  const sourceRecordId = row.sourceRecordId;
  return {
    source,
    sourceRecordId,
    title: row.title,
    agency: row.agency ?? null,
    sourceUrl: detailDestination ?? row.sourceUrl ?? null,
    sourceReference: displayReference ?? detail?.sourceReference.providerRecordId ?? null,
    type: row.type ?? null,
    recordType: detail?.sourceReference.recordType ?? null,
    displayReference: detail?.displayReference ?? null,
    sourceReferenceDetail: detail?.sourceReference ?? null,
    sourceFacts,
    lifecycle: row.lifecycle,
    summary: row.summary ?? null,
    postedDate: dateTextValue(richDates?.posted) ?? row.postedDate ?? null,
    deadline: dateTextValue(richDates?.responseDeadline) ?? row.deadline ?? null,
    deadlineNote: richDates?.responseDeadline.sourceRaw ?? null,
    closeOrArchiveDate: dateTextValue(richDates?.closeOrArchive) ?? row.closeOrArchiveDate ?? null,
    sourceUpdatedAt: sourceUpdated ?? null,
    ingestedAt: options.ingestedAt ?? detail?.sourceReference.ingestedAt ?? null,
    sourceUpdatedRaw,
    sourceFreshnessState: options.sourceFreshnessState ?? null,
    isPursuable: row.isPursuable,
    clientCapability: row.clientCapability ?? null,
    eligibility: row.eligibility ?? null,
    matchedSignals: row.matchedSignals ?? [],
    relevanceScore: row.relevanceScore ?? null,
    mode: options.mode ?? (row.clientId ? 'matched' : 'all'),
    clientId: row.clientId ?? null,
    clientName: options.clientName,
    naicsCodes: richScope?.naicsCodes ?? row.naicsCodes ?? [],
    pscCodes: richScope?.pscCodes ?? row.pscCodes ?? [],
    classification: [
      ...(richScope?.sectors ?? []).map((item) => ({ label: 'Program area', value: item })),
      ...(richScope?.agencies ?? []).map((item) => ({ label: 'Agency', value: item })),
    ],
    setAside: richScope?.setAside ?? row.setAside ?? null,
    applicantTypes: richEligibility?.applicantTypes ?? row.applicantTypes ?? [],
    eligibilitySourceText: richEligibility?.sourceText ?? null,
    eligibilityClientReason: richEligibility?.clientReason ?? null,
    geography: richScope?.geography ?? row.geography ?? [],
    value: richValue,
    economics: detail
      ? [
          ...(detail.evaluation.costShare ?? []).map((item) => ({
            label: 'Cost share',
            value: item,
          })),
        ]
      : null,
    scope: [...(richScope?.sectors ?? [])],
    scopeContent: richScope?.content ?? [],
    evaluation,
    responsePath,
    responseInstructions,
    responseInstructionDetails: detail?.responseInstructions?.details ?? [],
    activity,
    activityCoverage: detail?.activityCoverage ?? null,
    documents: detail?.documents?.map((item) => item.label) ?? [],
    destinations: detail?.destinations ?? [],
    contacts,
    changeNotes,
    provenance: detail
      ? [
          { label: 'Source model', value: detail.provenance.sourceModel },
          { label: 'Source', value: sourceName(source) },
          {
            label: 'Source reference',
            value: displayReference ?? 'Not provided by source',
            mono: Boolean(displayReference),
          },
          { label: 'Source updated', value: sourceUpdatedRaw ?? dateText(sourceUpdated) },
          { label: 'Capiro ingested', value: dateText(detail.sourceReference.ingestedAt) },
        ]
      : [
          { label: 'Source', value: sourceName(source) },
          { label: 'Record id', value: sourceRecordId, mono: true },
        ],
    similar:
      detail?.similarOpportunities?.map((item) => ({
        id: `${item.source}:${item.sourceRecordId}`,
        source: item.source,
        sourceRecordId: item.sourceRecordId,
        title: item.title,
        detail:
          [
            sourceName(item.source),
            item.type ?? null,
            item.deadline ? dateText(item.deadline) : null,
          ]
            .filter(nonEmpty)
            .join(' · ') || item.similarity,
        url: item.sourceUrl,
        type: item.type ?? null,
        deadline: item.deadline ?? null,
      })) ?? [],
    similarUnavailableReason: detail?.similarOpportunitiesUnavailableReason ?? null,
    dateFacts: richDates ?? null,
    forecastDate:
      dateValue(richDates?.forecast.anticipatedAwardDate) ??
      (typeof sourceFacts.anticipatedAwardDate === 'string'
        ? sourceFacts.anticipatedAwardDate
        : null) ??
      (typeof sourceFacts.estimatedPeriod === 'string' ? sourceFacts.estimatedPeriod : null),
    workflowStatus: detail?.workflow.status ?? row.decoration?.workflow.status ?? null,
    workflowStage: row.decoration?.workflow.stage ?? null,
    bookmarkSaved: row.decoration?.bookmark.saved ?? false,
    humanDecision: detail?.workflow.humanDecision ?? row.decoration?.workflow.humanDecision ?? null,
    actionCapability: detail?.capabilities.pursue ?? row.decoration?.capabilities.pursue ?? null,
    workflow: null,
    decision: null,
    actionNote: detail?.capabilities.pursue.reason ?? null,
  };
}

export type FundingOpportunityV2ExternalAuditEvent =
  Parameters<FundingOpportunityV2ExternalAudit>[0];
