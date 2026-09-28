import { createHash } from 'node:crypto';
import { readPublicPESemanticSuggestions } from './defense-research-semantic.js';
import { parseCanonicalDecimalString } from '../defense-budget/contracts/decimal-string.js';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  TenantContext,
  DefenseContextDocumentDetailDto,
  DefenseContextDocumentListDto,
  DefenseContextDocumentRevisionDto,
  DefenseContextDocumentSummaryDto,
  DefenseContextSectionDto,
  DefenseDossierDto,
  DefenseDossierFieldDto,
  DefenseEvidenceRefDto,
  DefenseFundingCellDto,
  DefenseFundingMatrixDto,
  DefenseMilestoneDto,
  DefenseMilestonePeriodDto,
  DefenseMilestoneResponseDto,
  DefenseReferenceOccurrenceDto,
  DefenseResearchAvailability,
  DefenseOfficeSummaryDto,
  DefenseOfficeDetailDto,
  DefenseOfficeListDto,
  DefenseRelationshipListDto,
  DefenseRelationshipEdgeDto,
  OfficeStatus,
  OfficeRelation,
  DefenseAcquisitionRecordSummaryDto,
  DefenseAcquisitionRecordListDto,
  DefenseAcquisitionRecordDetailDto,
  DefenseAcquisitionRecordActionDto,
  DefenseAcquisitionCoverageGapListDto,
  AcquisitionRelationshipClass,
  DefenseSearchResponseDto,
  DefenseSearchLaneDto,
  DefenseSearchMatchDto,
  DefenseSearchQueryExpansion,
  DefenseComparisonResponseDto,
  DefenseComparisonSubjectDto,
  DefenseComparisonAlignmentDto,
  DefenseComparisonCellDto,
  DefenseComparisonMetricDto,
  DefenseProductCoverageResponseDto,
  DefenseProductCoverageRowDto,
  DefenseProductCoverageDenominatorDto,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

type SubjectType = DefenseDossierDto['subject']['type'];
type ComparisonSubjectType = SubjectType | 'context_document';
const EXPECTED_DOSSIER_FIELDS = [
  'mission',
  'plans',
  'accomplishments',
  'strategy_alignment',
  'performance_measures',
  'related_program_funding',
  'remarks',
  'analyst_questions',
] as const;

@Injectable()
export class DefenseResearchService {
  constructor(private readonly prisma: PrismaService) {}

  async dossier(subjectType: string, subjectId: string): Promise<DefenseDossierDto> {
    const type = this.subjectType(subjectType);
    if (type === 'program_element') return this.programElementDossier(subjectId);
    if (type === 'program') return this.programDossier(subjectId);
    if (type === 'project') return this.projectDossier(subjectId);
    return this.budgetLineDossier(subjectId);
  }

