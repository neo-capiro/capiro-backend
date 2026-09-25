import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { BusinessDevelopmentService } from '../business-development/business-development.service.js';
import { BizDevDossierService } from '../business-development/bizdev-dossier.service.js';
import { BizDevBriefService } from '../business-development/bizdev-brief.service.js';
import {
  BRIEF_SECTION_KEYS,
  BRIEF_TEXT_MAX,
  BRIEF_TITLE_MAX,
  type BriefSectionKey,
  type BriefSections,
} from '../business-development/bizdev-brief.types.js';
import type { EvidenceItem } from '../business-development/bizdev-evidence.types.js';
import {
  BizDevMeriScopeService,
  type MeriProspectScope,
} from '../business-development/bizdev-meri-scope.service.js';
import { authorizeMeriProspectScope } from './meri-prospect-scope.helpers.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';

/**
 * Business Development Phase 4 — Meri prospect tools.
 *
 * The five native handlers for prospect-scoped business-development chats:
 * read-only context, dossier evidence, current brief, citation resolution,
 * and the versioned brief save. Every handler shares one fail-closed gate:
 *
 * 1. reject authority-like keys the model must never supply;
 * 2. require a valid conversationId and an ACTIVE `clioConversation` owned
 *    by (tenantId, userId) with archivedAt:null;
 * 3. re-resolve the persisted prospect scope through
 *    `authorizeMeriProspectScope` — a missing/changed scope fails closed;
 * 4. use ONLY the returned scope.prospectId (never a model-supplied id).
 *
 * Import direction stays the one-way MeriModule → BusinessDevelopmentModule
 * edge (miri-meri-scope helpers docblock): this file imports BD services; BD
 * never imports Meri.
 */

