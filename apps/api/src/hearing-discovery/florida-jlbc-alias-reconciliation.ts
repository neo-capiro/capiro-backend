import { Prisma } from '@prisma/client';
import {
  classifyFloridaAgendaRelocations,
  classifyFloridaCandidateRelocations,
  floridaAliasConfirmation,
} from './florida-openstates-alias-reconciliation.js';
import { lockFloridaOpenstatesEventWriter } from './florida-openstates-concurrency.js';
import { contentHash, isoDay } from './hearing-identity.js';
import {
  FLORIDA_JLBC_ALIAS_REVIEW,
  validateFloridaJlbcAliasReview,
  type FloridaJlbcAliasReview,
  type VerifiedFloridaJlbcProof,
} from './florida-jlbc-alias-review.js';

type Tx = Prisma.TransactionClient;
type Side = 'alias' | 'canonical';
type ReferenceColumn = { tableName: string; columnName: string; immutableGuards: string[] };
type ReferenceFingerprint = ReferenceColumn & {
  source: number;
  target: number;
  rows: Array<{ side: Side; rowFingerprint: string }>;
};

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
const MOVE_TABLES = new Set([
  'hearing_source_observation',
  'legislative_observation_revision',
  'legislative_agenda_item',
  'hearing_stream_candidate',
]);
const RETAIN_TABLES = new Set(['legislative_calendar_transition']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function legislative(value: unknown): Record<string, unknown> | null {
  return record(record(value)?.legislative);
}

function fields(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  return record(metadata?.fields);
}

function timeField(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  return record(fields(metadata)?.time);
}

function agendaTitles(metadata: Record<string, unknown> | null): string[] {
  const agenda = fields(metadata)?.agenda;
  return Array.isArray(agenda)
    ? agenda.flatMap((item) => {
        const title = record(item)?.title;
        return typeof title === 'string' ? [title] : [];
      })
    : [];
}

function exactArray(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function validateProof(review: FloridaJlbcAliasReview, proof: VerifiedFloridaJlbcProof): void {
  const evidenceUrls = [review.houseMonthlyUrl, review.houseNoticeUrl, review.senateNoticeUrl];
  const facts = {
    title: review.title,
    date: review.date,
    startsAt: review.startsAt,
    endsAt: review.endsAt,
    houseLocation: review.houseLocation,
    senateLocation: review.senateLocation,
    agenda: review.agenda,
    evidenceUrls,
  };
  if (
    proof.repairId !== review.repairId ||
    proof.aliasId !== review.aliasId ||
    proof.canonicalId !== review.canonicalId ||
    proof.externalEventId !== review.externalEventId ||
    proof.officialIdentity !== review.officialIdentity ||
    !exactArray(proof.evidenceUrls, evidenceUrls) ||
    proof.title !== review.title ||
    proof.date !== review.date ||
    proof.startsAt !== review.startsAt ||
    proof.endsAt !== review.endsAt ||
    proof.houseLocation !== review.houseLocation ||
    proof.senateLocation !== review.senateLocation ||
    proof.agendaHash !== contentHash(review.agenda) ||
    proof.proofHash !== contentHash(facts)
  )
    throw new Error('Exact live Florida JLBC publisher proof is required');
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
  if (!row) throw new Error(`${table} ${id} vanished while building the JLBC repair plan`);
  return row.fingerprint;
}

async function requirePrivilegedRepairRole(tx: Tx): Promise<string> {
  const [role] = await tx.$queryRaw<
    Array<{ roleName: string; superuser: boolean; bypassRls: boolean; rdsSuperuser: boolean }>
  >`
    SELECT r.rolname AS "roleName", r.rolsuper AS superuser,
      r.rolbypassrls AS "bypassRls",
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser')
        THEN pg_has_role(r.rolname, 'rds_superuser', 'member') ELSE false END AS "rdsSuperuser"
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!role || (!role.superuser && !role.bypassRls && !role.rdsSuperuser))
    throw new Error(
      `Florida JLBC alias repair requires the migration/master database role; current role is ${role?.roleName ?? 'unknown'}`,
    );
  return role.roleName;
}

async function lockRepairTables(tx: Tx, references: ReferenceColumn[]): Promise<void> {
  const tables = ['committee_hearing', ...references.map((reference) => reference.tableName)];
  for (const table of [...new Set(tables)].sort())
    await tx.$executeRawUnsafe(`LOCK TABLE ${quote(table)} IN SHARE ROW EXCLUSIVE MODE`);
}

function exactObservationFacts(
  metadata: Record<string, unknown> | null,
  expected: {
    review: FloridaJlbcAliasReview;
    officialIdentity: string;
    bodySourceKey: string;
    sourceUrl: string;
    location: string;
    session: string | null;
  },
): boolean {
  const time = timeField(metadata);
  return Boolean(
    metadata?.jurisdiction === 'FL' &&
    metadata.session === expected.session &&
    metadata.chamber === 'joint' &&
    metadata.officialIdentity === expected.officialIdentity &&
    metadata.bodySourceKey === expected.bodySourceKey &&
    metadata.sourceUrl === expected.sourceUrl &&
    fields(metadata)?.title === expected.review.title &&
    fields(metadata)?.location === expected.location &&
    time?.date === expected.review.date &&
    time?.startsAt === expected.review.startsAt &&
    time?.endsAt === expected.review.endsAt,
  );
}

export function floridaJlbcAliasConfirmation(repairId: string): string {
  // Keep a distinct token from the generic TFC repair even though both share
  // the same transaction safety model.
  return `${floridaAliasConfirmation(repairId)}:jlbc-official-calendar`;
}

export function verifiedJlbcCanonicalDirectoryId(
  stateCommitteeId: string | null,
  review: FloridaJlbcAliasReview,
): boolean {
  // Normal first-party refresh can now fill this exact directory association.
  // No other committee ID is compatible with this reviewed one-event repair.
  return stateCommitteeId === null || stateCommitteeId === review.aliasStateCommitteeId;
}

export async function reconcileFloridaJlbcAlias(
  tx: Tx,
  review: FloridaJlbcAliasReview,
  proof: VerifiedFloridaJlbcProof,
  options: {
    apply: boolean;
    expectedPlanHash?: string;
    confirmation?: string;
    writersQuiesced?: boolean;
  },
): Promise<Record<string, unknown>> {
  validateFloridaJlbcAliasReview(review);
  validateProof(review, proof);
  if (options.apply) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash ?? ''))
      throw new Error('Apply requires the exact reviewed dry-run plan hash');
    if (options.confirmation !== floridaJlbcAliasConfirmation(review.repairId))
      throw new Error('Apply requires the JLBC repair-specific confirmation token');
    if (options.writersQuiesced !== true)
      throw new Error(
        'Apply requires an explicit Florida/OpenStates writer-quiescence attestation',
      );
  }

  const databaseRole = await requirePrivilegedRepairRole(tx);
  await tx.$executeRawUnsafe('SET LOCAL row_security = off');
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  if (options.apply && !(await lockFloridaOpenstatesEventWriter(tx, review.externalEventId, 'try')))
    throw new Error(
      `OpenStates writer is active for ${review.externalEventId}; keep both schedules disabled and retry`,
    );

  const references = await referenceColumns(tx);
  const [alias, canonical, children, observations] = await Promise.all([
    tx.committeeHearing.findUniqueOrThrow({ where: { id: review.aliasId } }),
    tx.committeeHearing.findUniqueOrThrow({ where: { id: review.canonicalId } }),
    tx.committeeHearing.count({ where: { canonicalHearingId: review.aliasId } }),
    tx.hearingSourceObservation.findMany({
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
    }),
  ]);
  if (
    alias.id !== review.aliasId ||
    canonical.id !== review.canonicalId ||
    canonical.canonicalHearingId !== null ||
    (alias.canonicalHearingId !== null && alias.canonicalHearingId !== review.canonicalId) ||
    children !== 0
  )
    throw new Error('Exact JLBC alias/canonical topology changed');
  for (const row of [alias, canonical])
    if (
      row.geographicJurisdiction !== 'FL' ||
      row.chamber !== 'Joint' ||
      row.title !== review.title ||
      isoDay(row.date) !== review.date ||
      row.startsAt?.toISOString() !== review.startsAt ||
      row.scheduledEnd?.toISOString() !== review.endsAt ||
      row.timezone !== 'America/New_York'
    )
      throw new Error(`Exact JLBC hearing facts changed for ${row.id}`);
  if (
    alias.legislativeSession !== review.legislativeSession ||
    alias.stateCommitteeId !== review.aliasStateCommitteeId ||
    alias.bodySourceKey !== review.enrichedAliasBodySourceKey ||
    alias.location !== review.houseLocation ||
    canonical.legislativeSession !== review.legislativeSession ||
    !verifiedJlbcCanonicalDirectoryId(canonical.stateCommitteeId, review) ||
    canonical.bodySourceKey !== review.bodySourceKey ||
    ![review.houseLocation, review.senateLocation].includes(canonical.location ?? '')
  )
    throw new Error('Exact JLBC provider/body qualification changed');

  const openstates = observations.filter(
    (row) => row.source.adapterKey === 'openstates-florida-events',
  );
  const rawOpenstates = openstates.filter((row) => row.externalEventId === review.externalEventId);
  const enrichedOpenstates = openstates.filter(
    (row) => row.externalEventId === review.enrichedExternalEventId,
  );
  const official = observations.filter(
    (row) =>
      ['florida-house', 'florida-senate'].includes(row.source.adapterKey) &&
      row.externalEventId === review.officialIdentity,
  );
  const house = official.filter((row) => row.source.adapterKey === 'florida-house');
  const senate = official.filter((row) => row.source.adapterKey === 'florida-senate');
  const pending = alias.canonicalHearingId === null;
  const openstatesObservationIds = new Set(openstates.map((row) => row.id));
  const openstatesMoveIds = openstates
    .filter((row) => row.hearingId === review.aliasId)
    .map((row) => row.id);
  if (
    openstates.length !== 2 ||
    rawOpenstates.length !== 1 ||
    enrichedOpenstates.length !== 1 ||
    openstates.some((row) => ![review.aliasId, review.canonicalId].includes(row.hearingId ?? '')) ||
    rawOpenstates[0]!.sourceId !== enrichedOpenstates[0]!.sourceId ||
    house.length !== 1 ||
    senate.length !== 1 ||
    official.some((row) => row.hearingId !== review.canonicalId) ||
    observations.some(
      (row) => row.hearingId === review.aliasId && !openstatesObservationIds.has(row.id),
    )
  )
    throw new Error('Exact JLBC source-ledger ownership changed');

  const rawOpenstatesMetadata = legislative(rawOpenstates[0]!.sourceMetadata);
  const enrichedOpenstatesMetadata = legislative(enrichedOpenstates[0]!.sourceMetadata);
  const houseMetadata = legislative(house[0]!.sourceMetadata);
  const senateMetadata = legislative(senate[0]!.sourceMetadata);
  if (
    !exactObservationFacts(rawOpenstatesMetadata, {
      review,
      officialIdentity: `openstates:event:${review.externalEventId}`,
      bodySourceKey: review.aliasBodySourceKey,
      sourceUrl: review.houseMonthlyUrl,
      location: review.houseLocation,
      session: review.legislativeSession,
    }) ||
    rawOpenstatesMetadata?.stateCommitteeId !== null ||
    agendaTitles(rawOpenstatesMetadata).length !== 0 ||
    !exactObservationFacts(enrichedOpenstatesMetadata, {
      review,
      officialIdentity: review.enrichedExternalEventId,
      bodySourceKey: review.enrichedAliasBodySourceKey,
      sourceUrl: review.houseMonthlyUrl,
      location: review.houseLocation,
      session: review.legislativeSession,
    }) ||
    enrichedOpenstatesMetadata?.stateCommitteeId !== review.aliasStateCommitteeId ||
    agendaTitles(enrichedOpenstatesMetadata).length !== 0 ||
    !exactObservationFacts(houseMetadata, {
      review,
      officialIdentity: review.officialIdentity,
      bodySourceKey: review.bodySourceKey,
      sourceUrl: review.houseNoticeUrl,
      location: review.houseLocation,
      session: null,
    }) ||
    !exactArray(agendaTitles(houseMetadata), review.agenda) ||
    !exactObservationFacts(senateMetadata, {
      review,
      officialIdentity: review.officialIdentity,
      bodySourceKey: review.bodySourceKey,
      sourceUrl: review.senateNoticeUrl,
      location: review.senateLocation,
      session: null,
    })
  )
    throw new Error('Persisted JLBC source facts do not match the exact live publisher proof');

  const inventory = await referenceInventory(tx, references, review.aliasId, review.canonicalId);
  const blockedOperations: Array<Record<string, unknown>> = [];
  for (const reference of inventory.filter((row) => row.source > 0)) {
    if (!MOVE_TABLES.has(reference.tableName) && !RETAIN_TABLES.has(reference.tableName))
      blockedOperations.push({
        table: reference.tableName,
        column: reference.columnName,
        references: reference.source,
        reason:
          'This one-time repair does not rewrite capture, user, notification, or intelligence history.',
      });
    if (MOVE_TABLES.has(reference.tableName) && reference.immutableGuards.length)
      blockedOperations.push({
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
      (row.sourceId !== rawOpenstates[0]!.sourceId ||
        ![review.externalEventId, review.enrichedExternalEventId].includes(row.externalEventId)),
  );
  if (invalidRevisions.length)
    blockedOperations.push({
      table: 'legislative_observation_revision',
      references: invalidRevisions.map((row) => row.id),
      reason: 'Alias contains a revision outside the exact OpenStates source ledger.',
    });
  const agenda = classifyFloridaAgendaRelocations(review.aliasId, review.canonicalId, agendas);
  const candidatesDisposition = classifyFloridaCandidateRelocations(
    review.aliasId,
    review.canonicalId,
    candidates,
  );
  for (const [table, conflicts] of [
    ['legislative_agenda_item', agenda.conflicts],
    ['hearing_stream_candidate', candidatesDisposition.conflicts],
  ] as const)
    if (conflicts.length)
      blockedOperations.push({
        table,
        conflicts,
        reason: 'Canonical has a non-equivalent row with the same semantic identity.',
      });

  const revisionIds = revisions
    .filter((row) => row.hearingId === review.aliasId)
    .map((row) => row.id);
  const hasMovableReferences =
    openstatesMoveIds.length > 0 ||
    revisionIds.length > 0 ||
    agenda.moved.length > 0 ||
    candidatesDisposition.moved.length > 0;
  const status = pending
    ? 'pending'
    : hasMovableReferences
      ? 'healing-stale-writes'
      : 'already-applied';
  const fingerprints = {
    alias: await rowFingerprint(tx, 'committee_hearing', review.aliasId),
    canonical: await rowFingerprint(tx, 'committee_hearing', review.canonicalId),
  };
  const relocation = {
    openstatesObservationIds: openstates.map((row) => row.id),
    moveObservationIds: openstatesMoveIds,
    revisionIds,
    agenda,
    candidates: candidatesDisposition,
    transitionsRetained:
      inventory.find((row) => row.tableName === 'legislative_calendar_transition')?.source ?? 0,
  };
  const plan = { review, status, proof, fingerprints, references: inventory, relocation };
  const planHash = contentHash({ repairId: review.repairId, plan, blockedOperations });
  if (options.apply && options.expectedPlanHash !== planHash)
    throw new Error('JLBC hearing data or references changed since review; produce a new dry run');
  if (options.apply && blockedOperations.length)
    throw new Error(
      `Florida JLBC alias repair blocked: ${blockedOperations
        .map((operation) => String(operation.table))
        .join(', ')}`,
    );

  if (options.apply) {
    await lockRepairTables(tx, references);
    const [currentReferences, aliasFingerprint, canonicalFingerprint, currentChildren] =
      await Promise.all([
        referenceInventory(tx, references, review.aliasId, review.canonicalId),
        rowFingerprint(tx, 'committee_hearing', review.aliasId),
        rowFingerprint(tx, 'committee_hearing', review.canonicalId),
        tx.committeeHearing.count({ where: { canonicalHearingId: review.aliasId } }),
      ]);
    if (
      contentHash(currentReferences) !== contentHash(inventory) ||
      aliasFingerprint !== fingerprints.alias ||
      canonicalFingerprint !== fingerprints.canonical ||
      currentChildren !== 0
    )
      throw new Error('JLBC data changed while acquiring repair locks; produce a new dry run');

    if (status !== 'already-applied') {
      if (relocation.moveObservationIds.length) {
        const moved = await tx.hearingSourceObservation.updateMany({
          where: { id: { in: relocation.moveObservationIds }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (moved.count !== relocation.moveObservationIds.length)
          throw new Error('OpenStates JLBC observations changed during apply');
      }
      if (relocation.revisionIds.length) {
        const moved = await tx.legislativeObservationRevision.updateMany({
          where: { id: { in: relocation.revisionIds }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (moved.count !== relocation.revisionIds.length)
          throw new Error('JLBC revision inventory changed during apply');
      }
      if (relocation.agenda.moved.length) {
        const moved = await tx.legislativeAgendaItem.updateMany({
          where: { id: { in: relocation.agenda.moved }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (moved.count !== relocation.agenda.moved.length)
          throw new Error('JLBC agenda inventory changed during apply');
      }
      if (relocation.candidates.moved.length) {
        const moved = await tx.hearingStreamCandidate.updateMany({
          where: { id: { in: relocation.candidates.moved }, hearingId: review.aliasId },
          data: { hearingId: review.canonicalId },
        });
        if (moved.count !== relocation.candidates.moved.length)
          throw new Error('JLBC stream-candidate inventory changed during apply');
      }
      if (pending) {
        const appliedAt = new Date();
        const published = await tx.committeeHearing.updateMany({
          where: {
            id: review.aliasId,
            canonicalHearingId: null,
            geographicJurisdiction: 'FL',
          },
          data: {
            canonicalHearingId: review.canonicalId,
            aliasedAt: appliedAt,
            aliasEvidence: JSON.parse(
              JSON.stringify({
                schema: 'florida-jlbc-openstates-official-alias-repair/v1',
                repairId: review.repairId,
                planHash,
                appliedAt: appliedAt.toISOString(),
                externalEventId: review.externalEventId,
                officialIdentity: review.officialIdentity,
                proof,
                canonicalProjectionPreserved: true,
                retainedHistory: {
                  legislativeCalendarTransitions: relocation.transitionsRetained,
                  equivalentAgendaRows: relocation.agenda.retainedEquivalent,
                  equivalentStreamCandidates: relocation.candidates.retainedEquivalent,
                },
              }),
            ) as Prisma.InputJsonValue,
          },
        });
        if (published.count !== 1) throw new Error('JLBC alias changed during apply');
      }
    }

    const [
      linkedObservations,
      aliasAfter,
      canonicalAfterFingerprint,
      revisionsLeft,
      agendaLeft,
      candidatesLeft,
    ] = await Promise.all([
      tx.hearingSourceObservation.findMany({
        where: { id: { in: relocation.openstatesObservationIds } },
        select: { hearingId: true, externalEventId: true },
        orderBy: { externalEventId: 'asc' },
      }),
      tx.committeeHearing.findUniqueOrThrow({
        where: { id: review.aliasId },
        select: { canonicalHearingId: true },
      }),
      rowFingerprint(tx, 'committee_hearing', review.canonicalId),
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
    if (
      linkedObservations.length !== relocation.openstatesObservationIds.length ||
      linkedObservations.some((row) => row.hearingId !== review.canonicalId) ||
      !exactArray(
        linkedObservations.map((row) => row.externalEventId),
        [review.externalEventId, review.enrichedExternalEventId].sort(),
      ) ||
      aliasAfter.canonicalHearingId !== review.canonicalId ||
      canonicalAfterFingerprint !== fingerprints.canonical ||
      revisionsLeft !== 0 ||
      agendaLeft !== 0 ||
      candidatesLeft !== 0
    )
      throw new Error('Florida JLBC alias repair postcondition failed');
  }

  return {
    mode: options.apply ? 'applied' : 'dry-run',
    databaseRole,
    repairId: review.repairId,
    planHash,
    readyToApply: blockedOperations.length === 0,
    confirmation: floridaJlbcAliasConfirmation(review.repairId),
    plan,
    blockedOperations,
    note: 'No hearing or history row is deleted. The exact OpenStates ledger and movable references relocate atomically to the already-authoritative official-calendar hearing; the canonical first-party projection is never overwritten.',
  };
}

/** Exported only so the one-shot script cannot accidentally import a mutable manifest. */
export function reviewedFloridaJlbcAlias(): FloridaJlbcAliasReview {
  return FLORIDA_JLBC_ALIAS_REVIEW;
}
