import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import { buildClaimSupportQuestion } from '../jev/claim-support-question';
import type { EvidenceDecision, EvidenceEnvelope } from '../jev/decision-contract';
import { assembleAnswer } from './assemble';
import { deriveRequirement, planRemedy } from './plan-remedy';
import { limitationSentence, proportionalFallback, recheckRevision } from './recheck';
import { reviseAffectedClaim } from './revise';
import type {
  ClaimRevision,
  RepairLedgerVersion,
  RepairOutcome,
  RepairOutcomeStatus,
  RepairTraceEvent,
  RunRepairLoopInput,
} from './types';

export async function runRepairLoop(input: RunRepairLoopInput): Promise<RepairOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + input.budget.maxMs;
  const trace: RepairTraceEvent[] = [];
  const revisions: ClaimRevision[] = [];
  const failedDedupeKeys = new Set<string>();
  const remedyKinds = new Set<ClaimRevision['outcome'] | string>();
  let ledger = cloneLedger(input.ledger);
  let toolCalls = 0;
  let inputTokens = 0;
  let status: RepairOutcomeStatus = 'unresolved';

  for (const claim of input.claims) {
    const initialDecision = decisionFor(input.decisions, claim.id);
    if (!initialDecision || isSupported(initialDecision)) continue;
    let decision = initialDecision;
    let hadNewEvidence = false;

    for (let pass = 1; pass <= input.budget.maxPasses; pass += 1) {
      if (input.signal?.aborted) return finish('cancelled');
      if (now() >= deadlineAt || toolCalls >= input.budget.maxToolCalls || inputTokens >= input.budget.maxInputTokens) {
        trace.push(event(now(), 'budget_exhausted', claim.id, pass, {}));
        revisions.push(fallbackRevision(claim, ledger.version, 'qualified', limitationSentence(claim, 'the repair budget was exhausted')));
        status = 'budget_exhausted';
        break;
      }

      const envelope = envelopeFor(claim, ledger, input);
      const requirement = deriveRequirement({ decision, claim, envelope, evidencePlan: input.evidencePlan });
      if (!requirement) break;
      trace.push(event(now(), 'requirement', claim.id, pass, { kind: requirement.kind }));
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
        const fallback = proportionalFallback(claim);
        revisions.push(fallbackRevision(claim, ledger.version, fallback, fallback === 'omitted' ? '' : limitationSentence(claim)));
        status = fallback;
        break;
      }
      const remedy = plan.remedy;
      remedyKinds.add(remedy.kind);
      trace.push(event(now(), 'remedy_planned', claim.id, pass, { remedyId: remedy.id, kind: remedy.kind, tool: remedy.toolCall.name }));
      toolCalls += 1;
      const result = await input.executor.execute(remedy.toolCall, { signal: input.signal });
      if (input.signal?.aborted) return finish('cancelled');
      inputTokens += result.inputTokens ?? 0;
      trace.push(event(now(), 'tool_result', claim.id, pass, { ok: result.ok, state: result.ok ? 'ok' : result.state }));
      if (!result.ok) {
        failedDedupeKeys.add(remedy.dedupeKey);
        if (pass >= input.budget.maxPasses) {
          const fallback = proportionalFallback(claim);
          revisions.push(fallbackRevision(claim, ledger.version, fallback, fallback === 'omitted' ? '' : limitationSentence(claim, result.reason)));
          status = fallback;
        }
        continue;
      }
      if (!result.evidence.length) break;
      hadNewEvidence = true;
      ledger = addEvidence(ledger, result.evidence);
      const revisedClaim: AssuredClaim = { ...claim, sourceIds: result.evidence.map((item) => item.id), unsupportedReason: undefined, conflict: undefined };
      const revised = await reviseAffectedClaim({
        reply: input.reply,
        claim,
        evidence: result.evidence,
        ledgerEvidenceIds: new Set(ledger.ledger.evidence.map((item) => item.id)),
        generate: input.generate,
        signal: input.signal,
      });
      if (input.signal?.aborted) return finish('cancelled');
      const primarySentence = revised.replacementText.match(/[^.!?]+(?:[.!?]+|$)/)?.[0]?.trim() ?? revised.replacementText;
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
      if (input.signal?.aborted) return finish('cancelled');
      inputTokens += checked.decisions.reduce((sum, item) => sum + (item.decision.kind === 'outcome' ? item.decision.usage?.inputTokens ?? 0 : 0), 0);
      trace.push(event(now(), 'recheck', claim.id, pass, { supported: checked.supported, checkedClaims: checked.decisions.map((item) => item.claim.id) }));
      if (checked.supported) {
        revisions.push({ claimId: claim.id, originalText: claim.text, replacementText: revised.replacementText, sourceIds: revised.citedEvidenceIds, ledgerVersion: ledger.version, dependentSentences: revised.dependentSentences, outcome: 'corrected' });
        status = 'corrected';
        break;
      }
      decision = checked.decisions.find((item) => item.claim.id === claim.id)?.decision ?? decision;
      if (pass >= input.budget.maxPasses || !hadNewEvidence) {
        const fallback = proportionalFallback(claim);
        const unresolved = checked.unresolvedClaims.map((item) => item.text).join('; ');
        revisions.push(fallbackRevision(claim, ledger.version, fallback, fallback === 'omitted' ? '' : limitationSentence(claim, `the revised assertion remains unsupported (${unresolved})`)));
        status = fallback;
      }
    }
  }
  return finish(status);

  function finish(finalStatus: RepairOutcomeStatus): RepairOutcome {
    if (finalStatus === 'cancelled') trace.push(event(now(), 'cancelled', undefined, undefined, {}));
    const assembled = assembleAnswer({ baseReply: input.reply, ledgerVersion: ledger, revisions, trace });
    return { status: finalStatus, reply: assembled.reply, citations: assembled.citations, ledger, trace: assembled.trace, toolCalls, inputTokens };
  }
}

