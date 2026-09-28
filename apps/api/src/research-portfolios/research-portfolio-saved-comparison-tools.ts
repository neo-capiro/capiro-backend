import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type {
  TenantContext,
  SaveDefenseComparisonDto,
  DefenseSavedComparisonDto,
  ChangeDefenseSavedComparisonLifecycleDto,
  AddDefenseSavedComparisonSelectionDto,
} from '@capiro/shared';
import type {
  DefenseSavedComparisonsService,
  DefenseSavedComparisonScope,
} from '../defense-research/defense-saved-comparisons.service.js';

export type ResearchPortfolioSavedComparisonInputSchema = {
  type?: string;
  properties?: Record<string, ResearchPortfolioSavedComparisonInputSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: ResearchPortfolioSavedComparisonInputSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
  format?: string;
  anyOf?: readonly ResearchPortfolioSavedComparisonInputSchema[];
};
const text: ResearchPortfolioSavedComparisonInputSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
};
const uuid: ResearchPortfolioSavedComparisonInputSchema = {
  ...text,
  maxLength: 36,
  format: 'uuid',
};
const key: ResearchPortfolioSavedComparisonInputSchema = { ...text, maxLength: 128 };
const revision: ResearchPortfolioSavedComparisonInputSchema = { type: 'integer', minimum: 1 };
const values = (...enumeration: string[]): ResearchPortfolioSavedComparisonInputSchema => ({
  type: 'string',
  enum: enumeration,
});
const nullable = (
  schema: ResearchPortfolioSavedComparisonInputSchema,
): ResearchPortfolioSavedComparisonInputSchema => ({
  anyOf: [schema, { type: 'null' }],
});
const object = (
  properties: Record<string, ResearchPortfolioSavedComparisonInputSchema>,
): ResearchPortfolioSavedComparisonInputSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (
  items: ResearchPortfolioSavedComparisonInputSchema,
  maxItems: number,
  minItems = 0,
): ResearchPortfolioSavedComparisonInputSchema => ({
  type: 'array',
  items,
  maxItems,
  minItems,
});
const selection = object({
  mode: values('explicit'),
  subjectKeys: array(text, 5),
  passageIds: array(uuid, 500),
});
const basis = object(
  Object.fromEntries(
    [
      'requestEdition',
      'fundingFiscalYear',
      'stage',
      'metric',
      'unit',
      'currency',
      'priceBasis',
      'asOfDate',
      'periodStart',
      'periodEnd',
    ].map((field) => [
      field,
      nullable(
        field === 'fundingFiscalYear' ? { type: 'integer', minimum: 1900, maximum: 2200 } : text,
      ),
    ]),
  ),
);
const save = {
  schemaVersion: values('defense_saved_comparison_v1'),
  displayVersion: values('defense-compare-display-v1'),
  name: { ...text, maxLength: 200 },
  subjects: array(
    object({
      type: values('program_element', 'program', 'project', 'budget_line', 'context_document'),
      id: text,
    }),
    5,
    2,
  ),
  selection,
  basisPair: object({ left: basis, right: basis }),
  passageMode: values('none', 'native_sections'),
  contextualRevisionPins: array(
    object({
      documentId: uuid,
      revisionId: uuid,
      sectionIds: array(uuid, 500),
    }),
    5,
  ),
  idempotencyKey: key,
};
const lifecycle = {
  comparisonId: uuid,
  expectedRevision: revision,
  idempotencyKey: key,
};
export const researchPortfolioSavedComparisonActions = {
  comparison_list: {
    properties: { includeArchived: { type: 'boolean' } },
    required: [],
    readOnly: true,
    ids: [],
  },
  comparison_get: {
    properties: { comparisonId: uuid, versionId: uuid },
    required: ['comparisonId'],
    readOnly: true,
    ids: ['comparisonId', 'versionId'],
  },
  comparison_create: {
    properties: save,
    required: Object.keys(save),
    readOnly: false,
    ids: [],
  },
  comparison_revise: {
    properties: { ...save, comparisonId: uuid, expectedRevision: revision },
    required: [...Object.keys(save), 'comparisonId', 'expectedRevision'],
    readOnly: false,
    ids: ['comparisonId'],
  },
  comparison_archive: {
    properties: lifecycle,
    required: Object.keys(lifecycle),
    readOnly: false,
    ids: ['comparisonId'],
  },
  comparison_restore: {
    properties: lifecycle,
    required: Object.keys(lifecycle),
    readOnly: false,
    ids: ['comparisonId'],
  },
  comparison_add_selection: {
    properties: {
      ...lifecycle,
      versionId: uuid,
      expectedPortfolioRevision: revision,
      selection,
    },
    required: [...Object.keys(lifecycle), 'versionId', 'expectedPortfolioRevision', 'selection'],
    readOnly: false,
    ids: ['comparisonId', 'versionId'],
  },
} as const;

