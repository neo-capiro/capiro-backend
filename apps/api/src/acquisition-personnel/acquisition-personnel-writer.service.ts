import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MatchScorerService } from './matching/match-scorer.service.js';
import { normalizeName } from './normalization/name-normalizer.js';
import { PersonRecordInput } from './types.js';

export class MissingRequiredFieldError extends BadRequestException {
  constructor(field: string) {
    super(`Missing required field: ${field}`);
    this.name = 'MissingRequiredFieldError';
  }
}

@Injectable()
export class AcquisitionPersonnelWriterService {
  private readonly logger = new Logger(AcquisitionPersonnelWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchScorer: MatchScorerService,
  ) {}

  async upsertPerson(
    record: PersonRecordInput,
    source: string,
    sourceUrl: string | undefined,
    snippet: string | undefined,
    observedAt: Date,
    confidence: number,
  ): Promise<{ inserted: boolean; person_id: string; mergedWith?: string }> {
    const fullName = (record.fullName ?? '').trim();
    if (!fullName) {
      await this.quarantine(record, 'Missing required field: full_name', source);
      throw new MissingRequiredFieldError('full_name');
    }

    const normalized = normalizeName(fullName);
    const emailDomain = this.extractEmailDomain(record.email, record.emailDomain);
    // Full email is PII: persisted when a source provides it, but the read layer
    // only surfaces it to capiro_admin (every other caller gets emailDomain).
    const fullEmail = this.normalizeFullEmail(record.email);

    const matches = await this.matchScorer.findMatches({
      fullName,
      organization: record.organization ?? undefined,
      title: record.title ?? undefined,
      emailDomain: emailDomain ?? undefined,
      programs: record.programs ?? undefined,
      peCodesMentioned: record.peCodesMentioned ?? undefined,
    });

    const top = matches[0];
    if (top && top.score >= 0.92) {
      await this.addSourceMention(top.personId, source, sourceUrl, snippet, observedAt, confidence);
      // Backfill the full email onto an existing person that lacks one (re-syncs
      // match the ~8.8k existing roster rather than inserting, so without this the
      // email would never populate). Never overwrite an email already present.
      if (fullEmail) {
        await this.prisma.acquisitionPersonnel.updateMany({
          where: { id: top.personId, email: null },
          data: { email: fullEmail, emailDomain: emailDomain ?? undefined },
        });
      }
      return { inserted: false, person_id: top.personId, mergedWith: top.personId };
    }

    const created = await this.prisma.acquisitionPersonnel.create({
      data: {
        fullName,
        nameKey: normalized.nameKey,
        service: record.service ?? null,
        organization: record.organization ?? null,
        title: record.title ?? null,
        role: record.role ?? null,
        programOfRecord: record.programOfRecord ?? null,
        pePrimary: record.pePrimary ?? null,
        peSecondary: record.peSecondary ?? [],
        emailDomain,
        email: fullEmail,
        publicProfileUrl: record.publicProfileUrl ?? null,
        confidence: this.capConfidence(confidence),
        status: 'active',
        metadata: this.toJsonValue(record.metadata ?? {}),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      },
    });

    await this.addSourceMention(created.id, source, sourceUrl, snippet, observedAt, confidence);

    if (top && top.score >= 0.7 && top.score < 0.92) {
      await this.prisma.acquisitionPersonnelMergeCandidate.create({
        data: {
          primaryPersonId: top.personId,
          secondaryPersonId: created.id,
          similarityScore: top.score,
          scoreBreakdown: this.toJsonValue(top.breakdown),
          status: 'open',
        },
      });
    }

    return { inserted: true, person_id: created.id, mergedWith: top?.personId };
  }

  async addSourceMention(
    personId: string,
    source: string,
    sourceUrl: string | undefined,
    snippet: string | undefined,
    observedAt: Date,
    confidence: number,
  ): Promise<boolean> {
    const person = await this.prisma.acquisitionPersonnel.findUnique({ where: { id: personId } });
    if (!person) return false;

    const existing = await this.prisma.acquisitionPersonnelSource.findFirst({
      where: { personId, source, sourceUrl: sourceUrl ?? null },
      orderBy: { observedAt: 'desc' },
    });

    if (existing) {
      if (
        existing.observedAt.getTime() === observedAt.getTime() &&
        existing.confidence === confidence
      )
        return false;
      await this.prisma.acquisitionPersonnelSource.update({
        where: { id: existing.id },
        data: { observedAt, snippet: snippet ?? existing.snippet, confidence },
      });
    } else {
      await this.prisma.acquisitionPersonnelSource.create({
        data: {
          personId,
          source,
          sourceUrl: sourceUrl ?? null,
          snippet: snippet ?? null,
          observedAt,
          confidence,
        },
      });
    }

    const mentions = await this.prisma.acquisitionPersonnelSource.findMany({ where: { personId } });
    const nextConfidence = this.aggregateConfidence(mentions.map((m) => m.confidence));

    await this.prisma.acquisitionPersonnel.update({
      where: { id: personId },
      data: {
        confidence: nextConfidence,
        lastSeenAt: observedAt > person.lastSeenAt ? observedAt : person.lastSeenAt,
      },
    });

    return true;
  }

