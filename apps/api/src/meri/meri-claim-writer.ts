import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** One claim to persist (mirrors VerifiedClaim from the verifier pass). */
export interface ClaimWriteClaim {
  claim: string;
  supported: boolean;
  /** Citation marker numbers ([N]) the claim relies on; empty for unsupported. */
  sourceIds: number[];
}

/** One numbered source the claims' [N] markers resolve against. */
export interface ClaimWriteSource {
  n: number;
  type: string;
  id: string;
  title: string;
  url?: string | null;
  snippet?: string | null;
}

export interface ClaimWriteSubject {
  subjectType: string;
  subjectId: string;
  artifactId?: string | null;
}

const MAX_CLAIMS_PER_WRITE = 50;

/**
 * Claim/Evidence store writer (Phase-0 tables, first real writer). The
 * grounding/verifier pass produces VerifiedClaim[] in-memory on every verified
 * deliverable; until now nothing persisted them, so the claim store stayed
 * empty. This writer materializes each verified claim as a `claim` row with its
 * `evidence` children (the numbered sources its [N] markers resolve to) in one
 * tenant-scoped transaction.
 *
 * FAIL-OPEN by contract: claim persistence is an audit/grounding artifact —
 * a write failure must never block or fail the turn (matches the verifier's
 * own null-on-error behavior). Callers use persistClaimsSafe.
 */
@Injectable()
export class MeriClaimWriterService {
  private readonly logger = new Logger(MeriClaimWriterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persistClaims(
    tenantId: string,
    subject: ClaimWriteSubject,
    claims: ClaimWriteClaim[],
    sources: ClaimWriteSource[],
  ): Promise<{ written: number }> {
    const byN = new Map(sources.map((s) => [s.n, s]));
    const now = new Date();
    const toWrite = claims
      .filter((c) => typeof c.claim === 'string' && c.claim.trim().length > 0)
      .slice(0, MAX_CLAIMS_PER_WRITE);
    if (!toWrite.length) return { written: 0 };

    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const c of toWrite) {
        await tx.claim.create({
          data: {
            tenantId,
            subjectType: subject.subjectType.slice(0, 60),
            subjectId: subject.subjectId.slice(0, 200),
            statement: c.claim.slice(0, 4000),
            confidence: c.supported ? 'high' : 'low',
            freshnessAt: now,
            artifactId: subject.artifactId ?? null,
            evidence: {
              create: (c.sourceIds ?? [])
                .map((n) => byN.get(n))
                .filter((s): s is ClaimWriteSource => Boolean(s))
                .map((s) => ({
                  tenantId,
                  sourceType: (s.type || 'unknown').slice(0, 60),
                  sourceId: s.id || `marker-${s.n}`,
                  url: s.url ?? null,
                  quote: s.snippet ? s.snippet.slice(0, 2000) : null,
                  accessedAt: now,
                })),
            },
          },
        });
      }
    });
    return { written: toWrite.length };
  }

  /** Fail-open wrapper for request hot paths — logs and swallows any error. */
  async persistClaimsSafe(
    tenantId: string,
    subject: ClaimWriteSubject,
    claims: ClaimWriteClaim[],
    sources: ClaimWriteSource[],
  ): Promise<void> {
    try {
      const { written } = await this.persistClaims(tenantId, subject, claims, sources);
      if (written) this.logger.debug(`persisted ${written} claims for ${subject.subjectType}`);
    } catch (e) {
      this.logger.warn(`claim persistence failed (non-blocking): ${(e as Error).message}`);
    }
  }
}
