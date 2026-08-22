/**
 * Canonical projection + diff — Phase 3.
 *
 * ARCHITECTURE: the canonical `committee_hearing` row is a PROJECTION over the
 * `hearing_source_observation` ledger, not a destructive merge. Every source's
 * report of an event is kept verbatim as an observation; the canonical value of
 * each field is then chosen from the highest-priority observation that actually
 * has that field. This is what makes "provenance conflicts do not overwrite
 * source history" true by construction rather than by discipline — replaying the
 * ledger reproduces the row, and a lower-priority source can never erase what a
 * higher-priority one said.
 *
 * OWNERSHIP: `sync-hearings.ts` still runs daily and owns the LEGACY display
 * columns (title/type/date/startsAt/time/location/url/witnesses/committeeCode)
 * for the rows whose ids it mints — `cm-{congress}-{eventId}` and
 * `{congress}-{jacket}-{date}`. For those rows this module fills a legacy column
 * only when it is empty, and otherwise reports the difference as a
 * `committee_site_update` signal instead of fighting the other writer for the
 * column. For rows only THIS phase can know about (Senate central schedule,
 * committee-site-only events) there is no other writer, so the projection owns
 * every column. `legacyOwnedId` is that fork, in one place, tested.
 *
 * Pure module: no Prisma, no fetch, no clock except an injected `now`.
 */
import {
  clockKey,
  contentHash,
  displayChamber,
  isoDay,
  normalizedTitleKey,
} from './hearing-identity.js';
import type {
  CommitteeUpdateObservation,
  EventStatus,
  ObservedStreamCandidate,
  SiteUpdateType,
  Visibility,
} from './hearing-discovery.types.js';

/**
 * One observation, flattened for projection. `sourcePriority` is
 * `committee_source.priority` (lower wins); `lastSeenAt` breaks ties so the
 * freshest report from an equally authoritative source wins.
 */
export interface ProjectableObservation {
  sourceId: string;
  adapterKey: string;
  sourcePriority: number;
  lastSeenAt: Date;
  sourceUpdatedAt: Date | null;
  congress: number | null;
  chamber: string;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  committeeName: string | null;
  title: string | null;
  eventType: string | null;
  eventStatus: EventStatus | null;
  visibility: Visibility | null;
  startsAt: Date | null;
  calendarDate: Date | null;
  displayTime: string | null;
  location: string | null;
  officialPageUrl: string | null;
  witnesses: string[];
  agendaBillIds: string[];
  streamCandidates: ObservedStreamCandidate[];
}

/** The projected canonical value set for one hearing. */
export interface ProjectedHearing {
  congress: number | null;
  chamber: string;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  committeeName: string | null;
  title: string | null;
  eventType: string | null;
  eventStatus: EventStatus | null;
  visibility: Visibility | null;
  startsAt: Date | null;
  calendarDate: Date | null;
  displayTime: string | null;
  location: string | null;
  officialPageUrl: string | null;
  witnesses: string[];
  agendaBillIds: string[];
  streamCandidates: ObservedStreamCandidate[];
  /** Newest `sourceUpdatedAt` any source published for this event. */
  lastOfficialUpdateAt: Date | null;
  /** Which source won each projected field — carried for the audit trail. */
  fieldSources: Record<string, string>;
}

/** The canonical row as it exists today, for diffing. */
export interface ExistingHearing {
  id: string;
  congress: number | null;
  chamber: string;
  committeeName: string;
  committeeCode: string | null;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  title: string;
  type: string | null;
  date: Date;
  startsAt: Date | null;
  time: string | null;
  location: string | null;
  url: string | null;
  witnesses: string[];
  eventStatus: string;
  visibility: string;
  sourceRevision: number;
  lastOfficialUpdateAt: Date | null;
  streamAvailability: string;
  coverageStatus: string;
}