  async mergePersons(primaryId: string, secondaryId: string, userId: string): Promise<void> {
    if (primaryId === secondaryId) return;
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const [primary, secondary] = await Promise.all([
        tx.acquisitionPersonnel.findUnique({ where: { id: primaryId } }),
        tx.acquisitionPersonnel.findUnique({ where: { id: secondaryId } }),
      ]);
      if (!primary || !secondary) return;

      await tx.acquisitionPersonnelSource.updateMany({
        where: { personId: secondaryId },
        data: { personId: primaryId },
      });

      const mergedPeSecondary = Array.from(
        new Set([...(primary.peSecondary ?? []), ...(secondary.peSecondary ?? [])]),
      );
      const mergedConfidence = this.aggregateConfidence([primary.confidence, secondary.confidence]);

      await tx.acquisitionPersonnel.update({
        where: { id: primaryId },
        data: {
          peSecondary: mergedPeSecondary,
          confidence: mergedConfidence,
          lastSeenAt:
            primary.lastSeenAt > secondary.lastSeenAt ? primary.lastSeenAt : secondary.lastSeenAt,
        },
      });

      await tx.acquisitionPersonnelMergeCandidate.updateMany({
        where: {
          OR: [
            { primaryPersonId: primaryId, secondaryPersonId: secondaryId },
            { primaryPersonId: secondaryId, secondaryPersonId: primaryId },
          ],
          status: 'open',
        },
        data: {
          status: 'merged',
          resolvedByUserId: userId,
          resolvedAt: new Date(),
          decisionNotes: 'merged by writer.mergePersons',
        },
      });

      await tx.acquisitionPersonnel.delete({ where: { id: secondaryId } });
    });
  }

  /**
   * Mark a person departed (departure heuristic, Step 30/36). When the status
   * actually transitions active -> departed, emit a `person_departed`
   * IntelligenceChange so the change feed surfaces it. related_client_ids are
   * the clients whose engagement_contacts link to this person; severity is
   * `notable` for senior roles (PEO / PM / Director / Senior / Chief / SES),
   * else `info`. Re-marking an already-departed person is a no-op (no duplicate
   * event).
   */
  async markDeparted(personId: string, asOfDate: Date): Promise<void> {
    const person = await this.prisma.acquisitionPersonnel.findUnique({
      where: { id: personId },
      select: {
        id: true,
        fullName: true,
        organization: true,
        role: true,
        title: true,
        status: true,
      },
    });
    if (!person) return;
    // Only fire on a genuine active -> departed transition.
    if (person.status === 'departed') return;

    // Clients whose CRM contacts are linked to this person (GLOBAL engagement_contacts
    // carry tenant_id; this read is intentionally cross-tenant because the personnel
    // table is global and the departure is a global signal — each affected client id
    // is still tenant-scoped downstream when the change feed is read).
    const linkedContacts = await this.prisma.engagementContact.findMany({
      where: { acquisitionPersonnelId: personId, clientId: { not: null } },
      select: { clientId: true },
    });
    const relatedClientIds = Array.from(
      new Set(linkedContacts.map((c) => c.clientId).filter((id): id is string => Boolean(id))),
    );

    const roleText = `${person.role ?? ''} ${person.title ?? ''}`.toLowerCase();
    const isSenior =
      /\b(peo|program executive|pm\b|program manager|director|senior|chief|ses|deputy)\b/.test(
        roleText,
      );
    const severity = isSenior ? 'notable' : 'info';

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.acquisitionPersonnel.update({
        where: { id: personId },
        data: { status: 'departed', lastSeenAt: asOfDate },
      });

      await tx.intelligenceChange.create({
        data: {
          source: 'acquisition_personnel',
          changeType: 'person_departed',
          severity,
          title: `Departure: ${person.fullName}${person.organization ? ` (${person.organization})` : ''}`,
          description: `${person.fullName}${person.title ? `, ${person.title}` : ''}${
            person.organization ? ` at ${person.organization}` : ''
          } appears to have departed (no longer present as of ${asOfDate.toISOString().slice(0, 10)}).`,
          relatedClientIds,
          relatedIssues: ['personnel_departure'],
          relatedPeCodes: [],
          data: {
            personId,
            role: person.role ?? null,
            title: person.title ?? null,
            organization: person.organization ?? null,
            asOf: asOfDate.toISOString(),
            senior: isSenior,
          },
        },
      });
    });
  }

  async quarantine(rawRecord: unknown, reason: string, source: string): Promise<void> {
    await this.prisma.acquisitionPersonnelQuarantine.create({
      data: { rawRecord: this.toJsonValue(rawRecord), reason, source },
    });
    this.logger.warn(`Acquisition personnel quarantined: ${reason} (${source})`);
  }

  private extractEmailDomain(email?: string | null, domain?: string | null): string | null {
    const source = email?.trim() || domain?.trim();
    if (!source) return null;
    const lowered = source.toLowerCase();
    if (lowered.startsWith('mailto:')) {
      const withoutScheme = lowered.replace(/^mailto:/, '').trim();
      if (!withoutScheme) return null;
      if (withoutScheme.includes('@')) return withoutScheme.split('@')[1] ?? null;
      return null;
    }
    if (lowered.includes('@')) return lowered.split('@')[1] ?? null;
    if (lowered.includes('/') || lowered.includes(' ')) return null;
    return lowered;
  }

  /** Validate + normalize a FULL email (local@domain.tld). Returns null otherwise. */
  private normalizeFullEmail(email?: string | null): string | null {
    const s = (email ?? '')
      .trim()
      .toLowerCase()
      .replace(/^mailto:/, '');
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
  }

  private aggregateConfidence(values: number[]): number {
    if (values.length === 0) return 0.5;
    let product = 1;
    for (const raw of values) {
      const value = this.capConfidence(raw);
      product *= 1 - value;
    }
    return this.capConfidence(1 - product);
  }

  private capConfidence(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    if (value <= 0) return 0;
    return Math.min(0.999, value);
  }

  private toJsonValue(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined) return {};
    return JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue;
  }
}
