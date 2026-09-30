import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type {
  ActionCard,
  ActionSort,
} from '../intelligence/actions/action-recommendation-read.service.js';
import type { ActionStatus } from '../intelligence/actions/action-recommendation.types.js';

const CURSOR_PREFIX = 'meri-action-item:';
const SOURCE_CONTRACT = 'action_recommendation:canonical:v1';
const MAX_LIMIT = 50;

interface ActionItemCursor {
  version: 1;
  sourceContract: typeof SOURCE_CONTRACT;
  tenantId: string;
  actorUserId: string;
  clientId: string;
  actionItemId: string | null;
  status: string | null;
  sort: ActionSort;
  page: number;
}

export interface MeriActionItemReadSelection {
  clientId: string;
  actionItemId: string | null;
  status: ActionStatus | null;
  sort: ActionSort;
  page: number;
  limit: number;
  cursorApplied: boolean;
}

export interface MeriActionItemOwnerPage {
  data: ActionCard[];
  total: number;
  page: number;
  limit: number;
  sourceStatus: 'healthy' | 'degraded';
  sourceReason: string | null;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function optionalText(input: Record<string, unknown>, key: string, max = 100): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException(`${key} is invalid`);
  return value.trim();
}

function decodeCursor(value: string): ActionItemCursor {
  try {
    if (!value.startsWith(CURSOR_PREFIX)) throw new Error('format');
    const cursor = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as ActionItemCursor;
    if (
      cursor.version !== 1 ||
      cursor.sourceContract !== SOURCE_CONTRACT ||
      typeof cursor.tenantId !== 'string' ||
      typeof cursor.actorUserId !== 'string' ||
      typeof cursor.clientId !== 'string' ||
      !(cursor.actionItemId === null || typeof cursor.actionItemId === 'string') ||
      !(cursor.status === null || typeof cursor.status === 'string') ||
      !['deadline', 'priority'].includes(cursor.sort) ||
      !Number.isSafeInteger(cursor.page) ||
      cursor.page < 2
    )
      throw new Error('contract');
    return cursor;
  } catch {
    throw new BadRequestException('Action-item cursor is invalid or no longer matches this read');
  }
}

function encodeCursor(cursor: ActionItemCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

export function parseMeriActionItemReadInput(
  ctx: TenantContext,
  input: Record<string, unknown>,
  clientId: string,
): MeriActionItemReadSelection {
  const actionItemId = optionalText(input, 'actionItemId', 80);
  const status = optionalText(input, 'status', 40) as ActionStatus | null;
  const sortInput = optionalText(input, 'sort', 20);
  if (sortInput && !['deadline', 'priority'].includes(sortInput))
    throw new BadRequestException('sort must be deadline or priority');
  const sort = (sortInput ?? 'deadline') as ActionSort;
  const requestedLimit = input.limit ?? 20;
  if (
    !Number.isSafeInteger(requestedLimit) ||
    Number(requestedLimit) < 1 ||
    Number(requestedLimit) > MAX_LIMIT
  )
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  const cursorInput = optionalText(input, 'cursor', 4096);
  let page = 1;
  let cursorApplied = false;
  if (cursorInput) {
    const cursor = decodeCursor(cursorInput);
    if (
      cursor.tenantId !== ctx.tenantId ||
      cursor.actorUserId !== ctx.userId ||
      cursor.clientId !== clientId ||
      cursor.actionItemId !== actionItemId ||
      cursor.status !== status ||
      cursor.sort !== sort
    )
      throw new BadRequestException(
        'Action-item cursor does not match the tenant, actor, client, identity, or filters',
      );
    page = cursor.page;
    cursorApplied = true;
  }
  return {
    clientId,
    actionItemId,
    status,
    sort,
    page,
    limit: Number(requestedLimit),
    cursorApplied,
  };
}

function canonicalAction(row: ActionCard) {
  const { linkedSourceProofs = [], ...card } = row;
  const action = {
    id: card.id,
    districtKey: card.districtKey ?? null,
    clientId: card.clientId,
    clientName: row.clientName ?? null,
    peCode: card.peCode,
    programId: card.programId,
    deltaId: card.deltaId,
    actionType: card.actionType,
    issueTitle: card.issueTitle,
    whatChanged: card.whatChanged,
    whyItMatters: card.whyItMatters,
    recommendedAction: card.recommendedAction,
    targetAudience: card.targetAudience,
    suggestedArtifactType: card.suggestedArtifactType,
    deadline: card.deadline,
    deadlineSource: card.deadlineSource,
    ownerUserId: card.ownerUserId,
    priority: card.priority,
    confidence: card.confidence,
    uncertainty: card.uncertainty,
    evidence: card.evidence,
    status: card.status,
    dismissalReason: card.dismissalReason,
    outcome: card.outcome,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    title: row.issueTitle,
    body: row.recommendedAction,
  };
  return {
    ...action,
    recordKind: 'action_recommendation' as const,
    recommendation: true,
    acceptedAsTask: false,
    nativeCompletion: {
      completed: false,
      evidence: row.outcome ? 'recommendation_outcome_only' : null,
      establishesDeliveryOrAcceptance: false,
      note: 'A recommendation, workflow status, or outcome is not an accepted or completed native task.',
    },
    sourceProof: {
      version: 1,
      owner: 'action_recommendation',
      sourceRecordId: row.id,
      currentClientId: row.clientId,
      sourceVersion: row.updatedAt,
      contentSha256: sha256(JSON.stringify(action)),
      linkedSources: linkedSourceProofs,
    },
  };
}

export function buildMeriActionItemReadResult(
  ctx: TenantContext,
  selection: MeriActionItemReadSelection,
  ownerPage: MeriActionItemOwnerPage,
) {
  const seen = new Set<string>();
  const actions = ownerPage.data.map(canonicalAction).filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  if (
    actions.length !== ownerPage.data.length ||
    actions.some((row) => row.clientId !== selection.clientId) ||
    ownerPage.page !== selection.page ||
    ownerPage.limit !== selection.limit
  )
    throw new BadRequestException(
      'Canonical action-item owner returned ambiguous or cross-client rows',
    );
  const hasMore = selection.page * selection.limit < ownerPage.total;
  const nextCursor = hasMore
    ? encodeCursor({
        version: 1,
        sourceContract: SOURCE_CONTRACT,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        clientId: selection.clientId,
        actionItemId: selection.actionItemId,
        status: selection.status,
        sort: selection.sort,
        page: selection.page + 1,
      })
    : null;
  const complete =
    ownerPage.sourceStatus === 'healthy' &&
    !selection.cursorApplied &&
    !hasMore &&
    actions.length === ownerPage.total;
  return {
    tool: 'query_action_items',
    generatedAt: new Date().toISOString(),
    clientId: selection.clientId,
    total: ownerPage.total,
    returned: actions.length,
    actions,
    scope: {
      actionItemId: selection.actionItemId,
      status: selection.status,
      sort: selection.sort,
      page: selection.page,
      limit: selection.limit,
      cursorApplied: selection.cursorApplied,
    },
    coverage: {
      sourceStatus: ownerPage.sourceStatus,
      sourceReason: ownerPage.sourceReason,
      complete,
      partial: !complete,
      paginationComplete: !hasMore,
      hasMore,
      nextCursor,
      totalIsExactForScope: true,
      absenceSupported: complete && actions.length === 0,
      note: complete
        ? 'All currently authorized action recommendations in the declared client scope were returned.'
        : 'This is an exact bounded page. Follow nextCursor before inferring that a recommendation is absent.',
    },
  };
}
