import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { BusinessDevelopmentService } from '../business-development/business-development.service.js';
import { BizDevDossierService } from '../business-development/bizdev-dossier.service.js';
import { BizDevBriefService } from '../business-development/bizdev-brief.service.js';
import {
  BRIEF_CITATION_CAP,
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
import { BizDevWatchService } from '../business-development/bizdev-watch.service.js';
import { BusinessDevelopmentWatchFlagGuard } from '../business-development/bizdev-watch.flag.guard.js';
import type { BizDevMaterialFieldChange } from '../business-development/bizdev-watch.types.js';
import { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';
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
  'alertId',
  'watchId',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Newest-first history window for get_business_development_context. */
const CONTEXT_HISTORY_LIMIT = 20;
/** Flattened evidence cap for get_business_development_evidence. */
const EVIDENCE_RECORD_CAP = 24;
/** Idempotency key bound (BRIEF_IDEMPOTENCY_KEY_MAX). */
const IDEMPOTENCY_KEY_MAX = 400;
/** Default/max alert page for get_business_development_recent_changes. */
const RECENT_CHANGES_LIMIT_DEFAULT = 10;
const RECENT_CHANGES_LIMIT_MAX = 25;

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
  'uei',
  'cageCode',
  'dbaName',
  'physicalAddress',
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
    // Phase 5 — read-only alert inbox access (one-way Meri → BD import).
    // Optional so non-DI consumers (specs) keep constructing positionally;
    // an actual recent-changes call without them wired is a server
    // misconfiguration, not a silent no-op (see getRecentChanges).
    private readonly watchService?: BizDevWatchService,
    private readonly watchFlagGuard?: BusinessDevelopmentWatchFlagGuard,
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
    // SAM's normalized business address only, never arbitrary nested fields.
    const address = facts.physicalAddress;
    if (address && typeof address === 'object' && !Array.isArray(address)) {
      facts.physicalAddress = Object.fromEntries(
        Object.entries(address).filter(([key, value]) =>
          ['line1', 'line2', 'city', 'state', 'zip', 'country'].includes(key) &&
          (value === null || typeof value === 'string'),
        ),
      );
    } else if (address !== null) {
      delete facts.physicalAddress;
    }
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

  /**
   * Descriptive free-text fact keys that may be safely excerpted (600 chars)
   * without changing meaning. Everything else is exact-or-omitted: factual
   * keys (amounts, dates, IDs, program codes…) are NEVER substring-cut.
   */
  private static readonly DESCRIPTIVE_FACT_KEYS = new Set([
    'description',
    'meaning',
    'ambiguityWarning',
    'distinctMeaning',
    'contextOnly',
  ]);
  private static readonly DESCRIPTIVE_FACT_STRING_MAX = 600;
  private static readonly DESCRIPTIVE_FACT_ARRAY_MAX = 12;

  /**
   * Bound oversized descriptive facts so one record cannot eat the whole
   * model-visible budget. Factual keys (amount/amountType/dates/IDs/program
   * codes) are kept EXACT or omitted with an explicit marker — never
   * substring-cut. Only whitelisted descriptive keys get a 600-char excerpt;
   * retained array elements are bounded too; truncated field names are
   * reported honestly in `factsTruncated` and omitted ones in
   * `factsOmitted`.
   */
  private static boundFacts(facts: Record<string, unknown>): {
    facts: Record<string, unknown>;
    factsTruncated: string[];
    factsOmitted: string[];
  } {
    const bounded: Record<string, unknown> = {};
    const truncated: string[] = [];
    const omitted: string[] = [];
    const excerpt = (value: string) =>
      `${value.slice(0, MeriBizDevToolsService.DESCRIPTIVE_FACT_STRING_MAX)}…[truncated]`;
    for (const [key, value] of Object.entries(facts)) {
      if (MeriBizDevToolsService.DESCRIPTIVE_FACT_KEYS.has(key)) {
        if (typeof value === 'string' && value.length > MeriBizDevToolsService.DESCRIPTIVE_FACT_STRING_MAX) {
          bounded[key] = excerpt(value);
          truncated.push(key);
        } else if (Array.isArray(value)) {
          let elementTruncated = false;
          const elements = value.slice(0, MeriBizDevToolsService.DESCRIPTIVE_FACT_ARRAY_MAX).map((element) => {
            if (
              typeof element === 'string' &&
              element.length > MeriBizDevToolsService.DESCRIPTIVE_FACT_STRING_MAX
            ) {
              elementTruncated = true;
              return excerpt(element);
            }
            return element;
          });
          const overCount = value.length > MeriBizDevToolsService.DESCRIPTIVE_FACT_ARRAY_MAX;
          bounded[key] = elements;
          if (elementTruncated || overCount) truncated.push(key);
        } else {
          bounded[key] = value;
        }
        continue;
      }
      // Non-descriptive key: exact or explicitly-unsupported, never cut.
      const size = JSON.stringify(value) ?? '';
      if (size.length <= MeriBizDevToolsService.DESCRIPTIVE_FACT_STRING_MAX) {
        bounded[key] = value;
      } else {
        omitted.push(key);
      }
    }
    return { facts: bounded, factsTruncated: truncated, factsOmitted: omitted };
  }

  /**
   * One full authorized record as the model-visible `data` row: the complete
   * projectEvidenceItem projection (identity, locators, strength, separated
   * dates, stage, status, bounded facts) PLUS the compact citation aliases
   * (id/url/snippet) the shared collector reads. The citation labels never
   * come alone — the exact facts/amounts/dates ride in the SAME row so they
   * survive the orchestrator's row-wise evidence projection.
   */
  private static evidenceDataRow(item: EvidenceItem): Record<string, unknown> {
    const projected = MeriBizDevToolsService.projectEvidenceItem(item);
    const { facts, factsTruncated, factsOmitted } =
      MeriBizDevToolsService.boundFacts(projected.facts as Record<string, unknown>);
    return {
      ...projected,
      id: item.recordId ?? item.originalSourceId ?? '',
      url: item.locator,
      snippet: [
        item.title,
        item.originalSourceName,
        item.eventDate ? `event ${item.eventDate}` : null,
      ]
        .filter(Boolean)
        .join(' — '),
      facts,
      ...(factsTruncated.length ? { factsTruncated } : {}),
      ...(factsOmitted.length
        ? {
            factsOmitted,
            factsOmittedNote:
              'These factual fields were too large to include exactly and were omitted rather than cut; treat them as unsupported here.',
          }
        : {}),
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
    const capped = all.slice(0, EVIDENCE_RECORD_CAP);
    // ONE full-fact payload: `data` carries the complete authorized records
    // (with citation aliases), and `evidence` shrinks to count metadata — no
    // second copy of the facts. The shared collector reads `data`, and the
    // orchestrator projection keeps whole rows, so each visible row is a
    // COMPLETE factual record, never a title-only label.
    const data = capped.map((item) =>
      MeriBizDevToolsService.evidenceDataRow(item),
    );
    const factsPartial = data.some((row) => row.factsTruncated || row.factsOmitted);
    return {
      tool: 'get_business_development_evidence',
      generatedAt: dossier.generatedAt,
      identityBasis: dossier.identityBasis,
      canonicalEntityId: dossier.canonicalEntityId,
      canonicalName: dossier.canonicalName,
      sectionStates: dossier.sectionStates,
      data,
      evidence: {
        total: all.length,
        returned: capped.length,
        truncated: all.length > capped.length,
      },
      coverage: {
        complete: all.length <= EVIDENCE_RECORD_CAP,
        partial:
          capped.length < all.length ||
          factsPartial ||
          dossier.sectionStates.some(
            (section) =>
              section.status !== 'available' && section.status !== 'empty_in_queried_scope',
          ),
        note:
          all.length > EVIDENCE_RECORD_CAP
            ? `Only the first ${EVIDENCE_RECORD_CAP} of ${all.length} evidence records are included; this is a partial view.`
            : factsPartial
              ? 'All available evidence records are included, but marked facts were excerpted or omitted; this is a partial factual view.'
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
      // Bounded official-citation rows through the existing `data`
      // contract so brief sources stay citable even when the full
      // five-section payload exceeds the model-visible budget. The cap
      // only bounds these ADDED compact rows; the persisted brief above
      // (sections + full citation index) is returned verbatim, never
      // truncated or renumbered. Locators come only from the saved
      // authorized citations — nothing is invented.
      ...(currentVersion.citations.length
        ? {
            data: currentVersion.citations
              .slice(0, BRIEF_CITATION_CAP)
              .map((citation) => ({
                id: citation.recordId,
                title: citation.title,
                url: citation.locator,
                snippet: [
                  citation.originalSourceName,
                  citation.stage ? `stage: ${citation.stage}` : null,
                ]
                  .filter(Boolean)
                  .join(' — '),
                sourceFamily: citation.sourceFamily,
              })),
            citationsSummary: {
              total: currentVersion.citations.length,
              returned: Math.min(currentVersion.citations.length, BRIEF_CITATION_CAP),
              truncated: currentVersion.citations.length > BRIEF_CITATION_CAP,
              note:
                currentVersion.citations.length > BRIEF_CITATION_CAP
                  ? `Only the first ${BRIEF_CITATION_CAP} of ${currentVersion.citations.length} brief citations are shown as compact rows; the full citation list is in brief.citations.`
                  : 'All brief citations are shown as compact rows.',
            },
          }
        : {}),
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
    if (!resolved.resolvable) {
      // No citation row for ANY unresolvable outcome — including
      // source_changed, where the old citation metadata still exists but
      // the record is in neither the saved snapshot nor the current
      // dossier. The citation metadata is echoed for transparency only.
      return {
        tool: 'resolve_business_development_source',
        generatedAt: new Date().toISOString(),
        resolvable: false,
        limitation: resolved.limitation,
        message: resolved.message,
        citation: resolved.citation,
      };
    }
    // Results only when a server-resolved EvidenceItem actually backs the
    // citation (snapshot and/or current dossier). The row is the FULL
    // authorized projection of that record — exact facts, amounts, dates,
    // stage, relationship and locators — plus the citation metadata, so the
    // facts survive the orchestrator's row-wise 12K projection. Source
    // authority is only the existing server-resolved record: record ids and
    // URLs come verbatim from it, never invented.
    const evidenceItem =
      resolved.currentDossierEvidence ?? resolved.sourceSnapshotEvidence;
    const basis: 'current_dossier' | 'snapshot_only' | 'none' = resolved.currentDossierEvidence
      ? 'current_dossier'
      : resolved.sourceSnapshotEvidence
        ? 'snapshot_only'
        : 'none';
    return {
      tool: 'resolve_business_development_source',
      generatedAt: new Date().toISOString(),
      resolvable: true,
      citation: resolved.citation,
      basis,
      // Truthful basis: a snapshot-only match is NOT live current data.
      ...(basis === 'snapshot_only'
        ? {
            basisNote:
              'This record matches the saved brief snapshot only; it is not currently in the prospect dossier, so it may no longer be live current data.',
          }
        : basis === 'none'
          ? {
              basisNote:
                'The citation resolves, but no underlying evidence record backs it in either the snapshot or the current dossier; only the saved citation metadata is available.',
            }
          : {}),
      ...(evidenceItem
        ? {
            results: [
              {
                ...MeriBizDevToolsService.evidenceDataRow(evidenceItem),
                basis,
                citation: {
                  recordId: resolved.citation.recordId,
                  title: resolved.citation.title,
                  locator: resolved.citation.locator,
                  sourceFamily: resolved.citation.sourceFamily,
                  originalSourceName: resolved.citation.originalSourceName,
                  stage: resolved.citation.stage,
                },
              },
            ],
          }
        : {}),
    };
  }

  // ── get_business_development_recent_changes ───────────────────────────────

  /**
   * Phase 5 — read-only summary of already-ingested prospect alerts.
   *
   * The ONLY authority source is the persisted conversation scope
   * (authorizeScope); no model-provided prospect/alert/watch id is ever
   * trusted. Reads the tenant alert inbox through BizDevWatchService
   * .listProspectAlerts (a read-only tenant-scoped query; it never mutates
   * read/dismiss state and never touches a provider) and then reads the
   * structured changed fields already persisted on the alert rows. Raw
   * before/after state payloads, private notes and conflict reasons are
   * never exposed; `implication` is passed through verbatim with an
   * inference label so the model cannot sharpen its conditional language.
   */
  async getRecentChanges(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertMeriToolRequestActive();
    // Input contract: ONLY conversationId and optional limit. Unknown extra
    // keys are rejected before any read so direct dispatch cannot smuggle
    // ignored fields past the schema.
    const allowedKeys = new Set(['conversationId', 'limit']);
    for (const key of Object.keys(input)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException(
          `Unknown input key "${key}"; only conversationId and limit are accepted`,
        );
      }
    }
    const { prospectId, scope } = await this.authorizeScope(ctx, input);

    let limit = RECENT_CHANGES_LIMIT_DEFAULT;
    if (input.limit !== undefined) {
      if (
        typeof input.limit !== 'number' ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > RECENT_CHANGES_LIMIT_MAX
      ) {
        throw new BadRequestException(
          `limit must be an integer between 1 and ${RECENT_CHANGES_LIMIT_MAX}`,
        );
      }
      limit = input.limit;
    }

    if (!this.watchService || !this.watchFlagGuard) {
      // Server misconfiguration, not a silent no-op — same policy as
      // MeriToolsService.requireBizDevTools. BOTH the read service and the
      // watch flag gate are required: missing either fails closed.
      throw new NotFoundException('Meri tool not found');
    }
    // Fail closed on the per-tenant watch flag (global + tenant settings
    // check inside assertEnabledForTenant).
    await this.watchFlagGuard.assertEnabledForTenant(ctx.tenantId);

    const page = await this.watchService.listProspectAlerts(ctx, prospectId, {
      limit,
    });

    // Structured changed fields are persisted per alert (changes_jsonb,
    // already allowlisted to material fields by the pure diff). Fetch them
    // for exactly the returned page — read-only, tenant-scoped.
    const changedFieldsById = new Map<string, Array<{ field: string; before: unknown; after: unknown }>>();
    if (page.items.length > 0) {
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx.businessDevelopmentAlert.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: page.items.map((item) => item.id) },
          },
          select: { id: true, changesJsonb: true },
        });
        for (const row of rows) {
          const raw = row.changesJsonb;
          if (Array.isArray(raw) && raw.length > 0) {
            changedFieldsById.set(
              row.id,
              (raw as unknown as BizDevMaterialFieldChange[]).map((change) => ({
                field: change.field,
                before: change.before ?? null,
                after: change.after ?? null,
              })),
            );
          }
        }
      });
    }

    const alerts = page.items.map((row) => ({
      id: row.id,
      sourceFamily: row.sourceFamily,
      category: row.category,
      title: row.title,
      summary: row.summary,
      materiality: row.materiality,
      dates: {
        eventAt: row.eventAt,
        effectiveAt: row.effectiveAt,
        publishedAt: row.publishedAt,
        firstObservedAt: row.firstObservedAt,
      },
      sourceLocator: row.sourceLocator,
      implication: {
        text: row.implication,
        inference: true,
        note: 'Inference drawn from the ingested change diff, not a source fact. Preserve any conditional or thematic wording.',
      },
      changedFields: changedFieldsById.get(row.id) ?? [],
    }));

    return {
      tool: 'get_business_development_recent_changes',
      generatedAt: new Date().toISOString(),
      prospect: {
        id: prospectId,
        name: scope.prospectName,
      },
      alerts: {
        items: alerts,
        returned: alerts.length,
        unreadCount: page.unreadCount,
        truncated: page.nextCursor !== null,
        limit,
        note:
          'These are already-ingested change alerts for this prospect. Reading them does not mark them read. This summary never proves bid or win intent.',
      },
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
