import type { AssuredClaim } from '../assurance/claim-ledger';
import type { EvidenceDecision, EvidenceEnvelope } from '../jev/decision-contract';
import { assembleAnswer } from './assemble';
import { deriveRequirement, planRemedy } from './plan-remedy';
import { limitationSentence, proportionalFallback, recheckRevision } from './recheck';
import { reviseAffectedClaim } from './revise';
import type {
  ClaimRevision,
  ClaimRevisionReason,
  RepairClaimOutcome,
  RepairDocumentReference,
  RepairEvidence,
  RepairLedgerVersion,
  RepairOutcome,
  RepairOutcomeStatus,
  RepairSummary,
  RepairTokenUsage,
  RepairTraceEvent,
  RunRepairLoopInput,
} from './types';

/** One short claim-local note; the budget is never mentioned in customer text. */
export const REPAIR_BUDGET_LIMITATION =
  'Evidence limitation: this statement was not re-verified within this turn.';
/** The one-clause note left where an unverified exact-value claim was removed. */
export const OMITTED_CLAIM_NOTE = 'The unverified exact-value claim was omitted.';

const UNREADABLE_STATES = new Set(['metadata_only', 'failed', 'pending', 'unsupported']);
const DOCUMENT_TOOL = /document|attachment|transcript/i;

interface ResolvedReference {
  item: RepairDocumentReference;
  /** Matched through the claim's own evidence or filename, not by elimination. */
  direct: boolean;
}

