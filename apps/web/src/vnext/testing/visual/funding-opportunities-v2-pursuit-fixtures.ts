/**
 * Typed presentation transport for the supplied pursuit reference.
 *
 * This is testing-only data. It deliberately maps the authoritative reference
 * exports instead of copying a second set of pursuit records or becoming a
 * production API fallback.
 */
import type {
  PipelineBoardView,
  PipelineCardView,
  PipelineStageView,
} from '../../pages/funding-opportunities/funding-opportunities-domain.js';
import {
  referencePursuitAllowedMoves,
  referencePursuitRows,
} from './funding-opportunities-v2-reference-data.js';
import type { ReferencePursuitRow } from './funding-opportunities-v2-reference-data.js';

const sourceKeys: Record<string, string> = {
  'SAM.gov': 'sam_gov',
  'Grants.gov': 'grants_gov',
  'DLA bid board': 'dibbs',
  'California Grants Portal': 'ca_portal',
};

const sourceRecordIds: Record<string, string> = {
  p1: '00000000-0000-4000-8000-000000000001',
  p2: '00000000-0000-4000-8000-000000000002',
  p3: '00000000-0000-4000-8000-000000000003',
  p4: '00000000-0000-4000-8000-000000000004',
  p5: '00000000-0000-4000-8000-000000000005',
  p6: '00000000-0000-4000-8000-000000000006',
  p7: '00000000-0000-4000-8000-000000000007',
  p8: '00000000-0000-4000-8000-000000000008',
  p9: '00000000-0000-4000-8000-000000000009',
  p10: '00000000-0000-4000-8000-000000000010',
  p11: '00000000-0000-4000-8000-000000000011',
  p12: '00000000-0000-4000-8000-000000000012',
  p13: '00000000-0000-4000-8000-000000000013',
};

const ownerIds: Record<string, string> = {
  'Neo Martinez': 'neo-martinez',
  'Priya Raman': 'priya-raman',
};

const keyDateIso: Record<string, string | null> = {
  p1: '2026-09-24',
  p2: '2026-10-30',
  p3: '2026-09-20',
  p4: '2026-11-14',
  p5: '2026-10-14',
  p6: '2027-01-09',
  p7: '2026-10-07',
  p8: '2026-11-02',
  p9: '2026-12-12',
  p10: '2026-10-15',
  p11: null,
  p12: '2026-08-12',
  p13: '2026-08-18',
};

export const referencePursuitSourceIdentity = Object.freeze(
  Object.fromEntries(referencePursuitRows.map((row) => [row.id, {
    source: sourceKeys[row.source[0]] ?? row.source[0],
    sourceRecordId: sourceRecordIds[row.id] ?? null,
    sourceReference: row.ref,
  }])),
);

function stageMoves(stage: string): PipelineStageView[] {
  const moves = referencePursuitAllowedMoves[stage as keyof typeof referencePursuitAllowedMoves] ?? [];
  return moves.map(([key]) => key as PipelineStageView);
}

function cardFromReference(row: ReferencePursuitRow): PipelineCardView {
  const source = sourceKeys[row.source[0]] ?? row.source[0].toLowerCase().replaceAll(' ', '_');
  const owner = row.owner === 'Unassigned'
    ? null
    : { userId: ownerIds[row.owner] ?? row.owner.toLowerCase().replaceAll(' ', '-'), name: row.owner, email: null };
  const lifecycle = row.stage === 'won' ? 'post_award' : row.stage === 'lost' ? 'closed' : 'active';
  const kind = row.stage === 'won' ? 'award' : row.stage === 'lost' ? 'closed' : row.id === 'p11' ? 'anticipated_award' : row.id === 'p3' || row.id === 'p10' ? 'quote' : 'response';
  const keyDate = {
    kind,
    date: keyDateIso[row.id] ?? null,
    displayLabel: kind === 'anticipated_award' ? 'Dec 2026' : undefined,
  } as const;
  const value = row.basis.startsWith('Awarded $')
    ? { display: row.basis.slice('Awarded '.length), basis: 'awarded_amount' }
    : row.flag?.[0] === 'Value not provided'
      ? { display: 'Not provided by source', basis: 'Source value unavailable' }
      : null;
  return {
    rowId: row.id,
    source,
    sourceRecordId: sourceRecordIds[row.id] ?? row.ref,
    sourceReference: row.ref,
    title: row.title,
    stage: row.stage as PipelineStageView,
    stageBasis: 'recorded',
    stageExplanation: row.stage === 'lost' || row.stage === 'passed' ? 'Moved here by a person.' : row.basis,
    stageReason: row.stage === 'lost' || row.stage === 'passed' ? row.basis : null,
    version: 1,
    allowedTransitions: stageMoves(row.stage),
    responseDeadline: kind === 'response' || kind === 'quote' ? (keyDateIso[row.id] ?? null) : null,
    keyDate,
    value,
    flag: row.flag ? { label: row.flag[0], tone: row.flag[1] } : null,
    owner,
    lifecycle,
    nextAction: row.next || null,
    nextActionDueAt: null,
    capability: row.flag?.[0] === 'Eligibility gap' ? { canPursue: false, reason: 'Eligibility gap' } : undefined,
  };
}

