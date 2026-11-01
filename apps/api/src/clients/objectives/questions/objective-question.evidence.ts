import { ConflictException } from '@nestjs/common';
import type {
  ObjectiveEvidenceSelector,
  ObjectiveEvidenceSnapshot,
} from '../evidence/objective-evidence-source.types.js';
import { presentQuestion, type QuestionState } from './objective-question.rules.js';

/** Source querying and access remain with the canonical evidence owner. */
export interface QuestionEvidenceOwner {
  resolve(selector: ObjectiveEvidenceSelector): Promise<ObjectiveEvidenceSnapshot>;
  inspect(snapshot: ObjectiveEvidenceSnapshot): Promise<{
    status: 'current' | 'stale' | 'unavailable';
    snapshot?: ObjectiveEvidenceSnapshot;
  }>;
}
export async function presentQuestionEvidence(
  state: QuestionState,
  currentVersion: number,
  owner?: QuestionEvidenceOwner,
) {
  const question = presentQuestion(state, currentVersion);
  if (!state.evidenceRefs?.length) return question;
  const inspected = await Promise.all(
    state.evidenceRefs.map(async (ref) => {
      // A missing owner never releases retained external content.
      try {
        return (await owner?.inspect(ref)) ?? { status: 'unavailable' as const };
      } catch {
        return { status: 'unavailable' as const };
      }
    }),
  );
  const unavailable = inspected.some((ref) => ref.status === 'unavailable' || !ref.snapshot);
  const stale = unavailable || inspected.some((ref) => ref.status !== 'current');
  return {
    ...question,
    evidenceKind: 'cited_sources' as const,
    evidenceState: unavailable
      ? ('unavailable' as const)
      : stale
        ? ('stale' as const)
        : ('current' as const),
    stale: question.stale || stale,
    answer: unavailable ? null : question.answer,
    evidenceNote: unavailable ? null : question.evidenceNote,
    evidenceRefs: unavailable ? [] : inspected.map((ref) => ref.snapshot!),
  };
}
export async function requireCurrentQuestionEvidence(
  state: QuestionState,
  owner?: QuestionEvidenceOwner,
) {
  if (!state.evidenceRefs?.length) return;
  if (!owner) throw new Error('Question evidence owner unavailable.');
  for (const ref of state.evidenceRefs) {
    const result = await owner.inspect(ref);
    if (result.status !== 'current' || !result.snapshot || result.snapshot.digest !== ref.digest)
      throw new ConflictException('OBJECTIVE_QUESTION_SOURCE_STALE');
  }
}
