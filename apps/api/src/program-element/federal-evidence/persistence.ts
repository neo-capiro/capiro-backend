import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

const PARSER_VERSION = 'federal-legislative-exact-code-v1';
const PROGRAM_CODE_RE = /\b(?:[01]\d{6}[A-Z]|[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14})\b/g;
const SOURCE_HOSTS = new Set(['www.govinfo.gov', 'govinfo.gov', 'api.govinfo.gov', 'www.congress.gov', 'congress.gov']);

export interface FederalEvidenceMentionInput {
  candidateKey?: string;
  rawMention: string;
  canonicalPeCode?: string | null;
  matchType: 'exact_pe' | 'exact_blin' | 'alias' | 'jev';
  qualificationState?: 'pending' | 'qualified' | 'rejected';
  confidence: number;
  locator: string;
  evidence: string;
  languageHash?: string;
  matcherVersion?: string;
  qualifiedBy?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FederalEvidenceSnapshotInput {
  provider: 'govinfo' | 'congress.gov' | 'committee';
  collection: 'BILLS' | 'CRPT' | 'CPRT' | 'PLAW' | 'CREC' | 'COMMITTEE';
  packageId: string;
  billId?: string | null;
  versionCode?: string | null;
  /** Procedural branch; e.g. 119-hr-42:house or CRPT-119hrpt12. */
  lineageKey: string;
  sourceUrl: string;
  sourceModifiedAt?: Date | null;
  publishedAt?: Date | null;
  rawContent: string;
  extractedText: string;
  completeness: 'complete' | 'partial' | 'unreadable';
  /** Frozen end of the fully enumerated provider window. */
  inventoryWindowEnd: Date;
  /** Stable per-window receipt key; retrying it is a no-op. */
  observationKey: string;
  historical?: boolean;
  metadata?: Record<string, unknown>;
  mentions?: FederalEvidenceMentionInput[];
}

export interface FederalEvidenceRemovalInput {
  sourceKey: string;
  observationKey: string;
  inventoryWindowEnd: Date;
  sourceModifiedAt?: Date | null;
  historical?: boolean;
  metadata?: Record<string, unknown>;
  /** Must be true: absence from an incomplete inventory is never a removal. */
  inventoryComplete: boolean;
}

export interface FederalEvidencePersistResult {
  sourceKey: string;
  revisionId: string | null;
  observationInserted: boolean;
  revisionInserted: boolean;
  eventTypes: string[];
  pendingUnknownCodes: string[];
}

interface CurrentRow {
  state: 'present' | 'removed';
  revisionId: string | null;
  billId: string | null;
  contentHash: string | null;
  observationKey: string;
}

interface MentionRow {
  candidateKey: string;
  rawMention: string;
  canonicalPeCode: string | null;
  qualificationState: 'pending' | 'qualified' | 'rejected';
  confidence: number;
  locator: string;
  evidence: string;
  languageHash: string;
  matchType: string;
}

interface LifecycleEvent {
  eventType: 'text_changed' | 'added' | 'changed' | 'removed' | 'reinstated' | 'resolved';
  candidateKey: string;
  rawMention: string;
  canonicalPeCode: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableKey(...parts: Array<string | null | undefined>): string {
  return sha256(parts.map((part) => `${String(part ?? '').length}:${part ?? ''}`).join('|'));
}

function cleanCode(value: string): string {
  return value.trim().toUpperCase();
}

function sourceKeyOf(input: Pick<FederalEvidenceSnapshotInput, 'provider' | 'packageId'>): string {
  return `${input.provider}:${input.packageId.trim()}`;
}

function validateSnapshot(input: FederalEvidenceSnapshotInput): void {
  if (!input.packageId.trim() || !input.lineageKey.trim() || !input.observationKey.trim())
    throw new Error('FEDERAL_EVIDENCE_IDENTITY_REQUIRED');
  if (!Number.isFinite(input.inventoryWindowEnd.getTime()))
    throw new Error('FEDERAL_EVIDENCE_WINDOW_REQUIRED');
  if (input.rawContent.length > 30_000_000 || input.extractedText.length > 30_000_000)
    throw new Error('FEDERAL_EVIDENCE_CONTENT_TOO_LARGE');
  if (input.completeness === 'complete' && !input.extractedText.trim())
    throw new Error('COMPLETE_FEDERAL_EVIDENCE_REQUIRES_TEXT');
  const url = new URL(input.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !SOURCE_HOSTS.has(url.hostname))
    throw new Error('FEDERAL_EVIDENCE_SOURCE_URL_UNQUALIFIED');
}

/** Exact references are retained even when the catalog does not know them yet. */
export function extractFederalExactMentions(text: string): FederalEvidenceMentionInput[] {
  const upper = text.toUpperCase();
  const out = new Map<string, FederalEvidenceMentionInput>();
  for (const match of upper.matchAll(PROGRAM_CODE_RE)) {
    const code = match[0];
    if (out.has(code)) continue;
    const at = match.index ?? 0;
    const start = Math.max(0, at - 180);
    const end = Math.min(text.length, at + code.length + 180);
    const evidence = text.slice(start, end).replace(/\s+/g, ' ').trim();
    out.set(code, {
      candidateKey: `exact:${code}`,
      rawMention: code,
      canonicalPeCode: null,
      matchType: /^[01]\d{6}[A-Z]$/.test(code) ? 'exact_pe' : 'exact_blin',
      confidence: 1,
      locator: `characters:${at}-${at + code.length}`,
      evidence,
      languageHash: sha256(evidence),
      matcherVersion: PARSER_VERSION,
    });
  }
  return [...out.values()];
}

function mentionSnapshot(row: MentionRow): Record<string, unknown> {
  return {
    canonicalPeCode: row.canonicalPeCode,
    qualificationState: row.qualificationState,
    confidence: row.confidence,
    locator: row.locator,
    evidence: row.evidence,
    languageHash: row.languageHash,
    matchType: row.matchType,
  };
}

async function currentRow(tx: Prisma.TransactionClient, sourceKey: string): Promise<CurrentRow | null> {
  const rows = await tx.$queryRaw<CurrentRow[]>`
    SELECT c.state,
           c.revision_id AS "revisionId",
           c.bill_id AS "billId",
           c.content_hash AS "contentHash",
           c.observation_key AS "observationKey"
      FROM federal_evidence_current c
     WHERE c.source_key = ${sourceKey}
     LIMIT 1`;
  return rows[0] ?? null;
}

async function lastPresentRevisionId(
  tx: Prisma.TransactionClient,
  sourceKey: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ revisionId: string }>>`
    SELECT revision_id AS "revisionId"
      FROM federal_evidence_observation
     WHERE source_key = ${sourceKey} AND state = 'present'
     ORDER BY id DESC LIMIT 1`;
  return rows[0]?.revisionId ?? null;
}

async function mentionsForRevision(
  tx: Prisma.TransactionClient,
  revisionId: string | null,
): Promise<Map<string, MentionRow>> {
  if (!revisionId) return new Map();
  const rows = await tx.$queryRaw<MentionRow[]>`
    SELECT m.candidate_key AS "candidateKey",
           m.raw_mention AS "rawMention",
           COALESCE(m.canonical_pe_code, resolved.canonical_pe_code) AS "canonicalPeCode",
           CASE WHEN m.qualification_state = 'pending' AND resolved.canonical_pe_code IS NOT NULL
                THEN 'qualified' ELSE m.qualification_state END AS "qualificationState",
           m.confidence,
           m.locator,
           m.evidence,
           m.language_hash AS "languageHash",
           m.match_type AS "matchType"
      FROM federal_evidence_mention m
      LEFT JOIN LATERAL (
        SELECT e.canonical_pe_code
          FROM federal_evidence_mention_event e
         WHERE e.event_type = 'resolved'
           AND e.current_revision_id = m.revision_id
           AND e.candidate_key = m.candidate_key
         ORDER BY e.created_at DESC LIMIT 1
      ) resolved ON TRUE
     WHERE m.revision_id = ${revisionId}::uuid`;
  return new Map(rows.map((row) => [row.candidateKey, row]));
}

async function qualifyExactMentions(
  tx: Prisma.TransactionClient,
  mentions: FederalEvidenceMentionInput[],
): Promise<FederalEvidenceMentionInput[]> {
  const exactCodes = [
    ...new Set(
      mentions
        .filter((m) => m.matchType === 'exact_pe' || m.matchType === 'exact_blin')
        .map((m) => cleanCode(m.rawMention)),
    ),
  ];
  const known =
    exactCodes.length === 0
      ? []
      : await tx.$queryRaw<Array<{ peCode: string }>>(Prisma.sql`
          SELECT pe_code AS "peCode" FROM program_element
           WHERE pe_code IN (${Prisma.join(exactCodes)})`);
  const knownCodes = new Set(known.map((row) => row.peCode));
  return mentions.map((mention) => {
    if (mention.matchType !== 'exact_pe' && mention.matchType !== 'exact_blin') return mention;
    const raw = cleanCode(mention.rawMention);
    const canonicalPeCode = knownCodes.has(raw) ? raw : null;
    return {
      ...mention,
      rawMention: raw,
      canonicalPeCode,
      qualificationState: canonicalPeCode ? 'qualified' : 'pending',
      qualifiedBy: canonicalPeCode ? 'exact-program-element-registry' : null,
    };
  });
}

async function insertLifecycleEvent(
  tx: Prisma.TransactionClient,
  args: {
    sourceKey: string;
    billId: string | null;
    previousRevisionId: string | null;
    currentRevisionId: string | null;
    previousObservationKey: string | null;
    observationKey: string;
    event: LifecycleEvent;
    historical: boolean;
  },
): Promise<boolean> {
  const eventKey = stableKey(
    'federal-evidence-event-v1',
    args.sourceKey,
    args.event.eventType,
    args.event.candidateKey,
    args.previousObservationKey,
    args.observationKey,
  );
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO federal_evidence_mention_event(
      event_key, source_key, bill_id, event_type, candidate_key, raw_mention,
      canonical_pe_code, previous_revision_id, current_revision_id,
      before_jsonb, after_jsonb, historical
    ) VALUES (
      ${eventKey}, ${args.sourceKey}, ${args.billId}, ${args.event.eventType},
      ${args.event.candidateKey}, ${args.event.rawMention}, ${args.event.canonicalPeCode},
      ${args.previousRevisionId}::uuid, ${args.currentRevisionId}::uuid,
      ${args.event.before ? JSON.stringify(args.event.before) : null}::jsonb,
      ${args.event.after ? JSON.stringify(args.event.after) : null}::jsonb,
      ${args.historical}
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id`;
  const eventId = inserted[0]?.id;
  if (!eventId) return false;
  const payload = {
    eventKey,
    sourceKey: args.sourceKey,
    billId: args.billId,
    eventType: args.event.eventType,
    candidateKey: args.event.candidateKey,
    rawMention: args.event.rawMention,
    canonicalPeCode: args.event.canonicalPeCode,
    previousRevisionId: args.previousRevisionId,
    currentRevisionId: args.currentRevisionId,
    before: args.event.before,
    after: args.event.after,
    historical: args.historical,
  };
  await tx.$executeRaw`
    INSERT INTO federal_evidence_change_outbox(event_id, dedupe_key, payload_jsonb)
    VALUES (${eventId}::uuid, ${`federal-evidence:${eventKey}`}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING`;
  return true;
}

function planMentionEvents(
  previous: Map<string, MentionRow>,
  current: Map<string, MentionRow>,
  wasRemoved: boolean,
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const keys = new Set([...previous.keys(), ...current.keys()]);
  for (const key of [...keys].sort()) {
    const before = previous.get(key);
    const after = current.get(key);
    if (!after && before) {
      events.push({
        eventType: 'removed',
        candidateKey: key,
        rawMention: before.rawMention,
        canonicalPeCode: before.canonicalPeCode,
        before: mentionSnapshot(before),
        after: null,
      });
      continue;
    }
    if (!after || after.qualificationState !== 'qualified') continue;
    if (wasRemoved) {
      events.push({
        eventType: 'reinstated',
        candidateKey: key,
        rawMention: after.rawMention,
        canonicalPeCode: after.canonicalPeCode,
        before: before ? mentionSnapshot(before) : null,
        after: mentionSnapshot(after),
      });
      continue;
    }
    if (!before) {
      events.push({
        eventType: 'added',
        candidateKey: key,
        rawMention: after.rawMention,
        canonicalPeCode: after.canonicalPeCode,
        before: null,
        after: mentionSnapshot(after),
      });
      continue;
    }
    if (before.qualificationState === 'pending') {
      events.push({
        eventType: 'resolved',
        candidateKey: key,
        rawMention: after.rawMention,
        canonicalPeCode: after.canonicalPeCode,
        before: mentionSnapshot(before),
        after: mentionSnapshot(after),
      });
      continue;
    }
    if (
      before.languageHash !== after.languageHash ||
      before.canonicalPeCode !== after.canonicalPeCode ||
      before.qualificationState !== after.qualificationState
    ) {
      events.push({
        eventType: 'changed',
        candidateKey: key,
        rawMention: after.rawMention,
        canonicalPeCode: after.canonicalPeCode,
        before: mentionSnapshot(before),
        after: mentionSnapshot(after),
      });
    }
  }
  return events;
}

async function refreshLegacyPeProjection(
  tx: Prisma.TransactionClient,
  billId: string | null,
): Promise<void> {
  if (!billId) return;
  await tx.$executeRaw`
    UPDATE congress_bill b
       SET pe_codes = COALESCE((
         SELECT array_agg(DISTINCT COALESCE(m.canonical_pe_code, resolved.canonical_pe_code)
                          ORDER BY COALESCE(m.canonical_pe_code, resolved.canonical_pe_code))
           FROM federal_evidence_current c
           JOIN federal_evidence_mention m ON m.revision_id = c.revision_id
           LEFT JOIN LATERAL (
             SELECT e.canonical_pe_code
               FROM federal_evidence_mention_event e
              WHERE e.event_type = 'resolved'
                AND e.current_revision_id = m.revision_id
                AND e.candidate_key = m.candidate_key
              ORDER BY e.created_at DESC LIMIT 1
           ) resolved ON TRUE
          WHERE c.state = 'present' AND c.bill_id = ${billId}
            AND COALESCE(m.canonical_pe_code, resolved.canonical_pe_code) IS NOT NULL
            AND (m.qualification_state = 'qualified' OR resolved.canonical_pe_code IS NOT NULL)
       ), ARRAY[]::varchar[])
     WHERE b.id = ${billId}`;
}

/**
 * Persist a complete immutable revision, its candidates, the source observation,
 * lifecycle events and outbox records in one transaction.
 */
export async function persistFederalEvidenceSnapshot(
  prisma: PrismaClient,
  input: FederalEvidenceSnapshotInput,
): Promise<FederalEvidencePersistResult> {
  validateSnapshot(input);
  const sourceKey = sourceKeyOf(input);
  const contentHash = sha256(input.rawContent);
  const extractionHash = sha256(input.extractedText);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey}, 0))`;
    const previousCurrent = await currentRow(tx, sourceKey);
    const previousRevisionId =
      previousCurrent?.state === 'present'
        ? previousCurrent.revisionId
        : await lastPresentRevisionId(tx, sourceKey);
    const previousMentions = await mentionsForRevision(tx, previousRevisionId);

    const insertedRevision = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO federal_evidence_revision(
        source_key, provider, collection, package_id, bill_id, version_code,
        lineage_key, content_hash, extraction_hash, parser_version, source_url,
        source_modified_at, published_at, raw_content, extracted_text,
        completeness, metadata_jsonb
      ) VALUES (
        ${sourceKey}, ${input.provider}, ${input.collection}, ${input.packageId},
        ${input.billId ?? null}, ${input.versionCode ?? null}, ${input.lineageKey},
        ${contentHash}, ${extractionHash}, ${PARSER_VERSION}, ${input.sourceUrl},
        ${input.sourceModifiedAt ?? null}, ${input.publishedAt ?? null},
        ${input.rawContent}, ${input.extractedText}, ${input.completeness},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (source_key, content_hash, extraction_hash, parser_version) DO NOTHING
      RETURNING id`;
    const revisionRows = insertedRevision.length
      ? insertedRevision
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM federal_evidence_revision
           WHERE source_key = ${sourceKey} AND content_hash = ${contentHash}
             AND extraction_hash = ${extractionHash} AND parser_version = ${PARSER_VERSION}`;
    const revisionId = revisionRows[0]?.id;
    if (!revisionId) throw new Error('FEDERAL_EVIDENCE_REVISION_NOT_FOUND');

    // Preserve incomplete publisher bytes and the failed/partial observation,
    // but never let them replace the latest complete present/removed decision,
    // derive relationship removals, or clear the compatibility projection.
    if (input.completeness !== 'complete') {
      const observed = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO federal_evidence_observation(
          observation_key, source_key, revision_id, state, source_modified_at,
          inventory_window_end, historical, metadata_jsonb
        ) VALUES (
          ${input.observationKey}, ${sourceKey}, ${revisionId}::uuid, ${input.completeness},
          ${input.sourceModifiedAt ?? null}, ${input.inventoryWindowEnd},
          ${input.historical ?? false}, ${JSON.stringify(input.metadata ?? {})}::jsonb
        ) ON CONFLICT (observation_key) DO NOTHING RETURNING id`;
      return {
        sourceKey,
        revisionId,
        observationInserted: observed.length > 0,
        revisionInserted: insertedRevision.length > 0,
        eventTypes: [],
        pendingUnknownCodes: [],
      };
    }

    const suppliedMentions = input.mentions ?? extractFederalExactMentions(input.extractedText);
    const qualified = await qualifyExactMentions(tx, suppliedMentions);
    for (const mention of qualified) {
      const rawMention = mention.rawMention.trim();
      const candidateKey = mention.candidateKey ?? `${mention.matchType}:${cleanCode(rawMention)}`;
      const languageHash = mention.languageHash ?? sha256(mention.evidence.replace(/\s+/g, ' ').trim());
      await tx.$executeRaw`
        INSERT INTO federal_evidence_mention(
          revision_id, candidate_key, raw_mention, canonical_pe_code, match_type,
          qualification_state, confidence, locator, evidence, language_hash,
          matcher_version, qualified_by, metadata_jsonb
        ) VALUES (
          ${revisionId}::uuid, ${candidateKey}, ${rawMention}, ${mention.canonicalPeCode ?? null},
          ${mention.matchType}, ${mention.qualificationState ?? (mention.canonicalPeCode ? 'qualified' : 'pending')},
          ${mention.confidence}, ${mention.locator}, ${mention.evidence}, ${languageHash},
          ${mention.matcherVersion ?? PARSER_VERSION}, ${mention.qualifiedBy ?? null},
          ${JSON.stringify(mention.metadata ?? {})}::jsonb
        ) ON CONFLICT (revision_id, candidate_key, matcher_version) DO NOTHING`;
    }
    const currentMentions = await mentionsForRevision(tx, revisionId);

    const observed = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO federal_evidence_observation(
        observation_key, source_key, revision_id, state, source_modified_at,
        inventory_window_end, historical, metadata_jsonb
      ) VALUES (
        ${input.observationKey}, ${sourceKey}, ${revisionId}::uuid, 'present',
        ${input.sourceModifiedAt ?? null}, ${input.inventoryWindowEnd},
        ${input.historical ?? false}, ${JSON.stringify(input.metadata ?? {})}::jsonb
      ) ON CONFLICT (observation_key) DO NOTHING RETURNING id`;
    if (observed.length === 0) {
      return {
        sourceKey,
        revisionId,
        observationInserted: false,
        revisionInserted: insertedRevision.length > 0,
        eventTypes: [],
        pendingUnknownCodes: qualified
          .filter((m) => m.qualificationState === 'pending')
          .map((m) => m.rawMention),
      };
    }

    const events: LifecycleEvent[] = [];
    if (
      previousCurrent?.state === 'present' &&
      previousCurrent.revisionId &&
      previousCurrent.revisionId !== revisionId
    ) {
      events.push({
        eventType: 'text_changed',
        candidateKey: '__document__',
        rawMention: input.packageId,
        canonicalPeCode: null,
        before: { contentHash: previousCurrent.contentHash },
        after: { contentHash, extractionHash },
      });
    }
    if (previousCurrent?.revisionId !== revisionId || previousCurrent?.state === 'removed') {
      events.push(
        ...planMentionEvents(
          previousMentions,
          currentMentions,
          previousCurrent?.state === 'removed',
        ),
      );
    }
    const writtenTypes: string[] = [];
    for (const event of events) {
      if (
        await insertLifecycleEvent(tx, {
          sourceKey,
          billId: input.billId ?? previousCurrent?.billId ?? null,
          previousRevisionId,
          currentRevisionId: revisionId,
          previousObservationKey: previousCurrent?.observationKey ?? null,
          observationKey: input.observationKey,
          event,
          historical: input.historical ?? false,
        })
      )
        writtenTypes.push(event.eventType);
    }
    await refreshLegacyPeProjection(tx, input.billId ?? null);
    await tx.$executeRaw`
      UPDATE federal_evidence_coverage_gap
         SET resolved_at = clock_timestamp(), last_observed_at = clock_timestamp()
       WHERE source_key = ${sourceKey} AND resolved_at IS NULL`;
    return {
      sourceKey,
      revisionId,
      observationInserted: true,
      revisionInserted: insertedRevision.length > 0,
      eventTypes: writtenTypes,
      pendingUnknownCodes: qualified
        .filter((m) => m.qualificationState === 'pending')
        .map((m) => m.rawMention),
    };
  });
}

/** Record disappearance only after an exhaustive, complete inventory. */
export async function persistFederalEvidenceRemoval(
  prisma: PrismaClient,
  input: FederalEvidenceRemovalInput,
): Promise<FederalEvidencePersistResult> {
  if (!input.inventoryComplete) throw new Error('INCOMPLETE_INVENTORY_CANNOT_REMOVE_EVIDENCE');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sourceKey}, 0))`;
    const previous = await currentRow(tx, input.sourceKey);
    if (!previous) throw new Error('FEDERAL_EVIDENCE_SOURCE_NOT_FOUND');
    const observed = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO federal_evidence_observation(
        observation_key, source_key, revision_id, state, source_modified_at,
        inventory_window_end, historical, metadata_jsonb
      ) VALUES (
        ${input.observationKey}, ${input.sourceKey}, NULL, 'removed',
        ${input.sourceModifiedAt ?? null}, ${input.inventoryWindowEnd},
        ${input.historical ?? false}, ${JSON.stringify(input.metadata ?? {})}::jsonb
      ) ON CONFLICT (observation_key) DO NOTHING RETURNING id`;
    if (!observed.length || previous.state === 'removed') {
      return {
        sourceKey: input.sourceKey,
        revisionId: null,
        observationInserted: observed.length > 0,
        revisionInserted: false,
        eventTypes: [],
        pendingUnknownCodes: [],
      };
    }
    const previousMentions = await mentionsForRevision(tx, previous.revisionId);
    const writtenTypes: string[] = [];
    for (const mention of previousMentions.values()) {
      const event: LifecycleEvent = {
        eventType: 'removed',
        candidateKey: mention.candidateKey,
        rawMention: mention.rawMention,
        canonicalPeCode: mention.canonicalPeCode,
        before: mentionSnapshot(mention),
        after: null,
      };
      if (
        await insertLifecycleEvent(tx, {
          sourceKey: input.sourceKey,
          billId: previous.billId,
          previousRevisionId: previous.revisionId,
          currentRevisionId: null,
          previousObservationKey: previous.observationKey,
          observationKey: input.observationKey,
          event,
          historical: input.historical ?? false,
        })
      )
        writtenTypes.push('removed');
    }
    await refreshLegacyPeProjection(tx, previous.billId);
    return {
      sourceKey: input.sourceKey,
      revisionId: null,
      observationInserted: true,
      revisionInserted: false,
      eventTypes: writtenTypes,
      pendingUnknownCodes: [],
    };
  });
}

