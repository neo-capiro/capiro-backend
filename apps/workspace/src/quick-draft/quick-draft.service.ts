import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit } from '../collaborators/role-policy.js';
import { ContextService } from '../context/context.service.js';
import {
  WorkspaceReasoningGateway,
  type DraftSectionResult,
  type GenerateOutlineResult,
  type SynthesizeBriefResult,
} from '../workspace-reasoning/workspace-reasoning.gateway.js';
import {
  computeContextSnapshotHash,
  readAgentState,
  type ContextConflict,
  type DocumentAgentOutlineSection,
  type DocumentAgentRunSummary,
  type DocumentAgentState,
} from '../document-agent/document-agent-state.js';
import { REVISION_CONFLICT_CODE } from '../document-agent/document-agent.service.js';
import type {
  GenerateFromIntakeDto,
  QuickDraftSourceDto,
  QuickDraftSourcePurpose,
} from './dto/quick-draft.dto.js';

const MAX_SOURCE_TEXT = 50_000;
const MAX_PROMPT_SOURCE_TEXT = 18_000;
const MAX_PROMPT_TOTAL_TEXT = 120_000;

interface StoredSource {
  id: string;
  purpose: QuickDraftSourcePurpose;
  label: string;
  text: string;
  sourceType: string;
  refId?: string;
  url?: string;
}

interface BlueprintDefinition {
  sections?: Array<{
    id: string;
    title: string;
    purpose?: string;
    instructions?: string;
    required?: boolean;
    lockedByDefault?: boolean;
    targetWords?: { min?: number; max?: number };
    evidenceRules?: string[];
  }>;
  evidencePolicy?: Record<string, unknown>;
  contentRules?: Record<string, unknown>;
}

