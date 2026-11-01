import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseEvidenceReference as parseSourceReference } from '../evidence/objective-evidence-source.rules.js';
import type {
  ObjectiveEvidenceSelector,
  ObjectiveEvidenceSnapshot,
} from '../evidence/objective-evidence-source.types.js';

export type QuestionStatus = 'open' | 'answered' | 'closed';
export interface QuestionState {
  id: string;
  version: number;
  title: string;
  status: QuestionStatus;
  answer: string | null;
  evidenceNote: string | null;
  sourceObjectiveVersion: number;
  sourceRevisionId: string;
  evidenceRefs?: ObjectiveEvidenceSnapshot[];
}
export type QuestionCommand = {
  requestId: string;
  questionId: string;
  expectedVersion: number;
  expectedObjectiveVersion: number;
} & (
  | { action: 'create'; title: string }
  | {
      action: 'answer';
      answer: string;
      evidenceNote: string;
      evidenceRefs?: ObjectiveEvidenceSelector[];
    }
  | { action: 'close' }
  | { action: 'reopen' }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function questionId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) invalid();
  return value.toLowerCase();
}
function invalid(): never {
  throw new BadRequestException({
    code: 'OBJECTIVE_QUESTION_INVALID',
    message: 'Invalid Question request.',
  });
}
export function questionConflict(code = 'OBJECTIVE_QUESTION_VERSION_CONFLICT'): never {
  throw new ConflictException({
    code,
    message: 'The Question or its source changed. Reload before continuing.',
  });
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid();
  return value.trim();
}
export function parseEvidenceReference(value: unknown) {
  const ref = parseSourceReference(value);
  return ref.kind === 'document'
    ? { kind: 'document' as const, attachmentId: questionId(ref.attachmentId) }
    : { kind: 'news' as const, articleId: ref.articleId, observationId: ref.observationId };
}
export function parseEvidenceSelectors(value: unknown): ObjectiveEvidenceSelector[] {
  if (!Array.isArray(value) || value.length > 8) invalid();
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const { expectedDigest, ...reference } = entry;
    if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) invalid();
    const parsed = parseEvidenceReference(reference);
    const key =
      parsed.kind === 'document' ? `document:${parsed.attachmentId}` : `news:${parsed.articleId}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    return { ...parsed, expectedDigest };
  });
}
export function parseQuestionCommand(value: unknown): QuestionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const extras =
    row.action === 'create' ? ['title'] : row.action === 'answer' ? ['answer', 'evidenceNote'] : [];
  if (row.action === 'answer' && Object.hasOwn(row, 'evidenceRefs')) extras.push('evidenceRefs');
  const keys = [
    'requestId',
    'questionId',
    'expectedVersion',
    'expectedObjectiveVersion',
    'action',
    ...extras,
  ];
  if (
    Object.keys(row).some((key) => !keys.includes(key)) ||
    Object.keys(row).length !== keys.length
  )
    invalid();
  if (!['create', 'answer', 'close', 'reopen'].includes(String(row.action))) invalid();
  for (const key of ['expectedVersion', 'expectedObjectiveVersion']) {
    if (
      !Number.isInteger(row[key]) ||
      Number(row[key]) < (key === 'expectedVersion' ? 0 : 1) ||
      Number(row[key]) > 2147483647
    )
      invalid();
  }
  if ((row.action === 'create') !== (row.expectedVersion === 0)) invalid();
  const common = {
    requestId: questionId(row.requestId),
    questionId: questionId(row.questionId),
    expectedVersion: Number(row.expectedVersion),
    expectedObjectiveVersion: Number(row.expectedObjectiveVersion),
  };
  if (row.action === 'create') return { ...common, action: 'create', title: text(row.title, 2000) };
  if (row.action === 'answer')
    return {
      ...common,
      action: 'answer',
      answer: text(row.answer, 8000),
      evidenceNote: text(row.evidenceNote, 4000),
      ...(Object.hasOwn(row, 'evidenceRefs')
        ? { evidenceRefs: parseEvidenceSelectors(row.evidenceRefs) }
        : {}),
    };
  return { ...common, action: row.action as 'close' | 'reopen' };
}
export function questionCommandDigest(command: QuestionCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}
export function advanceQuestion(
  current: QuestionState | null,
  command: QuestionCommand,
  source: { objectiveVersion: number; currentRevisionId: string },
): QuestionState {
  if (source.objectiveVersion !== command.expectedObjectiveVersion)
    questionConflict('OBJECTIVE_VERSION_CONFLICT');
  if (command.action === 'create') {
    if (current) questionConflict();
    return {
      id: command.questionId,
      version: 1,
      title: command.title,
      status: 'open',
      answer: null,
      evidenceNote: null,
      sourceObjectiveVersion: source.objectiveVersion,
      sourceRevisionId: source.currentRevisionId,
    };
  }
  if (
    !current ||
    current.id !== command.questionId ||
    current.version !== command.expectedVersion ||
    current.version >= 2147483647
  )
    questionConflict();
  if (command.action === 'close') {
    if (current.status !== 'answered') questionConflict('OBJECTIVE_QUESTION_TRANSITION_INVALID');
    if (
      current.sourceObjectiveVersion !== source.objectiveVersion ||
      current.sourceRevisionId !== source.currentRevisionId
    )
      questionConflict('OBJECTIVE_QUESTION_SOURCE_STALE');
    return { ...current, version: current.version + 1, status: 'closed' };
  }
  if (command.action === 'reopen') {
    if (current.status === 'open') questionConflict('OBJECTIVE_QUESTION_TRANSITION_INVALID');
    return {
      ...current,
      version: current.version + 1,
      status: 'open',
      answer: null,
      evidenceNote: null,
      sourceObjectiveVersion: source.objectiveVersion,
      sourceRevisionId: source.currentRevisionId,
      ...(current.evidenceRefs ? { evidenceRefs: [] } : {}),
    };
  }
  if (current.status !== 'open') questionConflict('OBJECTIVE_QUESTION_TRANSITION_INVALID');
  return {
    ...current,
    version: current.version + 1,
    status: 'answered',
    answer: command.answer,
    evidenceNote: command.evidenceNote,
    sourceObjectiveVersion: source.objectiveVersion,
    sourceRevisionId: source.currentRevisionId,
  };
}
export function presentQuestion(state: QuestionState, currentVersion: number) {
  return {
    ...state,
    evidenceKind: 'objective_context' as const,
    stale: state.sourceObjectiveVersion !== currentVersion,
  };
}
