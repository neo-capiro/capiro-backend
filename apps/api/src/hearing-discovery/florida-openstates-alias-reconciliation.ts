import { Prisma } from '@prisma/client';
import { contentHash } from './hearing-identity.js';
import {
  floridaAliasPlanHash,
  validateFloridaOpenstatesAliasRows,
  validateFloridaOpenstatesAliasReview,
  type FloridaOpenstatesAliasReview,
} from './florida-openstates-alias-review.js';
import { lockFloridaOpenstatesEventWriter } from './florida-openstates-concurrency.js';

type Tx = Prisma.TransactionClient;
type Side = 'alias' | 'canonical';
type ReferenceColumn = { tableName: string; columnName: string; immutableGuards: string[] };
type ReferenceFingerprint = ReferenceColumn & {
  source: number;
  target: number;
  rows: Array<{ side: Side; rowFingerprint: string }>;
};

export interface VerifiedFloridaAliasMedia {
  aliasId: string;
  canonicalId: string;
  aliasEvidenceUrl: string;
  canonicalEvidenceUrl: string;
  aliasEntry: string;
  canonicalEntry: string;
}

type AgendaRow = {
  id: string;
  hearingId: string;
  itemKey: string;
  position: number;
  kind: string;
  title: string;
  billScope: string | null;
  stateBillKey: string | null;
  federalBillId: string | null;
  sourceUrl: string;
  evidence: unknown;
  active: boolean;
};

type CandidateRow = {
  id: string;
  hearingId: string;
  provider: string;
  officialPageUrl: string;
  mediaUrl: string | null;
  mediaType: string | null;
  priority: number;
  resolutionState: string;
  capturePolicy: string;
  sourceId: string | null;
  expiresAt: Date | null;
  failureReason: string | null;
};