/** Resolve retained exact references after a later budget-catalog load. */
export async function replayPendingFederalEvidenceMentions(
  prisma: PrismaClient,
  limit = 200,
): Promise<{ scanned: number; resolved: number }> {
  const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const candidates = await prisma.$queryRaw<
    Array<{
      revisionId: string;
      sourceKey: string;
      billId: string | null;
      candidateKey: string;
      rawMention: string;
      evidence: string;
      languageHash: string;
    }>
  >`
    SELECT m.revision_id AS "revisionId", r.source_key AS "sourceKey", r.bill_id AS "billId",
           m.candidate_key AS "candidateKey", m.raw_mention AS "rawMention",
           m.evidence, m.language_hash AS "languageHash"
      FROM federal_evidence_mention m
      JOIN federal_evidence_revision r ON r.id = m.revision_id
      JOIN program_element pe ON pe.pe_code = upper(m.raw_mention)
     WHERE m.qualification_state = 'pending'
       AND m.match_type IN ('exact_pe', 'exact_blin')
       AND NOT EXISTS (
         SELECT 1 FROM federal_evidence_mention_event e
          WHERE e.event_type = 'resolved' AND e.current_revision_id = m.revision_id
            AND e.candidate_key = m.candidate_key
       )
     ORDER BY m.created_at, m.id
     LIMIT ${bounded}`;
  let resolved = 0;
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.sourceKey}, 0))`;
      const event: LifecycleEvent = {
        eventType: 'resolved',
        candidateKey: candidate.candidateKey,
        rawMention: candidate.rawMention,
        canonicalPeCode: cleanCode(candidate.rawMention),
        before: { qualificationState: 'pending', evidence: candidate.evidence },
        after: {
          qualificationState: 'qualified',
          canonicalPeCode: cleanCode(candidate.rawMention),
          evidence: candidate.evidence,
          languageHash: candidate.languageHash,
        },
      };
      const inserted = await insertLifecycleEvent(tx, {
        sourceKey: candidate.sourceKey,
        billId: candidate.billId,
        previousRevisionId: candidate.revisionId,
        currentRevisionId: candidate.revisionId,
        previousObservationKey: `pending:${candidate.revisionId}`,
        observationKey: `registry-replay:${candidate.revisionId}:${candidate.candidateKey}`,
        event,
        // Historical discovery must refresh products without false breaking-news delivery.
        historical: true,
      });
      if (inserted) resolved += 1;
      await refreshLegacyPeProjection(tx, candidate.billId);
    });
  }
  return { scanned: candidates.length, resolved };
}
