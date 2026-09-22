import type { ClaimRevision, RepairLedgerVersion, RepairTraceEvent } from './types';

export interface AssembleAnswerInput {
  baseReply: string;
  ledgerVersion: RepairLedgerVersion;
  revisions: ClaimRevision[];
  trace?: RepairTraceEvent[];
}

export interface AssembledAnswer {
  reply: string;
  citations: string[];
  trace: RepairTraceEvent[];
}

export function assembleAnswer(input: AssembleAnswerInput): AssembledAnswer {
  let reply = input.baseReply;
  const trace = [...(input.trace ?? [])];
  const citations = new Set<string>();
  for (const revision of input.revisions) {
    if (revision.ledgerVersion !== input.ledgerVersion.version) {
      trace.push({
        at: Date.now(),
        type: 'stale_revision_rejected',
        claimId: revision.claimId,
        detail: { revisionVersion: revision.ledgerVersion, currentVersion: input.ledgerVersion.version },
      });
      continue;
    }
    const affected = [revision.originalText, ...revision.dependentSentences].join(' ');
    if (!reply.includes(affected)) continue;
    reply = reply.replace(affected, revision.replacementText);
    revision.sourceIds.forEach((id) => citations.add(id));
  }
  return { reply, citations: [...citations].sort(), trace };
}
