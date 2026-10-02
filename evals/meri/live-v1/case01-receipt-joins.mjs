import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes, sha256Stable } from './artifact-collector.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const need = (condition, code) => {
  if (!condition) fail(code);
};
const observed = (value, expected) =>
  value?.status === 'OBSERVED' && value.reason === null && value.value === expected;
const observedNumber = (value) =>
  value?.status === 'OBSERVED' &&
  value.reason === null &&
  Number.isSafeInteger(value.value) &&
  value.value >= 0;
const observedString = (value) =>
  value?.status === 'OBSERVED' &&
  value.reason === null &&
  typeof value.value === 'string' &&
  value.value.length > 0;

/** Pure joins only. This function cannot establish HTTP/auth/build authority or
 * turn caller objects into an acceptance capability. The transport owns that.
 */
export function assertCase01ReceiptJoins(input) {
  return assertMemoryReceiptJoins(input, '01', 'MA1-v2');
}
export function assertCase14ReceiptJoins(input) {
  const result = assertMemoryReceiptJoins(input, '14', 'MEM-PROPOSAL-14');
  const fixture = input.authority.fixture;
  need(
    UUID.test(fixture.candidateId ?? '') &&
      fixture.decision?.decision === 'approved' &&
      UUID.test(fixture.decision.transitionAuditId ?? '') &&
      fixture.decision.actorUserId === input.expected.actorUserId &&
      fixture.approvedText === 'Synthetic Aster candidate for approval' &&
      result.source.sourceVersion === `candidate:${fixture.candidateId}`,
    'CASE14_CANONICAL_DECISION_UNPROVED',
  );
  return result;
}
function assertMemoryReceiptJoins(
  {
    expected,
    admission,
    authority,
    policy,
    envelope,
    doneEnvelope,
    answer,
    sourceReadback,
    citations,
    now = Date.now(),
  },
  caseId,
  logicalSourceId,
) {
  const receipt = envelope?.receipt;
  need(
    expected?.caseId === caseId && receipt && policy && authority && admission,
    'CASE01_JOIN_INPUT_MISSING',
  );
  need(
    admission.schemaVersion === 1 &&
      admission.kind === `meri-case${caseId}-authenticated-admission` &&
      admission.status === 'READY' &&
      authority.schemaVersion === 1 &&
      authority.kind === `meri-case${caseId}-authenticated-readback`,
    'CASE01_AUTHORITY_SHAPE_INVALID',
  );
  for (const key of [
    'caseId',
    'captureRunId',
    'conversationId',
    'tenantId',
    'actorUserId',
    'clientId',
  ]) {
    need(
      typeof expected[key] === 'string' &&
        expected[key].length > 0 &&
        [admission, authority, policy, receipt].every((value) => value[key] === expected[key]),
      'CASE01_AUTHORITY_SCOPE_MISMATCH',
    );
  }
  need(
    policy.toolAuthority === 'shared_static_registry_read_only' &&
      policy.dynamicMcpAllowed === false &&
      policy.incidentalWriters === 'suppressed',
    'CASE01_DISPATCH_BOUNDARY_UNPROVED',
  );
  need(
    envelope.version === 1 &&
      envelope.audience === 'capiro:meri:server-readonly-capture:evidence:v1' &&
      envelope.purpose === 'server_capture_evidence' &&
      HASH.test(envelope.signature ?? '') &&
      receipt.kind === 'server_capture_evidence_receipt' &&
      receipt.purpose === 'server_capture_evidence' &&
      isDeepStrictEqual(envelope, doneEnvelope),
    'CASE01_RECEIPT_PAIR_MISMATCH',
  );
  const receiptSha256 = sha256Stable(envelope);
  need(
    authority.envelopeSha256 === receiptSha256 &&
      typeof answer === 'string' &&
      authority.answerSha256 === sha256Bytes(Buffer.from(answer, 'utf8')),
    'CASE01_BYTES_MISMATCH',
  );
  for (const key of ['policyId', 'requestId', 'traceId', 'turnId']) {
    need(
      typeof policy[key] === 'string' &&
        policy[key].length > 0 &&
        receipt[key] === policy[key] &&
        authority[key] === policy[key],
      'CASE01_RUN_JOIN_MISMATCH',
    );
  }
  need(
    authority.messageId === expected.assistantMessageId &&
      UUID.test(authority.messageId ?? '') &&
      Number.isSafeInteger(authority.verifiedAt) &&
      authority.verifiedAt <= now + 1000 &&
      now - authority.verifiedAt <= 60000 &&
      Number.isSafeInteger(policy.expiresAt) &&
      policy.expiresAt > now &&
      receipt.expiresAt === policy.expiresAt,
    'CASE01_READBACK_STALE_OR_MESSAGE_MISMATCH',
  );
  need(
    observed(receipt.releases?.api?.releaseRevision, expected.apiSha) &&
      observed(receipt.releases?.orchestrator?.releaseRevision, expected.orchestratorSha),
    'CASE01_SERVED_BUILD_MISMATCH',
  );
  need(
    observedString(receipt.usage?.provider) &&
      observedString(receipt.usage?.model) &&
      observedNumber(receipt.usage?.inputTokens) &&
      observedNumber(receipt.usage?.outputTokens) &&
      receipt.usage.costKind === 'existing_pricing_estimate',
    'CASE01_PROVIDER_USAGE_UNPROVED',
  );
  need(isDeepStrictEqual(authority.fixture, admission.fixture), 'CASE01_FIXTURE_CHANGED');
  const fixture = authority.fixture;
  need(
    fixture.fixtureNamespace === 'meri-foundation-20260928' &&
      HASH.test(fixture.currentVerifySha256 ?? ''),
    'CASE01_FIXTURE_OWNER_INVALID',
  );
  for (const [field, observation] of [
    ['fixtureVersion', 'version'],
    ['physicalMapSha256', 'physicalMapSha256'],
    ['seedReceiptId', 'seedReceiptId'],
    ['resetReceiptId', 'resetReceiptId'],
  ]) {
    need(
      typeof expected[field] === 'string' &&
        fixture[field] === expected[field] &&
        observed(receipt.fixture?.[observation], expected[field]),
      'CASE01_FIXTURE_BINDING_MISMATCH',
    );
  }
  need(
    Array.isArray(fixture.sources) && fixture.sources.length === 1,
    'CASE01_SOURCE_OWNER_MISSING',
  );
  const source = fixture.sources[0];
  need(
    source.logicalId === logicalSourceId &&
      UUID.test(source.physicalId ?? '') &&
      source.tenantId === expected.tenantId &&
      source.clientId === expected.clientId &&
      typeof source.sourceVersion === 'string' &&
      source.sourceVersion.length > 0 &&
      HASH.test(source.contentSha256 ?? ''),
    'CASE01_SOURCE_OWNER_INVALID',
  );
  const calls = receipt.toolCalls;
  need(
    Array.isArray(calls) &&
      calls.length > 0 &&
      new Set(calls.map((call) => call.callId)).size === calls.length &&
      calls.every(
        (call) =>
          typeof call.callId === 'string' &&
          call.callId &&
          call.readOnly === true &&
          call.status === 'complete' &&
          call.name === 'search_memory' &&
          Array.isArray(call.sourceIds),
      ),
    'CASE01_TOOL_AUTHORITY_UNPROVED',
  );
  need(
    Array.isArray(receipt.sources) && receipt.sources.length === 1,
    'CASE01_SOURCE_TOOL_JOIN_MISSING',
  );
  const captureSource = receipt.sources[0];
  need(
    captureSource.sourceId === source.physicalId &&
      calls.some(
        (call) =>
          call.callId === captureSource.toolCallId && call.sourceIds.includes(source.physicalId),
      ) &&
      (observed(captureSource.currentVersion, source.sourceVersion) ||
        observed(captureSource.currentVersion, `content:${source.contentSha256}`)) &&
      observedString(captureSource.passageSha256) &&
      HASH.test(captureSource.passageSha256.value),
    'CASE01_SOURCE_TOOL_JOIN_MISMATCH',
  );
  for (const [key, value] of [
    ['tenantId', expected.tenantId],
    ['clientId', expected.clientId],
  ]) {
    const field = captureSource[key];
    need(
      observed(field, value) || (field?.status === 'UNKNOWN' && field.value === null),
      'CASE01_SOURCE_AUTHORITY_CONTRADICTION',
    );
  }
  need(
    sourceReadback?.kind === 'memory' &&
      sourceReadback.status === 'available' &&
      sourceReadback.recordId === source.physicalId &&
      sourceReadback.sourceVersion === source.sourceVersion &&
      sourceReadback.nextCursor === null &&
      sourceReadback.offset === 0 &&
      typeof sourceReadback.text === 'string' &&
      sha256Bytes(sourceReadback.text) === source.contentSha256,
    'CASE01_CANONICAL_SOURCE_BYTES_MISMATCH',
  );
  need(Array.isArray(citations) && citations.length === 1, 'CASE01_CITATION_JOIN_MISSING');
  const citation = citations[0];
  need(
    citation.id === source.physicalId &&
      citation.tool === 'search_memory' &&
      typeof citation.snippet === 'string' &&
      citation.snippet.length > 0 &&
      sha256Bytes(citation.snippet) === captureSource.passageSha256.value &&
      sourceReadback.text.startsWith(
        citation.snippet.endsWith('…') ? citation.snippet.slice(0, -1) : citation.snippet,
      ) &&
      citation.source?.recordId === source.physicalId &&
      citation.source?.version === captureSource.currentVersion.value,
    'CASE01_CITATION_BYTES_MISMATCH',
  );
  const effects = receipt.effects;
  const writes = effects?.writes;
  const allowedWrites = new Set([
    'context_packet_and_evidence',
    'conversation_user_message',
    'conversation_assistant_message',
    'assistant_receipt_metadata',
    'provider_budget_ledger',
  ]);
  need(
    effects?.boundary === 'bounded_capture_path_hooks' &&
      Array.isArray(effects.logicalEffects) &&
      effects.logicalEffects.length === 1 &&
      Array.isArray(writes) &&
      new Set(writes.map((write) => write.logicalWriteId)).size === writes.length &&
      writes.every(
        (write) =>
          typeof write.logicalWriteId === 'string' &&
          write.logicalWriteId &&
          allowedWrites.has(write.kind) &&
          write.status === 'observed',
      ),
    'CASE01_EFFECT_BOUNDARY_UNPROVED',
  );
  for (const [kind, id] of [
    ['conversation_user_message', policy.turnId],
    ['conversation_assistant_message', authority.messageId],
    ['assistant_receipt_metadata', authority.messageId],
  ]) {
    const matches = writes.filter((write) => write.kind === kind);
    need(matches.length === 1 && matches[0].recordId === id, 'CASE01_EFFECT_RECORD_JOIN_MISMATCH');
  }
  const budget = receipt.providerBudget;
  need(
    budget?.version === 1 &&
      budget.boundary === `case${caseId}_memory_turn` &&
      budget.status === 'SETTLED' &&
      typeof budget.admissionId === 'string' &&
      budget.admissionId.length > 0 &&
      budget.turnId === policy.turnId &&
      HASH.test(budget.ledgerSha256 ?? '') &&
      HASH.test(budget.qualificationSha256 ?? '') &&
      Array.isArray(budget.unaccountedBoundaries) &&
      budget.unaccountedBoundaries.length === 0 &&
      [
        budget.chargedCostMicros,
        budget.maxCostMicros,
        expected.maxSpendMicros,
        budget.attempts,
        budget.chargedTokens,
      ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
      budget.chargedCostMicros <= budget.maxCostMicros &&
      budget.maxCostMicros === expected.maxSpendMicros &&
      budget.maxCostMicros > 0 &&
      budget.maxCostMicros <= 15_000_000 &&
      budget.qualificationSha256 === admission.providerBudget?.qualificationSha256 &&
      budget.qualificationSha256 === authority.providerBudget?.qualificationSha256,
    'CASE01_PROVIDER_RESERVATION_UNPROVED',
  );
  need(
    Number.isSafeInteger(budget.attempts) &&
      budget.attempts > 0 &&
      Number.isSafeInteger(budget.chargedTokens) &&
      budget.chargedTokens >= receipt.usage.inputTokens.value + receipt.usage.outputTokens.value,
    'CASE01_PROVIDER_LEDGER_USAGE_UNPROVED',
  );
  const ledgerWrites = writes.filter((write) => write.kind === 'provider_budget_ledger');
  need(
    ledgerWrites.length === 1 &&
      ledgerWrites[0].recordId === policy.conversationId &&
      ledgerWrites[0].logicalWriteId === policy.requestId + ':provider-budget-ledger' &&
      ledgerWrites[0].phase === 'during',
    'CASE01_PROVIDER_LEDGER_WRITE_UNPROVED',
  );
  const accountingEffect = effects.logicalEffects[0];
  need(
    accountingEffect.logicalEffectId === policy.requestId + ':provider-budget-ledger' &&
      accountingEffect.operationId === budget.admissionId &&
      accountingEffect.receiptId === budget.ledgerSha256 &&
      accountingEffect.status === 'observed',
    'CASE01_UNEXPECTED_LOGICAL_EFFECT',
  );
  const reconciledBlockers = new Set([
    `source_tenant_authority_unproved:${source.physicalId}`,
    `source_client_authority_unproved:${source.physicalId}`,
  ]);
  need(
    Array.isArray(receipt.blockers) &&
      receipt.blockers.every((blocker) => reconciledBlockers.has(blocker)) &&
      receipt.status === (receipt.blockers.length ? 'BLOCKED' : 'COMPLETE'),
    'CASE01_PRODUCER_GAP_UNRESOLVED',
  );
  return {
    status: 'VALIDATED_JOINS_ONLY',
    observedBusinessEffectCount: 0,
    receiptSha256,
    source,
    policyId: policy.policyId,
    requestId: policy.requestId,
    traceId: policy.traceId,
    turnId: policy.turnId,
    messageId: authority.messageId,
    usage: receipt.usage,
    providerBudget: budget,
  };
}
