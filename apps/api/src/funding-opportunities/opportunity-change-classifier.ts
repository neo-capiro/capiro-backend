/**
 * What CHANGED between two notices, and why it matters (Funding Opportunities
 * P28).
 *
 * ── Deterministic, and derived rather than stored ────────────────────────────
 *
 * Every function here is pure. The timeline is computed from
 * `tango_opportunity_notice` rows on each read, never persisted alongside them:
 * a derived timeline stored next to its own inputs is a second thing that can
 * be wrong about them, and reconciling the two is a job nobody wants.
 *
 * No LLM is involved and none is needed. "The response deadline moved from
 * 1 September to 15 September" is a comparison, not a judgement.
 *
 * ── Order-independence is the property that matters most ─────────────────────
 *
 * Notices arrive out of order routinely — a backfill walks whatever page the
 * provider hands back first, and an incremental run picks up an amendment
 * before Capiro has ever seen the original. {@link buildNoticeTimeline}
 * therefore SORTS its input, on a total order, before comparing anything. The
 * same set of notices in any input order produces a byte-identical timeline,
 * which `opportunity-change-classifier.spec.ts` proves against shuffled input.
 *
 * ── Absence is a change, in both directions ─────────────────────────────────
 *
 * A deadline that disappears (`2026-09-01` → null) and one that appears
 * (null → `2026-09-01`) are BOTH material, and both are reported with their
 * direction. A classifier that only compared two present values would silently
 * miss the more alarming of the two: an agency withdrawing a stated deadline.
 *
 * ── What this provider resource does NOT support, and why that is stated ─────
 *
 * The plan asks for nine change dimensions. The SDK's bundled `NOTICE_SCHEMA`
 * declares seventeen fields, and THREE of the plan's dimensions have no
 * counterpart among them:
 *
 *   stage (notice type)   the schema declares no `notice_type` on a NOTICE.
 *   place of performance  absent from the notice schema.
 *   contact               absent from the notice schema.
 *
 * Those three are declared in {@link CHANGE_DIMENSIONS} and reported through
 * {@link UNSUPPORTED_DIMENSIONS} with a reason, NOT silently omitted and NOT
 * reported as "no change". "The set-aside did not change" and "we cannot see
 * the set-aside" are different statements, and only one of them is a fact about
 * the notice.
 *
 * `description` was ORIGINALLY IN THAT LIST AND SHOULD NOT HAVE BEEN.
 * `NOTICE_SCHEMA` declares it as a plain optional `str`; the mistake was
 * reading `TangoNotice` — whose own field list had omitted it — instead of the
 * SDK's schema. It is a supported dimension now, and compared by HASH rather
 * than by value: see {@link classifyNoticeChange}.
 *
 * ── A caveat worth acting on ────────────────────────────────────────────────
 *
 * This program has now found four cases (decision-log D-35, D-41, D-42, D-45)
 * where the installed SDK's bundled schema disagreed with the LIVE SERVER —
 * twice because the server had more than the SDK declared. The `description`
 * mistake above is the same class of error in the opposite direction: trusting
 * a Capiro-side type instead of the schema. Both are read-the-source problems.
 *
 * Whether the live server exposes a `notice_type` is still open, and the
 * parent-opportunity link is a related open question: `NOTICE_SCHEMA` declares
 * an `opportunity` field but as a `dict` with `nestedModel: null`, so its inner
 * keys cannot be validated or guessed. Both are D-45-style investigations that
 * need a key.
 */

// ── The dimensions ───────────────────────────────────────────────────────────

/**
 * Every change dimension the plan names, supported or not.
 *
 * Declared in full — including the four with no provider counterpart — so the
 * gap is visible in the type rather than being a missing case nobody notices.
 */
