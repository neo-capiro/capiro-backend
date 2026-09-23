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
  /** Revisions that were applied to the reply, in application order. */
  applied: ClaimRevision[];
}

export function assembleAnswer(input: AssembleAnswerInput): AssembledAnswer {
  let reply = input.baseReply;
  const trace = [...(input.trace ?? [])];
  const citations = new Set<string>();
  const applied: ClaimRevision[] = [];
  for (const revision of input.revisions) {
    const staleReason = staleRevisionReason(revision, input.ledgerVersion);
    if (staleReason) {
      trace.push({
        at: Date.now(),
        type: 'stale_revision_rejected',
        claimId: revision.claimId,
        detail: {
          revisionVersion: revision.ledgerVersion,
          currentVersion: input.ledgerVersion.version,
          reason: staleReason,
        },
      });
      continue;
    }
    const affected = [revision.originalText, ...revision.dependentSentences].join(' ');
    if (!reply.includes(affected)) continue;
    // A replacer function keeps `$&`, `$1`, `$'` in source text literal.
    reply = reply.replace(affected, () => revision.replacementText);
    revision.sourceIds.forEach((id) => citations.add(id));
    applied.push(revision);
  }
  return { reply, citations: [...citations].sort(), trace, applied };
}

/**
 * A revision is judged against the evidence it was generated from, not against
 * the final ledger version: later additions for other claims never invalidate
 * it. It is stale only when evidence it cites changed (or disappeared) after it
 * was generated. Without per-evidence history the exact-version rule applies.
 */
function staleRevisionReason(revision: ClaimRevision, ledger: RepairLedgerVersion): string | null {
  const versions = ledger.evidenceVersions;
  if (!versions) {
    return revision.ledgerVersion === ledger.version ? null : 'version_mismatch';
  }
  if (revision.ledgerVersion > ledger.version) return 'future_version';
  const known = new Set(ledger.ledger.evidence.map((item) => item.id));
  for (const id of revision.sourceIds) {
    if (!known.has(id)) return `evidence_removed:${id}`;
    if ((versions[id] ?? 0) > revision.ledgerVersion) return `evidence_changed:${id}`;
  }
  return null;
}
