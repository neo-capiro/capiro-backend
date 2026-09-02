import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * LegiWatch Phase 9 — generic canonical-provenance dispositions (Stage 4).
 *
 * A disposition is a REVIEWED, DOCUMENTED record that a canonical hearing is
 * independently established as legitimate but has no retrievable event-level
 * official observation from currently available supported official sources.
 * It is never "we failed to find a page": the artifact URI must point at a
 * persisted investigation with per-source results.
 *
 * Safety contract:
 *  - formal operator path only (no ad hoc production SQL)
 *  - exact confirmation phrase required for every mutation
 *  - refused for hearings that do not exist, already carry a RECONCILED
 *    observation, already have an active disposition, or if type / reason /
 *    artifact / reviewer / confirmation are missing or unsupported
 *  - observation provenance always wins: the DB-level self-healing trigger
 *    (migration 20280201010000) supersedes the ACTIVE disposition the moment
 *    a reconciled observation is linked; this service refuses up front and
 *    `revoke()` remains available for operator-initiated supersession
 *  - no hearing/committee identifiers are encoded here; specifics live in
 *    the artifact + details
 */

export const LEGIWATCH_PROVENANCE_DISPOSITION_TYPES = [
  'OFFICIAL_OBSERVATION_UNAVAILABLE',
] as const;

export const LEGIWATCH_PROVENANCE_DISPOSITION_REASON_CODES = [
  'CLOSED_BRIEFING_NO_PUBLIC_EVENT_RECORD',
  'OFFICIAL_ARCHIVE_NO_EVENT_RECORD',
  'UPSTREAM_EVENT_RECORD_NOT_PUBLISHED',
] as const;

export const LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION =
  'RECORD REVIEWED LEGIWATCH PROVENANCE DISPOSITION';

const DISPOSITION_TYPES = new Set<string>(LEGIWATCH_PROVENANCE_DISPOSITION_TYPES);
const DISPOSITION_REASON_CODES = new Set<string>(LEGIWATCH_PROVENANCE_DISPOSITION_REASON_CODES);
/** Credential-like keys that must never appear inside disposition details. */
const FORBIDDEN_DETAIL_KEYS = [
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'apisecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'authheader',
  'cookie',
  'credential',
  'credentials',
  'tenantid',
  'clientid',
  'watchlistid',
  'ssn',
  'email',
];

interface DispositionRow {
  id: string;
  hearingId: string;
  dispositionType: string;
  reasonCode: string;
  status: string;
  artifactUri: string;
  details: unknown;
  reviewedBy: string;
  reviewedAt: Date;
  expiresAt: Date | null;
  revokedBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class LegiWatchPhase9ProvenanceDispositionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read-only preview of exactly what the operator path would do and refuse.
   * No confirmation required; performs no writes. Run this before applying.
   */
  async preview(input: ProvenanceDispositionInput): Promise<{
    wouldApply: boolean;
    refusals: string[];
    hearingExists: boolean;
    reconciledObservations: number;
    activeDisposition: boolean;
  }> {
    const checks = await this.validate(input);
    return {
      wouldApply: checks.refusals.length === 0,
      refusals: checks.refusals,
      hearingExists: checks.hearingExists,
      reconciledObservations: checks.reconciledObservations,
      activeDisposition: checks.activeDisposition,
    };
  }