export const CHANGE_DIMENSIONS = [
  'stage',
  'deadline',
  'set_aside',
  'naics',
  'psc',
  'place_of_performance',
  'contact',
  'attachments',
  'description',
  'cancellation',
  // Not in the plan's list, and added because it is unambiguously material: an
  // agency retitling a solicitation mid-competition is the single most common
  // reason a saved opportunity stops being findable.
  'title',
] as const;
export type ChangeDimension = (typeof CHANGE_DIMENSIONS)[number];

/** Dimensions with no counterpart in the provider's notice resource. */
export const UNSUPPORTED_DIMENSIONS: Readonly<Record<string, string>> = Object.freeze({
  stage:
    'The provider states no notice type on a notice, so a stage transition cannot be observed from notice history alone.',
  place_of_performance:
    'The provider states no place of performance on a notice, so a change of location cannot be observed.',
  contact:
    'The provider states no point of contact on a notice, so a change of contact cannot be observed.',
});

export function isSupportedDimension(dimension: ChangeDimension): boolean {
  return !(dimension in UNSUPPORTED_DIMENSIONS);
}

/**
 * How much a change should move somebody.
 *
 * Three bands, and the split is about ACTION rather than about size. A deadline
 * or a cancellation changes whether and when a team can respond at all; a
 * set-aside or a NAICS change can change whether they may respond; everything
 * else is worth seeing but not worth interrupting anyone for.
 *
 * P28 emits NO alerts — that is P48's job. This band exists so P48 has a
 * deterministic input rather than having to re-derive materiality from prose.
 */
export const CHANGE_SEVERITIES = ['critical', 'significant', 'informational'] as const;
export type ChangeSeverity = (typeof CHANGE_SEVERITIES)[number];

const SEVERITY: Readonly<Record<ChangeDimension, ChangeSeverity>> = Object.freeze({
  cancellation: 'critical',
  deadline: 'critical',
  set_aside: 'significant',
  naics: 'significant',
  psc: 'significant',
  stage: 'significant',
  place_of_performance: 'informational',
  contact: 'informational',
  attachments: 'informational',
  description: 'informational',
  title: 'informational',
});

// ── The observation shape ────────────────────────────────────────────────────

/** One `tango_opportunity_notice` row, as the classifier reads it. */
export interface NoticeObservation {
  tangoNoticeId: string;
  title: string | null;
  /**
   * SHA-256 of the normalized notice body, or null when the provider stated
   * none.
   *
   * A HASH rather than the body itself, for two reasons. A solicitation
   * description runs to tens of kilobytes, and the timeline query fetches up to
   * 500 notices — loading every body to compare two adjacent ones would make a
   * detail page read megabytes to answer "did the text change". And the ANSWER
   * is all a timeline can honestly give: a diff of two legal documents is not
   * something to summarize in a sentence, and quoting an excerpt would pick the
   * paragraph the differ happened to start at rather than the one that matters.
   * The entry says the body changed and links to the source.
   */
  descriptionHash: string | null;
  postedDate: Date | null;
  providerUpdatedAt: Date | null;
  responseDeadline: Date | null;
  active: boolean | null;
  setAside: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  attachmentCount: number | null;
  sourceUrl: string | null;
  contentHash: string;
}

export interface MaterialChange {
  dimension: ChangeDimension;
  severity: ChangeSeverity;
  /** Verbatim previous value, stringified for display. Null means it was absent. */
  before: string | null;
  /** Verbatim new value. Null means it became absent. */
  after: string | null;
  /**
   * One sentence, composed from the two values. Never a generic "the notice was
   * updated" — that is the label this phase exists to replace, because it tells
   * a reader nothing they can act on.
   */
  summary: string;
}

export interface TimelineEntry {
  tangoNoticeId: string;
  title: string | null;
  postedDate: string | null;
  providerUpdatedAt: string | null;
  sourceUrl: string | null;
  /** True for the earliest notice: there is nothing before it to compare against. */
  isFirstObservation: boolean;
  /** Empty for the first entry, and for any notice whose facts are unchanged. */
  changes: MaterialChange[];
}