function sourceKey(source: QuickDraftSourceDto): string {
  return createHash('sha256')
    .update(
      [
        source.purpose,
        source.refId ?? '',
        source.url ?? '',
        source.label.trim().toLowerCase(),
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

function safeText(value: unknown, limit = MAX_SOURCE_TEXT): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function canSupportFacts(source: StoredSource): boolean {
  return source.purpose === 'context' || source.purpose === 'client_saved';
}

function safeHtmlFragment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const cleaned = trimmed
    .replace(
      /<\s*(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
  if (/<[a-z][\s\S]*>/i.test(cleaned)) return cleaned;
  return cleaned
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

function completedStage(
  name: DocumentAgentRunSummary['stages'][number]['name'],
  startedAt: string,
  detail: string,
): DocumentAgentRunSummary['stages'][number] {
  return {
    name,
    status: 'done',
    startedAt,
    completedAt: new Date().toISOString(),
    detail,
  };
}

function briefFromResult(
  result: SynthesizeBriefResult,
  actorId: string,
  now: string,
): DocumentAgentState['brief'] {
  return {
    objective: result.objective,
    audience: result.audience,
    desiredAction: result.desiredAction,
    subject: result.subject,
    centralArgument: result.centralArgument,
    evidenceInstructions: result.evidenceInstructions,
    tone: result.tone,
    targetPages: result.targetPages,
    deadline: result.deadline,
    assumptions: (result.assumptions ?? []).map((assumption) => ({
      id: assumption.id,
      text: assumption.text,
      status: 'open' as const,
    })),
    provenance: result.provenance ?? {},
    approvedAt: now,
    approvedBy: actorId,
  };
}

function fallbackOutline(
  definition: BlueprintDefinition,
  evidenceItemIds: string[],
): DocumentAgentOutlineSection[] {
  return (definition.sections ?? []).map((section, index) => ({
    id: section.id || `section-${index + 1}`,
    title: section.title || `Section ${index + 1}`,
    purpose: section.purpose ?? '',
    instructions: section.instructions ?? '',
    required: section.required ?? true,
    locked: section.lockedByDefault ?? false,
    targetWords: {
      min: Math.max(50, section.targetWords?.min ?? 140),
      max: Math.max(
        section.targetWords?.min ?? 140,
        section.targetWords?.max ?? 240,
      ),
    },
    evidenceItemIds: [...evidenceItemIds],
  }));
}

function normalizeOutline(
  result: GenerateOutlineResult,
  definition: BlueprintDefinition,
  evidenceItemIds: string[],
): DocumentAgentOutlineSection[] {
  const allowedEvidence = new Set(evidenceItemIds);
  const generated = (result.sections ?? []).map((section, index) => ({
    id: section.id || `section-${index + 1}`,
    title: section.title || `Section ${index + 1}`,
    purpose: section.purpose ?? '',
    instructions: section.instructions ?? '',
    required: section.required ?? true,
    locked: section.locked ?? false,
    targetWords: {
      min: Math.max(50, section.targetWords?.min ?? 140),
      max: Math.max(
        section.targetWords?.min ?? 140,
        section.targetWords?.max ?? 240,
      ),
    },
    evidenceItemIds: (section.evidenceItemIds ?? []).filter((id) =>
      allowedEvidence.has(id),
    ),
  }));
  return generated.length
    ? generated
    : fallbackOutline(definition, evidenceItemIds);
}

/**
 * Converts the single intake surface into a complete editable first draft by
 * using the existing MeriV3/OpenAI structured Max reasoning gateway.
 */
@Injectable()
export class QuickDraftService {
  private readonly logger = new Logger(QuickDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly context: ContextService,
    private readonly reasoning: WorkspaceReasoningGateway,
  ) {}

  async generateFromIntake(
    tenantId: string,
    draftId: string,
    actorId: string,
    dto: GenerateFromIntakeDto,
  ) {
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canEdit,
      'You do not have permission to generate this document',
    );

    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: {
        id: true,
        docTitle: true,
        config: true,
        updatedAt: true,
      },
    });
    if (!draft) throw new NotFoundException('Draft not found');

    const config = (draft.config as Record<string, unknown> | null) ?? {};
    const currentState = readAgentState(config);
    if (currentState.revision !== dto.expectedRevision) {
      throw new ConflictException(REVISION_CONFLICT_CODE);
    }
    if (!currentState.blueprintPin) {
      throw new BadRequestException(
        'A published blueprint version must be selected before generation',
      );
    }
    if (!dto.goal.trim()) {
      throw new BadRequestException(
        'Tell Meri what this document should accomplish',
      );
    }

    const blueprintVersion = await this.prisma.wsBlueprintVersion.findFirst({
      where: {
        id: currentState.blueprintPin.versionId,
        blueprintId: currentState.blueprintPin.blueprintId,
        status: 'published',
        OR: [{ tenantId: null }, { tenantId }],
      },
      select: { definition: true, version: true },
    });
    if (!blueprintVersion) {
      throw new BadRequestException(
        'The selected blueprint version is not published or is no longer available',
      );
    }

    const originalUpdatedAt = draft.updatedAt;
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const stages: DocumentAgentRunSummary['stages'] = [];
    const definition =
      (blueprintVersion.definition as BlueprintDefinition | null) ?? {};
    let draftPersisted = false;

    try {
      stages.push(
        completedStage(
          'preflight',
          startedAt,
          `Pinned blueprint v${blueprintVersion.version}; validated ${dto.sources.length} selected sources.`,
        ),
      );

      const storedSources = await this.storeSources(
        tenantId,
        draftId,
        actorId,
        dto.sources,
      );
      const factualSources = storedSources.filter(canSupportFacts);
      const sampleSources = storedSources.filter(
        (source) => source.purpose === 'sample',
      );
      const systemRequests = storedSources.filter(
        (source) => source.purpose === 'system',
      );
      const evidenceItemIds = factualSources.map((source) => source.id);
      const sourcePacket = this.sourcePacket(storedSources);
      const now = new Date().toISOString();

      const briefResult = await this.reasoning.synthesizeBrief(
        tenantId,
        'You are Meri, Capiro’s senior government-affairs document strategist. Create a precise working brief from the user goal and selected context. Never treat sample documents or unresolved system-context requests as factual evidence; use samples only for structure, tone, and drafting quality. Keep assumptions explicit. Return only the structured result.',
        JSON.stringify({
          goal: dto.goal.trim(),
          documentType: currentState.documentType,
          blueprint: definition,
          sources: sourcePacket,
        }),
      );
      const brief = briefFromResult(briefResult, actorId, now);

      const contextAnalysis = await this.reasoning.analyzeContext(
        tenantId,
        'Analyze only sources marked factualUseAllowed for material numeric, date, status, authority, freshness, or semantic conflicts. Sample documents and unresolved system-context requests are not evidence. Return only structured conflicts and coverage.',
        JSON.stringify({ brief, sources: sourcePacket }),
      );
      const conflicts: ContextConflict[] = (
        contextAnalysis.conflicts ?? []
      ).map((conflict) => ({ ...conflict, resolved: false }));
      stages.push(
        completedStage(
          'evidence_plan',
          startedAt,
          `${factualSources.length} factual source(s), ${sampleSources.length} style sample(s), and ${systemRequests.length} Capiro context request(s) were separated by use policy.`,
        ),
      );

      const outlineResult = await this.reasoning.generateOutline(
        tenantId,
        'Create the strongest document outline for this approved brief using the pinned blueprint as the structural contract. Use stable section IDs. Assign only supplied factual evidence IDs. Return only the structured outline.',
        JSON.stringify({
          brief,
          blueprint: definition,
          sources: sourcePacket,
          allowedEvidenceItemIds: evidenceItemIds,
        }),
      );
      const outlineSections = normalizeOutline(
        outlineResult,
        definition,
        evidenceItemIds,
      );
      if (!outlineSections.length) {
        throw new BadRequestException(
          'The selected blueprint does not contain any usable document sections',
        );
      }

      const plan = await this.reasoning.planDocument(
        tenantId,
        'Plan one coherent, decision-oriented government-affairs document. Build a global evidence plan and narrative flow before drafting. Factual claims may use only sources marked factualUseAllowed. Sample documents may influence tone, organization, and rhetorical technique only. Unresolved Capiro context requests are planning instructions, not evidence. Return only the structured plan.',
        JSON.stringify({
          goal: dto.goal.trim(),
          brief,
          outline: outlineSections,
          sources: sourcePacket,
          blueprintRules: {
            evidencePolicy: definition.evidencePolicy,
            contentRules: definition.contentRules,
          },
        }),
      );
      stages.push(
        completedStage(
          'narrative_plan',
          startedAt,
          `Built a single narrative plan across ${outlineSections.length} sections.`,
        ),
      );

      const draftedById = new Map<string, DraftSectionResult>();
      for (const section of outlineSections) {
        const drafted = await this.reasoning.draftDocument(
          tenantId,
          'Draft this section as clean semantic HTML suitable for direct editing in Workspace. Follow the global plan and firm blueprint. Use sample documents only for style and structure. Do not copy distinctive phrasing. Do not invent facts. Qualify or omit claims affected by unresolved context conflicts. Return only the structured section result.',
          JSON.stringify({
            section,
            brief,
            plan,
            unresolvedConflicts: conflicts,
            sources: sourcePacket,
          }),
        );
        draftedById.set(section.id, drafted);
      }
      stages.push(
        completedStage(
          'drafting',
          startedAt,
          `Drafted ${draftedById.size} sections with Max reasoning.`,
        ),
      );

      const editorial = await this.reasoning.runEditorialPass(
        tenantId,
        'Run a global editorial pass over the complete document. Improve coherence, transitions, precision, persuasion, repetition, and consistency of the requested action. Preserve evidence boundaries and locked-section intent. Return clean semantic HTML for every changed section and only the structured result.',
        JSON.stringify({
          brief,
          plan,
          outline: outlineSections,
          sections: outlineSections.map((section) => ({
            sectionId: section.id,
            content: draftedById.get(section.id)?.content ?? '',
          })),
          sources: sourcePacket,
        }),
      );
      const editedById = new Map(
        (editorial.sectionEdits ?? []).map((edit) => [edit.sectionId, edit]),
      );
      stages.push(
        completedStage(
          'editorial_pass',
          startedAt,
          'Completed the whole-document editorial pass.',
        ),
      );

      const sectionContent: Record<string, string> = {};
      const sectionResults: NonNullable<
        DocumentAgentRunSummary['sectionResults']
      > = {};
      for (const section of outlineSections) {
        const raw =
          editedById.get(section.id)?.content ??
          draftedById.get(section.id)?.content ??
          '';
        const content = safeHtmlFragment(raw);
        sectionContent[section.title] = content;
        sectionResults[section.title] = {
          status: content ? 'succeeded' : 'failed',
          error: content
            ? undefined
            : 'The reasoning runtime returned no section content.',
        };
      }

      const failed = Object.values(sectionResults).some(
        (result) => result.status === 'failed',
      );
      stages.push(
        completedStage(
          'assurance',
          startedAt,
          conflicts.length
            ? `${conflicts.length} unresolved context conflict(s) remain visible and will block client delivery until reviewed.`
            : 'No unresolved context conflicts were detected in the selected factual evidence.',
        ),
      );

      const completedAt = new Date().toISOString();
      stages.push(
        completedStage(
          'snapshot',
          startedAt,
          'Prepared the generated draft and pinned intake snapshot for one atomic save.',
        ),
      );
      stages.push(
        completedStage(
          'complete',
          startedAt,
          'The first draft is ready to refine with Meri.',
        ),
      );

      const lastRun: DocumentAgentRunSummary = {
        runId,
        mode: 'max',
        startedAt,
        completedAt,
        status: failed
          ? 'partial'
          : conflicts.length
            ? 'complete_with_warnings'
            : 'complete',
        stages,
        sectionResults,
      };

      const nextState: DocumentAgentState = {
        ...currentState,
        revision: currentState.revision + 1,
        phase: 'draft',
        status: failed ? 'partial' : 'complete',
        goal: {
          text: dto.goal.trim(),
          client: currentState.goal?.client,
          createdAt: currentState.goal?.createdAt ?? now,
        },
        brief,
        contextPlan: {
          includedItemIds: factualSources.map((source) => source.id),
          excludedItems: [],
          conflicts,
          coverage: contextAnalysis.coverage,
          snapshotHash: computeContextSnapshotHash(
            storedSources.map((source) => ({
              id: source.id,
              label: source.label,
              text: source.text,
            })),
          ),
          approvedAt: conflicts.length ? undefined : now,
          approvedBy: conflicts.length ? undefined : actorId,
        },
        outline: {
          version: Math.max(1, currentState.outline.version + 1),
          sections: outlineSections,
          approvedAt: now,
          approvedBy: actorId,
        },
        generation: {
          mode: 'max',
          activeRunId: undefined,
          lastRun,
        },
      };

      const nextConfig = {
        ...config,
        sections: outlineSections.map((section) => section.title),
        sectionContent,
        quickDraftIntake: {
          schemaVersion: 1,
          sourceIds: storedSources.map((source) => source.id),
          factualSourceIds: factualSources.map((source) => source.id),
          sampleSourceIds: sampleSources.map((source) => source.id),
          systemContextRequestIds: systemRequests.map((source) => source.id),
          generatedAt: completedAt,
          reasoningMode: 'max',
        },
        documentAgent: nextState as unknown as Record<string, unknown>,
      };

      const updated = await this.prisma.wsDraft.updateMany({
        where: {
          id: draftId,
          tenantId,
          updatedAt: originalUpdatedAt,
        },
        data: { config: nextConfig as never },
      });
      if (updated.count !== 1) {
        throw new ConflictException(REVISION_CONFLICT_CODE);
      }
      draftPersisted = true;

      // Transcript continuity is useful but not part of the durable document
      // commit. A logging/transcript failure must never turn a successfully
      // saved editable draft into a false generation failure for the user.
      await this.prisma.wsAgentMessage
        .createMany({
          data: [
            {
              tenantId,
              draftId,
              actorId,
              role: 'user',
              phase: 'goal',
              text: dto.goal.trim(),
              data: { sourceCount: storedSources.length },
            },
            {
              tenantId,
              draftId,
              actorId: null,
              role: 'assistant',
              phase: 'draft',
              text: conflicts.length
                ? `Your first draft is ready. I found ${conflicts.length} context issue${conflicts.length === 1 ? '' : 's'} that should be reviewed before delivery.`
                : 'Your first draft is ready. I used Max reasoning to plan, draft, and edit it as one coherent document.',
              data: {
                runId,
                mode: 'max',
                contextConflictCount: conflicts.length,
              },
            },
          ],
        })
        .catch((messageError: unknown) => {
          this.logger.warn(
            `Draft ${draftId} was saved, but its intake transcript could not be recorded: ${
              messageError instanceof Error
                ? messageError.message
                : 'unknown error'
            }`,
          );
        });

      return {
        state: nextState,
        run: lastRun,
        draft: { id: draft.id, docTitle: draft.docTitle },
        sourceSummary: {
          total: storedSources.length,
          factual: factualSources.length,
          samples: sampleSources.length,
          system: systemRequests.length,
        },
      };
    } catch (error) {
      this.logger.error(
        `Quick draft generation failed for ${draftId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      if (!draftPersisted) {
        await this.persistFailureState(
          tenantId,
          draftId,
          config,
          currentState,
          runId,
          startedAt,
          originalUpdatedAt,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async storeSources(
    tenantId: string,
    draftId: string,
    actorId: string,
    sources: QuickDraftSourceDto[],
  ): Promise<StoredSource[]> {
    const existing = await this.context.listItems(tenantId, draftId, actorId);
    const existingByKey = new Map<string, (typeof existing)[number]>();
    for (const item of existing) {
      const payload = (item.payload as Record<string, unknown> | null) ?? {};
      const key = safeText(payload.quickDraftSourceKey, 128);
      if (key) existingByKey.set(key, item);
    }

    const stored: StoredSource[] = [];
    for (const source of sources) {
      const key = sourceKey(source);
      const found = existingByKey.get(key);
      if (found) {
        const payload =
          (found.payload as Record<string, unknown> | null) ?? {};
        stored.push({
          id: found.id,
          purpose: source.purpose,
          label: safeText(payload.label, 240) || source.label,
          text: safeText(payload.text),
          sourceType:
            safeText(payload.sourceType, 120) ||
            source.sourceType ||
            source.purpose,
          refId: safeText(payload.refId, 512) || undefined,
          url: safeText(payload.url, 2_048) || undefined,
        });
        continue;
      }

      const text = safeText(source.text);
      const payload: Record<string, unknown> = {
        label: source.label.trim(),
        text,
        sourceType: source.sourceType ?? source.purpose,
        authority:
          source.purpose === 'client_saved'
            ? 'client'
            : source.purpose === 'system'
              ? 'firm'
              : 'unknown',
        verification: 'not_verified',
        freshness: 'unknown',
        included: true,
        scope: 'document',
        purpose: source.purpose,
        usePolicy:
          source.purpose === 'sample'
            ? 'style_and_structure_only'
            : source.purpose === 'system'
              ? 'internal_context_request_only'
              : 'factual_context',
        quickDraftSourceKey: key,
        metadata: source.metadata ?? {},
      };
      if (source.refId) payload.refId = source.refId;
      if (source.url) payload.url = source.url;

      const created = await this.context.addItem(
        tenantId,
        draftId,
        {
          kind: source.purpose === 'system' ? 'free-text' : 'source',
          payload,
        },
        actorId,
      );
      stored.push({
        id: created.id,
        purpose: source.purpose,
        label: source.label.trim(),
        text,
        sourceType: source.sourceType ?? source.purpose,
        refId: source.refId,
        url: source.url,
      });
    }
    return stored;
  }

  private sourcePacket(sources: StoredSource[]) {
    let remaining = MAX_PROMPT_TOTAL_TEXT;
    return sources.map((source) => {
      const allowed = Math.min(MAX_PROMPT_SOURCE_TEXT, Math.max(0, remaining));
      const text = source.text.slice(0, allowed);
      remaining -= text.length;
      const factualUseAllowed = canSupportFacts(source);
      return {
        id: source.id,
        purpose: source.purpose,
        label: source.label,
        sourceType: source.sourceType,
        refId: source.refId,
        url: source.url,
        text,
        truncated: text.length < source.text.length,
        factualUseAllowed,
        instruction:
          source.purpose === 'sample'
            ? 'Use only as a style, structure, and rhetorical-quality reference. Do not copy distinctive phrasing and do not treat any statement as evidence.'
            : source.purpose === 'system'
              ? 'This is a requested Capiro context domain, not retrieved evidence. Do not infer facts from the request label. Use only factual context that is explicitly supplied elsewhere in this packet.'
              : 'May support factual claims when relevant, authoritative, and not contradicted.',
      };
    });
  }

  private async persistFailureState(
    tenantId: string,
    draftId: string,
    existingConfig: Record<string, unknown>,
    currentState: DocumentAgentState,
    runId: string,
    startedAt: string,
    originalUpdatedAt: Date,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const failedState: DocumentAgentState = {
      ...currentState,
      revision: currentState.revision + 1,
      phase: 'generate',
      status: 'failed',
      generation: {
        mode: 'max',
        activeRunId: undefined,
        lastRun: {
          runId,
          mode: 'max',
          startedAt,
          completedAt,
          status: 'failed',
          stages: [
            {
              name: 'preflight',
              status: 'done',
              startedAt,
              completedAt,
            },
            {
              name: 'complete',
              status: 'failed',
              startedAt: completedAt,
              completedAt,
              detail:
                'The first draft could not be completed. The intake was preserved for retry.',
            },
          ],
        },
      },
    };
    await this.prisma.wsDraft.updateMany({
      where: {
        id: draftId,
        tenantId,
        updatedAt: originalUpdatedAt,
      },
      data: {
        config: {
          ...existingConfig,
          documentAgent: failedState as unknown as Record<string, unknown>,
        } as never,
      },
    });
  }
}