function fallbackRevision(claim: AssuredClaim, ledgerVersion: number, outcome: 'qualified' | 'omitted', replacementText: string): ClaimRevision {
  return { claimId: claim.id, originalText: claim.text, replacementText, sourceIds: [], ledgerVersion, dependentSentences: [], outcome };
}

function decisionFor(decisions: RunRepairLoopInput['decisions'], id: string): EvidenceDecision | undefined {
  return decisions instanceof Map
    ? decisions.get(id)
    : (decisions as Record<string, EvidenceDecision>)[id];
}

function isSupported(decision: EvidenceDecision): boolean {
  return decision.kind === 'outcome' && decision.outcome === 'supported';
}

function cloneLedger(version: RepairLedgerVersion): RepairLedgerVersion {
  return { version: version.version, ledger: { ...version.ledger, evidence: [...version.ledger.evidence] }, passages: { ...version.passages } };
}

function addEvidence(ledger: RepairLedgerVersion, evidence: import('./types').RepairEvidence[]): RepairLedgerVersion {
  const byId = new Map(ledger.ledger.evidence.map((item) => [item.id, item]));
  for (const { passage: _passage, documentId: _documentId, version: _version, locator: _locator, ...item } of evidence) byId.set(item.id, item);
  const passages = { ...ledger.passages, ...Object.fromEntries(evidence.map((item) => [item.id, item.passage])) };
  return { version: ledger.version + 1, ledger: { ...ledger.ledger, evidence: [...byId.values()] }, passages };
}

function envelopeFor(claim: AssuredClaim, ledger: RepairLedgerVersion, input: RunRepairLoopInput): EvidenceEnvelope {
  const byId = new Map(ledger.ledger.evidence.map((item) => [item.id, item]));
  return { envelopeVersion: 'meri-evidence-envelope-v1', claimId: claim.id, claimText: claim.text, claimKind: claim.type, claimCategory: claim.category, tenantId: input.tenantId, clientId: input.clientId ?? null, scopeQualifiers: [...(input.scopeQualifiers ?? [])], asOf: claim.asOf ?? null, sources: claim.sourceIds.flatMap((id) => { const item = byId.get(id); return item ? [{ evidenceId: id, sourceType: item.evidenceClass, sourceId: item.sourceId, documentId: null, version: null, locator: null, passage: ledger.passages[id] ?? '', sourceDate: item.asOf ?? null, retrievedAt: item.retrievedAt ?? null }] : []; }) };
}

function event(at: number, type: RepairTraceEvent['type'], claimId: string | undefined, pass: number | undefined, detail: Record<string, unknown>): RepairTraceEvent {
  return { at, type, ...(claimId ? { claimId } : {}), ...(pass ? { pass } : {}), detail };
}