export type RelocationDisposition = {
  moved: string[];
  retainedEquivalent: string[];
  conflicts: Array<{ sourceId: string; targetId: string; key: string }>;
};

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
const MOVE_TABLES = new Set([
  'hearing_source_observation',
  'legislative_observation_revision',
  'legislative_agenda_item',
  'hearing_stream_candidate',
]);
const RETAIN_TABLES = new Set(['legislative_calendar_transition']);
const CONFIRM_SUFFIX = 'apply-reviewed-aliases';

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function nullableInputJson(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

export type CalendarProjection = {
  calendarRevision: number;
  calendarSnapshot: unknown;
  calendarProvenance: unknown;
  calendarCheckedAt: Date | null;
  calendarCheckState: string;
  timePrecision: string | null;
  scheduledEnd: Date | null;
  committeeName: string;
  title: string;
  date: Date;
  time: string | null;
  startsAt: Date | null;
  location: string | null;
  type: string | null;
  url: string | null;
  timezone: string;
  eventStatus: string;
  syncedAt: Date;
};

const CALENDAR_PROJECTION_SELECT = {
  calendarRevision: true,
  calendarSnapshot: true,
  calendarProvenance: true,
  calendarCheckedAt: true,
  calendarCheckState: true,
  timePrecision: true,
  scheduledEnd: true,
  committeeName: true,
  title: true,
  date: true,
  time: true,
  startsAt: true,
  location: true,
  type: true,
  url: true,
  timezone: true,
  eventStatus: true,
  syncedAt: true,
} as const;

export function calendarProjectionFingerprint(row: CalendarProjection): string {
  return contentHash({
    calendarSnapshot: row.calendarSnapshot,
    calendarProvenance: row.calendarProvenance,
    calendarCheckedAt: row.calendarCheckedAt,
    calendarCheckState: row.calendarCheckState,
    timePrecision: row.timePrecision,
    scheduledEnd: row.scheduledEnd,
    committeeName: row.committeeName,
    title: row.title,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt,
    location: row.location,
    type: row.type,
    url: row.url,
    timezone: row.timezone,
    eventStatus: row.eventStatus,
    syncedAt: row.syncedAt,
  });
}

function calendarMaterialFingerprint(row: CalendarProjection): string {
  // Exact field list owned by legiwatch_calendar_material_revision().
  return contentHash({
    title: row.title,
    date: row.date,
    startsAt: row.startsAt,
    time: row.time,
    timezone: row.timezone,
    location: row.location,
    eventStatus: row.eventStatus,
    url: row.url,
    scheduledEnd: row.scheduledEnd,
  });
}

export function targetCalendarRevision(
  alias: CalendarProjection,
  canonical: CalendarProjection,
): number {
  const projectionChanged =
    calendarProjectionFingerprint(alias) !== calendarProjectionFingerprint(canonical);
  const materialChanged =
    calendarMaterialFingerprint(alias) !== calendarMaterialFingerprint(canonical);
  // Any projection change advances the canonical sequence. A material change
  // must also be strictly above OLD so the database trigger observes the same
  // revision instead of silently rewriting it.
  return Math.max(
    alias.calendarRevision,
    canonical.calendarRevision + (projectionChanged || materialChanged ? 1 : 0),
  );
}

function agendaSemantic(row: AgendaRow): string {
  return contentHash({
    itemKey: row.itemKey,
    position: row.position,
    kind: row.kind,
    title: row.title,
    billScope: row.billScope,
    stateBillKey: row.stateBillKey,
    federalBillId: row.federalBillId,
    sourceUrl: row.sourceUrl,
    evidence: row.evidence,
    active: row.active,
  });
}

export function classifyFloridaAgendaRelocations(
  aliasId: string,
  canonicalId: string,
  rows: AgendaRow[],
): RelocationDisposition {
  const targets = new Map(
    rows.filter((row) => row.hearingId === canonicalId).map((row) => [row.itemKey, row]),
  );
  const disposition: RelocationDisposition = {
    moved: [],
    retainedEquivalent: [],
    conflicts: [],
  };
  for (const row of rows.filter((candidate) => candidate.hearingId === aliasId)) {
    const target = targets.get(row.itemKey);
    if (!target) disposition.moved.push(row.id);
    else if (agendaSemantic(row) === agendaSemantic(target))
      disposition.retainedEquivalent.push(row.id);
    else disposition.conflicts.push({ sourceId: row.id, targetId: target.id, key: row.itemKey });
  }
  return disposition;
}

function candidateIdentity(row: CandidateRow): string {
  // Match StreamCandidateRepository's idempotency contract exactly: media
  // candidates key on provider+media URL; page-only candidates key on
  // provider+official page with a null media URL.
  return row.mediaUrl
    ? jsonString([row.provider, 'media', row.mediaUrl])
    : jsonString([row.provider, 'page', row.officialPageUrl]);
}

function candidateSemantic(row: CandidateRow): string {
  return contentHash({
    provider: row.provider,
    officialPageUrl: row.officialPageUrl,
    mediaUrl: row.mediaUrl,
    mediaType: row.mediaType,
    priority: row.priority,
    resolutionState: row.resolutionState,
    capturePolicy: row.capturePolicy,
    sourceId: row.sourceId,
    expiresAt: row.expiresAt,
    failureReason: row.failureReason,
  });
}

export function classifyFloridaCandidateRelocations(
  aliasId: string,
  canonicalId: string,
  rows: CandidateRow[],
): RelocationDisposition {
  const targets = new Map(
    rows.filter((row) => row.hearingId === canonicalId).map((row) => [candidateIdentity(row), row]),
  );
  const disposition: RelocationDisposition = {
    moved: [],
    retainedEquivalent: [],
    conflicts: [],
  };
  for (const row of rows.filter((candidate) => candidate.hearingId === aliasId)) {
    const key = candidateIdentity(row);
    const target = targets.get(key);
    if (!target) disposition.moved.push(row.id);
    else if (candidateSemantic(row) === candidateSemantic(target))
      disposition.retainedEquivalent.push(row.id);
    else disposition.conflicts.push({ sourceId: row.id, targetId: target.id, key });
  }
  return disposition;
}

export function floridaAliasConfirmation(repairId: string): string {
  return `${repairId}:${CONFIRM_SUFFIX}`;
}

export async function verifyFloridaAliasMediaEvidence(
  reviews: FloridaOpenstatesAliasReview[],
  fetchPage: (url: string) => Promise<Uint8Array>,
  entryFromHtml: (html: string) => string | null,
): Promise<VerifiedFloridaAliasMedia[]> {
  const verified: VerifiedFloridaAliasMedia[] = [];
  const cache = new Map<string, string | null>();
  const entry = async (url: string): Promise<string | null> => {
    if (!cache.has(url))
      cache.set(url, entryFromHtml(new TextDecoder().decode(await fetchPage(url))));
    return cache.get(url) ?? null;
  };
  for (const review of reviews) {
    validateFloridaOpenstatesAliasReview(review);
    const aliasEntry = await entry(review.aliasEvidenceUrl);
    const canonicalEntry = await entry(review.canonicalEvidenceUrl);
    if (
      aliasEntry !== review.publisherMediaEntryId ||
      canonicalEntry !== review.publisherMediaEntryId
    )
      throw new Error(
        `Florida publisher proof changed for ${review.aliasId}: expected ${review.publisherMediaEntryId}, got ${aliasEntry ?? 'none'} / ${canonicalEntry ?? 'none'}`,
      );
    verified.push({
      aliasId: review.aliasId,
      canonicalId: review.canonicalId,
      aliasEvidenceUrl: review.aliasEvidenceUrl,
      canonicalEvidenceUrl: review.canonicalEvidenceUrl,
      aliasEntry,
      canonicalEntry,
    });
  }
  return verified;
}

async function referenceColumns(tx: Tx): Promise<ReferenceColumn[]> {
  return tx.$queryRaw<ReferenceColumn[]>`
    SELECT c.relname AS "tableName", a.attname AS "columnName",
      ARRAY(SELECT tr.tgname || ':' || p.proname
        FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
        WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
          AND (tr.tgtype::int & 16) <> 0
          AND (tr.tgname ILIKE '%immutable%' OR p.proname ILIKE '%immutable%'
               OR tr.tgname = 'public_hearing_review_context_guard'
               OR tr.tgname ILIKE '%append_only%' OR p.proname ILIKE '%append_only%')
        ORDER BY tr.tgname) AS "immutableGuards"
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped AND t.typname IN ('text', 'varchar')
      AND (a.attname IN ('hearing_id', 'canonical_hearing_id', 'hearingId', 'canonicalHearingId')
        OR (a.attname = 'event_id' AND c.relname IN
          ('intel_hearing_record_run', 'intel_hearing_record_brief', 'intel_hearing_record_job')))
      AND c.relname <> 'committee_hearing'
    ORDER BY c.relname, a.attname`;
}

async function referenceInventory(
  tx: Tx,
  references: ReferenceColumn[],
  aliasId: string,
  canonicalId: string,
): Promise<ReferenceFingerprint[]> {
  const inventory: ReferenceFingerprint[] = [];
  for (const ref of references) {
    const rows = await tx.$queryRawUnsafe<Array<{ side: Side; rowFingerprint: string }>>(
      `SELECT CASE WHEN t.${quote(ref.columnName)} = $1 THEN 'alias' ELSE 'canonical' END AS side,
              encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS "rowFingerprint"
       FROM ${quote(ref.tableName)} t
       WHERE t.${quote(ref.columnName)} IN ($1, $2)
       ORDER BY side, "rowFingerprint"`,
      aliasId,
      canonicalId,
    );
    if (!rows.length) continue;
    inventory.push({
      ...ref,
      source: rows.filter((row) => row.side === 'alias').length,
      target: rows.filter((row) => row.side === 'canonical').length,
      rows,
    });
  }
  return inventory;
}

async function rowFingerprint(tx: Tx, table: string, id: string): Promise<string> {
  const [row] = await tx.$queryRawUnsafe<Array<{ fingerprint: string }>>(
    `SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS fingerprint
     FROM ${quote(table)} t WHERE id = $1`,
    id,
  );
  if (!row) throw new Error(`${table} ${id} vanished while building the reviewed plan`);
  return row.fingerprint;
}

async function requirePrivilegedRepairRole(tx: Tx): Promise<string> {
  const [role] = await tx.$queryRaw<
    Array<{
      roleName: string;
      superuser: boolean;
      bypassRls: boolean;
      rdsSuperuser: boolean;
    }>
  >`
    SELECT r.rolname AS "roleName", r.rolsuper AS superuser,
      r.rolbypassrls AS "bypassRls",
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser')
        THEN pg_has_role(r.rolname, 'rds_superuser', 'member') ELSE false END AS "rdsSuperuser"
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!role || (!role.superuser && !role.bypassRls && !role.rdsSuperuser))
    throw new Error(
      `Florida alias repair requires the migration/master database role to inventory FORCE-RLS references; current role is ${role?.roleName ?? 'unknown'}`,
    );
  return role.roleName;
}

async function lockRepairTables(tx: Tx, references: ReferenceColumn[]): Promise<void> {
  // Acquired only after the dry-run hash has been rebuilt and accepted. This
  // short critical section prevents a new soft reference from appearing
  // between the final inventory and alias publication. Five-second timeout:
  // live traffic wins and the repair aborts for a later retry.
  const tables = [
    'committee_hearing',
    'state_committee',
    ...references.map((reference) => reference.tableName),
  ];
  for (const table of [...new Set(tables)].sort())
    await tx.$executeRawUnsafe(`LOCK TABLE ${quote(table)} IN SHARE ROW EXCLUSIVE MODE`);
}

function legislativeMetadata(value: unknown): Record<string, unknown> | null {
  return jsonRecord(jsonRecord(value)?.legislative);
}

function metadataField(metadata: Record<string, unknown> | null, field: string): unknown {
  return jsonRecord(metadata?.fields)?.[field];
}

export async function reconcileFloridaOpenstatesAliases(
  tx: Tx,
  reviews: FloridaOpenstatesAliasReview[],
  verifiedMedia: VerifiedFloridaAliasMedia[],
  options: {
    apply: boolean;
    expectedPlanHash?: string;
    confirmation?: string;
    writersQuiesced?: boolean;
  },
): Promise<Record<string, unknown>> {
  if (!reviews.length || reviews.length > 20)
    throw new Error('Supply 1-20 reviewed Florida alias pairs');
  for (const review of reviews) validateFloridaOpenstatesAliasReview(review);
  const repairIds = new Set(reviews.map((review) => review.repairId));
  const allIds = reviews.flatMap((review) => [review.aliasId, review.canonicalId]);
  if (repairIds.size !== 1 || new Set(allIds).size !== allIds.length)
    throw new Error('One repair id and distinct hearing ids are required');
  const repairId = reviews[0]!.repairId;
  if (options.apply) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash ?? ''))
      throw new Error('Apply requires the exact reviewed dry-run plan hash');
    if (options.confirmation !== floridaAliasConfirmation(repairId))
      throw new Error('Apply requires the repair-specific confirmation token');
    if (options.writersQuiesced !== true)
      throw new Error('Apply requires an explicit writer-quiescence attestation');
  }
  const verifiedByAlias = new Map(verifiedMedia.map((row) => [row.aliasId, row]));
  if (
    verifiedByAlias.size !== reviews.length ||
    reviews.some((review) => {
      const proof = verifiedByAlias.get(review.aliasId);
      return (
        !proof ||
        proof.canonicalId !== review.canonicalId ||
        proof.aliasEvidenceUrl !== review.aliasEvidenceUrl ||
        proof.canonicalEvidenceUrl !== review.canonicalEvidenceUrl ||
        proof.aliasEntry !== review.publisherMediaEntryId ||
        proof.canonicalEntry !== review.publisherMediaEntryId
      );
    })
  )
    throw new Error('Exact publisher media verification is required for every pair');

  const databaseRole = await requirePrivilegedRepairRole(tx);
  await tx.$executeRawUnsafe('SET LOCAL row_security = off');
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  if (options.apply) {
    // Scheduled writers are disabled operationally before apply. These exact
    // per-event try-locks prove no already-running reconcile/candidate writer
    // is still inside its critical section; fail fast instead of waiting.
    for (const review of [...reviews].sort((a, b) =>
      a.externalEventId.localeCompare(b.externalEventId),
    )) {
      if (!(await lockFloridaOpenstatesEventWriter(tx, review.externalEventId, 'try')))
        throw new Error(
          `OpenStates writer is active for ${review.externalEventId}; keep schedules disabled and retry`,
        );
    }
  }
  const references = await referenceColumns(tx);

  const plans: Array<Record<string, unknown>> = [];
  const blockedOperations: Array<Record<string, unknown>> = [];
  for (const review of reviews) {
    const [alias, canonical, committee, children] = await Promise.all([
      tx.committeeHearing.findUniqueOrThrow({ where: { id: review.aliasId } }),
      tx.committeeHearing.findUniqueOrThrow({ where: { id: review.canonicalId } }),
      tx.stateCommittee.findUniqueOrThrow({ where: { id: review.stateCommitteeId } }),
      tx.committeeHearing.count({ where: { canonicalHearingId: review.aliasId } }),
    ]);
    validateFloridaOpenstatesAliasRows(review, alias, canonical, committee);
    if (children) throw new Error(`${review.aliasId} already has alias children`);

    const observations = await tx.hearingSourceObservation.findMany({
      where: { hearingId: { in: [review.aliasId, review.canonicalId] } },
      select: {
        id: true,
        hearingId: true,
        sourceId: true,
        externalEventId: true,
        sourceMetadata: true,
        source: { select: { adapterKey: true } },
      },
      orderBy: { id: 'asc' },
    });
    const openstates = observations.filter(
      (row) =>
        row.source.adapterKey === 'openstates-florida-events' &&
        row.externalEventId === review.externalEventId,
    );
    const archive = observations.filter(
      (row) => row.source.adapterKey === 'florida-channel-archive',
    );
    const pending = alias.canonicalHearingId === null;
    const observationNeedsMove = openstates[0]?.hearingId === review.aliasId;
    const observationHasValidLocation = pending
      ? observationNeedsMove
      : openstates[0]?.hearingId === review.aliasId ||
        openstates[0]?.hearingId === review.canonicalId;
    if (
      openstates.length !== 1 ||
      !observationHasValidLocation ||
      archive.length !== 1 ||
      archive[0]!.hearingId !== review.canonicalId ||
      observations.some((row) => row.hearingId === review.aliasId && row.id !== openstates[0]!.id)
    )
      throw new Error(`Source-ledger ownership is not exact for ${review.aliasId}`);
    const openstatesMetadata = legislativeMetadata(openstates[0]!.sourceMetadata);
    const archiveMetadata = legislativeMetadata(archive[0]!.sourceMetadata);
    if (
      openstatesMetadata?.jurisdiction !== 'FL' ||
      openstatesMetadata?.session !== review.session ||
      openstatesMetadata?.officialIdentity !== `openstates:event:${review.externalEventId}` ||
      openstatesMetadata?.stateCommitteeId !== review.stateCommitteeId ||
      openstatesMetadata?.bodySourceKey !== review.bodySourceKey ||
      metadataField(openstatesMetadata, 'watchUrl') !== review.aliasEvidenceUrl ||
      archiveMetadata?.publisherMediaEntryId !== review.publisherMediaEntryId ||
      !String(archiveMetadata?.officialIdentity ?? '').startsWith('fl:tfc:video:') ||
      ![archiveMetadata?.sourceUrl, metadataField(archiveMetadata, 'watchUrl')].includes(
        review.canonicalEvidenceUrl,
      )
    )
      throw new Error(`Persisted publisher/source evidence is not exact for ${review.aliasId}`);

    const inventory = await referenceInventory(tx, references, review.aliasId, review.canonicalId);
    for (const reference of inventory.filter((row) => row.source > 0)) {
      if (!MOVE_TABLES.has(reference.tableName) && !RETAIN_TABLES.has(reference.tableName))
        blockedOperations.push({
          aliasId: review.aliasId,
          table: reference.tableName,
          column: reference.columnName,
          references: reference.source,
          reason:
            'This one-off repair does not rewrite capture, user, notification, or intelligence references.',
        });
      if (MOVE_TABLES.has(reference.tableName) && reference.immutableGuards.length > 0)
        blockedOperations.push({
          aliasId: review.aliasId,
          table: reference.tableName,
          column: reference.columnName,
          references: reference.source,
          guards: reference.immutableGuards,
          reason: 'A protected history trigger blocks this reviewed relocation.',
        });
    }

    const [revisions, agendas, candidates] = await Promise.all([
      tx.legislativeObservationRevision.findMany({
        where: { hearingId: { in: [review.aliasId, review.canonicalId] } },
        select: { id: true, hearingId: true, sourceId: true, externalEventId: true },
        orderBy: { id: 'asc' },
      }),
      tx.legislativeAgendaItem.findMany({
        where: { hearingId: { in: [review.aliasId, review.canonicalId] } },
        orderBy: { id: 'asc' },
      }),
      tx.hearingStreamCandidate.findMany({
        where: { hearingId: { in: [review.aliasId, review.canonicalId] } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const invalidRevisions = revisions.filter(
      (row) =>
        row.hearingId === review.aliasId &&
        (row.sourceId !== openstates[0]!.sourceId ||
          row.externalEventId !== review.externalEventId),
    );
    if (invalidRevisions.length)
      blockedOperations.push({
        aliasId: review.aliasId,
        table: 'legislative_observation_revision',
        references: invalidRevisions.map((row) => row.id),
        reason: 'Alias contains a revision outside the exact OpenStates source ledger.',
      });
    const agendaDisposition = classifyFloridaAgendaRelocations(
      review.aliasId,
      review.canonicalId,
      agendas,
    );
    const candidateDisposition = classifyFloridaCandidateRelocations(
      review.aliasId,
      review.canonicalId,
      candidates,
    );
    for (const [table, conflicts] of [
      ['legislative_agenda_item', agendaDisposition.conflicts],
      ['hearing_stream_candidate', candidateDisposition.conflicts],
    ] as const)
      if (conflicts.length)
        blockedOperations.push({
          aliasId: review.aliasId,
          table,
          conflicts,
          reason: 'The canonical side has a non-equivalent row with the same semantic identity.',
        });

    const revisionIds = revisions
      .filter((row) => row.hearingId === review.aliasId)
      .map((row) => row.id);
    const hasMovableReferences =
      observationNeedsMove ||
      revisionIds.length > 0 ||
      agendaDisposition.moved.length > 0 ||
      candidateDisposition.moved.length > 0;
    const status = pending
      ? 'pending'
      : hasMovableReferences
        ? 'healing-stale-writes'
        : 'already-applied';

    plans.push({
      review,
      status,
      proof: verifiedByAlias.get(review.aliasId),
      fingerprints: {
        alias: await rowFingerprint(tx, 'committee_hearing', review.aliasId),
        canonical: await rowFingerprint(tx, 'committee_hearing', review.canonicalId),
        committee: await rowFingerprint(tx, 'state_committee', review.stateCommitteeId),
        calendarProjection: calendarProjectionFingerprint(alias),
        calendarRevision: {
          alias: alias.calendarRevision,
          canonicalBefore: canonical.calendarRevision,
          canonicalAfter: pending
            ? targetCalendarRevision(alias, canonical)
            : canonical.calendarRevision,
        },
      },
      references: inventory,
      relocation: {
        openstatesObservationId: openstates[0]!.id,
        moveObservation: observationNeedsMove,
        revisionIds,
        agenda: agendaDisposition,
        candidates: candidateDisposition,
        transitionsRetained:
          inventory.find((row) => row.tableName === 'legislative_calendar_transition')?.source ?? 0,
      },
    });
  }

  const planHash = floridaAliasPlanHash({ repairId, plans, blockedOperations });
  if (options.apply && options.expectedPlanHash !== planHash)
    throw new Error('Hearing data or references changed since review; produce a new dry run');
  if (options.apply && blockedOperations.length)
    throw new Error(
      `Florida alias reconciliation blocked: ${blockedOperations
        .map((operation) => `${operation.aliasId}:${operation.table}`)
        .join(', ')}`,
    );

  if (options.apply) {
    await lockRepairTables(tx, references);
    // READ COMMITTED gives these post-lock statements a fresh snapshot. Any
    // change since the accepted plan—including a newly inserted soft ref—is
    // detected before the first mutation, while the table locks prevent a new
    // one until commit.
    for (const plan of plans) {
      const review = plan.review as FloridaOpenstatesAliasReview;
      const expectedFingerprints = plan.fingerprints as {
        alias: string;
        canonical: string;
        committee: string;
      };
      const [
        currentReferences,
        aliasFingerprint,
        canonicalFingerprint,
        committeeFingerprint,
        children,
      ] = await Promise.all([
        referenceInventory(tx, references, review.aliasId, review.canonicalId),
        rowFingerprint(tx, 'committee_hearing', review.aliasId),
        rowFingerprint(tx, 'committee_hearing', review.canonicalId),
        rowFingerprint(tx, 'state_committee', review.stateCommitteeId),
        tx.committeeHearing.count({ where: { canonicalHearingId: review.aliasId } }),
      ]);
      if (
        contentHash(currentReferences) !== contentHash(plan.references) ||
        aliasFingerprint !== expectedFingerprints.alias ||
        canonicalFingerprint !== expectedFingerprints.canonical ||
        committeeFingerprint !== expectedFingerprints.committee ||
        children !== 0
      )
        throw new Error(
          `Hearing data or references changed while acquiring repair locks for ${review.aliasId}; produce a new dry run`,
        );
    }
  }

  if (options.apply) {
    const appliedAt = new Date();
    for (const plan of plans) {
      const review = plan.review as FloridaOpenstatesAliasReview;
      if (plan.status === 'already-applied') continue;
      const relocation = plan.relocation as {
        openstatesObservationId: string;
        moveObservation: boolean;
        revisionIds: string[];
        agenda: RelocationDisposition;
        candidates: RelocationDisposition;
        transitionsRetained: number;
      };
      if (relocation.moveObservation) {
        const observation = await tx.hearingSourceObservation.updateMany({
          where: { id: relocation.openstatesObservationId, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (observation.count !== 1) throw new Error('OpenStates observation changed during apply');
      }
      if (relocation.revisionIds.length) {
        const result = await tx.legislativeObservationRevision.updateMany({
          where: { id: { in: relocation.revisionIds }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (result.count !== relocation.revisionIds.length)
          throw new Error('OpenStates revision inventory changed during apply');
      }
      if (relocation.agenda.moved.length) {
        const result = await tx.legislativeAgendaItem.updateMany({
          where: { id: { in: relocation.agenda.moved }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (result.count !== relocation.agenda.moved.length)
          throw new Error('Agenda inventory changed during apply');
      }
      if (relocation.candidates.moved.length) {
        const result = await tx.hearingStreamCandidate.updateMany({
          where: { id: { in: relocation.candidates.moved }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (result.count !== relocation.candidates.moved.length)
          throw new Error('Stream candidate inventory changed during apply');
      }
      let sourceProjection: CalendarProjection | null = null;
      let canonicalCalendarRevision: number | null = null;
      if (plan.status === 'pending') {
        const [loadedSourceProjection, canonicalProjectionBefore] = await Promise.all([
          tx.committeeHearing.findUniqueOrThrow({
            where: { id: review.aliasId },
            select: CALENDAR_PROJECTION_SELECT,
          }),
          tx.committeeHearing.findUniqueOrThrow({
            where: { id: review.canonicalId },
            select: CALENDAR_PROJECTION_SELECT,
          }),
        ]);
        sourceProjection = loadedSourceProjection;
        canonicalCalendarRevision = targetCalendarRevision(
          loadedSourceProjection,
          canonicalProjectionBefore,
        );
        const canonicalUpdate = await tx.committeeHearing.updateMany({
          where: {
            id: review.canonicalId,
            canonicalHearingId: null,
            geographicJurisdiction: 'FL',
          },
          data: {
            stateCommitteeId: review.stateCommitteeId,
            bodySourceKey: review.bodySourceKey,
            committeeName: loadedSourceProjection.committeeName,
            title: loadedSourceProjection.title,
            date: loadedSourceProjection.date,
            time: loadedSourceProjection.time,
            startsAt: loadedSourceProjection.startsAt,
            scheduledEnd: loadedSourceProjection.scheduledEnd,
            location: loadedSourceProjection.location,
            type: loadedSourceProjection.type,
            url: loadedSourceProjection.url,
            timezone: loadedSourceProjection.timezone,
            eventStatus: loadedSourceProjection.eventStatus,
            calendarRevision: canonicalCalendarRevision,
            calendarSnapshot: nullableInputJson(loadedSourceProjection.calendarSnapshot),
            calendarProvenance: nullableInputJson(loadedSourceProjection.calendarProvenance),
            calendarCheckedAt: loadedSourceProjection.calendarCheckedAt,
            calendarCheckState: loadedSourceProjection.calendarCheckState,
            timePrecision: loadedSourceProjection.timePrecision,
            syncedAt: loadedSourceProjection.syncedAt,
          },
        });
        if (canonicalUpdate.count !== 1)
          throw new Error('Canonical Florida hearing changed during apply');
        await tx.committeeHearing.update({
          where: { id: review.aliasId },
          data: {
            canonicalHearingId: review.canonicalId,
            aliasedAt: appliedAt,
            aliasEvidence: JSON.parse(
              JSON.stringify({
                schema: 'florida-openstates-alias-repair/v1',
                repairId,
                planHash,
                appliedAt: appliedAt.toISOString(),
                externalEventId: review.externalEventId,
                publisherMediaEntryId: review.publisherMediaEntryId,
                reason: review.reason,
                evidenceUrls: [review.aliasEvidenceUrl, review.canonicalEvidenceUrl],
                calendarProjectionHash: calendarProjectionFingerprint(loadedSourceProjection),
                calendarRevision: canonicalCalendarRevision,
                retainedHistory: {
                  legislativeCalendarTransitions: relocation.transitionsRetained,
                  equivalentAgendaRows: relocation.agenda.retainedEquivalent,
                  equivalentStreamCandidates: relocation.candidates.retainedEquivalent,
                },
              }),
            ) as Prisma.InputJsonValue,
          },
        });
      }
      const [
        linkedObservation,
        aliasAfter,
        canonicalAfter,
        revisionsLeft,
        agendaMovesLeft,
        candidateMovesLeft,
      ] = await Promise.all([
        tx.hearingSourceObservation.findUnique({
          where: { id: relocation.openstatesObservationId },
          select: { hearingId: true, externalEventId: true },
        }),
        tx.committeeHearing.findUniqueOrThrow({
          where: { id: review.aliasId },
          select: { canonicalHearingId: true },
        }),
        tx.committeeHearing.findUniqueOrThrow({
          where: { id: review.canonicalId },
          select: {
            stateCommitteeId: true,
            bodySourceKey: true,
            ...CALENDAR_PROJECTION_SELECT,
          },
        }),
        relocation.revisionIds.length
          ? tx.legislativeObservationRevision.count({
              where: { id: { in: relocation.revisionIds }, hearingId: review.aliasId },
            })
          : 0,
        relocation.agenda.moved.length
          ? tx.legislativeAgendaItem.count({
              where: { id: { in: relocation.agenda.moved }, hearingId: review.aliasId },
            })
          : 0,
        relocation.candidates.moved.length
          ? tx.hearingStreamCandidate.count({
              where: { id: { in: relocation.candidates.moved }, hearingId: review.aliasId },
            })
          : 0,
      ]);
      const pendingProjectionFailed =
        plan.status === 'pending' &&
        (sourceProjection === null ||
          canonicalCalendarRevision === null ||
          canonicalAfter.calendarRevision !== canonicalCalendarRevision ||
          calendarProjectionFingerprint(canonicalAfter) !==
            calendarProjectionFingerprint(sourceProjection));
      if (
        linkedObservation?.hearingId !== review.canonicalId ||
        linkedObservation.externalEventId !== review.externalEventId ||
        aliasAfter.canonicalHearingId !== review.canonicalId ||
        canonicalAfter.stateCommitteeId !== review.stateCommitteeId ||
        canonicalAfter.bodySourceKey !== review.bodySourceKey ||
        pendingProjectionFailed ||
        revisionsLeft !== 0 ||
        agendaMovesLeft !== 0 ||
        candidateMovesLeft !== 0
      )
        throw new Error(`Florida alias postcondition failed for ${review.aliasId}`);
    }
  }

  return {
    mode: options.apply ? 'applied' : 'dry-run',
    databaseRole,
    repairId,
    planHash,
    readyToApply: blockedOperations.length === 0,
    confirmation: floridaAliasConfirmation(repairId),
    plans,
    blockedOperations,
    note: 'No hearing is deleted. With scheduled writers explicitly quiesced, the qualified OpenStates calendar projection and current/revision/agenda/media references relocate atomically. Repeated runs heal allowed stale writes; exact canonical duplicates stay on the durable alias, and immutable calendar transitions remain there as audited history.',
  };
}