export async function runRepairLoop(input: RunRepairLoopInput): Promise<RepairOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + input.budget.maxMs;
  const trace: RepairTraceEvent[] = [];
  const revisions: ClaimRevision[] = [];
  const failedDedupeKeys = new Set<string>();
  const tokens: RepairTokenUsage = { revisionInput: 0, revisionOutput: 0, recheckInput: 0 };
  const attempted: AssuredClaim[] = [];
  const unresolvedReasons = new Map<string, RepairClaimOutcome['reason']>();
  let ledger = cloneLedger(input.ledger);
  let toolCalls = 0;
  let inputTokens = 0;
  let budgetHit = false;
  let budgetNoted = false;

  for (const claim of input.claims) {
    const initialDecision = decisionFor(input.decisions, claim.id);
    if (!initialDecision || isSupported(initialDecision)) continue;
    attempted.push(claim);
    let decision = initialDecision;
    let hadNewEvidence = false;
    // A second pass for THIS claim needs a new remedy kind; other claims may
    // reuse the same kind.
    const remedyKinds = new Set<string>();
    const reference = documentReferenceFor(claim, input.documentReferences);
    const documentName = reference?.item.filename?.trim() || input.missingDocumentName;
    // A sentence the ledger already supports is qualified, never deleted.
    const fallbackFor = (): 'qualified' | 'omitted' =>
      ledgerMarksSupported(claim, ledger) ? 'qualified' : proportionalFallback(claim);

    for (let pass = 1; pass <= input.budget.maxPasses; pass += 1) {
      if (input.signal?.aborted) return finish(true);
      if (
        now() >= deadlineAt ||
        toolCalls >= input.budget.maxToolCalls ||
        inputTokens >= input.budget.maxInputTokens
      ) {
        trace.push(event(now(), 'budget_exhausted', claim.id, pass, {}));
        budgetHit = true;
        unresolvedReasons.set(claim.id, 'budget_exhausted');
        // Remaining flagged sentences stay untouched; at most one note is added.
        if (!budgetNoted) {
          budgetNoted = true;
          revisions.push(
            fallbackRevision(
              claim,
              ledger.version,
              'qualified',
              `${claim.text} ${REPAIR_BUDGET_LIMITATION}`,
              'budget_exhausted',
            ),
          );
          trace.push(event(now(), 'qualification', claim.id, pass, { reason: 'budget_exhausted' }));
        }
        break;
      }

      const envelope = envelopeFor(claim, ledger, input);
      const requirement = deriveRequirement({
        decision,
        claim,
        envelope,
        evidencePlan: input.evidencePlan,
        deterministic: input.deterministic?.[claim.id],
      });
      if (!requirement) break;
      if (
        reference &&
        (reference.direct || requirement.toolFamilies.some((name) => DOCUMENT_TOOL.test(name)))
      ) {
        requirement.route = {
          ...requirement.route,
          documentId: reference.item.id,
          ...(reference.item.filename ? { documentName: reference.item.filename } : {}),
        };
      }
      trace.push(
        event(now(), 'requirement', claim.id, pass, {
          kind: requirement.kind,
          ...(requirement.route ? { route: requirement.route } : {}),
        }),
      );
      // A document the turn already knows cannot be read needs no tool call:
      // the claim is narrowed to a request for that document.
      if (
        requirement.kind === 'document_unavailable' ||
        (requirement.route && reference && referenceUnreadable(reference.item))
      ) {
        pushDocumentRequest(claim, pass, documentName);
        break;
      }
      const plan = planRemedy(requirement, {
        tenantId: input.tenantId,
        clientId: input.clientId,
        scopeQualifiers: input.scopeQualifiers,
        evidencePlan: input.evidencePlan,
        toolRegistry: input.toolRegistry,
        failedDedupeKeys,
        previousRemedyKinds: remedyKinds as Set<never>,
      });
      if (!plan.remedy) {
        trace.push(event(now(), 'remedy_refused', claim.id, pass, { reason: plan.reason }));
        const fallback = fallbackFor();
        pushFallback(claim, pass, fallback, fallbackText(claim, fallback), 'remedy_refused', {
          detail: plan.reason,
        });
        break;
      }
      const remedy = plan.remedy;
      remedyKinds.add(remedy.kind);
      trace.push(
        event(now(), 'remedy_planned', claim.id, pass, {
          remedyId: remedy.id,
          kind: remedy.kind,
          tool: remedy.toolCall.name,
        }),
      );
      toolCalls += 1;
      const result = await input.executor.execute(remedy.toolCall, { signal: input.signal });
      if (input.signal?.aborted) return finish(true);
      inputTokens += result.inputTokens ?? 0;
      trace.push(
        event(now(), 'tool_result', claim.id, pass, {
          ok: result.ok,
          state: result.ok ? 'ok' : result.state,
        }),
      );
      if (!result.ok) {
        failedDedupeKeys.add(remedy.dedupeKey);
        if (pass >= input.budget.maxPasses) {
          if (result.state === 'document_unavailable') {
            pushDocumentRequest(claim, pass, documentName);
          } else {
            const fallback = fallbackFor();
            pushFallback(
              claim,
              pass,
              fallback,
              fallbackText(claim, fallback, humanReason(result.reason)),
              'retrieval_failed',
              { detail: result.reason },
            );
          }
        } else {
          unresolvedReasons.set(claim.id, 'retrieval_failed');
        }
        continue;
      }
      if (!result.evidence.length) {
        unresolvedReasons.set(claim.id, 'no_new_evidence');
        break;
      }
      hadNewEvidence = true;
      ledger = addEvidence(ledger, result.evidence);
      const revisedClaim: AssuredClaim = {
        ...claim,
        sourceIds: result.evidence.map((item) => item.id),
        unsupportedReason: undefined,
        conflict: undefined,
      };
      const revised = await reviseAffectedClaim({
        reply: input.reply,
        claim,
        evidence: result.evidence,
        ledgerEvidenceIds: new Set(ledger.ledger.evidence.map((item) => item.id)),
        generate: input.generate,
        signal: input.signal,
      });
      if (input.signal?.aborted) return finish(true);
      tokens.revisionInput += revised.usage?.inputTokens ?? 0;
      tokens.revisionOutput += revised.usage?.outputTokens ?? 0;
      inputTokens += revised.usage?.inputTokens ?? 0;
      const primarySentence =
        revised.replacementText.match(/[^.!?]+(?:[.!?]+|$)/)?.[0]?.trim() ??
        revised.replacementText;
      revisedClaim.text = primarySentence;
      revisedClaim.sourceIds = revised.citedEvidenceIds;
      trace.push(event(now(), 'revision', claim.id, pass, { sourceIds: revised.citedEvidenceIds }));
      const checked = await recheckRevision({
        revisedClaim,
        originalAffectedText: revised.affectedText,
        replacementText: revised.replacementText,
        ledger,
        provider: input.providers.decision,
        tenantId: input.tenantId,
        clientId: input.clientId,
        scopeQualifiers: input.scopeQualifiers,
        signal: input.signal,
        deadlineAt,
      });
      if (input.signal?.aborted) return finish(true);
      const recheckTokens = checked.decisions.reduce(
        (sum, item) =>
          sum + (item.decision.kind === 'outcome' ? (item.decision.usage?.inputTokens ?? 0) : 0),
        0,
      );
      tokens.recheckInput += recheckTokens;
      inputTokens += recheckTokens;
      trace.push(
        event(now(), 'recheck', claim.id, pass, {
          supported: checked.supported,
          checkedClaims: checked.decisions.map((item) => item.claim.id),
        }),
      );
      if (checked.supported) {
        revisions.push({
          claimId: claim.id,
          originalText: claim.text,
          replacementText: revised.replacementText,
          sourceIds: revised.citedEvidenceIds,
          ledgerVersion: ledger.version,
          dependentSentences: revised.dependentSentences,
          outcome: 'corrected',
        });
        break;
      }
      decision = checked.decisions.find((item) => item.claim.id === claim.id)?.decision ?? decision;
      if (pass >= input.budget.maxPasses || !hadNewEvidence) {
        const fallback = fallbackFor();
        const unresolved = checked.unresolvedClaims.map((item) => item.text).join('; ');
        pushFallback(
          claim,
          pass,
          fallback,
          fallbackText(
            claim,
            fallback,
            `the revised assertion remains unsupported (${unresolved})`,
          ),
          'recheck_unsupported',
          {},
        );
      } else {
        unresolvedReasons.set(claim.id, 'recheck_unsupported');
      }
    }
  }
  return finish(false);

  function pushDocumentRequest(claim: AssuredClaim, pass: number, name: string | undefined): void {
    revisions.push(
      fallbackRevision(
        claim,
        ledger.version,
        'qualified',
        documentRequest(claim.text, name),
        'document_unavailable',
      ),
    );
    trace.push(
      event(now(), 'qualification', claim.id, pass, {
        reason: 'document_unavailable',
        ...(name ? { documentName: name } : {}),
      }),
    );
  }

  function pushFallback(
    claim: AssuredClaim,
    pass: number,
    fallback: 'qualified' | 'omitted',
    replacementText: string,
    reason: ClaimRevisionReason,
    detail: Record<string, unknown>,
  ): void {
    revisions.push(fallbackRevision(claim, ledger.version, fallback, replacementText, reason));
    trace.push(
      event(now(), fallback === 'omitted' ? 'omission' : 'qualification', claim.id, pass, {
        reason,
        ...detail,
      }),
    );
  }

  function finish(cancelled: boolean): RepairOutcome {
    if (cancelled) {
      trace.push(event(now(), 'cancelled', undefined, undefined, {}));
      // An aborted repair never releases a partially edited answer.
      const claimOutcomes = attempted.map((claim): RepairClaimOutcome => ({
        claimId: claim.id,
        outcome: 'aborted',
      }));
      return {
        status: 'cancelled',
        summary: 'aborted',
        reply: input.reply,
        citations: [],
        ledger,
        trace,
        toolCalls,
        inputTokens,
        applied: [],
        claimOutcomes,
        tokens,
      };
    }
    const assembled = assembleAnswer({
      baseReply: input.reply,
      ledgerVersion: ledger,
      revisions,
      trace,
    });
    const claimOutcomes = attempted.map((claim): RepairClaimOutcome => {
      const applied = assembled.applied.find((item) => item.claimId === claim.id);
      if (applied)
        return {
          claimId: claim.id,
          outcome: applied.outcome,
          ...(applied.reason ? { reason: applied.reason } : {}),
        };
      const stale = assembled.trace.some(
        (item) => item.type === 'stale_revision_rejected' && item.claimId === claim.id,
      );
      const hadRevision = revisions.some((item) => item.claimId === claim.id);
      const reason = stale
        ? 'stale_revision'
        : hadRevision
          ? 'affected_text_not_found'
          : unresolvedReasons.get(claim.id);
      return { claimId: claim.id, outcome: 'unresolved', ...(reason ? { reason } : {}) };
    });
    const { status, summary } = summarize(claimOutcomes, budgetHit);
    return {
      status,
      summary,
      reply: assembled.reply,
      citations: assembled.citations,
      ledger,
      trace: assembled.trace,
      toolCalls,
      inputTokens,
      applied: assembled.applied,
      claimOutcomes,
      tokens,
    };
  }
}

