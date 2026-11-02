import type { ObjectiveOperationalActor, ObjectiveOperationalTx } from '@capiro/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { OperationalScope } from '../operational/objective-operational.types.js';
import {
  advanceQuestion,
  questionCommandDigest,
  questionConflict,
  type QuestionCommand,
  type QuestionState,
} from './objective-question.rules.js';
import {
  presentQuestionEvidence,
  requireCurrentQuestionEvidence,
  type QuestionEvidenceOwner,
} from './objective-question.evidence.js';

type Tx = ObjectiveOperationalTx;
type Scope = Pick<
  OperationalScope,
  'clientId' | 'objectiveId' | 'objectiveVersion' | 'currentRevisionId'
>;
function refused(requestId: string): never {
  throw new ConflictException({
    error: { code: 'OBJECTIVE_QUESTION_REFUSED' },
    requestId,
    outcome: 'not_committed',
    message:
      'This Question command was refused without changes. Reload its current source and review again.',
  });
}
interface Revision {
  requestId: string;
  payloadDigest: string;
  actorUserId: string;
  action: QuestionCommand['action'];
  snapshot: QuestionState;
  committedAt: Date;
}
export async function presentRevision(
  row: Revision,
  scope: Scope,
  evidence?: QuestionEvidenceOwner,
) {
  return {
    requestId: row.requestId,
    actorUserId: row.actorUserId,
    action: row.action,
    committedAt: row.committedAt.toISOString(),
    ...(row.snapshot.evidenceRefs?.length ? { payloadDigest: row.payloadDigest } : {}),
    question: await presentQuestionEvidence(row.snapshot, scope.objectiveVersion, evidence),
  };
}
export async function findQuestionReceipt(
  tx: Tx,
  actor: ObjectiveOperationalActor,
  scope: Scope,
  requestId: string,
): Promise<Revision | null> {
  const rows = await tx.$queryRaw<
    Revision[]
  >`SELECT request_id::text AS "requestId", payload_digest AS "payloadDigest", actor_user_id::text AS "actorUserId", action,snapshot,committed_at AS "committedAt"
    FROM client_objective_question_revisions WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid
    AND objective_id=${scope.objectiveId}::uuid AND actor_user_id=${actor.userId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0] ?? null;
}
export async function readQuestionCitation(
  tx: Tx,
  actor: ObjectiveOperationalActor,
  scope: Scope,
  id: string,
  version: number,
  digest: string,
) {
  const rows = await tx.$queryRaw<Array<{ snapshot: QuestionState }>>`
    SELECT snapshot FROM client_objective_question_revisions WHERE tenant_id=${actor.tenantId}::uuid
    AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid
    AND question_id=${id}::uuid AND version=${version}`;
  const citation = rows[0]?.snapshot.evidenceRefs?.find((ref) => ref.digest === digest);
  if (!citation || citation.selector.kind !== 'document')
    throw new NotFoundException('Question citation unavailable.');
  return citation;
}
export async function readQuestions(
  tx: Tx,
  actor: ObjectiveOperationalActor,
  scope: Scope,
  after: string | null,
  status: string | null,
  evidence?: QuestionEvidenceOwner,
) {
  const rows = await tx.$queryRaw<
    Array<{ snapshot: QuestionState }>
  >`SELECT snapshot FROM client_objective_questions
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid
    AND (${after}::uuid IS NULL OR id>${after}::uuid) AND (${status}::text IS NULL OR status=${status}) ORDER BY id LIMIT 51`;
  const counts = await tx.$queryRaw<
    Array<{ total: number; openCount: number }>
  >`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='open')::int AS "openCount"
    FROM client_objective_questions WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid`;
  if (!counts[0]) throw new Error('Question count observation unavailable.');
  return {
    ...counts[0],
    items: await Promise.all(
      rows
        .slice(0, 50)
        .map((row) => presentQuestionEvidence(row.snapshot, scope.objectiveVersion, evidence)),
    ),
    nextCursor: rows.length > 50 ? rows[49]!.snapshot.id : null,
  };
}
export async function readQuestionHistory(
  tx: Tx,
  actor: ObjectiveOperationalActor,
  scope: Scope,
  questionId: string,
  before: number | null,
  evidence?: QuestionEvidenceOwner,
) {
  const rows = await tx.$queryRaw<
    Revision[]
  >`SELECT request_id::text AS "requestId", payload_digest AS "payloadDigest", actor_user_id::text AS "actorUserId", action,snapshot,committed_at AS "committedAt"
    FROM client_objective_question_revisions WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid
    AND question_id=${questionId}::uuid AND (${before}::int IS NULL OR version<${before}::int) ORDER BY version DESC LIMIT 51`;
  if (!rows.length && before === null) throw new NotFoundException('Question not available.');
  return {
    items: await Promise.all(rows.slice(0, 50).map((row) => presentRevision(row, scope, evidence))),
    nextCursor: rows.length > 50 ? rows[49]!.snapshot.version : null,
  };
}
export async function commitQuestion(
  tx: Tx,
  actor: ObjectiveOperationalActor,
  scope: Scope,
  command: QuestionCommand,
  evidence?: QuestionEvidenceOwner,
) {
  // Serialize the original actor/request before touching a Question, including concurrent creates.
  const requestKey = [
    actor.tenantId,
    scope.clientId,
    scope.objectiveId,
    actor.userId,
    command.requestId,
  ].join(':');
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}, 0))::text`;
  const digest = questionCommandDigest(command);
  const prior = await findQuestionReceipt(tx, actor, scope, command.requestId);
  if (prior) {
    if (prior.payloadDigest !== digest) questionConflict('OBJECTIVE_QUESTION_REQUEST_CONFLICT');
    return presentRevision(prior, scope, evidence);
  }
  const records = await tx.$queryRaw<
    Array<{ snapshot: QuestionState }>
  >`SELECT snapshot FROM client_objective_questions
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid AND id=${command.questionId}::uuid FOR UPDATE`;
  let next: QuestionState;
  try {
    next = advanceQuestion(records[0]?.snapshot ?? null, command, scope);
    if (command.action === 'close') await requireCurrentQuestionEvidence(next, evidence);
    if (command.action === 'answer' && command.evidenceRefs !== undefined) {
      if (command.evidenceRefs.length && !evidence)
        throw new Error('Question evidence owner unavailable.');
      next.evidenceRefs = [];
      for (const selector of command.evidenceRefs) {
        const resolved = await evidence!.resolve(selector);
        if (resolved.digest !== selector.expectedDigest)
          questionConflict('OBJECTIVE_QUESTION_SOURCE_STALE');
        next.evidenceRefs.push(resolved);
      }
      // Repeat the owning current-source check immediately before the durable write.
      await requireCurrentQuestionEvidence(next, evidence);
    }
  } catch (error) {
    // Only transition/CAS refusal after original-request reconciliation is definitive.
    if (error instanceof ConflictException) refused(command.requestId);
    throw error;
  }
  const snapshot = JSON.stringify(next);
  if (command.action === 'create') {
    const inserted = await tx.$queryRaw<
      Array<{ id: string }>
    >`INSERT INTO client_objective_questions (id,tenant_id,client_id,objective_id,version,status,snapshot)
      VALUES (${next.id}::uuid,${actor.tenantId}::uuid,${scope.clientId}::uuid,${scope.objectiveId}::uuid,${next.version},${next.status},${snapshot}::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length !== 1) refused(command.requestId);
  } else {
    const updated = await tx.$queryRaw<
      Array<{ id: string }>
    >`UPDATE client_objective_questions SET version=${next.version},status=${next.status},snapshot=${snapshot}::jsonb
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${scope.clientId}::uuid AND objective_id=${scope.objectiveId}::uuid AND id=${next.id}::uuid AND version=${command.expectedVersion} RETURNING id`;
    if (updated.length !== 1) refused(command.requestId);
  }
  const rows = await tx.$queryRaw<Revision[]>`INSERT INTO client_objective_question_revisions
    (tenant_id,client_id,objective_id,question_id,version,source_revision_id,source_objective_version,actor_user_id,request_id,payload_digest,action,snapshot)
    VALUES (${actor.tenantId}::uuid,${scope.clientId}::uuid,${scope.objectiveId}::uuid,${next.id}::uuid,${next.version},${next.sourceRevisionId}::uuid,${next.sourceObjectiveVersion},${actor.userId}::uuid,${command.requestId}::uuid,${digest},${command.action},${snapshot}::jsonb)
    RETURNING request_id::text AS "requestId", payload_digest AS "payloadDigest", actor_user_id::text AS "actorUserId", action,snapshot,committed_at AS "committedAt"`;
  if (!rows[0]) throw new Error('Original Question receipt unavailable.');
  return presentRevision(rows[0], scope, evidence);
}