  async milestones(subjectType: string, subjectId: string): Promise<DefenseMilestoneResponseDto> {
    const type = this.subjectType(subjectType);
    let peCode: string | null = type === 'program_element' ? subjectId : null;
    let projectId: string | null = null;
    let projectCode: string | null = null;
    let projectLabel: string | null = null;
    if (type === 'project') {
      const project = await this.prisma.programElementProject.findFirst({
        where: this.projectWhere(subjectId),
        select: { id: true, peCode: true, projectCode: true, title: true },
      });
      if (!project) throw new NotFoundException('Defense research subject not found');
      peCode = project.peCode;
      projectId = project.id;
      projectCode = project.projectCode;
      projectLabel = project.title;
    }
    if (!peCode) {
      const subject = await this.subjectLabel(type, subjectId);
      return {
        subject,
        projectionVersion: 'defense-milestones-v1',
        milestones: [],
        coverage: {
          state: 'unavailable',
          reason:
            'Milestone schedules are currently qualified for program elements and their projects only.',
        },
      };
    }
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      include: {
        milestones: {
          include: {
            schedulePeriods: {
              include: { sourceDocument: true },
              orderBy: [{ periodRole: 'asc' }, { createdAt: 'asc' }],
            },
          },
          orderBy: { milestoneType: 'asc' },
        },
      },
    });
    if (!pe) throw new NotFoundException('Defense research subject not found');
    const rows = pe.milestones.filter((milestone) => {
      if (!projectId) return true;
      const metadata = milestone.schedulePeriods[0]?.metadata as
        Record<string, unknown> | undefined;
      return metadata?.projectId === projectId || metadata?.projectCode === projectCode;
    });
    const mapped = rows.map((milestone): DefenseMilestoneDto => {
      const periods = milestone.schedulePeriods.map((period) => this.schedulePeriod(period));
      return {
        id: milestone.id,
        projectId,
        eventCategory: this.milestoneCategory(milestone.milestoneType),
        label: milestone.milestoneType,
        status: milestone.status,
        periods,
        observedAt: milestone.lastSyncedAt.toISOString(),
        edition: milestone.schedulePeriods[0]?.sourceDocument?.sourceKey ?? null,
        history: [
          {
            revision: milestone.schedulePeriods[0]?.sourceDocument?.sha256 ?? milestone.id,
            observedAt: milestone.lastSyncedAt.toISOString(),
            periods,
          },
        ],
      };
    });
    const qualified =
      mapped.length > 0 &&
      mapped.every(
        (milestone) =>
          milestone.periods.length > 0 &&
          milestone.periods.every((period) => this.qualifiedSchedulePeriod(period)),
      );
    return {
      subject: {
        type,
        id: type === 'project' ? projectId! : subjectId,
        label: projectLabel ?? pe.title,
      },
      projectionVersion: 'defense-milestones-v1',
      milestones: mapped,
      coverage: {
        state: !mapped.length ? 'unavailable' : qualified ? 'available' : 'partial',
        reason: !mapped.length
          ? 'No stored milestone periods are available for this subject.'
          : qualified
            ? null
            : 'Some stored milestone periods lack valid typed dates or archived source-locator proof; raw rows and history are retained as partial.',
      },
    };
  }

  async fundingMatrix(
    subjectType: string,
    subjectId: string,
    knownAt?: string,
  ): Promise<DefenseFundingMatrixDto> {
    const type = this.subjectType(subjectType);
    if (knownAt)
      throw new BadRequestException(
        'Arbitrary knownAt reconstruction is unsupported; use a captured portfolio snapshot for historical reproduction.',
      );
    const subject = await this.subjectLabel(type, subjectId);
    let cells: DefenseFundingCellDto[] = [];
    if (type === 'program_element') {
      const rows = await this.prisma.programElementBudgetPosition.findMany({
        where: { peCode: subjectId },
        include: { sourceDocument: true },
        orderBy: [{ assertedFy: 'asc' }, { positionCycle: 'asc' }, { valueKind: 'asc' }],
      });
      cells = rows.map((row) => this.positionCell(row, `pe-position:${row.id}`));
    } else if (type === 'project') {
      const project = await this.prisma.programElementProject.findFirst({
        where: this.projectWhere(subjectId),
      });
      if (!project) throw new NotFoundException('Defense research subject not found');
      const rows = await this.prisma.programElementProjectBudgetPosition.findMany({
        where: { peCode: project.peCode, projectCode: project.projectCode },
        include: { sourceDocument: true },
        orderBy: [{ assertedFy: 'asc' }, { positionCycle: 'asc' }],
      });
      cells = rows.map((row) => this.positionCell(row, `project-position:${row.id}`));
    } else if (type === 'budget_line') {
      const line = await this.prisma.procurementLine.findUnique({
        where: { id: subjectId },
        include: {
          years: {
            include: { sources: { include: { sourceDocument: true } } },
            orderBy: { fy: 'asc' },
          },
        },
      });
      if (!line) throw new NotFoundException('Defense research subject not found');
      const stages = [
        'request',
        'hascMark',
        'sascMark',
        'hacDMark',
        'sacDMark',
        'conference',
        'enacted',
        'actuals',
      ] as const;
      for (const year of line.years)
        for (const stage of stages) {
          const value = year[stage];
          const evidence = year.sources
            .filter((source) => this.procurementCellProof(source, year, stage, value))
            .map((source) =>
              this.evidence(
                `procurement-source:${source.id}`,
                source.sourceDocumentId,
                source.sourceDocument?.sha256 ?? null,
                'procurement_jbook',
                source.sourceDocument?.title ?? null,
                source.sourceUrl,
                source.pageNumber,
                null,
                null,
                source.sourceDocument?.sourceKey ?? null,
                source.sourceDocument?.ingestedAt ?? null,
              ),
            );
          cells.push({
            basis: {
              requestEdition: evidence[0]?.edition ?? null,
              fundingFiscalYear: year.fy,
              stage,
              metric: 'funding',
              unit: 'usd_millions',
              currency: 'USD',
              priceBasis: null,
              knownAt: null,
              knowledgeTimeSupported: false,
            },
            value: value?.toString() ?? null,
            disposition: value == null ? 'missing' : evidence.length ? 'observed' : 'partial',
            sourceObservationId: `procurement-year:${year.id}:${stage}`,
            replacedByObservationId: null,
            evidence,
          });
        }
    }
    const years = [...new Set(cells.map((cell) => cell.basis.fundingFiscalYear))].sort();
    const editions = [
      ...new Set(
        cells
          .map((cell) => cell.basis.requestEdition)
          .filter((item): item is string => Boolean(item)),
      ),
    ].sort();
    const stages = [...new Set(cells.map((cell) => cell.basis.stage))].sort();
    const metrics = [...new Set(cells.map((cell) => cell.basis.metric))];
    return {
      subject,
      projectionVersion: 'defense-funding-matrix-v1',
      cells,
      supported: { fiscalYears: years, editions, stages, metrics, knownAt: false },
      limitations: [
        'Request edition and funding fiscal year remain separate.',
        'Arbitrary pre-capture known-at reconstruction is unsupported.',
        ...(cells.some((cell) => cell.evidence.length === 0)
          ? ['Some cells lack source-locator proof and are marked partial.']
          : []),
      ],
    };
  }

  async search(
    query: string,
    semanticEnabled = false,
    ctx?: TenantContext,
  ): Promise<DefenseSearchResponseDto> {
    const original = query?.trim() ?? '';
    if (original.length < 2 || original.length > 200)
      throw new BadRequestException('q must contain between 2 and 200 characters');
    const normalized = this.normalizeSearch(original);
    const negativeControls = [
      'retired_program_elements_excluded',
      'rejected_capability_matches_excluded',
      'substring_noise_limited',
    ];
    const [
      programElements,
      programs,
      projects,
      budgetLines,
      offices,
      acquisitions,
      contextDocuments,
      capabilities,
    ] = await Promise.all([
      this.prisma.programElement.findMany({
        where: {
          retiredAt: null,
          OR: [
            { peCode: { equals: original, mode: 'insensitive' } },
            { title: { contains: original, mode: 'insensitive' } },
            { description: { contains: original, mode: 'insensitive' } },
          ],
        },
        include: {
          sources: { include: { sourceDocument: true }, orderBy: { observedAt: 'desc' }, take: 1 },
        },
        take: 12,
      }),
      this.prisma.program.findMany({
        where: {
          status: { not: 'retired' },
          OR: [
            { canonicalName: { contains: original, mode: 'insensitive' } },
            { mdapCode: { equals: original, mode: 'insensitive' } },
            {
              aliases: {
                some: {
                  OR: [
                    { alias: { contains: original, mode: 'insensitive' } },
                    { aliasNormalized: { equals: normalized } },
                  ],
                },
              },
            },
          ],
        },
        include: { aliases: { orderBy: { confidence: 'desc' }, take: 10 } },
        take: 12,
      }),
      this.prisma.programElementProject.findMany({
        where: {
          OR: [
            { projectCode: { equals: original, mode: 'insensitive' } },
            { title: { contains: original, mode: 'insensitive' } },
            { mission: { contains: original, mode: 'insensitive' } },
          ],
        },
        include: { sourceDocument: true },
        take: 10,
      }),
      this.prisma.procurementLine.findMany({
        where: {
          OR: [
            { lineItemNumber: { equals: original, mode: 'insensitive' } },
            { title: { contains: original, mode: 'insensitive' } },
            { relatedPeCode: { equals: original, mode: 'insensitive' } },
          ],
        },
        include: {
          sources: { include: { sourceDocument: true }, orderBy: { observedAt: 'desc' }, take: 1 },
        },
        take: 10,
      }),
      this.prisma.programOffice.findMany({
        where: { status: 'active', name: { contains: original, mode: 'insensitive' } },
        take: 8,
      }),
      this.prisma.acquisitionRecordRevision.findMany({
        where: {
          OR: [
            { identityKey: { equals: original, mode: 'insensitive' } },
            { sourceRecordId: { equals: original, mode: 'insensitive' } },
            { title: { contains: original, mode: 'insensitive' } },
          ],
        },
        orderBy: { recordedAt: 'desc' },
        take: 16,
      }),
      this.prisma.defenseContextDocument.findMany({
        where: {
          eligible: true,
          qualification: 'qualified',
          OR: [
            { sourceKey: { equals: original, mode: 'insensitive' } },
            { title: { contains: original, mode: 'insensitive' } },
          ],
        },
        include: { currentRevision: true },
        take: 8,
      }),
      this.prisma.capability.findMany({
        where: {
          OR: [
            { slug: { equals: original.toLowerCase() } },
            { name: { contains: original, mode: 'insensitive' } },
            { aliases: { hasSome: [original, normalized, original.toLowerCase()] } },
          ],
        },
        include: { matches: { where: { status: 'accepted' } } },
        take: 8,
      }),
    ]);

    const exactItems: DefenseSearchMatchDto[] = [];
    for (const row of programElements) {
      const source = row.sources[0];
      const evidence = source
        ? [
            this.evidence(
              `pe-source:${source.id}`,
              source.sourceDocumentId,
              source.sourceDocument?.sha256 ?? null,
              source.docType,
              source.publisher,
              source.sourceUrl,
              source.pageNumber,
              null,
              null,
              source.sourceDocument?.sourceKey ?? null,
              source.observedAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'program_element',
          row.peCode,
          row.title,
          row.service ?? row.serviceCode,
          row.peCode.toUpperCase() === original.toUpperCase() ? 'exact_id' : 'canonical_name',
          original,
          [
            'peCode',
            row.title.toLowerCase().includes(original.toLowerCase()) ? 'title' : 'description',
          ],
          evidence,
          negativeControls,
        ),
      );
    }
    for (const row of programs) {
      const alias = row.aliases.find(
        (item) =>
          item.aliasNormalized === normalized ||
          item.alias.toLowerCase().includes(original.toLowerCase()),
      );
      const kind =
        row.id === original || row.mdapCode?.toLowerCase() === original.toLowerCase()
          ? 'exact_id'
          : alias?.aliasType === 'acronym'
            ? 'acronym'
            : alias
              ? 'alias'
              : 'canonical_name';
      const evidence = alias?.sourceUrl
        ? [
            this.evidence(
              `program-alias:${alias.id}`,
              null,
              null,
              'program_alias',
              alias.source,
              alias.sourceUrl,
              null,
              null,
              null,
              null,
              alias.createdAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'program',
          row.id,
          row.canonicalName,
          row.component,
          kind,
          original,
          alias ? [`alias:${alias.aliasType}`] : ['canonicalName'],
          evidence,
          negativeControls,
        ),
      );
    }
    for (const row of projects) {
      const evidence = row.sourceUrl
        ? [
            this.evidence(
              `project:${row.id}`,
              row.sourceDocumentId,
              row.sourceDocument?.sha256 ?? null,
              'r2a_project',
              row.sourceDocument?.title ?? null,
              row.sourceUrl,
              row.pageNumber,
              null,
              null,
              row.sourceDocument?.sourceKey ?? null,
              row.lastSyncedAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'project',
          row.id,
          row.title,
          `${row.peCode} / ${row.projectCode}`,
          row.projectCode.toLowerCase() === original.toLowerCase() ? 'exact_id' : 'canonical_name',
          original,
          [
            row.projectCode.toLowerCase() === original.toLowerCase()
              ? 'projectCode'
              : row.title.toLowerCase().includes(original.toLowerCase())
                ? 'title'
                : 'mission',
          ],
          evidence,
          negativeControls,
        ),
      );
    }
    for (const row of budgetLines) {
      const source = row.sources[0];
      const evidence = source
        ? [
            this.evidence(
              `procurement-source:${source.id}`,
              source.sourceDocumentId,
              source.sourceDocument?.sha256 ?? null,
              'procurement_jbook',
              source.sourceDocument?.title ?? source.publisher,
              source.sourceUrl,
              source.pageNumber,
              null,
              null,
              source.sourceDocument?.sourceKey ?? null,
              source.observedAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'budget_line',
          row.id,
          row.title,
          `${row.appropriationCode} / ${row.lineItemNumber}`,
          row.lineItemNumber.toLowerCase() === original.toLowerCase()
            ? 'exact_id'
            : 'canonical_name',
          original,
          [
            row.lineItemNumber.toLowerCase() === original.toLowerCase()
              ? 'lineItemNumber'
              : 'title',
          ],
          evidence,
          negativeControls,
        ),
      );
    }
    for (const row of offices) {
      const evidence = row.sourceUrl
        ? [
            this.evidence(
              `office-source:${row.id}`,
              null,
              null,
              'program_office',
              null,
              row.sourceUrl,
              null,
              null,
              null,
              null,
              row.updatedAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'office',
          row.id,
          row.name,
          row.service,
          row.id === original ? 'exact_id' : 'canonical_name',
          original,
          ['name'],
          evidence,
          negativeControls,
        ),
      );
    }
    const seenAcquisitions = new Set<string>();
    for (const row of acquisitions) {
      if (seenAcquisitions.has(row.identityKey)) continue;
      seenAcquisitions.add(row.identityKey);
      const evidence = row.sourceUrl
        ? [
            this.evidence(
              `acquisition-search:${row.id}`,
              null,
              row.contentHash,
              row.recordKind,
              row.sourceSystem,
              row.sourceUrl,
              null,
              null,
              null,
              row.sourceVersion,
              row.sourceObservedAt ?? row.recordedAt,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'acquisition',
          row.identityKey,
          row.title ?? row.sourceRecordId,
          row.recordKind,
          row.identityKey.toLowerCase() === original.toLowerCase() ||
            row.sourceRecordId.toLowerCase() === original.toLowerCase()
            ? 'exact_id'
            : 'canonical_name',
          original,
          [row.title?.toLowerCase().includes(original.toLowerCase()) ? 'title' : 'sourceRecordId'],
          evidence,
          negativeControls,
        ),
      );
    }
    for (const row of contextDocuments) {
      const revision = row.currentRevision;
      const evidence = row.sourceUrl
        ? [
            this.evidence(
              revision ? `context-search-revision:${revision.id}` : `context-search:${row.id}`,
              revision?.sourceDocumentId ?? null,
              revision?.contentHash ?? null,
              row.family,
              row.publisher,
              revision?.sourceUrl ?? row.sourceUrl,
              null,
              null,
              null,
              revision?.version ?? null,
              revision?.observedAt ?? row.updatedAt,
              revision?.id ?? null,
            ),
          ]
        : [];
      exactItems.push(
        this.searchMatch(
          'context_document',
          row.id,
          row.title,
          row.publisher,
          row.sourceKey.toLowerCase() === original.toLowerCase() ? 'exact_id' : 'canonical_name',
          original,
          [row.sourceKey.toLowerCase() === original.toLowerCase() ? 'sourceKey' : 'title'],
          evidence,
          negativeControls,
        ),
      );
    }
    const exact = this.searchLane(this.rankSearch(exactItems));

    const capabilityItems: DefenseSearchMatchDto[] = [];
    const peCodes = [
      ...new Set(
        capabilities.flatMap((capability) => capability.matches.map((match) => match.peCode)),
      ),
    ];
    const capabilityPes = peCodes.length
      ? await this.prisma.programElement.findMany({
          where: { peCode: { in: peCodes }, retiredAt: null },
          include: {
            sources: {
              include: { sourceDocument: true },
              orderBy: { observedAt: 'desc' },
              take: 1,
            },
          },
        })
      : [];
    const peByCode = new Map(capabilityPes.map((row) => [row.peCode, row]));
    for (const capability of capabilities)
      for (const match of capability.matches) {
        const pe = peByCode.get(match.peCode);
        if (!pe) continue;
        const source = pe.sources[0];
        const evidence = source
          ? [
              this.evidence(
                `pe-source:${source.id}`,
                source.sourceDocumentId,
                source.sourceDocument?.sha256 ?? null,
                source.docType,
                source.publisher,
                source.sourceUrl,
                source.pageNumber,
                null,
                null,
                source.sourceDocument?.sourceKey ?? null,
                source.observedAt,
              ),
            ]
          : [];
        capabilityItems.push({
          ...this.searchMatch(
            'program_element',
            pe.peCode,
            pe.title,
            capability.taxonomyPath,
            'capability',
            original,
            [`capability:${capability.name}`, `matchedOn:${match.matchedOn}`],
            evidence,
            negativeControls,
          ),
          score: match.confidence === 'high' ? 1 : match.confidence === 'med' ? 0.7 : 0.4,
        });
      }
    const capabilityLane = this.searchLane(this.rankSearch(capabilityItems));
    const semantic: DefenseSearchLaneDto = semanticEnabled
      ? await readPublicPESemanticSuggestions(this.prisma, ctx, original)
      : {
          status: 'disabled',
          reason:
            'Semantic search is disabled for this request; exact and governed capability results remain active.',
          items: [],
        };
    const expansionTerms = [
      ...new Set([
        normalized,
        ...capabilities
          .flatMap((row) => [row.name, row.slug, ...row.aliases])
          .filter(
            (term) =>
              this.normalizeSearch(term).includes(normalized) ||
              normalized.includes(this.normalizeSearch(term)),
          ),
      ]),
    ];
    const expansion: DefenseSearchQueryExpansion = {
      original,
      normalized,
      terms: expansionTerms,
      excludedTerms: negativeControls,
      applied: expansionTerms.length > 1,
    };
    return {
      query: original,
      expansion,
      exact,
      capability: capabilityLane,
      semantic,
      limitations: [
        'Exact and governed capability lanes use persisted source controls; individual evidence availability and limitations remain explicit.',
        'Capability results use accepted matches only.',
        'An empty lane is an abstention, not proof that no relevant record exists.',
        ...(semanticEnabled
          ? [
              'Semantic results are partial public-PE mission-similarity suggestions; current text-hash and archived source citation do not attest every indexed field at that locator or independently qualify relevance.',
            ]
          : []),
      ],
    };
  }

  async compare(
    subjectTokens: readonly string[],
    options?: {
      contextualRevisionPins: readonly {
        documentId: string;
        revisionId: string;
        sectionIds: readonly string[];
      }[];
    },
  ): Promise<DefenseComparisonResponseDto> {
    if (subjectTokens.length < 2 || subjectTokens.length > 5)
      throw new BadRequestException('Compare requires between 2 and 5 subjects');
    const parsed = subjectTokens.map((token) => {
      const split = token.indexOf(':');
      if (split < 1 || split === token.length - 1)
        throw new BadRequestException('Each subject must use type:id');
      return {
        type: this.comparisonSubjectType(token.slice(0, split)),
        id: token.slice(split + 1),
      };
    });
    const keys = parsed.map((item) => `${item.type}:${item.id}`);
    if (new Set(keys).size !== keys.length)
      throw new BadRequestException('Compare subjects must be distinct');
    const bundles = await Promise.all(
      parsed.map(async (item, index) => {
        if (item.type === 'context_document') {
          const row = await this.prisma.defenseContextDocument.findUnique({
            where: { id: this.requireUuid(item.id, 'Comparison subject not found') },
            include: {
              currentRevision: {
                include: { sourceDocument: true, sections: { orderBy: { ordinal: 'asc' } } },
              },
            },
          });
          if (!row) throw new NotFoundException('Comparison subject not found');
          const pin = options?.contextualRevisionPins.find((pin) => pin.documentId === row.id);
          const revision = pin
            ? await this.prisma.defenseContextDocumentRevision.findFirst({
                where: { id: this.requireUuid(pin.revisionId), documentId: row.id },
                include: {
                  sourceDocument: true,
                  sections: {
                    where: { id: { in: [...pin.sectionIds] } },
                    orderBy: { ordinal: 'asc' },
                  },
                },
              })
            : row.currentRevision;
          if (
            pin &&
            (!row.eligible ||
              row.qualification !== 'qualified' ||
              !revision ||
              revision.sections.length !== pin.sectionIds.length)
          )
            throw new NotFoundException('Qualified pinned comparison revision/sections not found');
          const passages =
            revision?.sections.map((section) => ({
              key: this.normalizeSearch(section.nativeLocator ?? section.label),
              label: section.label,
              value: section.contentText?.slice(0, 500) ?? null,
              availability: section.textAvailability,
              evidence: [
                this.evidence(
                  `context-compare:${section.id}`,
                  revision.sourceDocumentId,
                  revision.contentHash,
                  row.family,
                  row.publisher,
                  revision.sourceUrl ?? row.sourceUrl,
                  null,
                  section.nativeLocator,
                  null,
                  revision.version,
                  revision.observedAt,
                  revision.id,
                ),
              ],
            })) ?? [];
          return {
            key: keys[index]!,
            subject: { type: 'context_document' as const, id: row.id, label: row.title },
            funding: { cells: [] as DefenseFundingCellDto[] },
            milestones: { milestones: [] as DefenseMilestoneDto[] },
            passages,
          };
        }
        const [subject, funding, milestones] = await Promise.all([
          this.subjectLabel(item.type, item.id),
          this.fundingMatrix(item.type, item.id),
          this.milestones(item.type, item.id),
        ]);
        return { key: keys[index]!, subject, funding, milestones, passages: [] };
      }),
    );
    const subjects: DefenseComparisonSubjectDto[] = bundles.map((bundle) => ({
      key: bundle.key,
      ...bundle.subject,
      availability:
        bundle.funding.cells.length || bundle.milestones.milestones.length || bundle.passages.length
          ? 'available'
          : 'unavailable',
    }));
    const metricBases = new Map<string, DefenseFundingCellDto['basis']>();
    for (const bundle of bundles)
      for (const cell of bundle.funding.cells)
        metricBases.set(this.fundingBasisKey(cell.basis), cell.basis);
    const fundingMetrics: DefenseComparisonMetricDto[] = [...metricBases.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, basis]) => ({
        key,
        label: `${basis.metric} · FY${basis.fundingFiscalYear} · ${basis.stage}`,
        period: `FY${basis.fundingFiscalYear}`,
        metric: basis.metric,
        unit: basis.unit,
        grain: 'subject / edition / fiscal year / stage / metric',
        cells: bundles.map((bundle): DefenseComparisonCellDto => {
          const cell = bundle.funding.cells.find(
            (candidate) => this.fundingBasisKey(candidate.basis) === key,
          );
          if (!cell)
            return {
              subjectKey: bundle.key,
              value: null,
              disposition: bundle.funding.cells.length ? 'missing' : 'unavailable',
              reason: bundle.funding.cells.length
                ? 'No qualified observation exists for this exact basis.'
                : 'This subject has no qualified funding matrix.',
              evidence: [],
            };
          if (cell.value === null)
            return {
              subjectKey: bundle.key,
              value: null,
              disposition: 'missing',
              reason: 'The source does not state a value; missing is not zero.',
              evidence: cell.evidence,
            };
          return {
            subjectKey: bundle.key,
            value: cell.value,
            disposition: cell.disposition === 'observed' ? 'observed' : 'incompatible',
            reason:
              cell.disposition === 'observed'
                ? null
                : 'The value is present but its source basis is incomplete.',
            evidence: cell.evidence,
          };
        }),
      }));
    const passageLabels = new Map<string, string>();
    for (const bundle of bundles)
      for (const passage of bundle.passages)
        if (passage.key) passageLabels.set(passage.key, passage.label);
    const passageMetrics: DefenseComparisonMetricDto[] = [...passageLabels.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([passageKey, label]) => ({
        key: `passage|${passageKey}`,
        label: `Passage · ${label}`,
        period: null,
        metric: 'passage',
        unit: null,
        grain: 'document revision / native section',
        cells: bundles.map((bundle): DefenseComparisonCellDto => {
          if (bundle.subject.type !== 'context_document')
            return {
              subjectKey: bundle.key,
              value: null,
              disposition: 'incompatible',
              reason: 'Passage alignment applies only to contextual document subjects.',
              evidence: [],
            };
          const passage = bundle.passages.find((candidate) => candidate.key === passageKey);
          if (!passage)
            return {
              subjectKey: bundle.key,
              value: null,
              disposition: 'missing',
              reason: 'This exact native section is not present in the selected revision.',
              evidence: [],
            };
          if (!passage.value)
            return {
              subjectKey: bundle.key,
              value: null,
              disposition: 'unavailable',
              reason: 'The section is identified, but qualified text is unavailable.',
              evidence: passage.evidence,
            };
          return {
            subjectKey: bundle.key,
            value: passage.value,
            disposition: passage.availability === 'available' ? 'observed' : 'incompatible',
            reason:
              passage.availability === 'available'
                ? null
                : 'Only partial section text is available.',
            evidence: passage.evidence,
          };
        }),
      }));
    const metrics = [...fundingMetrics, ...passageMetrics];
    const fundingEvidence = Object.fromEntries(
      bundles.map((bundle) => [bundle.key, bundle.funding.cells.flatMap((cell) => cell.evidence)]),
    );
    const milestoneEvidence = Object.fromEntries(
      bundles.map((bundle) => [
        bundle.key,
        bundle.milestones.milestones.flatMap((milestone) =>
          milestone.periods.flatMap((period) => period.evidence),
        ),
      ]),
    );
    const passageEvidence = Object.fromEntries(
      bundles.map((bundle) => [bundle.key, bundle.passages.flatMap((passage) => passage.evidence)]),
    );
    const alignments: DefenseComparisonAlignmentDto[] = [
      {
        kind: 'funding',
        state:
          fundingMetrics.length && bundles.every((bundle) => bundle.funding.cells.length)
            ? 'aligned'
            : fundingMetrics.length
              ? 'partial'
              : 'unavailable',
        reason: fundingMetrics.length
          ? 'Cells align only on identical edition, fiscal year, stage, metric, and unit.'
          : 'No qualified funding observations are available for these subjects.',
        subjectEvidence: fundingEvidence,
      },
      {
        kind: 'milestone',
        ...this.milestoneAlignment(bundles.map((bundle) => bundle.milestones.milestones)),
        subjectEvidence: milestoneEvidence,
      },
      {
        kind: 'passage',
        state:
          passageMetrics.length && bundles.every((bundle) => bundle.passages.length)
            ? 'aligned'
            : passageMetrics.length
              ? 'partial'
              : 'unavailable',
        reason: passageMetrics.length
          ? 'Passages align only on the normalized source-native section label or locator in each selected revision.'
          : 'No contextual document sections were selected for passage alignment.',
        subjectEvidence: passageEvidence,
      },
      {
        kind: 'table',
        state:
          fundingMetrics.length && bundles.every((bundle) => bundle.funding.cells.length)
            ? 'aligned'
            : fundingMetrics.length
              ? 'partial'
              : 'unavailable',
        reason: fundingMetrics.length
          ? 'Source-native funding tables align on exact edition, fiscal year, stage, metric, and unit; incompatible bases remain separate.'
          : 'No source-qualified structured funding table cells are available for these subjects.',
        subjectEvidence: fundingEvidence,
      },
    ];
    return {
      projectionVersion: 'defense-comparison-v1',
      subjects,
      metrics,
      alignments,
      limitations: [
        'Null means missing or unavailable and is never converted to zero.',
        'Each cell retains independent evidence.',
        'Cross-grain or cross-unit values are not combined.',
      ],
    };
  }

  async productCoverage(filters: {
    perimeter?: string;
    component?: string;
    account?: string;
    family?: string;
    fiscalYear?: number;
    edition?: string;
    stage?: string;
    detail?: string;
  }): Promise<DefenseProductCoverageResponseDto> {
    if (
      filters.fiscalYear !== undefined &&
      (!Number.isInteger(filters.fiscalYear) ||
        filters.fiscalYear < 1900 ||
        filters.fiscalYear > 2200)
    )
      throw new BadRequestException('fiscalYear must be a four-digit year');
    const where = {
      ...(filters.account || filters.edition
        ? {
            AND: [
              ...(filters.account ? [{ metadata: { path: ['account'], equals: filters.account } }] : []),
              ...(filters.edition ? [{ metadata: { path: ['edition'], equals: filters.edition } }] : []),
            ],
          }
        : {}),
      ...(filters.detail
        ? {
            bundleMembers: {
              some: {
                OR: [
                  { budgetActivity: filters.detail },
                  { volume: filters.detail },
                  { memberKey: filters.detail },
                ],
              },
            },
          }
        : {}),
      ...(filters.perimeter ? { authorityTrack: filters.perimeter } : {}),
      ...(filters.component ? { component: filters.component } : {}),
      ...(filters.family ? { sourceFamily: filters.family } : {}),
      ...(filters.fiscalYear ? { fiscalYear: filters.fiscalYear } : {}),
      ...(filters.stage ? { stage: filters.stage } : {}),
    };
    const sources = await this.prisma.defenseBudgetExpectedSource.findMany({
      where,
      include: {
        observations: {
          select: {
            id: true,
            sourceDocumentId: true,
            contentSha256: true,
            observationState: true,
            supersededByObservationId: true,
          },
        },
        bundleMembers: {
          select: {
            memberKey: true,
            budgetActivity: true,
            volume: true,
            required: true,
            memberStatus: true,
            sourceDocumentId: true,
          },
        },
      },
      orderBy: [
        { fiscalYear: 'desc' },
        { sourceFamily: 'asc' },
        { component: 'asc' },
        { stage: 'asc' },
        { id: 'asc' },
      ],
      // Filter the complete cohort first and use one sentinel row to disclose truncation.
      take: 501,
    });
    const truncated = sources.length > 500;
    const scoped = sources.slice(0, 500).filter((source) => {
      const metadata = this.record(source.metadata);
      return (
        (!filters.account || metadata.account === filters.account) &&
        (!filters.edition || metadata.edition === filters.edition) &&
        (!filters.detail ||
          source.bundleMembers.some(
            (member) =>
              member.budgetActivity === filters.detail ||
              member.volume === filters.detail ||
              member.memberKey === filters.detail,
          ))
      );
    });
    const documentIds = [
      ...new Set(
        scoped.flatMap((source) => [
          ...source.observations
            .filter(
              (row) =>
                row.supersededByObservationId === null &&
                !['blocked', 'withdrawn'].includes(row.observationState),
            )
            .flatMap((row) => (row.sourceDocumentId ? [row.sourceDocumentId] : [])),
          ...source.bundleMembers.flatMap((row) =>
            row.sourceDocumentId ? [row.sourceDocumentId] : [],
          ),
        ]),
      ),
    ];
    const environment =
      process.env.APP_ENV?.trim() || process.env.CAPIRO_ENVIRONMENT?.trim() || 'unknown';
    const [candidates, pointer] = await Promise.all([
      documentIds.length
        ? this.prisma.budgetExtractionCandidateV1.findMany({
            where: { sourceDocumentId: { in: documentIds } },
            select: {
              id: true,
              sourceDocumentId: true,
              currentRunId: true,
              runs: { select: { id: true, decision: true } },
              reviewDecisions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { runId: true, decision: true },
              },
            },
          })
        : Promise.resolve([]),
      environment !== 'unknown'
        ? this.prisma.defenseBudgetActiveSnapshot.findUnique({
            where: { domain_environment: { domain: 'defense_budget', environment } },
            select: { snapshotId: true },
          })
        : Promise.resolve(null),
    ]);
    const published =
      pointer && documentIds.length
        ? await this.prisma.defenseBudgetCanonicalRow.findMany({
            where: { snapshotId: pointer.snapshotId, sourceDocumentId: { in: documentIds } },
            select: { sourceDocumentId: true },
          })
        : [];
    const publishedIds = new Set(published.map((row) => row.sourceDocumentId));
    const candidatesByDocument = new Map<string, typeof candidates>();
    for (const candidate of candidates)
      candidatesByDocument.set(candidate.sourceDocumentId, [
        ...(candidatesByDocument.get(candidate.sourceDocumentId) ?? []),
        candidate,
      ]);
    const asOf = new Date().toISOString();
    const rows: DefenseProductCoverageRowDto[] = scoped.map((source) => {
      const metadata = this.record(source.metadata);
      const currentDocuments = [
        ...new Set([
          ...source.observations
            .filter(
              (row) =>
                row.supersededByObservationId === null &&
                !['blocked', 'withdrawn'].includes(row.observationState),
            )
            .flatMap((row) => (row.sourceDocumentId ? [row.sourceDocumentId] : [])),
          ...source.bundleMembers
            .filter((row) => row.memberStatus !== 'missing')
            .flatMap((row) => (row.sourceDocumentId ? [row.sourceDocumentId] : [])),
        ]),
      ];
      const rowCandidates = currentDocuments.flatMap((id) => candidatesByDocument.get(id) ?? []);
      const qualifiedDocuments = new Set(
        rowCandidates.flatMap((candidate) => {
          const run = candidate.runs.find((item) => item.id === candidate.currentRunId);
          const review = candidate.reviewDecisions[0];
          return run?.decision === 'PASS' &&
            review?.runId === run.id &&
            review.decision === 'accept'
            ? [candidate.sourceDocumentId]
            : [];
        }),
      );
      const detail =
        source.bundleMembers.length === 1
          ? (source.bundleMembers[0]!.budgetActivity ??
            source.bundleMembers[0]!.volume ??
            source.bundleMembers[0]!.memberKey)
          : null;
      const denominator: DefenseProductCoverageDenominatorDto = {
        state: 'unknown',
        value: null,
        unit: 'physical_documents',
        reason: 'The source catalog has no completeness attestation for this cohort.',
        attestedAt: null,
      };
      return {
        perimeter: source.authorityTrack,
        component: source.component,
        account: typeof metadata.account === 'string' ? metadata.account : null,
        family: source.sourceFamily,
        fiscalYear: source.fiscalYear,
        edition: typeof metadata.edition === 'string' ? metadata.edition : null,
        stage: source.stage,
        detail,
        asOf,
        denominator,
        discovered: currentDocuments.length,
        parsed: new Set(rowCandidates.map((candidate) => candidate.sourceDocumentId)).size,
        qualified: qualifiedDocuments.size,
        published: currentDocuments.filter((id) => publishedIds.has(id)).length,
        outcome: 'unknown',
        limitations: [
          'Numerators describe observed physical documents; the complete eligible population is unattested.',
          ...(source.optional ? ['This catalog slot is optional.'] : []),
          ...(!source.bundleMembers.length
            ? ['The catalog slot has no physical bundle manifest.']
            : []),
        ],
      };
    });
    return {
      projectionVersion: 'defense-product-coverage-v1',
      filters,
      rows,
      denominatorKnown: false,
      limitations: [
        'Coverage is a customer-safe aggregate and excludes internal queues, adapter identifiers, and operator ownership.',
        'No cohort is labelled complete while its denominator is unknown.',
        ...(truncated
          ? ['This response is limited to 500 matching catalog slots; additional matching slots are omitted.']
          : []),
        'Account, edition, and detail are shown only when represented by source metadata or a physical bundle manifest.',
      ],
    };
  }

  async listContextDocuments(filters: {
    family?: string;
    publisher?: string;
    status?: string;
    limit?: number;
  }): Promise<DefenseContextDocumentListDto> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const persistedWhere = {
      ...(filters.family ? { family: filters.family } : {}),
      ...(filters.publisher
        ? { publisher: { contains: filters.publisher, mode: 'insensitive' as const } }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
    const rows = await this.prisma.defenseContextDocument.findMany({
      where: persistedWhere,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const [
      persistedObserved,
      persistedEligible,
      persistedQualified,
      persistedAvailable,
      persistedPartial,
      persistedUnavailable,
    ] = await Promise.all([
      this.prisma.defenseContextDocument.count({ where: persistedWhere }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, eligible: true } }),
      this.prisma.defenseContextDocument.count({
        where: { ...persistedWhere, qualification: 'qualified' },
      }),
      this.prisma.defenseContextDocument.count({
        where: { ...persistedWhere, coverage: 'available' },
      }),
      this.prisma.defenseContextDocument.count({
        where: { ...persistedWhere, coverage: 'partial' },
      }),
      this.prisma.defenseContextDocument.count({
        where: { ...persistedWhere, coverage: 'unavailable' },
      }),
    ]);

    const includesTranscripts =
      (!filters.family || filters.family === 'hearing_transcript') &&
      (!filters.publisher || 'govinfo'.includes(filters.publisher.toLowerCase())) &&
      (!filters.status || filters.status === 'published');
    const transcripts = includesTranscripts
      ? await this.prisma.officialHearingTranscript.findMany({
          orderBy: { date: 'desc' },
          take: Math.min(20, limit),
        })
      : [];
    const transcriptCount = includesTranscripts
      ? await this.prisma.officialHearingTranscript.count()
      : 0;

    const includesHearings = !filters.family || filters.family === 'hearing';
    const transcriptLinks = includesHearings
      ? await this.prisma.officialHearingTranscript.findMany({
          where: { hearingId: { not: null } },
          select: { hearingId: true },
        })
      : [];
    const transcriptHearingIds = [
      ...new Set(
        transcriptLinks.map((item) => item.hearingId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const hearingWhere = {
      id: { notIn: transcriptHearingIds },
      ...(filters.status ? { eventStatus: filters.status } : {}),
      ...(filters.publisher
        ? { url: { contains: filters.publisher, mode: 'insensitive' as const } }
        : {}),
    };
    const hearingGaps = includesHearings
      ? await this.prisma.committeeHearing.findMany({
          where: hearingWhere,
          orderBy: { date: 'desc' },
          take: Math.min(10, limit),
        })
      : [];
    const hearingCount = includesHearings
      ? await this.prisma.committeeHearing.count({ where: hearingWhere })
      : 0;

    const includesPolicy =
      (!filters.family || filters.family === 'federal_register_rule') &&
      (!filters.status || filters.status === 'published');
    const policyWhere = {
      type: 'RULE',
      ...(filters.publisher ? { agencyNames: { has: filters.publisher } } : {}),
    };
    const policyDocuments = includesPolicy
      ? await this.prisma.federalRegisterDocument.findMany({
          where: policyWhere,
          orderBy: { publicationDate: 'desc' },
          take: Math.min(20, limit),
        })
      : [];
    const policyCoverage = includesPolicy
      ? await this.prisma.federalRegisterDocument.findMany({
          where: policyWhere,
          select: { abstract: true, cfrReferences: true },
        })
      : [];
    const policyPartial = policyCoverage.filter(
      (row) => Boolean(row.abstract) || row.cfrReferences.length > 0,
    ).length;
    const policyUnavailable = policyCoverage.length - policyPartial;

    const allItems: DefenseContextDocumentSummaryDto[] = [
      ...rows.map((row) => this.contextSummary(row)),
      ...transcripts.map((row) => ({
        id: `transcript:${row.id}`,
        family: 'hearing_transcript',
        publisher: 'GovInfo',
        title: row.title,
        congress: row.congress,
        committee: row.committeeName,
        publishedAt: (row.publishedAt ?? row.date).toISOString(),
        status: 'published',
        currentRevisionId: `transcript:${row.id}:v1`,
        transcriptAvailability: 'available' as const,
        coverage: 'available' as const,
        sourceUrl: row.sourceUrl,
      })),
      ...hearingGaps.map((row) => ({
        id: `hearing:${row.id}`,
        family: 'hearing',
        publisher: this.publisherFromUrl(row.url),
        title: row.title,
        congress: row.congress,
        committee: row.committeeName,
        publishedAt: row.date.toISOString(),
        status: row.eventStatus,
        currentRevisionId: null,
        transcriptAvailability: 'unavailable' as const,
        coverage: 'unavailable' as const,
        sourceUrl: row.url,
      })),
      ...policyDocuments.map((row) => this.federalRegisterSummary(row)),
    ];
    const filtered = allItems.filter(
      (item) =>
        (!filters.family || item.family === filters.family) &&
        (!filters.publisher ||
          item.publisher.toLowerCase().includes(filters.publisher.toLowerCase())) &&
        (!filters.status || item.status === filters.status),
    );
    const items = filtered.slice(0, limit);
    const observed = persistedObserved + transcriptCount + hearingCount + policyCoverage.length;
    return {
      items,
      nextCursor: null,
      denominator: {
        eligible: persistedEligible + transcriptCount + hearingCount + policyCoverage.length,
        observed,
        qualified: persistedQualified + transcriptCount + policyCoverage.length,
        available: persistedAvailable + transcriptCount,
        partial: persistedPartial + policyPartial,
        unavailable: persistedUnavailable + hearingCount + policyUnavailable,
      },
    };
  }

  async contextDocument(documentId: string): Promise<DefenseContextDocumentDetailDto> {
    if (documentId.startsWith('transcript:'))
      return this.transcriptDetail(documentId.slice('transcript:'.length));
    if (documentId.startsWith('hearing:'))
      return this.hearingGapDetail(documentId.slice('hearing:'.length));
    if (documentId.startsWith('federal-register:'))
      return this.federalRegisterDetail(documentId.slice('federal-register:'.length));
    const row = await this.prisma.defenseContextDocument.findUnique({
      where: { id: this.requireUuid(documentId) },
      include: {
        revisions: {
          include: { sections: { orderBy: { ordinal: 'asc' } } },
          orderBy: { observedAt: 'desc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Context document not found');
    const current =
      row.revisions.find((revision) => revision.id === row.currentRevisionId) ?? row.revisions[0];
    return {
      ...this.contextSummary(row),
      revisions: row.revisions.map((revision) => this.contextRevision(revision)),
      sections: current?.sections.map((section) => this.contextSection(section)) ?? [],
      coverageReason: row.coverageReason,
    };
  }

  async contextRevisions(
    documentId: string,
  ): Promise<readonly DefenseContextDocumentRevisionDto[]> {
    return (await this.contextDocument(documentId)).revisions;
  }
  async contextSections(documentId: string): Promise<readonly DefenseContextSectionDto[]> {
    return (await this.contextDocument(documentId)).sections;
  }

  async references(documentId: string): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    if (documentId.startsWith('transcript:') || documentId.startsWith('hearing:')) return [];
    if (documentId.startsWith('federal-register:')) {
      const row = await this.prisma.federalRegisterDocument.findUnique({
        where: { documentNumber: documentId.slice('federal-register:'.length) },
      });
      if (!row) throw new NotFoundException('Context document not found');
      return row.cfrReferences.map((reference, index) =>
        this.federalRegisterReference(row, reference, index),
      );
    }
    const rows = await this.prisma.defenseReferenceOccurrence.findMany({
      where: { documentId: this.requireUuid(documentId) },
      include: { revision: true, document: true, section: true },
      orderBy: [{ sectionId: 'asc' }, { startOffset: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.referenceDto(row));
  }

  async referenceOccurrence(occurrenceId: string): Promise<DefenseReferenceOccurrenceDto> {
    if (occurrenceId.startsWith('federal-register-reference:')) {
      const value = occurrenceId.slice('federal-register-reference:'.length);
      const split = value.lastIndexOf(':');
      const documentNumber = split > 0 ? value.slice(0, split) : '';
      const index = split > 0 ? Number.parseInt(value.slice(split + 1), 10) : Number.NaN;
      const row = documentNumber
        ? await this.prisma.federalRegisterDocument.findUnique({ where: { documentNumber } })
        : null;
      if (!row || !Number.isInteger(index) || index < 0 || index >= row.cfrReferences.length)
        throw new NotFoundException('Reference occurrence not found');
      return this.federalRegisterReference(row, row.cfrReferences[index]!, index);
    }
    const row = await this.prisma.defenseReferenceOccurrence.findUnique({
      where: { id: this.requireUuid(occurrenceId) },
      include: { revision: true, document: true, section: true },
    });
    if (!row) throw new NotFoundException('Reference occurrence not found');
    return this.referenceDto(row);
  }

  async citedBy(documentId: string): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    if (
      documentId.startsWith('transcript:') ||
      documentId.startsWith('hearing:') ||
      documentId.startsWith('federal-register:')
    )
      return [];
    const rows = await this.prisma.defenseReferenceOccurrence.findMany({
      where: { resolvedTargetDocumentId: this.requireUuid(documentId) },
      include: { revision: true, document: true, section: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.referenceDto(row));
  }

  async resolveEvidence(evidenceRefId: string): Promise<DefenseEvidenceRefDto> {
    if (evidenceRefId.startsWith('context-occurrence:'))
      return (await this.referenceOccurrence(evidenceRefId.slice('context-occurrence:'.length)))
        .evidenceRef;
    if (evidenceRefId.startsWith('federal-register-reference:'))
      return (await this.referenceOccurrence(evidenceRefId)).evidenceRef;
    if (evidenceRefId.startsWith('context-compare:')) {
      const row = await this.prisma.defenseContextSection.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'context-compare:') },
        include: { revision: { include: { document: true } } },
      });
      if (
        !row ||
        !row.revision.document.eligible ||
        row.revision.document.qualification !== 'qualified'
      )
        throw new NotFoundException('Evidence reference not found');
      const revision = row.revision;
      return this.evidence(
        evidenceRefId,
        revision.sourceDocumentId,
        revision.contentHash,
        revision.document.family,
        revision.document.publisher,
        revision.sourceUrl ?? revision.document.sourceUrl,
        null,
        row.nativeLocator,
        null,
        revision.version,
        revision.observedAt,
        revision.id,
      );
    }
    if (evidenceRefId.startsWith('context-search-revision:')) {
      const row = await this.prisma.defenseContextDocumentRevision.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'context-search-revision:') },
        include: { document: true },
      });
      if (!row || !row.document.eligible || row.document.qualification !== 'qualified')
        throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.contentHash,
        row.document.family,
        row.document.publisher,
        row.sourceUrl ?? row.document.sourceUrl,
        null,
        null,
        null,
        row.version,
        row.observedAt,
        row.id,
      );
    }
    if (evidenceRefId.startsWith('context-search:')) {
      const row = await this.prisma.defenseContextDocument.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'context-search:') },
      });
      if (!row || !row.eligible || row.qualification !== 'qualified')
        throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        null,
        null,
        row.family,
        row.publisher,
        row.sourceUrl,
        null,
        null,
        null,
        null,
        row.updatedAt,
      );
    }
    const officePrefix = evidenceRefId.startsWith('office-source:')
      ? 'office-source:'
      : evidenceRefId.startsWith('office:')
        ? 'office:'
        : null;
    if (officePrefix) {
      const row = await this.prisma.programOffice.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, officePrefix) },
      });
      const evidence = row
        ? this.sourceEvidence(evidenceRefId, 'program_office', row.sourceUrl, row.updatedAt)
        : [];
      if (!evidence[0]) throw new NotFoundException('Evidence reference not found');
      return evidence[0];
    }
    const linkPrefix = evidenceRefId.startsWith('office-program-path:')
      ? 'office-program-path:'
      : evidenceRefId.startsWith('office-program:')
        ? 'office-program:'
        : null;
    if (linkPrefix) {
      const row = await this.prisma.programOfficeProgramLink.findFirst({
        where: { id: this.evidenceUuid(evidenceRefId, linkPrefix), reviewStatus: 'accepted' },
      });
      const evidence = row
        ? this.sourceEvidence(
            evidenceRefId,
            linkPrefix === 'office-program-path:' ? 'program' : 'program_office_program_link',
            row.sourceUrl,
            row.updatedAt,
          )
        : [];
      if (!evidence[0]) throw new NotFoundException('Evidence reference not found');
      return evidence[0];
    }
    if (evidenceRefId.startsWith('person-role:')) {
      const row = await this.prisma.personRole.findFirst({
        where: { id: this.evidenceUuid(evidenceRefId, 'person-role:'), reviewStatus: 'accepted' },
        select: { source: true, sourceUrl: true, observedAt: true },
      });
      const evidence = row
        ? this.sourceEvidence(evidenceRefId, row.source, row.sourceUrl, row.observedAt)
        : [];
      if (!evidence[0]) throw new NotFoundException('Evidence reference not found');
      return evidence[0];
    }
    if (evidenceRefId.startsWith('program-alias:')) {
      const row = await this.prisma.programAlias.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'program-alias:') },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        null,
        null,
        'program_alias',
        row.source,
        row.sourceUrl,
        null,
        null,
        null,
        null,
        row.createdAt,
      );
    }
    if (evidenceRefId.startsWith('acquisition-search:')) {
      const row = await this.prisma.acquisitionRecordRevision.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'acquisition-search:') },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        null,
        row.contentHash,
        row.recordKind,
        row.sourceSystem,
        row.sourceUrl,
        null,
        null,
        null,
        row.sourceVersion,
        row.sourceObservedAt ?? row.recordedAt,
      );
    }
    if (evidenceRefId.startsWith('pe-source:')) {
      const row = await this.prisma.programElementSource.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'pe-source:') },
        include: { sourceDocument: true },
      });
      if (!row) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        row.docType,
        row.publisher,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? null,
        row.observedAt,
      );
    }
    if (evidenceRefId.startsWith('project:')) {
      const row = await this.prisma.programElementProject.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'project:') },
        include: { sourceDocument: true },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        'r2a_project',
        row.sourceDocument?.title ?? null,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? null,
        row.lastSyncedAt,
      );
    }
    if (evidenceRefId.startsWith('procurement-source:')) {
      const row = await this.prisma.procurementLineSource.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'procurement-source:') },
        include: { sourceDocument: true },
      });
      if (!row) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        'procurement_jbook',
        row.sourceDocument?.title ?? row.publisher,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? null,
        row.observedAt,
      );
    }
    if (evidenceRefId.startsWith('pe-position:')) {
      const row = await this.prisma.programElementBudgetPosition.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'pe-position:') },
        include: { sourceDocument: true },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        row.sourceDocument?.documentType ?? 'budget_position',
        row.sourceDocument?.title ?? null,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? row.positionCycle,
        row.sourceDocument?.ingestedAt ?? row.createdAt,
      );
    }
    if (evidenceRefId.startsWith('project-position:')) {
      const row = await this.prisma.programElementProjectBudgetPosition.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'project-position:') },
        include: { sourceDocument: true },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        row.sourceDocument?.documentType ?? 'budget_position',
        row.sourceDocument?.title ?? null,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? row.positionCycle,
        row.sourceDocument?.ingestedAt ?? row.createdAt,
      );
    }
    if (evidenceRefId.startsWith('milestone-period:')) {
      const row = await this.prisma.programElementMilestoneSchedulePeriod.findUnique({
        where: { id: this.evidenceUuid(evidenceRefId, 'milestone-period:') },
        include: { sourceDocument: true },
      });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(
        evidenceRefId,
        row.sourceDocumentId,
        row.sourceDocument?.sha256 ?? null,
        'milestone_schedule',
        row.sourceDocument?.title ?? null,
        row.sourceUrl,
        row.pageNumber,
        null,
        null,
        row.sourceDocument?.sourceKey ?? null,
        row.sourceDocument?.ingestedAt ?? row.createdAt,
      );
    }
    throw new NotFoundException('Evidence reference not found');
  }

  private async programElementDossier(peCode: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.programElement.findUnique({
      where: { peCode },
      include: { sources: { include: { sourceDocument: true }, orderBy: { observedAt: 'desc' } } },
    });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.raw);
    const evidence = row.sources.map((source) =>
      this.evidence(
        `pe-source:${source.id}`,
        source.sourceDocumentId,
        source.sourceDocument?.sha256 ?? null,
        source.docType,
        source.publisher,
        source.sourceUrl,
        source.pageNumber,
        null,
        null,
        source.sourceDocument?.sourceKey ?? null,
        source.observedAt,
      ),
    );
    return this.dossierResult(
      { type: 'program_element', id: peCode, label: row.title },
      {
        mission: row.description ?? raw.mission,
        plans: raw.plans,
        accomplishments: raw.accomplishments,
        strategy_alignment: raw.strategyAlignment,
        performance_measures: raw.performanceMeasures,
        related_program_funding: raw.relatedProgramFunding,
        remarks: raw.remarks ?? raw.notes,
        analyst_questions: raw.analystQuestions,
      },
      evidence,
    );
  }

  private async programDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.program.findUnique({
      where: { id },
      include: { aliases: { orderBy: { confidence: 'desc' } } },
    });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.metadata);
    return this.dossierResult(
      { type: 'program', id, label: row.canonicalName },
      {
        mission: row.description,
        plans: raw.plans,
        accomplishments: raw.accomplishments,
        strategy_alignment: raw.strategyAlignment,
        performance_measures: raw.performanceMeasures,
        related_program_funding: raw.relatedProgramFunding,
        remarks: raw.remarks,
        analyst_questions: raw.analystQuestions,
      },
      [],
    );
  }

  private async projectDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.programElementProject.findFirst({
      where: this.projectWhere(id),
      include: { sourceDocument: true, programElement: true },
    });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.metadata);
    const evidence = row.sourceUrl
      ? [
          this.evidence(
            `project:${row.id}`,
            row.sourceDocumentId,
            row.sourceDocument?.sha256 ?? null,
            'r2a_project',
            row.sourceDocument?.title ?? null,
            row.sourceUrl,
            row.pageNumber,
            null,
            null,
            row.sourceDocument?.sourceKey ?? null,
            row.lastSyncedAt,
          ),
        ]
      : [];
    const document = row.sourceDocument;
    const now = new Date();
    const archiveString = (value: string | null | undefined) =>
      typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'null';
    const missionProof =
      document &&
      document.id === row.sourceDocumentId &&
      document.supersededByDocumentId === null &&
      typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(document.sha256) &&
      archiveString(document.archiveBucket) &&
      archiveString(document.archiveS3Key) &&
      archiveString(document.archiveVersionId) &&
      document.archivedAt instanceof Date && Number.isFinite(document.archivedAt.getTime()) &&
      document.archivedAt <= now &&
      (document.retainUntil == null ||
        (document.retainUntil instanceof Date && Number.isFinite(document.retainUntil.getTime()) &&
          document.retainUntil > now && document.retainUntil > document.archivedAt)) &&
      Number.isFinite(row.confidence) && row.confidence >= 0.9 && row.confidence <= 1 &&
      Number.isInteger(row.pageNumber) && (row.pageNumber ?? 0) > 0 &&
      (document.pageCount === null ||
        (Number.isInteger(document.pageCount) && (row.pageNumber ?? 0) <= document.pageCount));
    return this.dossierResult(
      { type: 'project', id: row.id, label: row.title },
      {
        mission: row.mission,
        plans: raw.plans,
        accomplishments: raw.accomplishments,
        strategy_alignment: raw.strategyAlignment,
        performance_measures: raw.performanceMeasures,
        related_program_funding: raw.relatedProgramFunding,
        remarks: raw.remarks,
        analyst_questions: raw.analystQuestions,
      },
      evidence,
      // A canonical field link and immutable raw-archive receipt are both required.
      // Other metadata fields have no equivalent field-specific source binding.
      { mission: missionProof ? evidence : [] },
    );
  }

  private async budgetLineDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.procurementLine.findUnique({
      where: { id },
      include: { sources: { include: { sourceDocument: true } } },
    });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.raw);
    const evidence = row.sources.map((source) =>
      this.evidence(
        `procurement-source:${source.id}`,
        source.sourceDocumentId,
        source.sourceDocument?.sha256 ?? null,
        'procurement_jbook',
        source.sourceDocument?.title ?? null,
        source.sourceUrl,
        source.pageNumber,
        null,
        null,
        source.sourceDocument?.sourceKey ?? null,
        source.createdAt,
      ),
    );
    return this.dossierResult(
      { type: 'budget_line', id, label: row.title },
      {
        mission: raw.mission ?? raw.description,
        plans: raw.plans,
        accomplishments: raw.accomplishments,
        strategy_alignment: raw.strategyAlignment,
        performance_measures: raw.performanceMeasures,
        related_program_funding: raw.relatedProgramFunding,
        remarks: raw.remarks,
        analyst_questions: raw.analystQuestions,
      },
      evidence,
    );
  }

  private dossierResult(
    subject: DefenseDossierDto['subject'],
    values: Record<string, unknown>,
    evidence: DefenseEvidenceRefDto[],
    fieldEvidence: Partial<Record<string, readonly DefenseEvidenceRefDto[]>> = {},
  ): DefenseDossierDto {
    const fields: DefenseDossierFieldDto[] = EXPECTED_DOSSIER_FIELDS.map((field) => {
      const value = values[field];
      const text =
        typeof value === 'string' ? value.trim() : value == null ? '' : JSON.stringify(value);
      const availability: DefenseResearchAvailability = !text
        ? 'unavailable'
        : fieldEvidence[field]?.some((ref) => ref.availability === 'available')
          ? 'available'
          : 'partial';
      return {
        field,
        availability,
        value: text || null,
        reason:
          availability === 'unavailable'
            ? 'No qualified source observation is available for this field.'
            : availability === 'partial'
              ? 'A value is present, but field-bound archived source and exact native locator proof is incomplete.'
              : null,
        fiscalPeriod: null,
        metric: null,
        unit: null,
        evidence: text ? evidence : [],
      };
    });
    const counts = {
      available: fields.filter((field) => field.availability === 'available').length,
      partial: fields.filter((field) => field.availability === 'partial').length,
      unavailable: fields.filter((field) => field.availability === 'unavailable').length,
    };
    return {
      subject,
      projectionVersion: 'defense-dossier-v1',
      fields,
      coverage: {
        state:
          counts.unavailable === fields.length
            ? 'unavailable'
            : counts.partial || counts.unavailable
              ? 'partial'
              : 'available',
        expectedFields: fields.length,
        availableFields: counts.available,
        partialFields: counts.partial,
        unavailableFields: counts.unavailable,
      },
    };
  }

  private async subjectLabel(type: SubjectType, id: string): Promise<DefenseDossierDto['subject']> {
    if (type === 'program_element') {
      const row = await this.prisma.programElement.findUnique({
        where: { peCode: id },
        select: { title: true },
      });
      if (!row) throw new NotFoundException('Defense research subject not found');
      return { type, id, label: row.title };
    }
    if (type === 'program') {
      const row = await this.prisma.program.findUnique({
        where: { id },
        select: { canonicalName: true },
      });
      if (!row) throw new NotFoundException('Defense research subject not found');
      return { type, id, label: row.canonicalName };
    }
    if (type === 'project') {
      const row = await this.prisma.programElementProject.findFirst({
        where: this.projectWhere(id),
        select: { id: true, title: true },
      });
      if (!row) throw new NotFoundException('Defense research subject not found');
      return { type, id: row.id, label: row.title };
    }
    const row = await this.prisma.procurementLine.findUnique({
      where: { id },
      select: { title: true },
    });
    if (!row) throw new NotFoundException('Defense research subject not found');
    return { type, id, label: row.title };
  }

  private normalizeSearch(value: string): string {
    return value
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private searchMatch(
    type: DefenseSearchMatchDto['subject']['type'],
    id: string,
    label: string,
    secondaryLabel: string | null,
    matchKind: DefenseSearchMatchDto['matchKind'],
    queryTerm: string,
    matchedFields: string[],
    evidence: DefenseEvidenceRefDto[],
    negativeControls: string[],
  ): DefenseSearchMatchDto {
    return {
      subject: { type, id, label },
      secondaryLabel,
      matchKind,
      score:
        matchKind === 'exact_id'
          ? 1
          : matchKind === 'acronym'
            ? 0.95
            : matchKind === 'alias'
              ? 0.9
              : matchKind === 'canonical_name'
                ? 0.8
                : null,
      explanation: {
        queryTerm,
        matchedFields,
        rationale:
          matchKind === 'capability'
            ? 'A governed, accepted capability-to-program-element match supports this result.'
            : `The query matched ${matchedFields.join(', ')}.`,
        negativeControls,
      },
      availability: evidence.length ? 'available' : 'partial',
      evidence,
    };
  }

  private rankSearch(items: DefenseSearchMatchDto[]): DefenseSearchMatchDto[] {
    const rank: Record<DefenseSearchMatchDto['matchKind'], number> = {
      exact_id: 0,
      acronym: 1,
      alias: 2,
      canonical_name: 3,
      capability: 4,
      semantic: 5,
    };
    const deduped = new Map<string, DefenseSearchMatchDto>();
    for (const item of items) {
      const key = `${item.subject.type}:${item.subject.id}`;
      const prior = deduped.get(key);
      if (!prior || rank[item.matchKind] < rank[prior.matchKind]) deduped.set(key, item);
    }
    return [...deduped.values()]
      .sort(
        (left, right) =>
          rank[left.matchKind] - rank[right.matchKind] ||
          left.subject.label.localeCompare(right.subject.label),
      )
      .slice(0, 25);
  }

  private searchLane(items: DefenseSearchMatchDto[]): DefenseSearchLaneDto {
    return items.length
      ? { status: 'available', reason: null, items }
      : {
          status: 'abstained',
          reason: "No qualified record met this lane's matching controls.",
          items: [],
        };
  }

  private milestoneAlignment(
    groups: readonly (readonly DefenseMilestoneDto[])[],
  ): Pick<DefenseComparisonAlignmentDto, 'state' | 'reason'> {
    if (!groups.some((group) => group.length))
      return {
        state: 'unavailable',
        reason: 'No source-qualified milestone periods are available for these subjects.',
      };
    const keysFor = (group: readonly DefenseMilestoneDto[]) => {
      const keys = new Set<string>();
      let incomplete = group.length === 0;
      for (const milestone of group) {
        const label = this.normalizeSearch(milestone.label);
        if (!label || !milestone.periods.length) incomplete = true;
        for (const period of milestone.periods) {
          const knownPrecision = !['unknown', 'text_only'].includes(period.precision);
          const nativePeriodPresent =
            period.precision === 'exact_date'
              ? Boolean(period.exactDate)
              : period.precision === 'calendar_month'
                ? Boolean(period.calendarYear && period.calendarMonth)
                : period.precision === 'calendar_quarter'
                  ? Boolean(period.calendarYear && period.calendarQuarter)
                  : period.precision === 'fiscal_quarter'
                    ? Boolean(period.fiscalYear && (period.fiscalQuarter ?? period.quarter))
                    : period.precision === 'fiscal_year'
                      ? Boolean(period.fiscalYear)
                      : period.precision === 'range'
                        ? Boolean(period.rangeStart && period.rangeEnd)
                        : false;
          const proof = period.evidence.some((evidence) =>
            Boolean(
              evidence.contentHash &&
              (evidence.sourceDocumentId || evidence.sourceRevisionId) &&
              evidence.sourceUrl &&
              (evidence.nativeLocator.page ||
                evidence.nativeLocator.section ||
                evidence.nativeLocator.occurrenceId),
            ),
          );
          const key = [label, milestone.eventCategory, period.role, period.precision].join('|');
          if (!knownPrecision || !nativePeriodPresent || !proof || keys.has(key)) incomplete = true;
          if (knownPrecision && nativePeriodPresent && proof) keys.add(key);
        }
      }
      return { keys, incomplete };
    };
    const indexed = groups.map(keysFor);
    const first = indexed[0]?.keys ?? new Set<string>();
    const sameEvents =
      first.size > 0 &&
      indexed.every(
        (item) =>
          !item.incomplete &&
          item.keys.size === first.size &&
          [...first].every((key) => item.keys.has(key)),
      );
    return sameEvents
      ? {
          state: 'aligned',
          reason:
            'Exact normalized event label, category, planned/actual role and source-native precision match; each period has independent source proof. Dates may differ.',
        }
      : {
          state: 'partial',
          reason:
            'Milestones are independently available, but labels, planned/actual roles, precision or source proof do not support complete event alignment.',
        };
  }

  private fundingBasisKey(basis: DefenseFundingCellDto['basis']): string {
    return [
      basis.requestEdition ?? 'unknown-edition',
      basis.fundingFiscalYear,
      basis.stage,
      basis.metric,
      basis.unit,
      basis.currency ?? 'unknown-currency',
      basis.priceBasis ?? 'unknown-price-basis',
    ].join('|');
  }

  private positionCell(row: any, observationId: string): DefenseFundingCellDto {
    const metric =
      row.valueKind === 'quantity'
        ? 'quantity'
        : row.valueKind === 'unit_cost'
          ? 'unit_cost'
          : 'funding';
    const unit =
      metric === 'quantity'
        ? 'units'
        : metric === 'unit_cost'
          ? 'usd_millions_per_unit'
          : 'usd_millions';
    const evidence = row.sourceUrl
      ? [
          this.evidence(
            observationId,
            row.sourceDocumentId,
            row.sourceDocument?.sha256 ?? null,
            row.sourceDocument?.documentType ?? 'budget_position',
            row.sourceDocument?.title ?? null,
            row.sourceUrl,
            row.pageNumber,
            null,
            null,
            row.sourceDocument?.sourceKey ?? row.positionCycle,
            row.sourceDocument?.ingestedAt ?? row.createdAt,
          ),
        ]
      : [];
    return {
      basis: {
        requestEdition: row.positionCycle,
        fundingFiscalYear: row.assertedFy,
        stage: this.stage(row.positionCycle),
        metric,
        unit,
        currency: 'USD',
        priceBasis: null,
        knownAt: null,
        knowledgeTimeSupported: false,
      },
      value:
        (metric === 'quantity' ? (row.quantity ?? row.amount) : row.amount)?.toString() ?? null,
      disposition: evidence.length ? 'observed' : 'partial',
      sourceObservationId: observationId,
      replacedByObservationId: null,
      evidence,
    };
  }

  // Preserve useful figures, but attach only the exact writer-asserted cell proof.
  private procurementCellProof(source: any, year: any, stage: string, value: unknown): boolean {
    if (
      value == null ||
      source.yearId !== year.id ||
      source.fy !== year.fy ||
      !source.sourceUrl ||
      !source.sourceDocumentId ||
      !source.sourceDocument?.sha256 ||
      !Number.isInteger(source.pageNumber) ||
      source.pageNumber < 1
    )
      return false;
    const metadata = this.record(source.metadata);
    if (
      metadata.writerVersion !== 'procurement_line_writer_v1' ||
      metadata.field !== stage ||
      metadata.fundingField !== (stage === 'actuals' ? 'executed' : stage) ||
      metadata.assertionKind !== 'funding' ||
      typeof metadata.assertionId !== 'string' ||
      !metadata.assertionId ||
      typeof metadata.artifactId !== 'string' ||
      !metadata.artifactId.trim() ||
      typeof metadata.artifactContentSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.artifactContentSha256) ||
      typeof metadata.sourcePdfSha256 !== 'string' ||
      metadata.sourcePdfSha256 !== source.sourceDocument.sha256 ||
      typeof source.sourceSpanHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(source.sourceSpanHash) ||
      (metadata.sublineKey ?? '') !== (year.sublineKey ?? '') ||
      typeof metadata.valueMillions !== 'string'
    )
      return false;
    try {
      return (
        parseCanonicalDecimalString(metadata.valueMillions) ===
        parseCanonicalDecimalString(String(value))
      );
    } catch {
      return false;
    }
  }

  private qualifiedSchedulePeriod(period: DefenseMilestonePeriodDto): boolean {
    const integer = (value: unknown, minimum: number, maximum: number) =>
      Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
    const date = (value: string | null) =>
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
    let typed = false;
    switch (period.precision) {
      case 'exact_date':
        typed = date(period.exactDate);
        break;
      case 'calendar_month':
        typed = integer(period.calendarYear, 1, 9999) && integer(period.calendarMonth, 1, 12);
        break;
      case 'calendar_quarter':
        typed = integer(period.calendarYear, 1, 9999) && integer(period.calendarQuarter, 1, 4);
        break;
      case 'fiscal_quarter':
        typed =
          integer(period.fiscalYear, 1, 9999) &&
          integer(period.fiscalQuarter ?? period.quarter, 1, 4);
        break;
      case 'fiscal_year':
        typed = integer(period.fiscalYear, 1, 9999);
        break;
      case 'range':
        typed =
          date(period.rangeStart) &&
          date(period.rangeEnd) &&
          period.rangeStart! <= period.rangeEnd!;
        break;
    }
    return (
      typed &&
      period.evidence.some(
        (ref) =>
          ref.availability === 'available' &&
          typeof ref.contentHash === 'string' &&
          /^[a-f0-9]{64}$/i.test(ref.contentHash) &&
          Boolean(ref.sourceDocumentId || ref.sourceRevisionId) &&
          integer(ref.nativeLocator.page, 1, Number.MAX_SAFE_INTEGER),
      )
    );
  }

  private schedulePeriod(period: any): DefenseMilestonePeriodDto {
    const evidence = period.sourceUrl
      ? [
          this.evidence(
            `milestone-period:${period.id}`,
            period.sourceDocumentId,
            period.sourceDocument?.sha256 ?? null,
            'milestone_schedule',
            period.sourceDocument?.title ?? null,
            period.sourceUrl,
            period.pageNumber,
            null,
            null,
            period.sourceDocument?.sourceKey ?? null,
            period.sourceDocument?.ingestedAt ?? period.createdAt,
          ),
        ]
      : [];
    return {
      role: period.periodRole,
      rawText: period.rawText,
      precision: period.periodKind,
      exactDate: period.exactDate?.toISOString().slice(0, 10) ?? null,
      rangeStart: period.rangeStart?.toISOString().slice(0, 10) ?? null,
      rangeEnd: period.rangeEnd?.toISOString().slice(0, 10) ?? null,
      fiscalYear: period.fiscalYear,
      quarter: period.fiscalQuarter ?? period.calendarQuarter,
      calendarYear: period.calendarYear ?? null,
      calendarMonth: period.calendarMonth ?? null,
      calendarQuarter: period.calendarQuarter ?? null,
      fiscalQuarter: period.fiscalQuarter ?? null,
      evidence,
    };
  }

  private contextSummary(row: any): DefenseContextDocumentSummaryDto {
    return {
      id: row.id,
      family: row.family,
      publisher: row.publisher,
      title: row.title,
      congress: row.congress,
      committee: row.committee,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      status: row.status,
      currentRevisionId: row.currentRevisionId,
      transcriptAvailability: row.transcriptAvailability,
      coverage: row.coverage,
      sourceUrl: row.sourceUrl,
    };
  }
  private contextRevision(row: any): DefenseContextDocumentRevisionDto {
    return {
      id: row.id,
      version: row.version,
      contentHash: row.contentHash,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      observedAt: row.observedAt.toISOString(),
      status: row.status,
      sourceUrl: row.sourceUrl,
    };
  }
  private contextSection(row: any): DefenseContextSectionDto {
    return {
      id: row.id,
      revisionId: row.revisionId,
      ordinal: row.ordinal,
      label: row.label,
      nativeLocator: row.nativeLocator,
      textAvailability: row.textAvailability,
      contentHash: row.contentHash,
    };
  }
  private referenceDto(row: any): DefenseReferenceOccurrenceDto {
    return {
      id: row.id,
      sourceDocumentId: row.documentId,
      sourceRevisionId: row.revisionId,
      sourceSectionId: row.sectionId,
      exactSpan: row.exactSpan,
      originalWording: row.originalWording,
      referenceType: row.referenceType,
      targetCandidates: row.targetCandidates,
      resolvedTarget: row.resolvedTarget,
      disposition: row.disposition,
      evidenceRef: this.evidence(
        `context-occurrence:${row.id}`,
        row.revision.sourceDocumentId ?? null,
        row.revision.contentHash,
        row.document.family,
        row.document.publisher,
        row.revision.sourceUrl ?? row.document.sourceUrl,
        null,
        row.section?.nativeLocator ?? null,
        row.id,
        row.revision.version,
        row.revision.observedAt,
        row.revisionId,
      ),
    };
  }

  private async transcriptDetail(id: string): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.officialHearingTranscript.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Context document not found');
    const hash = createHash('sha256').update(row.text).digest('hex');
    return {
      id: `transcript:${row.id}`,
      family: 'hearing_transcript',
      publisher: 'GovInfo',
      title: row.title,
      congress: row.congress,
      committee: row.committeeName,
      publishedAt: (row.publishedAt ?? row.date).toISOString(),
      status: 'published',
      currentRevisionId: `transcript:${row.id}:v1`,
      transcriptAvailability: 'available',
      coverage: 'available',
      sourceUrl: row.sourceUrl,
      revisions: [
        {
          id: `transcript:${row.id}:v1`,
          version: 'v1',
          contentHash: hash,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          observedAt: row.fetchedAt.toISOString(),
          status: 'published',
          sourceUrl: row.sourceUrl,
        },
      ],
      sections: [
        {
          id: `transcript:${row.id}:section:1`,
          revisionId: `transcript:${row.id}:v1`,
          ordinal: 1,
          label: 'Official transcript',
          nativeLocator: 'transcript',
          textAvailability: 'available',
          contentHash: hash,
        },
      ],
      coverageReason: null,
    };
  }

  private async hearingGapDetail(id: string): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.committeeHearing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Context document not found');
    return {
      id: `hearing:${row.id}`,
      family: 'hearing',
      publisher: this.publisherFromUrl(row.url),
      title: row.title,
      congress: row.congress,
      committee: row.committeeName,
      publishedAt: row.date.toISOString(),
      status: row.eventStatus,
      currentRevisionId: null,
      transcriptAvailability: 'unavailable',
      coverage: 'unavailable',
      sourceUrl: row.url,
      revisions: [],
      sections: [],
      coverageReason: 'No qualified official transcript revision is available for this hearing.',
    };
  }

  private async federalRegisterDetail(
    documentNumber: string,
  ): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.federalRegisterDocument.findUnique({ where: { documentNumber } });
    if (!row || row.type !== 'RULE') throw new NotFoundException('Context document not found');
    const summary = this.federalRegisterSummary(row);
    const hash = this.federalRegisterHash(row);
    const revisionId = `${summary.id}:v1`;
    return {
      ...summary,
      revisions: [
        {
          id: revisionId,
          version: row.documentNumber,
          contentHash: hash,
          publishedAt: row.publicationDate.toISOString(),
          observedAt: row.syncedAt.toISOString(),
          status: 'published',
          sourceUrl: summary.sourceUrl,
        },
      ],
      sections: [
        {
          id: `${summary.id}:abstract`,
          revisionId,
          ordinal: 1,
          label: 'Federal Register abstract',
          nativeLocator: row.documentNumber,
          textAvailability: row.abstract ? 'partial' : 'unavailable',
          contentHash: row.abstract
            ? createHash('sha256').update(row.abstract).digest('hex')
            : null,
        },
      ],
      coverageReason: row.abstract
        ? 'Federal Register metadata, abstract, and CFR references are available; the full rule text is not stored in this projection.'
        : 'Only Federal Register metadata and CFR references are available; no stored abstract or full text is available.',
    };
  }

  private federalRegisterSummary(row: any): DefenseContextDocumentSummaryDto {
    return {
      id: `federal-register:${row.documentNumber}`,
      family: 'federal_register_rule',
      publisher: row.agencyNames?.length
        ? row.agencyNames.join(', ')
        : 'Office of the Federal Register',
      title: row.title,
      congress: null,
      committee: null,
      publishedAt: row.publicationDate.toISOString(),
      status: 'published',
      currentRevisionId: `federal-register:${row.documentNumber}:v1`,
      transcriptAvailability: 'not_applicable',
      coverage: row.abstract || row.cfrReferences?.length ? 'partial' : 'unavailable',
      sourceUrl: row.htmlUrl ?? row.pdfUrl,
    };
  }

  private federalRegisterHash(row: any): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          documentNumber: row.documentNumber,
          title: row.title,
          abstract: row.abstract,
          cfrReferences: row.cfrReferences,
          publicationDate: row.publicationDate.toISOString(),
        }),
      )
      .digest('hex');
  }

  private federalRegisterReference(
    row: any,
    reference: string,
    index: number,
  ): DefenseReferenceOccurrenceDto {
    const documentId = `federal-register:${row.documentNumber}`;
    const revisionId = `${documentId}:v1`;
    const id = `federal-register-reference:${row.documentNumber}:${index}`;
    const sourceUrl = row.htmlUrl ?? row.pdfUrl;
    return {
      id,
      sourceDocumentId: documentId,
      sourceRevisionId: revisionId,
      sourceSectionId: `${documentId}:abstract`,
      exactSpan: reference,
      originalWording: reference,
      referenceType: 'cfr_reference',
      targetCandidates: [{ type: 'cfr', id: reference, label: reference }],
      resolvedTarget: null,
      disposition: 'unresolved',
      evidenceRef: this.evidence(
        id,
        null,
        this.federalRegisterHash(row),
        'federal_register_rule',
        this.federalRegisterSummary(row).publisher,
        sourceUrl,
        null,
        row.documentNumber,
        id,
        row.documentNumber,
        row.syncedAt,
        revisionId,
      ),
    };
  }

  private evidence(
    evidenceRefId: string,
    sourceDocumentId: string | null,
    contentHash: string | null,
    sourceFamily: string,
    publisher: string | null,
    sourceUrl: string | null,
    page: number | null,
    section: string | null,
    occurrenceId: string | null,
    edition: string | null,
    observedAt: Date | null,
    sourceRevisionId: string | null = null,
  ): DefenseEvidenceRefDto {
    return {
      evidenceRefId,
      sourceDocumentId,
      sourceRevisionId,
      sourceFamily,
      publisher,
      sourceUrl,
      nativeLocator: { page, section, occurrenceId },
      contentHash,
      edition,
      observedAt: observedAt?.toISOString() ?? null,
      availability: !sourceUrl
        ? 'unavailable'
        : contentHash && (sourceDocumentId || sourceRevisionId) && (page || section || occurrenceId)
          ? 'available'
          : 'partial',
      reason: !sourceUrl
        ? 'Source URL is unavailable.'
        : contentHash && (sourceDocumentId || sourceRevisionId) && (page || section || occurrenceId)
          ? null
          : 'Contextual source is available, but archived revision or exact native locator proof is incomplete.',
    };
  }
  private subjectType(value: string): SubjectType {
    if (!['program', 'program_element', 'project', 'budget_line'].includes(value))
      throw new BadRequestException(
        'subjectType must be program, program_element, project, or budget_line',
      );
    return value as SubjectType;
  }
  private comparisonSubjectType(value: string): ComparisonSubjectType {
    if (
      !['program', 'program_element', 'project', 'budget_line', 'context_document'].includes(value)
    )
      throw new BadRequestException(
        'comparison subject type must be program, program_element, project, budget_line, or context_document',
      );
    return value as ComparisonSubjectType;
  }
  private evidenceUuid(evidenceRefId: string, prefix: string): string {
    return this.requireUuid(evidenceRefId.slice(prefix.length), 'Evidence reference not found');
  }
  private requireUuid(value: string, message = 'Context record not found'): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
      throw new NotFoundException(message);
    return value;
  }
  private projectWhere(id: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? { id }
      : id.includes(':')
        ? { peCode: id.split(':')[0], projectCode: id.split(':').slice(1).join(':') }
        : { id };
  }
  private record(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }
  private stage(positionCycle: string): string {
    const value = positionCycle.toLowerCase();
    if (value.startsWith('pb_')) return 'request';
    if (value.startsWith('hasc')) return 'hasc_mark';
    if (value.startsWith('sasc')) return 'sasc_mark';
    if (value.startsWith('hac')) return 'hac_d_mark';
    if (value.startsWith('sac')) return 'sac_d_mark';
    if (value.startsWith('conference')) return 'conference';
    if (value.startsWith('enacted')) return 'enacted';
    return value.split('_fy')[0] ?? value;
  }
  private milestoneCategory(value: string): DefenseMilestoneDto['eventCategory'] {
    const normalized = value.toLowerCase();
    if (/test|eval|demonstrat/.test(normalized)) return 'testing';
    if (/produc|manufactur|field/.test(normalized)) return 'production';
    if (/transition|deploy|operational/.test(normalized)) return 'transition';
    if (/develop|design|prototype/.test(normalized)) return 'development';
    return 'other';
  }
  private publisherFromUrl(url: string | null): string {
    try {
      return url ? new URL(url).hostname : 'Official committee source';
    } catch {
      return 'Official committee source';
    }
  }

  async listOffices(filters: {
    agency?: string;
    component?: string;
    officeType?: string;
    capability?: string;
    program?: string;
    status?: OfficeStatus;
    availability?: DefenseResearchAvailability;
    freshness?: 'fresh' | 'stale' | 'any';
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<DefenseOfficeListDto> {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where = this.buildOfficeWhere(filters);
    const [total, offices] = await Promise.all([
      this.prisma.programOffice.count({ where }),
      this.prisma.programOffice.findMany({
        where,
        include: {
          parentOffice: { select: { id: true, name: true } },
          roles: { select: { id: true }, take: 1 },
          programLinks: { select: { id: true }, take: 1 },
        },
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const items = offices.map((office) => this.officeToSummary(office));
    return {
      items,
      total,
      page,
      limit,
      filters: {
        agency: filters.agency,
        component: filters.component,
        officeType: filters.officeType,
        capability: filters.capability,
        program: filters.program,
        status: filters.status,
        availability: filters.availability,
        freshness: filters.freshness,
      },
    };
  }

  async getOffice(id: string): Promise<DefenseOfficeDetailDto> {
    const office = await this.prisma.programOffice.findUnique({
      where: { id },
      include: {
        parentOffice: true,
        childOffices: true,
        roles: {
          include: {
            person: true,
          },
          where: { reviewStatus: 'accepted' },
        },
        programLinks: {
          include: { program: true },
          where: { reviewStatus: 'accepted' },
        },
      },
    });
    if (!office) throw new NotFoundException('Office not found');
    return this.officeToDetail(office);
  }

  async getRelationships(filters: {
    from?: string;
    to?: string;
    edgeType?: string;
    status?: string;
    includeSpeculative?: boolean;
    page?: number;
    limit?: number;
  }): Promise<DefenseRelationshipListDto> {
    const page = Math.max(Number(filters.page ?? 1), 1);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
    const reviewStates = filters.includeSpeculative ? ['accepted', 'candidate'] : ['accepted'];
    const offices = await this.prisma.programOffice.findMany({
      include: {
        parentOffice: { select: { id: true, name: true, service: true } },
        roles: {
          where: { reviewStatus: { in: reviewStates } },
          include: {
            person: { select: { id: true, fullName: true } },
            program: { select: { id: true, canonicalName: true, component: true } },
          },
        },
        programLinks: {
          where: { reviewStatus: { in: reviewStates } },
          include: {
            program: {
              select: { id: true, canonicalName: true, component: true, acquisitionPathway: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });

    const edges: DefenseRelationshipEdgeDto[] = [];
    const now = new Date();
    for (const office of offices) {
      if (office.parentOffice) {
        edges.push({
          id: `office-parent:${office.id}:${office.parentOffice.id}`,
          from: {
            type: 'office',
            id: office.parentOffice.id,
            label: office.parentOffice.name,
            service: office.parentOffice.service,
          },
          to: { type: 'office', id: office.id, label: office.name, service: office.service },
          relation: 'manages',
          sourceStated: Boolean(office.sourceUrl),
          derived: !office.sourceUrl,
          inferred: false,
          validity: this.relationshipValidity(office.status, office.validTo),
          observationRevision: office.updatedAt.toISOString(),
          evidence: this.sourceEvidence(
            `office:${office.id}`,
            'program_office',
            office.sourceUrl,
            office.updatedAt,
          ),
          reviewStatus: office.sourceUrl ? 'accepted' : 'candidate',
          supersessionImpact:
            office.status === 'superseded'
              ? 'Office hierarchy edge is historical and must not be treated as current.'
              : null,
        });
      }
      for (const link of office.programLinks) {
        const relation = this.officeProgramRelation(link.relation);
        edges.push({
          id: `office-program:${link.id}`,
          from: { type: 'office', id: office.id, label: office.name, service: office.service },
          to: {
            type: 'program',
            id: link.program.id,
            label: link.program.canonicalName,
            service: link.program.component,
          },
          relation,
          sourceStated: !link.derivedBy,
          derived: Boolean(link.derivedBy),
          inferred: false,
          validity: link.reviewStatus === 'accepted' ? 'valid' : 'candidate',
          observationRevision: link.updatedAt.toISOString(),
          evidence: this.sourceEvidence(
            `office-program:${link.id}`,
            'program_office_program_link',
            link.sourceUrl,
            link.updatedAt,
          ),
          reviewStatus: this.reviewState(link.reviewStatus),
          supersessionImpact: null,
        });
        if (link.program.acquisitionPathway) {
          edges.push({
            id: `program-acquisition-path:${link.program.id}`,
            from: {
              type: 'program',
              id: link.program.id,
              label: link.program.canonicalName,
              service: link.program.component,
            },
            to: {
              type: 'acquisition',
              id: `pathway:${link.program.acquisitionPathway}`,
              label: link.program.acquisitionPathway,
            },
            relation: 'acquisition_path',
            sourceStated: false,
            derived: true,
            inferred: false,
            validity: 'valid',
            observationRevision: link.updatedAt.toISOString(),
            evidence: this.sourceEvidence(
              `office-program-path:${link.id}`,
              'program',
              link.sourceUrl,
              link.updatedAt,
            ),
            reviewStatus: this.reviewState(link.reviewStatus),
            supersessionImpact:
              'Acquisition pathway is context only and carries no allocation or award authority.',
          });
        }
      }
      for (const role of office.roles) {
        const target = role.program
          ? {
              type: 'program' as const,
              id: role.program.id,
              label: role.program.canonicalName,
              service: role.program.component,
            }
          : { type: 'office' as const, id: office.id, label: office.name, service: office.service };
        edges.push({
          id: `person-role:${role.id}`,
          from: { type: 'person', id: role.person.id, label: role.person.fullName },
          to: target,
          relation: 'holds_role',
          sourceStated: true,
          derived: false,
          inferred: false,
          validity:
            role.effectiveStart && role.effectiveStart > now
              ? 'unresolved'
              : role.effectiveEnd && role.effectiveEnd < now
                ? 'superseded'
                : role.reviewStatus === 'accepted'
                  ? 'valid'
                  : 'candidate',
          observationRevision: role.observedAt.toISOString(),
          evidence: this.sourceEvidence(
            `person-role:${role.id}`,
            role.source,
            role.sourceUrl,
            role.observedAt,
          ),
          reviewStatus: this.reviewState(role.reviewStatus),
          supersessionImpact:
            role.effectiveStart && role.effectiveStart > now
              ? 'Role is not current before its effective start: ' +
                role.effectiveStart.toISOString()
              : role.effectiveEnd
                ? 'Role has an explicit effective end and is retained as historical evidence.'
                : null,
        });
      }
    }

    const filtered = edges.filter((edge) => {
      if (!filters.includeSpeculative && edge.reviewStatus !== 'accepted') return false;
      if (filters.from && edge.from.id !== filters.from) return false;
      if (filters.to && edge.to.id !== filters.to) return false;
      if (filters.edgeType && edge.relation !== filters.edgeType) return false;
      if (
        filters.status &&
        edge.validity !== filters.status &&
        edge.reviewStatus !== filters.status
      )
        return false;
      return true;
    });
    const start = (page - 1) * limit;
    return {
      items: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
    };
  }

  private buildOfficeWhere(filters: any) {
    const where: any = {};
    const serviceFilters = [filters.agency, filters.component].filter(Boolean);
    if (serviceFilters.length === 1)
      where.service = { equals: serviceFilters[0], mode: 'insensitive' };
    if (serviceFilters.length > 1)
      where.AND = serviceFilters.map((value: string) => ({
        service: { equals: value, mode: 'insensitive' },
      }));
    if (filters.officeType) where.officeType = filters.officeType;
    if (filters.status) where.status = filters.status;
    const relationshipFilters: any[] = [];
    if (filters.program) {
      relationshipFilters.push({
        programLinks: {
          some: {
            reviewStatus: 'accepted',
            program: {
              OR: [
                { id: filters.program },
                { canonicalName: { contains: filters.program, mode: 'insensitive' } },
                {
                  aliases: { some: { alias: { contains: filters.program, mode: 'insensitive' } } },
                },
              ],
            },
          },
        },
      });
    }
    if (filters.capability) {
      relationshipFilters.push({
        programLinks: {
          some: {
            reviewStatus: 'accepted',
            program: { capabilityArea: { contains: filters.capability, mode: 'insensitive' } },
          },
        },
      });
    }
    // Office availability describes stored metadata, not source qualification.
    // Match officeToSummary before both count and pagination; URL-only evidence
    // remains partial. Every persisted office maps to available or partial.
    if (filters.availability === 'available') {
      where.sourceUrl = { not: null };
      where.AND = [...(where.AND ?? []), { sourceUrl: { not: '' } }];
    } else if (filters.availability === 'partial') {
      where.AND = [...(where.AND ?? []), { OR: [{ sourceUrl: null }, { sourceUrl: '' }] }];
    } else if (filters.availability === 'unavailable') {
      where.id = { in: [] };
    }
    if (filters.freshness === 'fresh') {
      where.AND = [...(where.AND ?? []), { validTo: null }, { status: 'active' }];
    } else if (filters.freshness === 'stale') {
      where.OR = [{ validTo: { not: null } }, { status: { in: ['historical', 'superseded'] } }];
    }
    if (filters.q) {
      const search = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { metadata: { path: ['acronym'], equals: filters.q } },
        { metadata: { path: ['aliases'], array_contains: [filters.q] } },
      ];
      where.AND = [...(where.AND ?? []), { OR: search }];
    }
    if (relationshipFilters.length) where.AND = [...(where.AND ?? []), ...relationshipFilters];
    return where;
  }

  private officeToSummary(office: any): DefenseOfficeSummaryDto {
    return {
      id: office.id,
      name: office.name,
      officeType: office.officeType,
      service: office.service,
      parentOfficeId: office.parentOfficeId,
      parentOfficeName: office.parentOffice?.name ?? null,
      status: this.officeStatus(office.status),
      validFrom: office.validFrom?.toISOString() ?? null,
      validTo: office.validTo?.toISOString() ?? null,
      sourceUrl: office.sourceUrl,
      reviewStatus: null,
      confidence: 1.0,
      observedAt: office.createdAt.toISOString(),
      effectiveStart: office.validFrom?.toISOString() ?? null,
      effectiveEnd: office.validTo?.toISOString() ?? null,
      aliases: this.stringArray(this.record(office.metadata).aliases),
      availability: office.sourceUrl ? 'available' : 'partial',
      evidence: this.sourceEvidence(
        `office:${office.id}`,
        'program_office',
        office.sourceUrl,
        office.updatedAt ?? office.createdAt,
      ),
    };
  }

  private officeToDetail(office: any): DefenseOfficeDetailDto {
    const summary = this.officeToSummary(office);
    const leadership = office.roles.map((role: any) => ({
      personId: role.person.id,
      personName: role.person.fullName,
      roleTitle: role.roleTitle,
      roleType: role.roleType,
      contactUse: role.contactUse,
      observedAt: role.observedAt.toISOString(),
      effectiveStart: role.effectiveStart?.toISOString() ?? null,
      effectiveEnd: role.effectiveEnd?.toISOString() ?? null,
      reviewStatus: this.reviewState(role.reviewStatus),
      sourceUrl: role.sourceUrl,
      evidence: this.sourceEvidence(
        `person-role:${role.id}`,
        role.source,
        role.sourceUrl,
        role.observedAt,
      ),
    }));
    const programs = office.programLinks.map((link: any) => ({
      programId: link.program.id,
      programName: link.program.canonicalName,
      relation: this.officeProgramRelation(link.relation),
      reviewStatus: this.reviewState(link.reviewStatus),
      sourceUrl: link.sourceUrl,
      evidence: this.sourceEvidence(
        `office-program:${link.id}`,
        'program_office_program_link',
        link.sourceUrl,
        link.updatedAt,
      ),
    }));
    const metadata = this.record(office.metadata);
    const mission = this.optionalString(metadata.mission);
    const responsibilities = this.optionalString(metadata.responsibilities);
    const scope = this.optionalString(metadata.scope);
    const contact = this.optionalString(metadata.contact);
    const website = this.optionalString(metadata.website);
    const coverage: DefenseOfficeDetailDto['coverage'] = {
      mission: mission ? 'available' : 'unavailable',
      responsibilities: responsibilities ? 'available' : 'unavailable',
      scope: scope ? 'available' : 'unavailable',
      leadership: leadership.length ? 'available' : 'unavailable',
      programs: programs.length ? 'available' : 'unavailable',
      contact: contact ? 'available' : 'unavailable',
      website: website ? 'available' : 'unavailable',
    };
    return {
      ...summary,
      mission,
      responsibilities,
      scope,
      leadership,
      programs,
      contact,
      website,
      hierarchy: {
        parent: office.parentOffice ? this.officeToSummary(office.parentOffice) : null,
        children: office.childOffices.map((child: any) => this.officeToSummary(child)),
      },
      coverage,
    };
  }

  private optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }
  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }
  private officeStatus(value: string): OfficeStatus {
    return ['active', 'historical', 'superseded', 'unresolved'].includes(value)
      ? (value as OfficeStatus)
      : 'unresolved';
  }
  private reviewState(value: string): 'accepted' | 'candidate' | 'quarantined' {
    return value === 'accepted' || value === 'quarantined' ? value : 'candidate';
  }
  private relationshipValidity(
    status: string,
    validTo: Date | null,
  ): DefenseRelationshipEdgeDto['validity'] {
    if (status === 'unresolved') return 'unresolved';
    if (status === 'superseded' || status === 'historical' || (validTo && validTo < new Date()))
      return 'superseded';
    return 'valid';
  }
  private officeProgramRelation(value: string): OfficeRelation {
    if (value === 'manages' || value === 'executes' || value === 'supports') return value;
    return 'supports';
  }
  private sourceEvidence(
    id: string,
    family: string,
    sourceUrl: string | null,
    observedAt: Date | null,
  ): DefenseEvidenceRefDto[] {
    if (!sourceUrl) return [];
    return [
      {
        evidenceRefId: id,
        sourceDocumentId: null,
        sourceRevisionId: null,
        sourceFamily: family,
        publisher: this.publisherFromUrl(sourceUrl),
        sourceUrl,
        nativeLocator: { page: null, section: null, occurrenceId: null },
        contentHash: null,
        edition: null,
        observedAt: observedAt?.toISOString() ?? null,
        availability: 'partial',
        reason:
          'URL-only contextual evidence has no archived byte revision or exact native locator; this mutable observation cannot reproduce an earlier revision.',
      },
    ];
  }

  private acquisitionTextAvailability(raw: unknown): DefenseResearchAvailability {
    const value = this.record(raw);
    return ['description', 'text', 'content', 'summary', 'synopsis'].some((key) =>
      this.optionalString(value[key]),
    )
      ? 'partial'
      : 'unavailable';
  }

  private acquisitionRecordSummaryDto(
    row: any,
    amendmentCount: number,
    openGaps: number,
  ): DefenseAcquisitionRecordSummaryDto {
    return {
      identityKey: row.identityKey,
      sourceSystem: row.sourceSystem,
      sourceRecordId: row.sourceRecordId,
      recordKind: row.recordKind,
      parentIdentityKey: row.parentIdentityKey,
      title: row.title,
      status: row.status,
      buyerOffice: row.buyerOffice,
      postedAt: row.postedAt?.toISOString() ?? null,
      responseDeadline: row.responseDeadline?.toISOString() ?? null,
      validFrom: row.validFrom?.toISOString() ?? null,
      validTo: row.validTo?.toISOString() ?? null,
      contentHash: row.contentHash,
      sourceUrl: row.sourceUrl,
      sourceVersion: row.sourceVersion,
      sourceObservedAt: row.sourceObservedAt?.toISOString() ?? null,
      recordedAt: row.recordedAt.toISOString(),
      textAvailability: this.acquisitionTextAvailability(row.raw),
      amendmentCount,
      openCoverageGaps: openGaps,
    };
  }

  private extractFieldsFromRaw(raw: unknown): DefenseAcquisitionRecordDetailDto['extractedFields'] {
    const value = this.record(raw);
    const strings = (...candidates: unknown[]): string[] => [
      ...new Set(
        candidates.flatMap((candidate) => {
          if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()];
          if (Array.isArray(candidate))
            return candidate
              .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
              .map((item) => item.trim());
          if (candidate && typeof candidate === 'object')
            return Object.values(candidate as Record<string, unknown>)
              .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
              .map((item) => item.trim());
          return [];
        }),
      ),
    ];
    const result: DefenseAcquisitionRecordDetailDto['extractedFields'] = {};
    const geography = strings(
      value.geography,
      value.placeOfPerformance,
      value.place_of_performance,
    );
    const naics = strings(value.naics, value.naicsCode, value.naicsCodes, value.naics_code);
    const psc = strings(value.psc, value.pscCode, value.pscCodes, value.psc_code);
    const setAside = strings(
      value.setAside,
      value.setAsideCode,
      value.setAsideType,
      value.set_aside,
    );
    if (geography.length) result.geography = geography;
    if (naics.length) result.naics = naics;
    if (psc.length) result.psc = psc;
    if (setAside.length) result.setAside = setAside;
    return result;
  }

  async getAcquisitionRecords(filters: {
    q?: string;
    sourceSystem?: string;
    recordKind?: string;
    status?: string;
    buyerOffice?: string;
    activeOn?: string;
    page?: number;
    limit?: number;
  }): Promise<DefenseAcquisitionRecordListDto> {
    const page = Math.max(Number(filters.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 100);
    const where: any = {
      ...(filters.sourceSystem
        ? { sourceSystem: { equals: filters.sourceSystem, mode: 'insensitive' } }
        : {}),
      ...(filters.recordKind ? { recordKind: filters.recordKind } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.buyerOffice
        ? { buyerOffice: { contains: filters.buyerOffice, mode: 'insensitive' } }
        : {}),
    };
    if (filters.q) {
      where.OR = [
        { identityKey: { contains: filters.q, mode: 'insensitive' } },
        { sourceRecordId: { contains: filters.q, mode: 'insensitive' } },
        { title: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    if (filters.activeOn) {
      const activeOn = new Date(filters.activeOn);
      if (!Number.isFinite(activeOn.getTime()))
        throw new BadRequestException('activeOn must be a valid ISO date.');
      where.AND = [
        { OR: [{ validFrom: null }, { validFrom: { lte: activeOn } }] },
        { OR: [{ validTo: null }, { validTo: { gte: activeOn } }] },
      ];
    }
    // Select current identity revisions before mutable field/date filters. Only IDs
    // are materialized; full identity population cost remains corpus-dependent.
    const current = await this.prisma.acquisitionRecordRevision.findMany({
      orderBy: [{ identityKey: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      distinct: ['identityKey'],
      select: { id: true },
    });
    where.id = { in: current.map((row) => row.id) };
    const grouped = await this.prisma.acquisitionRecordRevision.groupBy({
      by: ['identityKey'],
      where,
    });
    const rows = await this.prisma.acquisitionRecordRevision.findMany({
      where,
      orderBy: [{ identityKey: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
    const items = await Promise.all(
      rows.map(async (row) => {
        const [amendmentCount, openCoverageGaps] = await Promise.all([
          this.prisma.acquisitionRecordRevision
            .groupBy({
              by: ['identityKey'],
              where: { parentIdentityKey: row.identityKey, recordKind: 'amendment' },
            })
            .then((groups) => groups.length),
          this.prisma.acquisitionCoverageGap.count({
            where: { subjectKind: 'acquisition', subjectKey: row.identityKey, resolvedAt: null },
          }),
        ]);
        return this.acquisitionRecordSummaryDto(row, amendmentCount, openCoverageGaps);
      }),
    );
    return {
      items,
      total: grouped.length,
      page,
      limit,
      filters: {
        q: filters.q,
        sourceSystem: filters.sourceSystem,
        recordKind: filters.recordKind,
        status: filters.status,
        buyerOffice: filters.buyerOffice,
        activeOn: filters.activeOn,
      },
    };
  }

  async getAcquisitionActions(
    identityKey: string,
  ): Promise<readonly DefenseAcquisitionRecordActionDto[]> {
    if (!identityKey.trim()) throw new BadRequestException('identityKey is required.');
    const rows = await this.prisma.acquisitionAwardTransactionRevision.findMany({
      where: { OR: [{ awardIdentityKey: identityKey }, { parentAwardIdentityKey: identityKey }] },
      orderBy: [
        { transactionIdentityKey: 'asc' },
        { revision: 'desc' },
        { recordedAt: 'desc' },
        { id: 'desc' },
      ],
      distinct: ['transactionIdentityKey'],
    });
    return rows.map((row) => ({
      transactionIdentityKey: row.transactionIdentityKey,
      awardIdentityKey: row.awardIdentityKey,
      parentAwardIdentityKey: row.parentAwardIdentityKey,
      sourceSystem: row.sourceSystem,
      sourceTransactionId: row.sourceTransactionId,
      piid: row.piid,
      modificationNumber: row.modificationNumber,
      actionDate: row.actionDate?.toISOString().slice(0, 10) ?? null,
      signedObligationDelta: row.signedObligationDelta?.toString() ?? null,
      signedOutlayDelta: row.signedOutlayDelta?.toString() ?? null,
      correctsIdentityKey: row.correctsIdentityKey,
      supersedesId: row.supersedesId,
      sourceUrl: row.sourceUrl,
      sourceObservedAt: row.sourceObservedAt?.toISOString() ?? null,
      recordedAt: row.recordedAt.toISOString(),
      raw: row.raw,
    }));
  }

  async getAcquisitionRecord(
    identityKey: string,
    includeSpeculative?: boolean,
  ): Promise<DefenseAcquisitionRecordDetailDto> {
    const revisions = await this.prisma.acquisitionRecordRevision.findMany({
      where: { identityKey },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    if (revisions.length === 0) {
      throw new NotFoundException('Acquisition record not found');
    }
    const latest = revisions[0]!;
    const childIdentities = await this.prisma.acquisitionRecordRevision
      .findMany({
        where: { parentIdentityKey: identityKey },
        select: { identityKey: true },
        distinct: ['identityKey'],
      })
      .then((rows) => rows.map((row) => row.identityKey));
    const amendmentIdentities = await this.prisma.acquisitionRecordRevision
      .findMany({
        where: { parentIdentityKey: identityKey, recordKind: 'amendment' },
        select: { identityKey: true },
        distinct: ['identityKey'],
      })
      .then((rows) => rows.map((row) => row.identityKey));
    const extractedFields = this.extractFieldsFromRaw(latest.raw);
    const associations = await this.prisma.programAcquisitionRelationship.findMany({
      where: {
        acquisitionIdentityKey: identityKey,
        reviewStatus: includeSpeculative ? { in: ['accepted', 'candidate'] } : 'accepted',
      },
      orderBy: [{ logicalKey: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      distinct: ['logicalKey'],
    });
    const associationDtos = associations.map((rel) => ({
      relationshipId: rel.id,
      relationshipClass: rel.relationshipClass as AcquisitionRelationshipClass,
      subjectKind: rel.subjectKind,
      subjectKey: rel.subjectKey,
      subjectLabel: null,
      validFromFy: rel.validFromFy,
      validToFy: rel.validToFy,
      allocatedAmountUsd:
        rel.reviewStatus === 'accepted' &&
        (rel.relationshipClass === 'source_stated_financial_allocation' ||
          rel.relationshipClass === 'deterministic_financial_allocation')
          ? (rel.allocatedAmountUsd?.toString() ?? null)
          : null,
      sourceUrl: rel.sourceUrl,
      sourceObservedAt: rel.sourceObservedAt?.toISOString() ?? null,
      reviewStatus: rel.reviewStatus as 'accepted' | 'candidate' | 'quarantined',
    }));
    const amendmentCount = amendmentIdentities.length;
    const openCoverageGaps = await this.prisma.acquisitionCoverageGap.count({
      where: {
        subjectKind: 'acquisition',
        subjectKey: identityKey,
        resolvedAt: null,
      },
    });
    const summary = this.acquisitionRecordSummaryDto(latest, amendmentCount, openCoverageGaps);
    return {
      ...summary,
      revisions: revisions.map((rev) => ({
        id: rev.id,
        identityKey: rev.identityKey,
        sourceSystem: rev.sourceSystem,
        sourceRecordId: rev.sourceRecordId,
        recordKind: rev.recordKind,
        title: rev.title,
        status: rev.status,
        buyerOffice: rev.buyerOffice,
        postedAt: rev.postedAt?.toISOString() ?? null,
        responseDeadline: rev.responseDeadline?.toISOString() ?? null,
        validFrom: rev.validFrom?.toISOString() ?? null,
        validTo: rev.validTo?.toISOString() ?? null,
        contentHash: rev.contentHash,
        sourceUrl: rev.sourceUrl,
        sourceVersion: rev.sourceVersion,
        sourceObservedAt: rev.sourceObservedAt?.toISOString() ?? null,
        recordedAt: rev.recordedAt.toISOString(),
        raw: rev.raw,
      })),
      childIdentities,
      amendmentIdentities,
      extractedFields,
      associations: associationDtos,
    };
  }

  async getAcquisitionCoverage(
    subjectKind: string,
    subjectKey: string,
  ): Promise<DefenseAcquisitionCoverageGapListDto> {
    if (!subjectKind?.trim() || !subjectKey?.trim())
      throw new BadRequestException('subjectKind and subjectKey are required.');
    const rows = await this.prisma.acquisitionCoverageGap.findMany({
      where: { subjectKind, subjectKey, resolvedAt: null },
      orderBy: [{ sourceSystem: 'asc' }, { relationshipKind: 'asc' }, { reason: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        subjectKind: row.subjectKind,
        subjectKey: row.subjectKey,
        sourceSystem: row.sourceSystem,
        relationshipKind: row.relationshipKind,
        reason: row.reason,
        detail: row.detail,
        coverageState: row.coverageState,
        sourceAsOf: row.sourceAsOf?.toISOString() ?? null,
        firstObservedAt: row.firstObservedAt.toISOString(),
        lastObservedAt: row.lastObservedAt.toISOString(),
        resolvedAt: null,
      })),
      total: rows.length,
      page: 1,
      limit: rows.length,
      filters: { subjectKind, subjectKey },
    };
  }
}