/** The turn status is derived from every claim's terminal outcome, never from the last claim alone. */
function summarize(
  claims: readonly RepairClaimOutcome[],
  budgetHit: boolean,
): { status: RepairOutcomeStatus; summary: RepairSummary } {
  if (budgetHit) return { status: 'budget_exhausted', summary: 'aborted' };
  const resolved = claims.filter(
    (item) => item.outcome !== 'unresolved' && item.outcome !== 'aborted',
  );
  if (!resolved.length) return { status: 'unresolved', summary: 'unresolved' };
  if (resolved.length < claims.length) return { status: 'partial', summary: 'partial' };
  const kinds = new Set(resolved.map((item) => item.outcome));
  const only = [...kinds][0]!;
  return {
    status: kinds.size === 1 && only !== 'unresolved' && only !== 'aborted' ? only : 'repaired',
    summary: 'repaired',
  };
}

function documentRequest(claimText: string, documentName?: string): string {
  return documentName?.trim()
    ? `To confirm “${claimText}”, attach the '${documentName.trim()}' transcript.`
    : `To confirm “${claimText}”, attach the named transcript.`;
}

function fallbackText(
  claim: AssuredClaim,
  fallback: 'qualified' | 'omitted',
  reason?: string,
): string {
  return fallback === 'omitted' ? OMITTED_CLAIM_NOTE : limitationSentence(claim, reason);
}