/** Keys that smell like server authority — supplied ⇒ reject, never trust. */
const AUTHORITY_LIKE_KEYS = [
  'tenantId',
  'userId',
  'prospectId',
  'canonicalOrganizationId',
  'linkedClientId',
  'scopeVersion',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Newest-first history window for get_business_development_context. */
const CONTEXT_HISTORY_LIMIT = 20;
/** Flattened evidence cap for get_business_development_evidence. */
const EVIDENCE_RECORD_CAP = 24;
/** Idempotency key bound (BRIEF_IDEMPOTENCY_KEY_MAX). */
const IDEMPOTENCY_KEY_MAX = 400;

/** Bounded normalized dossier fields needed to reason about claims. */
const EVIDENCE_DETAIL_KEYS = new Set([
  'agency',
  'subTier',
  'amount',
  'amountType',
  'description',
  'kind',
  'matchBasis',
  'peCode',
  'peCodeSource',
  'peCodeConfidence',
  'peCodeCandidateCount',
  'dodAcqProgramCode',
  'dodAcqProgramName',
  'peEvidenceStrength',
  'meaning',
  'ambiguityWarning',
  'office',
  'noticeType',
  'responseDeadline',
  'contextOnly',
  'popState',
  'popCongressionalDistrict',
  'recipientState',
  'recipientCongressionalDistrict',
  'distinctMeaning',
  'facilityKind',
  'name',
  'city',
  'state',
  'congressionalDistrict',
  'employeeCount',
  'registrant',
  'clientOfRecord',
  'filingPeriod',
  'income',
  'issueCodes',
  'registrationStatus',
  'registrationExpirationDate',
  'entityStructure',
  'stateOfIncorporation',
  'primaryNaics',
]);

function rejectAuthorityLikeKeys(input: Record<string, unknown>): void {
  for (const key of AUTHORITY_LIKE_KEYS) {
    if (key in input) {
      throw new BadRequestException(
        `${key} is controlled by the server and may not be supplied`,
      );
    }
  }
}

function requiredConversationId(input: Record<string, unknown>): string {
  const conversationId = input.conversationId;
  if (
    typeof conversationId !== 'string' ||
    !UUID_RE.test(conversationId)
  ) {
    throw new BadRequestException(
      'A valid conversationId for this prospect chat is required.',
    );
  }
  return conversationId;
}

@Injectable()
export class MeriBizDevToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: BizDevMeriScopeService,
    private readonly businessDevelopment: BusinessDevelopmentService,
    private readonly dossierService: BizDevDossierService,
    private readonly briefService: BizDevBriefService,
  ) {}

  /**
   * The shared fail-closed gate: authority-key rejection → conversation
   * ownership → prospect-scope re-resolution. Returns the ONLY prospectId
   * the handler may use.
   */
  private async authorizeScope(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<{ prospectId: string; scope: MeriProspectScope }> {
    rejectAuthorityLikeKeys(input);
    const conversationId = requiredConversationId(input);
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, metadata: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    const scope = await authorizeMeriProspectScope(
      this.scopeService,
      ctx,
      conversation.metadata,
    );
    if (!scope) {
      throw new BadRequestException(
        'This conversation is not scoped to a business-development prospect.',
      );
    }
    return { prospectId: scope.prospectId, scope };
  }

  // ── get_business_development_context ─────────────────────────────────────

  async getContext(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    const { prospectId } = await this.authorizeScope(ctx, input);
    const [prospect, preferences, history] = await Promise.all([
      this.businessDevelopment.get(ctx, prospectId),
      this.businessDevelopment.getPreferences(ctx),
      this.businessDevelopment.history(ctx, prospectId),
    ]);
    // Newest 20, projected to minimum safe fields. History returns oldest →
    // newest; the model wants the recent tail, and ids/kind/body/time/actor
    // id is all a conversation needs — never the before/after payloads.
    const recent = [...history]
      .slice(-CONTEXT_HISTORY_LIMIT)
      .reverse()
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        body: entry.body,
        at: entry.createdAt.toISOString(),
        actorUserId: entry.actorUserId,
      }));
    return {
      tool: 'get_business_development_context',
      generatedAt: new Date().toISOString(),
      prospect: {
        id: prospect.id,
        displayName: prospect.displayName,
        ownerUserId: prospect.ownerUserId,
        stage: prospect.stage,
        serviceHypothesis: prospect.serviceHypothesis,
        geography: prospect.geography,
        nextAction: prospect.nextAction,
        canonicalEntityId: prospect.canonicalEntityId,
        linkedClientId: prospect.linkedClientId,
      },
      firmPreferences: {
        practiceServiceAreas: preferences?.practiceServiceAreas ?? [],
        agenciesIssues: preferences?.agenciesIssues ?? [],
        geographies: preferences?.geographies ?? [],
      },
      history: {
        entries: recent,
        total: history.length,
        returned: recent.length,
        truncated: history.length > recent.length,
      },
    };
  }

  // ── get_business_development_evidence ─────────────────────────────────────

  /**
   * Flatten one evidence item to the fields the model may see: stable ids,
   * locators, strength, factual fields and the separated dates. The free-form
   * provider detail payload is dropped (contact/provider payloads stay out).
   */
  private static projectEvidenceItem(item: EvidenceItem): Record<string, unknown> {
    const facts = Object.fromEntries(
      Object.entries(item.detail).filter(([key]) => EVIDENCE_DETAIL_KEYS.has(key)),
    );
    return {
      sourceFamily: item.sourceFamily,
      recordId: item.recordId,
      locator: item.locator,
      originalSourceName: item.originalSourceName,
      originalSourceId: item.originalSourceId,
      claimType: item.claimType,
      relationshipStrength: item.relationshipStrength,
      eventDate: item.eventDate,
      effectiveDate: item.effectiveDate,
      fiscalYear: item.fiscalYear,
      stage: item.stage,
      sourceUpdatedAt: item.sourceUpdatedAt,
      retrievedAt: item.fetchedAt,
      scopeChecked: item.scopeChecked,
      status: item.status,
      title: item.title,
      facts,
    };
  }

  async getEvidence(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    const { prospectId } = await this.authorizeScope(ctx, input);
    // Local dossier read only (suppressJev: never schedule Jev evaluation from
    // a Meri tool read, and the dossier itself never calls providers live).
    const dossier = await this.dossierService.prospectDossier(
      ctx,
      prospectId,
      undefined,
      true,
    );
    const all: EvidenceItem[] = [];
    for (const section of Object.values(dossier.sections)) {
      if (section?.evidence) all.push(...section.evidence);
    }
    const records = all
      .slice(0, EVIDENCE_RECORD_CAP)
      .map((item) => MeriBizDevToolsService.projectEvidenceItem(item));
    return {
      tool: 'get_business_development_evidence',
      generatedAt: dossier.generatedAt,
      identityBasis: dossier.identityBasis,
      canonicalEntityId: dossier.canonicalEntityId,
      canonicalName: dossier.canonicalName,
      sectionStates: dossier.sectionStates,
      evidence: {
        records,
        total: all.length,
        returned: records.length,
        truncated: all.length > records.length,
      },
      coverage: {
        complete: all.length <= EVIDENCE_RECORD_CAP,
        partial:
          records.length < all.length ||
          dossier.sectionStates.some(
            (section) =>
              section.status !== 'available' && section.status !== 'empty_in_queried_scope',
          ),
        note:
          all.length > EVIDENCE_RECORD_CAP
            ? `Only the first ${EVIDENCE_RECORD_CAP} of ${all.length} evidence records are included; this is a partial view.`
            : 'All available evidence records are included.',
      },
    };
  }

  // ── get_business_development_brief ────────────────────────────────────────

  async getBrief(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    const { prospectId } = await this.authorizeScope(ctx, input);
    const { brief, currentVersion } = await this.briefService.getCurrentBrief(
      ctx,
      prospectId,
    );
    if (!brief || !currentVersion) {
      return {
        tool: 'get_business_development_brief',
        generatedAt: new Date().toISOString(),
        brief: null,
        message:
          'No saved brief exists for this prospect yet. Ask the user to create the initial brief from the Brief tab.',
      };
    }
    return {
      tool: 'get_business_development_brief',
      generatedAt: new Date().toISOString(),
      brief: {
        id: brief.id,
        title: brief.title,
        status: brief.status,
        currentVersionNumber: currentVersion.versionNumber,
        updatedAt: brief.updatedAt,
        sections: currentVersion.sections,
        citations: currentVersion.citations,
      },
    };
  }

  // ── resolve_business_development_source ───────────────────────────────────

  async resolveSource(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    const { prospectId } = await this.authorizeScope(ctx, input);
    const citationIndex = input.citationIndex;
    if (typeof citationIndex !== 'number' || !Number.isInteger(citationIndex) || citationIndex < 0) {
      throw new BadRequestException('citationIndex must be a non-negative integer');
    }
    const resolved = await this.briefService.resolveCitation(
      ctx,
      prospectId,
      citationIndex,
    );
    return {
      tool: 'resolve_business_development_source',
      generatedAt: new Date().toISOString(),
      ...resolved,
    };
  }

  // ── save_business_development_brief ───────────────────────────────────────

  /**
   * Normalize sections for the idempotency fingerprint: exactly the five keys,
   * sorted, text trimmed, citation indexes deduped+sorted. Same content ⇒
   * same key; different content ⇒ different key.
   */
  private static normalizeSectionsForHash(
    sections: BriefSections,
  ): Record<string, { text: string; citationIndexes: number[] }> {
    const normalized: Record<string, { text: string; citationIndexes: number[] }> = {};
    for (const key of [...BRIEF_SECTION_KEYS].sort()) {
      const section = sections[key];
      normalized[key] = {
        text: section.text.trim(),
        citationIndexes: [...new Set(section.citationIndexes)].sort((a, b) => a - b),
      };
    }
    return normalized;
  }

  async saveBrief(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    const { prospectId, scope } = await this.authorizeScope(ctx, input);

    const expectedVersionNumber = input.expectedVersionNumber;
    if (
      typeof expectedVersionNumber !== 'number' ||
      !Number.isInteger(expectedVersionNumber) ||
      expectedVersionNumber < 1
    ) {
      throw new BadRequestException('expectedVersionNumber must be a positive integer');
    }

    const title =
      typeof input.title === 'string' && input.title.trim()
        ? input.title.trim().slice(0, BRIEF_TITLE_MAX)
        : undefined;

    // Exactly five sections, each { text, citationIndexes }. Authority-like
    // provenance is never accepted from the model — it is forced to
    // 'generated' below.
    const rawSections = input.sections;
    if (!rawSections || typeof rawSections !== 'object' || Array.isArray(rawSections)) {
      throw new BadRequestException('sections must be an object');
    }
    const sectionRecord = rawSections as Record<string, unknown>;
    const keys = Object.keys(sectionRecord).sort();
    const expectedKeys = [...BRIEF_SECTION_KEYS].sort();
    if (keys.join('|') !== expectedKeys.join('|')) {
      throw new BadRequestException(
        `sections must contain exactly the five brief sections: ${BRIEF_SECTION_KEYS.join(', ')}`,
      );
    }
    const parsed = new Map<
      BriefSectionKey,
      { text: string; citationIndexes: number[] }
    >();
    for (const key of keys as BriefSectionKey[]) {
      const raw = sectionRecord[key];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(`sections.${key} must be an object`);
      }
      const record = raw as Record<string, unknown>;
      if (Object.keys(record).sort().join('|') !== 'citationIndexes|text') {
        throw new BadRequestException(
          `sections.${key} may only contain text and citationIndexes`,
        );
      }
      if (typeof record.text !== 'string' || record.text.trim().length < 1) {
        throw new BadRequestException(`sections.${key}.text is required`);
      }
      if (record.text.length > BRIEF_TEXT_MAX) {
        throw new BadRequestException(
          `sections.${key}.text must contain no more than ${BRIEF_TEXT_MAX} characters`,
        );
      }
      if (
        !Array.isArray(record.citationIndexes) ||
        record.citationIndexes.some(
          (index) =>
            typeof index !== 'number' || !Number.isInteger(index) || index < 0,
        )
      ) {
        throw new BadRequestException(
          `sections.${key}.citationIndexes must be an array of non-negative integers`,
        );
      }
      // Provenance is server-forced: a generated brief edit from Meri is a
      // generated version, and the model cannot claim otherwise.
      parsed.set(key, {
        text: record.text.trim(),
        citationIndexes: [
          ...new Set(record.citationIndexes as number[]),
        ].sort((a: number, b: number) => a - b),
      });
    }
    const sections: BriefSections = {
      companyAndFirmImplication: {
        ...parsed.get('companyAndFirmImplication')!,
        provenance: 'generated',
      },
      verifiedEvidence: { ...parsed.get('verifiedEvidence')!, provenance: 'generated' },
      judgment: { ...parsed.get('judgment')!, provenance: 'generated' },
      practicalAction: { ...parsed.get('practicalAction')!, provenance: 'generated' },
      missingInformation: { ...parsed.get('missingInformation')!, provenance: 'generated' },
    };

    // Deterministic idempotency key over the versioned prefix + conversation +
    // expected version + normalized content. Same content retried under the
    // same conversation/version replays; different content differs.
    const fingerprintPayload = JSON.stringify({
      prefix: 'meri-bizdev-brief-save-v1',
      conversationId: requiredConversationId(input),
      expectedVersionNumber,
      title: title ?? null,
      sections: MeriBizDevToolsService.normalizeSectionsForHash(sections),
    });
    const idempotencyKey = `meri-bizdev-brief:${createHash('sha256')
      .update(fingerprintPayload, 'utf8')
      .digest('hex')}`.slice(0, IDEMPOTENCY_KEY_MAX);

    let saved;
    try {
      saved = await this.briefService.saveEditedVersion(ctx, prospectId, {
        idempotencyKey,
        expectedVersionNumber,
        title,
        sections,
      });
    } catch (error) {
      // A prospect without any brief has nothing to save a version onto; the
      // model cannot create the initial version (that is a human Brief-tab
      // action), so convert to a bounded instruction instead of a raw 404.
      if (error instanceof NotFoundException) {
        throw new BadRequestException(
          'This prospect has no brief yet. Ask the user to create the initial brief from the Brief tab first.',
        );
      }
      throw error;
    }

    return {
      tool: 'save_business_development_brief',
      status: 'saved',
      generatedAt: new Date().toISOString(),
      brief: {
        id: saved.brief.id,
        title: saved.brief.title,
        status: saved.brief.status,
        currentVersionNumber: saved.version.versionNumber,
        updatedAt: saved.brief.updatedAt,
      },
      version: {
        id: saved.version.id,
        versionNumber: saved.version.versionNumber,
        createdAt: saved.version.createdAt,
        citationCount: saved.version.citations.length,
      },
      reused: saved.created === false,
      prospectName: scope.prospectName,
    };
  }
}