  async apply(input: ProvenanceDispositionInput): Promise<DispositionRow> {
    if (input.confirmation !== LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION) {
      throw new ConflictException(
        `Exact confirmation required: ${LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION}`,
      );
    }
    const { refusals } = await this.validate(input);
    if (refusals.length > 0) {
      throw new ConflictException(`Provenance disposition refused: ${refusals.join('; ')}`);
    }
    const created = await this.prisma.withSystem(
      async (tx) => {
        // Re-check inside the transaction: an observation may land between
        // validation and commit. Observation wins — refuse instead of writing.
        const obs = await tx.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT COUNT(*)::int AS n
           FROM hearing_source_observation
           WHERE hearing_id=$1 AND reconciliation_status='RECONCILED'`,
          input.hearingId,
        );
        if ((obs[0]?.n ?? 0) > 0) {
          throw new ConflictException(
            `hearing ${input.hearingId} gained a reconciled official observation; observation provenance supersedes any disposition`,
          );
        }
        const rows = await tx.$queryRawUnsafe<DispositionRow[]>(
          `INSERT INTO canonical_provenance_disposition
             (hearing_id, disposition_type, reason_code, status, artifact_uri,
              details, reviewed_by, reviewed_at, expires_at)
           VALUES ($1, $2, $3, 'ACTIVE', $4, $5::jsonb, $6, $7::timestamptz,
                   $8::timestamptz)
           RETURNING id::text AS id,
                     hearing_id AS "hearingId",
                     disposition_type AS "dispositionType",
                     reason_code AS "reasonCode",
                     status,
                     artifact_uri AS "artifactUri",
                     details,
                     reviewed_by AS "reviewedBy",
                     reviewed_at AS "reviewedAt",
                     expires_at AS "expiresAt",
                     revoked_by AS "revokedBy",
                     revoked_at AS "revokedAt",
                     created_at AS "createdAt"`,
          input.hearingId,
          input.dispositionType,
          input.reasonCode,
          input.artifactUri,
          JSON.stringify(input.details),
          input.reviewedBy,
          input.reviewedAt,
          input.expiresAt ?? null,
        );
        return rows[0];
      },
      { timeoutMs: DISPOSITION_TX_TIMEOUT_MS },
    );
    if (!created) throw new Error('provenance disposition insert returned no row');
    return created;
  }

  /**
   * Operator-initiated supersession/revocation. History is kept: the row is
   * marked REVOKED with durable actor/time, never deleted.
   */
  async revoke(input: {
    hearingId: string;
    actor: string;
    confirmation: string;
  }): Promise<DispositionRow> {
    const actor = boundedText(input.actor, 200);
    if (input.confirmation !== LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION) {
      throw new ConflictException(
        `Exact confirmation required: ${LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION}`,
      );
    }
    const rows = await this.prisma.$queryRawUnsafe<DispositionRow[]>(
      `UPDATE canonical_provenance_disposition
       SET status='REVOKED', revoked_by=$2, revoked_at=now()
       WHERE hearing_id=$1 AND status='ACTIVE'
       RETURNING id::text AS id,
                 hearing_id AS "hearingId",
                 disposition_type AS "dispositionType",
                 reason_code AS "reasonCode",
                 status,
                 artifact_uri AS "artifactUri",
                 details,
                 reviewed_by AS "reviewedBy",
                 reviewed_at AS "reviewedAt",
                 expires_at AS "expiresAt",
                 revoked_by AS "revokedBy",
                 revoked_at AS "revokedAt",
                 created_at AS "createdAt"`,
      input.hearingId,
      actor,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`no ACTIVE provenance disposition for hearing ${input.hearingId}`);
    }
    return row;
  }

  async listActive(): Promise<DispositionRow[]> {
    return this.prisma.$queryRawUnsafe<DispositionRow[]>(
      `SELECT id::text AS id,
              hearing_id AS "hearingId",
              disposition_type AS "dispositionType",
              reason_code AS "reasonCode",
              status,
              artifact_uri AS "artifactUri",
              details,
              reviewed_by AS "reviewedBy",
              reviewed_at AS "reviewedAt",
              expires_at AS "expiresAt",
              revoked_by AS "revokedBy",
              revoked_at AS "revokedAt",
              created_at AS "createdAt"
       FROM canonical_provenance_disposition
       WHERE status='ACTIVE'
       ORDER BY hearing_id`,
    );
  }

  /**
   * §8 pre-mutation validation. Returns the full refusal list instead of
   * throwing so `preview()` can surface everything at once; `apply()` treats
   * a non-empty list as a hard stop.
   */
  private async validate(input: ProvenanceDispositionInput): Promise<{
    refusals: string[];
    hearingExists: boolean;
    reconciledObservations: number;
    activeDisposition: boolean;
  }> {
    const refusals: string[] = [];
    const hearingId = (input.hearingId ?? '').trim();
    if (!hearingId) refusals.push('hearingId is required');

    const dispositionType = (input.dispositionType ?? '').trim();
    if (!DISPOSITION_TYPES.has(dispositionType)) {
      refusals.push(
        `unsupported dispositionType "${dispositionType || '(empty)'}"; supported: ${[...DISPOSITION_TYPES].join(', ')}`,
      );
    }
    const reasonCode = (input.reasonCode ?? '').trim();
    if (!DISPOSITION_REASON_CODES.has(reasonCode)) {
      refusals.push(
        `unsupported reasonCode "${reasonCode || '(empty)'}"; supported: ${[...DISPOSITION_REASON_CODES].join(', ')}`,
      );
    }
    if (!input.artifactUri || !input.artifactUri.trim()) {
      refusals.push('artifactUri is required');
    } else if (!/^https:\/\//i.test(input.artifactUri.trim()) &&
               !/^s3:\/\//i.test(input.artifactUri.trim()) &&
               !/^arn:/i.test(input.artifactUri.trim())) {
      refusals.push('artifactUri must be a credential-free https://, s3://, or arn: reference');
    }
    const reviewedBy = (input.reviewedBy ?? '').trim();
    if (!reviewedBy) refusals.push('reviewedBy is required');

    const reviewedAt = input.reviewedAt instanceof Date ? input.reviewedAt : undefined;
    if (!reviewedAt || !Number.isFinite(reviewedAt.getTime())) {
      refusals.push('reviewedAt must be a valid date');
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : undefined;
      if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
        refusals.push('expiresAt must be a valid date when provided');
      } else if (reviewedAt && Number.isFinite(reviewedAt.getTime()) && expiresAt <= reviewedAt) {
        refusals.push('expiresAt must be after reviewedAt');
      }
    }

    const detailRefusals = validateDetails(input.details);
    refusals.push(...detailRefusals);

    let hearingExists = false;
    let reconciledObservations = 0;
    let activeDisposition = false;
    if (hearingId) {
      const hearings = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM committee_hearing WHERE id=$1`,
        hearingId,
      );
      hearingExists = (hearings[0]?.n ?? 0) > 0;
      if (!hearingExists) refusals.push(`canonical hearing ${hearingId} does not exist`);

      const obs = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n
         FROM hearing_source_observation
         WHERE hearing_id=$1 AND reconciliation_status='RECONCILED'`,
        hearingId,
      );
      reconciledObservations = obs[0]?.n ?? 0;
      if (reconciledObservations > 0) {
        refusals.push(
          `hearing ${hearingId} already has ${reconciledObservations} reconciled official observation(s); observation provenance wins`,
        );
      }

      const active = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n
         FROM canonical_provenance_disposition
         WHERE hearing_id=$1 AND status='ACTIVE'`,
        hearingId,
      );
      activeDisposition = (active[0]?.n ?? 0) > 0;
      if (activeDisposition) {
        refusals.push(`hearing ${hearingId} already has an ACTIVE provenance disposition`);
      }
    }

    return { refusals, hearingExists, reconciledObservations, activeDisposition };
  }
}

export interface ProvenanceDispositionInput {
  hearingId: string;
  dispositionType: string;
  reasonCode: string;
  artifactUri: string;
  details: Record<string, unknown>;
  reviewedBy: string;
  reviewedAt: Date;
  expiresAt?: Date | null;
  /** Exact confirmation phrase; required for apply(), omitted by preview(). */
  confirmation?: string;
}

const DISPOSITION_TX_TIMEOUT_MS = 30_000;

function boundedText(value: string, maximum: number): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximum);
  if (!clean) throw new BadRequestException('actor is required');
  return clean;
}

/** §8.9 — tenant/customer/secret data must never enter public disposition details. */
export function validateDetails(details: Record<string, unknown>): string[] {
  const refusals: string[] = [];
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return ['details must be a JSON object'];
  }
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_DETAIL_KEYS.includes(normalized)) {
        refusals.push(`details contain forbidden key "${key}" at ${path || '$'}`);
      }
      walk(nested, path ? `${path}.${key}` : key);
    }
  };
  walk(details, '');
  return refusals;
}