/** Internal reason codes (snake_case tokens) never reach customer-facing text. */
function humanReason(reason: string | undefined): string | undefined {
  if (!reason || /^[\w:.-]+$/.test(reason.trim())) return undefined;
  return reason;
}

function documentReferenceFor(
  claim: AssuredClaim,
  references: readonly RepairDocumentReference[] | undefined,
): ResolvedReference | undefined {
  if (!references?.length) return undefined;
  const bySource = references.find((item) => claim.sourceIds.includes(item.id));
  if (bySource) return { item: bySource, direct: true };
  const text = claim.text.toLowerCase();
  const byName = references.find(
    (item) => item.filename && text.includes(item.filename.toLowerCase()),
  );
  if (byName) return { item: byName, direct: true };
  return references.length === 1 ? { item: references[0]!, direct: false } : undefined;
}

function referenceUnreadable(item: RepairDocumentReference): boolean {
  return (
    item.readable === false ||
    (item.contentState !== undefined && UNREADABLE_STATES.has(item.contentState))
  );
}

/** True when the ledger records the sentence as supported by existing evidence. */
function ledgerMarksSupported(claim: AssuredClaim, ledger: RepairLedgerVersion): boolean {
  const recorded = ledger.ledger.claims.find((item) => item.id === claim.id);
  if (recorded) {
    return (
      recorded.sourceIds.length > 0 &&
      !ledger.ledger.unsupportedClaimIds.includes(claim.id) &&
      !ledger.ledger.conflictedClaimIds.includes(claim.id)
    );
  }
  const evidence = new Set(ledger.ledger.evidence.map((item) => item.id));
  return claim.sourceIds.some((id) => evidence.has(id));
}