export const referencePursuitCards = referencePursuitRows.map(cardFromReference);

const REFERENCE_CLOCK = new Date('2026-09-16T12:00:00Z');

function summaryForCards(cards: readonly PipelineCardView[]): NonNullable<PipelineBoardView['summary']> {
  const dated = cards.filter((card) => card.keyDate?.date && (card.keyDate.kind === 'response' || card.keyDate.kind === 'quote'));
  return {
    inPipeline: cards.filter((card) => card.stage != null).length,
    deadlinesInside30Days: dated.filter((card) => {
      const date = Date.parse(`${card.keyDate!.date}T00:00:00Z`);
      const days = Math.round((date - REFERENCE_CLOCK.getTime()) / 86_400_000);
      return days >= 0 && days <= 30;
    }).length,
    unassigned: cards.filter((card) => card.stage != null && card.owner == null).length,
    awaitingAward: cards.filter((card) => card.stage === 'submitted').length,
    lastStageChange: '2026-08-20T00:00:00Z',
  };
}

function boardForCards(cards: readonly PipelineCardView[], clientId = 'overland'): PipelineBoardView {
  return {
    clientId,
    counts: {
      stages: ['reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'].map((stage) => ({ stage: stage as PipelineStageView, count: cards.filter((card) => card.stage === stage).length })),
      unstaged: { suggested: 0, expired: 0, other: 0 },
      total: cards.length,
      derivedFromWorkflowStatus: 0,
    },
    cards: [...cards],
    cardsTruncated: false,
    hasMore: false,
    summary: summaryForCards(cards),
  };
}

export const referencePursuitBoardFixture: PipelineBoardView = boardForCards(referencePursuitCards);

export function createReferencePursuitBoardFixture(clientId = referencePursuitBoardFixture.clientId): PipelineBoardView {
  return boardForCards(referencePursuitCards.map((card) => ({ ...card, allowedTransitions: [...card.allowedTransitions] })), clientId);
}

export function createReferencePursuitFixtureApi(): {
  get<T>(url: string): Promise<{ data: T }>;
  post<T>(url: string, data?: unknown): Promise<{ data: T }>;
} {
  let cards = referencePursuitCards.map((card) => ({ ...card, allowedTransitions: [...card.allowedTransitions] }));
  let lastStageChange = '2026-08-20T00:00:00Z';
  const summaryBoard = (clientId = referencePursuitBoardFixture.clientId) => {
    const board = boardForCards(cards, clientId);
    return { ...board, summary: { ...board.summary!, lastStageChange } };
  };
  const currentBoard = (clientId = referencePursuitBoardFixture.clientId) => summaryBoard(clientId);
  return {
    async get<T>(url: string) {
      if (url.includes('/pipeline')) return { data: currentBoard() as T };
      throw new Error(`Unexpected pursuit fixture GET ${url}`);
    },
    async post<T>(url: string, data?: unknown) {
      if (url.includes('/pipeline/') && url.endsWith('/stage')) {
        const rowId = decodeURIComponent(url.split('/').at(-2) ?? '');
        const input = data as { toStage?: PipelineStageView; expectedVersion?: number; reason?: string | null } | undefined;
        const card = cards.find((entry) => entry.rowId === rowId);
        if (!card) throw { response: { status: 404, data: { message: 'The opportunity is no longer in this pipeline.' } } };
        if (input?.expectedVersion !== card.version) throw { response: { status: 409, data: { message: 'This opportunity changed while you were viewing it.' } } };
        if (!input.toStage || !card.allowedTransitions.includes(input.toStage)) throw { response: { status: 409, data: { message: 'That stage move is no longer allowed.' } } };
        if ((input.toStage === 'lost' || input.toStage === 'passed') && !input.reason?.trim()) throw { response: { status: 400, data: { message: 'A reason is required for this stage.' } } };
        const next = {
          ...card,
          stage: input.toStage,
          version: card.version + 1,
          allowedTransitions: stageMoves(input.toStage),
          stageExplanation: card.stageExplanation,
          stageReason: input.reason?.trim() || card.stageReason,
          flag: input.toStage === 'lost' || input.toStage === 'passed' ? { label: 'Reason recorded', tone: 'gray' } : card.flag,
        };
        cards = cards.map((entry) => entry.rowId === rowId ? next : entry);
        lastStageChange = REFERENCE_CLOCK.toISOString();
        return { data: { rowId, to: input.toStage, version: next.version } as T };
      }
      throw new Error(`Unexpected pursuit fixture POST ${url}`);
    },
  };
}

export const referencePursuitFixtureInventory = {
  source: 'referencePursuitRows',
  cards: 'referencePursuitCards',
  board: 'referencePursuitBoardFixture',
  api: 'createReferencePursuitFixtureApi',
} as const;