function requireAttachment(
  comparison: DefenseSavedComparisonDto,
  ctx: TenantContext,
  portfolioId: string,
): void {
  if (comparison.ownerUserId !== ctx.userId || comparison.portfolioId !== portfolioId)
    throw new NotFoundException('Saved comparison is unavailable in this Research Portfolio chat');
}
/** Inputs are validated by the management discriminator; no supplied context or capture values are delegated. */
export async function executeResearchPortfolioSavedComparison(
  service: DefenseSavedComparisonsService | undefined,
  ctx: TenantContext,
  portfolioId: string,
  action: keyof typeof researchPortfolioSavedComparisonActions,
  p: Record<string, unknown>,
): Promise<unknown> {
  if (!service)
    throw new ServiceUnavailableException('Research Portfolio saved comparisons are unavailable');
  const scope: DefenseSavedComparisonScope = Object.freeze({ portfolioId });
  if (action === 'comparison_list') {
    const rows = await service.list(ctx, p.includeArchived === true, scope);
    return rows.filter((row) => row.ownerUserId === ctx.userId && row.portfolioId === portfolioId);
  }
  if (action === 'comparison_get') {
    const comparison = await service.get(
      ctx,
      p.comparisonId as string,
      p.versionId as string | undefined,
      scope,
    );
    requireAttachment(comparison, ctx, portfolioId);
    return comparison;
  }
  // Native scoped authorization checks attachment under its transaction lock before any write or replay.
  if (action === 'comparison_create' || action === 'comparison_revise') {
    const body: SaveDefenseComparisonDto = {
      schemaVersion: 'defense_saved_comparison_v1',
      displayVersion: 'defense-compare-display-v1',
      name: p.name as string,
      subjects: p.subjects as SaveDefenseComparisonDto['subjects'],
      selection: p.selection as SaveDefenseComparisonDto['selection'],
      basisPair: p.basisPair as SaveDefenseComparisonDto['basisPair'],
      passageMode: p.passageMode as SaveDefenseComparisonDto['passageMode'],
      contextualRevisionPins:
        p.contextualRevisionPins as SaveDefenseComparisonDto['contextualRevisionPins'],
      idempotencyKey: p.idempotencyKey as string,
      portfolioId,
      ...(action === 'comparison_revise' ? { expectedRevision: p.expectedRevision as number } : {}),
    };
    const receipt = await service.save(
      ctx,
      body,
      action === 'comparison_revise' ? (p.comparisonId as string) : undefined,
      scope,
    );
    requireAttachment(receipt.comparison, ctx, portfolioId);
    return receipt;
  }
  const body: ChangeDefenseSavedComparisonLifecycleDto = {
    expectedRevision: p.expectedRevision as number,
    idempotencyKey: p.idempotencyKey as string,
  };
  if (action === 'comparison_archive' || action === 'comparison_restore') {
    const receipt = await service.changeLifecycle(
      ctx,
      p.comparisonId as string,
      body,
      action === 'comparison_archive',
      scope,
    );
    requireAttachment(receipt.comparison, ctx, portfolioId);
    return receipt;
  }
  const selectionBody: AddDefenseSavedComparisonSelectionDto = {
    ...body,
    portfolioId,
    expectedPortfolioRevision: p.expectedPortfolioRevision as number,
    selection: p.selection as SaveDefenseComparisonDto['selection'],
  };
  const receipt = await service.addSelectionToPortfolio(
    ctx,
    p.comparisonId as string,
    p.versionId as string,
    selectionBody,
    scope,
  );
  requireAttachment(receipt.comparison, ctx, portfolioId);
  if (receipt.portfolioId !== portfolioId)
    throw new NotFoundException('Selection receipt is unavailable in this Research Portfolio chat');
  return receipt;
}