/** What the repository should write, and what the product should be told about. */
export interface CanonicalWritePlan {
  /** Column patch for `committee_hearing`. Empty object means nothing to write. */
  patch: Record<string, unknown>;
  /** Fields whose PREVIOUSLY-OBSERVED value changed (drives sourceRevision). */
  changedFields: string[];
  /** Fields that were empty and got filled — additive, not a change. */
  filledFields: string[];
  /** Normalized change signals for `committee_site_update`. */
  updates: CommitteeUpdateObservation[];
}

/**
 * True when `sync-hearings.ts` owns the legacy display columns of this row.
 * Both of its id conventions are covered: `cm-{congress}-{eventId}` and the
 * historical `{congress}-{jacketNumber}-{YYYY-MM-DD}` transcript form.
 */
export function legacyOwnedId(id: string): boolean {
  return /^cm-\d+-\d+$/.test(id) || /^\d+-\d+-\d{4}-\d{2}-\d{2}$/.test(id);
}

/** Ledger order: best (lowest) priority first, then freshest. */
function byAuthority(a: ProjectableObservation, b: ProjectableObservation): number {
  if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
  return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Project the observation ledger for one event onto a single canonical value
 * set. Scalar fields take the best-authority non-empty value. Arrays
 * (witnesses, agenda bills) also take the best-authority NON-EMPTY array rather
 * than a union: a union would resurrect a witness a committee deliberately
 * removed, and the removal is exactly the signal the product needs to surface.
 * Stream candidates DO union, keyed by media/page URL, because two sources
 * advertising two different players are two genuinely different candidates.
 */
export function projectCanonical(observations: ProjectableObservation[]): ProjectedHearing {
  const ordered = [...observations].sort(byAuthority);
  const fieldSources: Record<string, string> = {};

  function pick<K extends keyof ProjectableObservation>(
    field: K,
  ): ProjectableObservation[K] | null {
    for (const obs of ordered) {
      const v = obs[field];
      if (!isEmpty(v)) {
        fieldSources[field as string] = obs.adapterKey;
        return v;
      }
    }
    return null;
  }

  const candidates = new Map<string, ObservedStreamCandidate>();
  for (const obs of ordered) {
    for (const c of obs.streamCandidates ?? []) {
      const key = `${c.provider}::${c.mediaUrl ?? c.officialPageUrl}`;
      if (!candidates.has(key)) candidates.set(key, c);
    }
  }

  const officialUpdates = ordered
    .map((o) => o.sourceUpdatedAt)
    .filter((d): d is Date => d instanceof Date);

  return {
    congress: pick('congress') ?? null,
    chamber: displayChamber(pick('chamber') ?? ordered[0]?.chamber ?? 'Joint'),
    committeeSystemCode: pick('committeeSystemCode') ?? null,
    subcommitteeSystemCode: pick('subcommitteeSystemCode') ?? null,
    committeeName: pick('committeeName') ?? null,
    title: pick('title') ?? null,
    eventType: pick('eventType') ?? null,
    eventStatus: pick('eventStatus') ?? null,
    visibility: pick('visibility') ?? null,
    startsAt: pick('startsAt') ?? null,
    calendarDate: pick('calendarDate') ?? null,
    displayTime: pick('displayTime') ?? null,
    location: pick('location') ?? null,
    officialPageUrl: pick('officialPageUrl') ?? null,
    witnesses: pick('witnesses') ?? [],
    agendaBillIds: pick('agendaBillIds') ?? [],
    streamCandidates: [...candidates.values()],
    lastOfficialUpdateAt: officialUpdates.length
      ? new Date(Math.max(...officialUpdates.map((d) => d.getTime())))
      : null,
    fieldSources,
  };
}

/** Which `committee_site_update.update_type` a status transition should emit. */
function statusUpdateType(next: EventStatus): SiteUpdateType | null {
  if (next === 'canceled') return 'canceled';
  if (next === 'postponed') return 'postponed';
  return null;
}

/**
 * Diff the projection against the stored row and produce the write plan.
 *
 * `sourceRevision` bumps only when a field that was ALREADY populated changes —
 * filling an empty column is additive and must not look to a consumer like "this
 * changed under me". The site-update rows carry previous/new values so the
 * Committee Room feed can show the actual delta.
 */
export function planCanonicalWrite(
  existing: ExistingHearing | null,
  projected: ProjectedHearing,
  opts: { now: Date; sourceUrl: string; parserVersion: string; sourceId?: string | null },
): CanonicalWritePlan {
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const filledFields: string[] = [];
  const updates: CommitteeUpdateObservation[] = [];
  const systemCode = projected.committeeSystemCode ?? existing?.committeeSystemCode ?? null;

  const pushUpdate = (
    updateType: SiteUpdateType,
    previousValue: string | null,
    newValue: string | null,
    summary: string,
  ): void => {
    // Without a system code there is no committee to file the update under
    // (committee_site_update.committee_system_code is NOT NULL), so the signal is
    // dropped rather than filed against a fabricated committee.
    if (!systemCode) return;
    updates.push({
      committeeSystemCode: systemCode,
      hearingId: existing?.id ?? null,
      updateType,
      normalizedTitle: (projected.title ?? existing?.title ?? '(untitled)').slice(0, 500),
      normalizedSummary: summary,
      sourceUrl: opts.sourceUrl,
      officialPublishedAt: projected.lastOfficialUpdateAt,
      previousValue,
      newValue,
      parserVersion: opts.parserVersion,
      // Identity of the CHANGE, not of the run: same delta observed twice must
      // hash identically so the repository can dedupe it.
      contentHash: contentHash({
        hearingId: existing?.id ?? null,
        systemCode,
        updateType,
        previousValue,
        newValue,
      }),
    });
  };

  // ── New canonical row ────────────────────────────────────────────────────
  if (!existing) {
    if (systemCode) {
      pushUpdate(
        'hearing_announced',
        null,
        projected.calendarDate ? isoDay(projected.calendarDate) : null,
        'Hearing announced on an official source.',
      );
    }
    return { patch, changedFields, filledFields, updates };
  }

  const legacyOwned = legacyOwnedId(existing.id);

  /**
   * Assign a column. `legacy` marks a column another writer owns: for those we
   * only ever FILL an empty value, and a difference becomes a signal instead of
   * a write.
   */
  const assign = (
    column: string,
    nextValue: unknown,
    currentValue: unknown,
    opts2: { legacy?: boolean; equals?: (a: unknown, b: unknown) => boolean } = {},
  ): 'filled' | 'changed' | 'noop' => {
    if (isEmpty(nextValue)) return 'noop';
    const same = opts2.equals
      ? opts2.equals(nextValue, currentValue)
      : scalarEquals(nextValue, currentValue);
    if (same) return 'noop';
    if (isEmpty(currentValue)) {
      patch[column] = nextValue;
      filledFields.push(column);
      return 'filled';
    }
    if (opts2.legacy && legacyOwned) {
      // Another writer owns the column; record the divergence, do not write.
      changedFields.push(column);
      return 'changed';
    }
    patch[column] = nextValue;
    changedFields.push(column);
    return 'changed';
  };

  // ── Canonical columns Phase 2 added: this phase owns them outright ───────
  assign('congress', projected.congress, existing.congress);
  assign('committeeSystemCode', projected.committeeSystemCode, existing.committeeSystemCode);
  assign(
    'subcommitteeSystemCode',
    projected.subcommitteeSystemCode,
    existing.subcommitteeSystemCode,
  );
  if (projected.visibility && projected.visibility !== existing.visibility) {
    patch.visibility = projected.visibility;
    changedFields.push('visibility');
  }
  if (projected.eventStatus && projected.eventStatus !== existing.eventStatus) {
    patch.eventStatus = projected.eventStatus;
    changedFields.push('eventStatus');
    const t = statusUpdateType(projected.eventStatus);
    if (t) {
      pushUpdate(
        t,
        existing.eventStatus,
        projected.eventStatus,
        `Event status changed from ${existing.eventStatus} to ${projected.eventStatus}.`,
      );
    }
  }
  if (
    projected.lastOfficialUpdateAt &&
    projected.lastOfficialUpdateAt.getTime() !== (existing.lastOfficialUpdateAt?.getTime() ?? 0)
  ) {
    patch.lastOfficialUpdateAt = projected.lastOfficialUpdateAt;
  }

  // ── Legacy display columns: fill-only on rows sync-hearings owns ─────────
  const dateOutcome = assign('date', projected.calendarDate, existing.date, {
    legacy: true,
    equals: dayEquals,
  });
  if (dateOutcome === 'changed' && projected.calendarDate) {
    pushUpdate(
      'date_changed',
      isoDay(existing.date),
      isoDay(projected.calendarDate),
      'Official schedule moved this event to a different day.',
    );
  }

  const timeOutcome = assign('startsAt', projected.startsAt, existing.startsAt, {
    legacy: true,
    equals: instantEquals,
  });
  if (timeOutcome === 'changed') {
    pushUpdate(
      'time_changed',
      existing.startsAt ? clockKey(existing.startsAt) : existing.time,
      projected.startsAt ? clockKey(projected.startsAt) : projected.displayTime,
      'Official schedule moved this event to a different time.',
    );
  }
  assign('time', projected.displayTime, existing.time, { legacy: true });

  const locationOutcome = assign('location', projected.location, existing.location, {
    legacy: true,
  });
  if (locationOutcome === 'changed') {
    pushUpdate('room_changed', existing.location, projected.location, 'Room or building changed.');
  }

  assign('url', projected.officialPageUrl, existing.url, { legacy: true });
  assign('committeeCode', projected.committeeSystemCode, existing.committeeCode, { legacy: true });

  // Witness deltas are a first-class product signal even when another writer
  // owns the column, so they are diffed explicitly rather than through `assign`.
  const before = new Set(existing.witnesses ?? []);
  const after = new Set(projected.witnesses ?? []);
  const added = [...after].filter((w) => !before.has(w));
  const removed = [...before].filter((w) => !after.has(w));
  if (projected.witnesses.length && (added.length || removed.length)) {
    if (!legacyOwned || before.size === 0) {
      patch.witnesses = projected.witnesses;
      (before.size === 0 ? filledFields : changedFields).push('witnesses');
    } else {
      changedFields.push('witnesses');
    }
    if (added.length) {
      pushUpdate(
        'witness_added',
        null,
        added.slice(0, 10).join('; '),
        `${added.length} witness(es) added to the official notice.`,
      );
    }
    if (removed.length) {
      pushUpdate(
        'witness_removed',
        removed.slice(0, 10).join('; '),
        null,
        `${removed.length} witness(es) removed from the official notice.`,
      );
    }
  }

  // Title changes never overwrite a legacy-owned title (sync-hearings prefixes
  // status into it), but a genuine retitle is still worth surfacing.
  if (
    projected.title &&
    normalizedTitleKey(projected.title) !== normalizedTitleKey(existing.title)
  ) {
    if (!legacyOwned) {
      patch.title = projected.title;
      changedFields.push('title');
    }
  }

  if (changedFields.length > 0) {
    patch.sourceRevision = existing.sourceRevision + 1;
  }
  return { patch, changedFields, filledFields, updates };
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}

/** Two `@db.Date` values are the same day when their UTC calendar day matches. */
function dayEquals(a: unknown, b: unknown): boolean {
  if (!(a instanceof Date) || !(b instanceof Date)) return false;
  return isoDay(a) === isoDay(b);
}

/**
 * Start instants are compared at MINUTE resolution. Congress.gov re-publishes
 * the same start with sub-minute jitter often enough that second-level equality
 * would emit a phantom `time_changed` on almost every run.
 */
function instantEquals(a: unknown, b: unknown): boolean {
  if (!(a instanceof Date) || !(b instanceof Date)) return false;
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}