function fallbackRevision(
  claim: AssuredClaim,
  ledgerVersion: number,
  outcome: 'qualified' | 'omitted',
  replacementText: string,
  reason: ClaimRevisionReason,
): ClaimRevision {
  return {
    claimId: claim.id,
    originalText: claim.text,
    replacementText,
    sourceIds: [],
    ledgerVersion,
    dependentSentences: [],
    outcome,
    reason,
  };
}

function decisionFor(
  decisions: RunRepairLoopInput['decisions'],
  id: string,
): EvidenceDecision | undefined {
  return decisions instanceof Map
    ? decisions.get(id)
    : (decisions as Record<string, EvidenceDecision>)[id];
}

function isSupported(decision: EvidenceDecision): boolean {
  return decision.kind === 'outcome' && decision.outcome === 'supported';
}

function cloneLedger(version: RepairLedgerVersion): RepairLedgerVersion {
  return {
    version: version.version,
    ledger: { ...version.ledger, evidence: [...version.ledger.evidence] },
    passages: { ...version.passages },
    evidenceVersions: { ...(version.evidenceVersions ?? {}) },
  };
}

function addEvidence(ledger: RepairLedgerVersion, evidence: RepairEvidence[]): RepairLedgerVersion {
  const byId = new Map(ledger.ledger.evidence.map((item) => [item.id, item]));
  for (const {
    passage: _passage,
    documentId: _documentId,
    version: _version,
    locator: _locator,
    ...item
  } of evidence)
    byId.set(item.id, item);
  const passages = {
    ...ledger.passages,
    ...Object.fromEntries(evidence.map((item) => [item.id, item.passage])),
  };
  const version = ledger.version + 1;
  const evidenceVersions = {
    ...(ledger.evidenceVersions ?? {}),
    ...Object.fromEntries(evidence.map((item) => [item.id, version])),
  };
  return {
    version,
    ledger: { ...ledger.ledger, evidence: [...byId.values()] },
    passages,
    evidenceVersions,
  };
}

function envelopeFor(
  claim: AssuredClaim,
  ledger: RepairLedgerVersion,
  input: RunRepairLoopInput,
): EvidenceEnvelope {
  const byId = new Map(ledger.ledger.evidence.map((item) => [item.id, item]));
  return {
    envelopeVersion: 'meri-evidence-envelope-v1',
    claimId: claim.id,
    claimText: claim.text,
    claimKind: claim.type,
    claimCategory: claim.category,
    tenantId: input.tenantId,
    clientId: input.clientId ?? null,
    scopeQualifiers: [...(input.scopeQualifiers ?? [])],
    asOf: claim.asOf ?? null,
    sources: claim.sourceIds.flatMap((id) => {
      const item = byId.get(id);
      return item
        ? [
            {
              evidenceId: id,
              sourceType: item.evidenceClass,
              sourceId: item.sourceId,
              documentId: null,
              version: null,
              locator: null,
              passage: ledger.passages[id] ?? '',
              sourceDate: item.asOf ?? null,
              publishedAt: item.publishedAt ?? null,
              effectiveAt: item.effectiveAt ?? null,
              retrievedAt: item.retrievedAt ?? null,
            },
          ]
        : [];
    }),
  };
}

function event(
  at: number,
  type: RepairTraceEvent['type'],
  claimId: string | undefined,
  pass: number | undefined,
  detail: Record<string, unknown>,
): RepairTraceEvent {
  return { at, type, ...(claimId ? { claimId } : {}), ...(pass ? { pass } : {}), detail };
}
