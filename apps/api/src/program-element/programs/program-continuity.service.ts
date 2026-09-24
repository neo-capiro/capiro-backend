import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

export const PROGRAM_IDENTITY_KINDS = [
  'pe',
  'pe_project',
  'procurement_line',
  'mdap',
  'source_program',
] as const;

export type ProgramIdentityKind = (typeof PROGRAM_IDENTITY_KINDS)[number];

export interface ProgramContinuityQuery {
  asOfFy: number;
  knownAt?: string;
  identityKind?: ProgramIdentityKind;
  sourceSystem?: string;
  sourceIdentifier?: string;
  includeCandidates?: boolean;
  limit?: number;
  cursor?: string;
}

interface CrosswalkRow {
  id: string;
  programId: string;
  canonicalName: string;
  identityKind: ProgramIdentityKind;
  sourceSystem: string;
  sourceIdentifier: string;
  relationshipKind: string;
  validFromFy: number | null;
  validToFy: number | null;
  recordedAt: Date;
  supersedesId: string | null;
  source: string;
  sourceUrl: string | null;
  sourceDocumentId: string | null;
  evidence: unknown;
  confidence: number;
  reviewStatus: string;
  reviewedAt: Date | null;
}

interface CursorValue {
  v: 1;
  asOfFy: number;
  knownAt: string;
  includeCandidates: boolean;
  identityKind?: ProgramIdentityKind;
  sourceSystem?: string;
  sourceIdentifier?: string;
  recordedAt: string;
  id: string;
}

function decodeCursor(
  cursor: string | undefined,
  query: Omit<CursorValue, 'recordedAt' | 'id'>,
): Pick<CursorValue, 'recordedAt' | 'id'> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorValue>;
    if (
      parsed.v !== 1 ||
      parsed.asOfFy !== query.asOfFy ||
      parsed.knownAt !== query.knownAt ||
      parsed.includeCandidates !== query.includeCandidates ||
      parsed.identityKind !== query.identityKind ||
      parsed.sourceSystem !== query.sourceSystem ||
      parsed.sourceIdentifier !== query.sourceIdentifier ||
      typeof parsed.recordedAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.recordedAt)) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error('cursor shape or query mismatch');
    }
    return { recordedAt: parsed.recordedAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid or query-mismatched continuity cursor.');
  }
}

function cursorKnownAt(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorValue>;
    if (typeof parsed.knownAt !== 'string' || Number.isNaN(Date.parse(parsed.knownAt))) return undefined;
    return new Date(parsed.knownAt).toISOString();
  } catch {
    return undefined;
  }
}

function encodeCursor(row: CrosswalkRow, query: Omit<CursorValue, 'recordedAt' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ ...query, recordedAt: row.recordedAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

/** Read-only temporal resolver for identity evidence. It never returns or derives amounts. */
@Injectable()
export class ProgramContinuityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProgramContinuityQuery) {
    if (!Number.isInteger(query.asOfFy) || query.asOfFy < 1900 || query.asOfFy > 2200) {
      throw new BadRequestException('asOfFy must be a fiscal year between 1900 and 2200.');
    }
    const knownAt = query.knownAt
      ? new Date(query.knownAt)
      : query.cursor && cursorKnownAt(query.cursor)
        ? new Date(cursorKnownAt(query.cursor)!)
        : new Date();
    if (Number.isNaN(knownAt.getTime())) throw new BadRequestException('knownAt must be a valid timestamp.');
    const includeCandidates = query.includeCandidates === true;
    const cursorScope: Omit<CursorValue, 'recordedAt' | 'id'> = {
      v: 1 as const,
      asOfFy: query.asOfFy,
      knownAt: knownAt.toISOString(),
      includeCandidates,
      identityKind: query.identityKind,
      sourceSystem: query.sourceSystem,
      sourceIdentifier: query.sourceIdentifier,
    };
    const cursor = decodeCursor(query.cursor, cursorScope);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const cursorFilter = cursor
      ? Prisma.sql`AND (x.recorded_at < ${new Date(cursor.recordedAt)} OR (x.recorded_at = ${new Date(cursor.recordedAt)} AND x.id > ${cursor.id}::uuid))`
      : Prisma.empty;
    const statusFilter = includeCandidates
      ? Prisma.sql`AND x.review_status IN ('accepted', 'candidate')`
      : Prisma.sql`AND x.review_status = 'accepted'`;
    const kindFilter = query.identityKind
      ? Prisma.sql`AND x.identity_kind = ${query.identityKind}`
      : Prisma.empty;
    const systemFilter = query.sourceSystem
      ? Prisma.sql`AND x.source_system = ${query.sourceSystem}`
      : Prisma.empty;
    const identifierFilter = query.sourceIdentifier
      ? Prisma.sql`AND x.source_identifier = ${query.sourceIdentifier}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<CrosswalkRow[]>(Prisma.sql`
      SELECT x.id, x.program_id AS "programId", p.canonical_name AS "canonicalName",
             x.identity_kind AS "identityKind", x.source_system AS "sourceSystem",
             x.source_identifier AS "sourceIdentifier", x.relationship_kind AS "relationshipKind",
             x.valid_from_fy AS "validFromFy", x.valid_to_fy AS "validToFy",
             x.recorded_at AS "recordedAt", x.supersedes_id AS "supersedesId",
             x.source, x.source_url AS "sourceUrl", x.source_document_id AS "sourceDocumentId",
             x.evidence_jsonb AS evidence, x.confidence, x.review_status AS "reviewStatus",
             x.reviewed_at AS "reviewedAt"
      FROM program_identity_crosswalk x
      JOIN program p ON p.id = x.program_id
      WHERE x.recorded_at <= ${knownAt}
        AND (x.valid_from_fy IS NULL OR x.valid_from_fy <= ${query.asOfFy})
        AND (x.valid_to_fy IS NULL OR x.valid_to_fy >= ${query.asOfFy})
        AND NOT EXISTS (
          SELECT 1 FROM program_identity_crosswalk newer
          WHERE newer.supersedes_id = x.id AND newer.recorded_at <= ${knownAt}
        )
        ${statusFilter} ${kindFilter} ${systemFilter} ${identifierFilter} ${cursorFilter}
      ORDER BY x.recorded_at DESC, x.id ASC
      LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => ({
        id: row.id,
        program: { id: row.programId, canonicalName: row.canonicalName },
        sourceIdentity: {
          kind: row.identityKind,
          system: row.sourceSystem,
          identifier: row.sourceIdentifier,
        },
        relationshipKind: row.relationshipKind,
        validTime: { fromFy: row.validFromFy, toFy: row.validToFy },
        systemTime: { recordedAt: row.recordedAt, supersedesId: row.supersedesId },
        evidence: row.evidence,
        provenance: { source: row.source, sourceUrl: row.sourceUrl, sourceDocumentId: row.sourceDocumentId },
        confidence: row.confidence,
        review: { status: row.reviewStatus, reviewedAt: row.reviewedAt },
        path: [
          { type: 'source_identity', kind: row.identityKind, system: row.sourceSystem, identifier: row.sourceIdentifier },
          { type: 'program', id: row.programId, canonicalName: row.canonicalName },
        ],
      })),
      asOfFy: query.asOfFy,
      knownAt: knownAt.toISOString(),
      nextCursor: hasMore && last ? encodeCursor(last, cursorScope) : null,
      // Identity links carry no dollar-allocation or funding inference.
      attribution: 'identity_relationship_only',
    };
  }
}