export interface NoticeTimeline {
  entries: TimelineEntry[];
  /** Total material changes across every entry. */
  changeCount: number;
  /** Counts by severity, so a caller need not re-derive them. */
  bySeverity: Record<ChangeSeverity, number>;
  /** Dimensions that could not be compared at all, with the reason for each. */
  unsupported: Array<{ dimension: string; reason: string }>;
}

// ── Comparison helpers ───────────────────────────────────────────────────────

function isoOrNull(value: Date | null): string | null {
  if (value == null) return null;
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** Text comparison form: lowercase, whitespace runs collapsed. */
function normText(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/** Code comparison form: uppercase alphanumerics only. */
function normCode(value: string | null): string | null {
  if (value == null) return null;
  const stripped = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return stripped === '' ? null : stripped;
}

/**
 * Deadline comparison form: trimmed to the MINUTE.
 *
 * Same reasoning as P27's parity ledger: the provider and SAM.gov round the
 * same value differently at the seconds place, and a seconds-level
 * "the deadline moved" on a timeline is a rounding artefact reported as an
 * agency action.
 */
function normInstant(value: Date | null): string | null {
  const iso = isoOrNull(value);
  return iso == null ? null : iso.slice(0, 16);
}

function displayDate(value: Date | null): string | null {
  const iso = isoOrNull(value);
  return iso == null ? null : iso;
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * What changed between two CONSECUTIVE observations.
 *
 * `previous` is the earlier notice, `next` the later one — the caller
 * establishes the order (see {@link buildNoticeTimeline}); this function does
 * not sort, so passing them backwards produces a correct comparison of a
 * backwards pair rather than silently correcting it.
 *
 * Returns an empty array when nothing compared changed. That is the answer for
 * a re-sync of identical content, and it is why a timeline entry can exist with
 * no changes on it: the notice is real, and saying "nothing changed" is
 * different from omitting it.
 */
export function classifyNoticeChange(
  previous: NoticeObservation,
  next: NoticeObservation,
): MaterialChange[] {
  const changes: MaterialChange[] = [];

  // ── Cancellation / closure. FIRST, because it is the one change that makes
  // every other change on the same notice irrelevant.
  if (previous.active !== next.active && next.active != null) {
    if (next.active === false) {
      changes.push({
        dimension: 'cancellation',
        severity: SEVERITY.cancellation,
        before: previous.active == null ? null : String(previous.active),
        after: 'false',
        summary: 'The agency marked this notice inactive. It is no longer open for response.',
      });
    } else if (previous.active === false) {
      // Rare but real: an agency reinstating a cancelled solicitation.
      changes.push({
        dimension: 'cancellation',
        severity: SEVERITY.cancellation,
        before: 'false',
        after: 'true',
        summary: 'The agency reinstated this notice after marking it inactive.',
      });
    }
  }

  // ── Deadline, in BOTH directions of absence.
  const beforeDeadline = normInstant(previous.responseDeadline);
  const afterDeadline = normInstant(next.responseDeadline);
  if (beforeDeadline !== afterDeadline) {
    changes.push({
      dimension: 'deadline',
      severity: SEVERITY.deadline,
      before: displayDate(previous.responseDeadline),
      after: displayDate(next.responseDeadline),
      summary: deadlineSummary(previous.responseDeadline, next.responseDeadline),
    });
  }

  pushTextChange(changes, 'set_aside', previous.setAside, next.setAside, (b, a) =>
    b == null
      ? `A set-aside was added: ${a}.`
      : a == null
        ? `The set-aside was removed. It previously stated: ${b}.`
        : `The set-aside changed from ${b} to ${a}.`,
  );

  pushCodeChange(changes, 'naics', previous.naicsCode, next.naicsCode, 'NAICS code');
  pushCodeChange(changes, 'psc', previous.pscCode, next.pscCode, 'product/service code');

  pushTextChange(changes, 'title', previous.title, next.title, (b, a) =>
    b == null
      ? `A title was added: ${a}.`
      : a == null
        ? `The title was removed. It previously read: ${b}.`
        : `The title changed from “${b}” to “${a}”.`,
  );

  // ── Description. Compared by HASH, and reported WITHOUT either body.
  //
  // The before/after carry the two hashes rather than the two texts. A reader
  // cannot act on a hash, and that is the point: the actionable fact is "the
  // body changed, go read it", and the entry links to the source. Putting a
  // truncated excerpt here would quote whichever paragraph came first rather
  // than whichever one mattered.
  if (previous.descriptionHash !== next.descriptionHash) {
    changes.push({
      dimension: 'description',
      severity: SEVERITY.description,
      before: previous.descriptionHash,
      after: next.descriptionHash,
      summary:
        previous.descriptionHash == null
          ? 'A description was added to this notice. Read it at the source.'
          : next.descriptionHash == null
            ? 'The description was removed from this notice.'
            : 'The description text changed. Read the new version at the source — the change is not summarised here, because a summary of a legal document is a claim about it.',
    });
  }

  // ── Attachments. A COUNT, and the direction is stated: an attachment
  // disappearing is not the same event as one appearing.
  if (previous.attachmentCount !== next.attachmentCount) {
    const b = previous.attachmentCount;
    const a = next.attachmentCount;
    changes.push({
      dimension: 'attachments',
      severity: SEVERITY.attachments,
      before: b == null ? null : String(b),
      after: a == null ? null : String(a),
      summary:
        b == null || a == null
          ? `The attachment count went from ${b == null ? 'unstated' : String(b)} to ${a == null ? 'unstated' : String(a)}.`
          : a > b
            ? `${a - b} attachment${a - b === 1 ? '' : 's'} added (now ${a}).`
            : `${b - a} attachment${b - a === 1 ? '' : 's'} removed (now ${a}).`,
    });
  }

  return changes;
}

function deadlineSummary(before: Date | null, after: Date | null): string {
  const b = isoOrNull(before);
  const a = isoOrNull(after);
  if (b == null && a != null) return `A response deadline was set: ${a}.`;
  if (b != null && a == null) {
    // The more alarming direction, and it gets its own sentence rather than
    // being folded into a generic "the deadline changed".
    return `The response deadline was removed. It previously stated ${b}.`;
  }
  if (b == null || a == null) return 'The response deadline changed.';
  const later = new Date(a).getTime() > new Date(b).getTime();
  return `The response deadline moved ${later ? 'later' : 'earlier'}, from ${b} to ${a}.`;
}

function pushTextChange(
  out: MaterialChange[],
  dimension: ChangeDimension,
  before: string | null,
  after: string | null,
  summarize: (before: string | null, after: string | null) => string,
): void {
  if (normText(before) === normText(after)) return;
  out.push({
    dimension,
    severity: SEVERITY[dimension],
    before: before ?? null,
    after: after ?? null,
    summary: summarize(before ?? null, after ?? null),
  });
}

function pushCodeChange(
  out: MaterialChange[],
  dimension: ChangeDimension,
  before: string | null,
  after: string | null,
  label: string,
): void {
  if (normCode(before) === normCode(after)) return;
  out.push({
    dimension,
    severity: SEVERITY[dimension],
    before: before ?? null,
    after: after ?? null,
    summary:
      before == null
        ? `A ${label} was added: ${after}.`
        : after == null
          ? `The ${label} was removed. It previously stated ${before}.`
          : `The ${label} changed from ${before} to ${after}.`,
  });
}

// ── The timeline ─────────────────────────────────────────────────────────────

/**
 * The TOTAL order notices are compared in.
 *
 * `postedDate` first, `providerUpdatedAt` as the tiebreaker, `tangoNoticeId`
 * last. The third key is what makes the order TOTAL, and therefore what makes
 * the timeline order-independent: two notices posted the same instant with no
 * update stamp would otherwise sort by input order, and the same set of
 * notices could produce two different timelines depending on which page the
 * provider handed back first.
 *
 * A notice with NO posted date sorts LAST rather than first. An undated
 * observation is the provider not stating when something happened, and placing
 * it at the head of a history would make it the baseline every later notice is
 * compared against — inventing a change on the second notice.
 */
export function compareNoticeOrder(a: NoticeObservation, b: NoticeObservation): number {
  const aPosted = a.postedDate?.getTime();
  const bPosted = b.postedDate?.getTime();
  const aHas = aPosted != null && !Number.isNaN(aPosted);
  const bHas = bPosted != null && !Number.isNaN(bPosted);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bHas && aPosted !== bPosted) return aPosted! - bPosted!;

  const aUpdated = a.providerUpdatedAt?.getTime();
  const bUpdated = b.providerUpdatedAt?.getTime();
  const aHasU = aUpdated != null && !Number.isNaN(aUpdated);
  const bHasU = bUpdated != null && !Number.isNaN(bUpdated);
  if (aHasU !== bHasU) return aHasU ? -1 : 1;
  if (aHasU && bHasU && aUpdated !== bUpdated) return aUpdated! - bUpdated!;

  return a.tangoNoticeId.localeCompare(b.tangoNoticeId);
}

/**
 * Every notice under one opportunity, in order, with what changed at each step.
 *
 * DUPLICATES ARE A NO-OP. Two observations of the same `tangoNoticeId` collapse
 * to one — the one with the later `providerUpdatedAt`, or the first seen when
 * neither states one. That is what makes an overlapping incremental window free
 * rather than a source of phantom changes: the overlap re-fetches notices the
 * previous run already stored, by design.
 */
export function buildNoticeTimeline(notices: readonly NoticeObservation[]): NoticeTimeline {
  const deduped = dedupeByNoticeId(notices);
  const ordered = [...deduped].sort(compareNoticeOrder);

  const entries: TimelineEntry[] = [];
  const bySeverity: Record<ChangeSeverity, number> = {
    critical: 0,
    significant: 0,
    informational: 0,
  };
  let changeCount = 0;

  ordered.forEach((notice, index) => {
    const previous = index === 0 ? null : ordered[index - 1]!;
    const changes = previous == null ? [] : classifyNoticeChange(previous, notice);
    for (const change of changes) {
      changeCount += 1;
      bySeverity[change.severity] += 1;
    }
    entries.push({
      tangoNoticeId: notice.tangoNoticeId,
      title: notice.title,
      postedDate: isoOrNull(notice.postedDate),
      providerUpdatedAt: isoOrNull(notice.providerUpdatedAt),
      sourceUrl: notice.sourceUrl,
      isFirstObservation: index === 0,
      changes,
    });
  });

  return {
    entries,
    changeCount,
    bySeverity,
    unsupported: Object.entries(UNSUPPORTED_DIMENSIONS).map(([dimension, reason]) => ({
      dimension,
      reason,
    })),
  };
}

/**
 * One row per notice id.
 *
 * Keeps the observation with the later `providerUpdatedAt`. A tie, or two
 * observations neither of which states one, keeps the FIRST — deterministic,
 * and the alternative (keeping the last) would make the result depend on input
 * order, which is the property this whole module is built to avoid.
 */
export function dedupeByNoticeId(
  notices: readonly NoticeObservation[],
): NoticeObservation[] {
  const byId = new Map<string, NoticeObservation>();
  for (const notice of notices) {
    const existing = byId.get(notice.tangoNoticeId);
    if (existing == null) {
      byId.set(notice.tangoNoticeId, notice);
      continue;
    }
    const existingAt = existing.providerUpdatedAt?.getTime() ?? null;
    const candidateAt = notice.providerUpdatedAt?.getTime() ?? null;
    if (candidateAt != null && (existingAt == null || candidateAt > existingAt)) {
      byId.set(notice.tangoNoticeId, notice);
    }
  }
  return [...byId.values()];
}
