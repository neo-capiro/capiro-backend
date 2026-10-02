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
export function assertControlledReadReceiptJoins({
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
}) {
  const receipt = envelope?.receipt;
  need(
    ['20', '72'].includes(expected?.caseId) && receipt && policy && authority && admission,
    'CONTROLLED_READ_JOIN_INPUT_MISSING',
  );
  need(
    admission.schemaVersion === 1 &&
      admission.kind === 'meri-controlled-read-authenticated-admission' &&
      admission.status === 'READY' &&
      authority.schemaVersion === 1 &&
      authority.kind === 'meri-controlled-read-authenticated-readback',
    'CONTROLLED_READ_AUTHORITY_SHAPE_INVALID',
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
      'CONTROLLED_READ_AUTHORITY_SCOPE_MISMATCH',
    );
  }
  need(
    policy.toolAuthority === 'shared_static_registry_read_only' &&
      policy.dynamicMcpAllowed === false &&
      policy.incidentalWriters === 'suppressed',
    'CONTROLLED_READ_DISPATCH_BOUNDARY_UNPROVED',
  );
  need(
    envelope.version === 1 &&
      envelope.audience === 'capiro:meri:server-readonly-capture:evidence:v1' &&
      envelope.purpose === 'server_capture_evidence' &&
      HASH.test(envelope.signature ?? '') &&
      receipt.kind === 'server_capture_evidence_receipt' &&
      receipt.purpose === 'server_capture_evidence' &&
      isDeepStrictEqual(envelope, doneEnvelope),
    'CONTROLLED_READ_RECEIPT_PAIR_MISMATCH',
  );
  const receiptSha256 = sha256Stable(envelope);
  need(
    authority.envelopeSha256 === receiptSha256 &&
      typeof answer === 'string' &&
      authority.answerSha256 === sha256Bytes(Buffer.from(answer, 'utf8')),
    'CONTROLLED_READ_BYTES_MISMATCH',
  );
  for (const key of ['policyId', 'requestId', 'traceId', 'turnId']) {
    need(
      typeof policy[key] === 'string' &&
        policy[key].length > 0 &&
        receipt[key] === policy[key] &&
        authority[key] === policy[key],
      'CONTROLLED_READ_RUN_JOIN_MISMATCH',
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
    'CONTROLLED_READ_READBACK_STALE_OR_MESSAGE_MISMATCH',
  );
  need(
    observed(receipt.releases?.api?.releaseRevision, expected.apiSha) &&
      observed(receipt.releases?.orchestrator?.releaseRevision, expected.orchestratorSha),
    'CONTROLLED_READ_SERVED_BUILD_MISMATCH',
  );
  need(
    observedString(receipt.usage?.provider) &&
      observedString(receipt.usage?.model) &&
      observedNumber(receipt.usage?.inputTokens) &&
      observedNumber(receipt.usage?.outputTokens) &&
      receipt.usage.costKind === 'existing_pricing_estimate',
    'CONTROLLED_READ_PROVIDER_USAGE_UNPROVED',
  );
  need(isDeepStrictEqual(authority.fixture, admission.fixture), 'CONTROLLED_READ_FIXTURE_CHANGED');
  const fixture = authority.fixture;
  need(
    fixture.fixtureNamespace === 'meri-foundation-20260928' &&
      HASH.test(fixture.currentVerifySha256 ?? ''),
    'CONTROLLED_READ_FIXTURE_OWNER_INVALID',
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
      'CONTROLLED_READ_FIXTURE_BINDING_MISMATCH',
    );
  }
  need(
    Array.isArray(fixture.sources) && fixture.sources.length === 1,
    'CONTROLLED_READ_SOURCE_OWNER_MISSING',
  );
  const source = fixture.sources[0];
  const isBudget = expected.caseId === '20';
  need(
    source.logicalId === (isBudget ? 'R2-27' : 'MEMO-A-LATEST') &&
      UUID.test(source.physicalId ?? '') &&
      source.tenantId === expected.tenantId &&
      source.clientId === (isBudget ? null : expected.clientId) &&
      source.sourceVersion === 'v1' &&
      source.kind === (isBudget ? 'budget_document' : 'memo') &&
      source.sourceStorage === 'immutable_source_owned_controlled_adapter' &&
      HASH.test(source.contentSha256 ?? ''),
    'CONTROLLED_READ_SOURCE_OWNER_INVALID',
  );
  const calls = receipt.toolCalls,
    attempts = receipt.controlledReadAttempts;
  const tools = new Set(
    isBudget
      ? ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline']
      : ['read_client_documents'],
  );
  need(
    Array.isArray(calls) &&
      calls.length > 0 &&
      new Set(calls.map((c) => c.callId)).size === calls.length &&
      calls.every(
        (c) =>
          typeof c.callId === 'string' &&
          c.callId &&
          c.readOnly === true &&
          tools.has(c.name) &&
          ['complete', 'failed', 'partial', 'unavailable'].includes(c.status) &&
          Array.isArray(c.sourceIds) &&
          c.sourceIds.every((id) => id === source.physicalId),
      ),
    'CONTROLLED_READ_TOOL_AUTHORITY_UNPROVED',
  );
  need(
    Array.isArray(attempts) &&
      attempts.length > 0 &&
      new Set(attempts.map((a) => a.callId)).size === attempts.length &&
      attempts.every(
        (a) =>
          calls.some((c) => c.callId === a.callId && c.name === a.tool) &&
          ['caseId', 'captureRunId', 'requestId', 'traceId', 'turnId'].every(
            (key) => a[key] === policy[key],
          ) &&
          a.httpStatus === 200 &&
          a.sourceId === source.physicalId &&
          a.logicalSourceId === source.logicalId &&
          a.sourceTenantId === expected.tenantId &&
          a.sourceClientId === source.clientId &&
          a.currentVerifySha256 === fixture.currentVerifySha256 &&
          a.sourceVersion === source.sourceVersion &&
          a.contentSha256 === source.contentSha256 &&
          HASH.test(a.responseSha256 ?? '') &&
          (isBudget
            ? a.logicalError === null &&
              a.fullRead === true &&
              a.passageSha256 === source.contentSha256
            : [null, 'document unavailable'].includes(a.logicalError) &&
              a.fullRead === false &&
              a.passageSha256 === null),
      ),
    'CONTROLLED_READ_HTTP_JOIN_UNPROVED',
  );
  // Every observed tool invocation must join its actual HTTP attempt. A missing
  // network response remains unqualified; no attempt is inferred from a label.
  need(calls.length === attempts.length, 'CONTROLLED_READ_HTTP_ATTEMPT_MISSING');
  need(
    Array.isArray(receipt.sources) && Array.isArray(citations),
    'CONTROLLED_READ_SOURCE_ARRAY_MISSING',
  );
  if (isBudget) {
    need(
      receipt.sources.length > 0 &&
        receipt.sources.every(
          (capture) =>
            capture.sourceId === source.physicalId &&
            attempts.some(
              (a) =>
                a.callId === capture.toolCallId &&
                a.fullRead &&
                a.passageSha256 === source.contentSha256,
            ) &&
            calls.some(
              (c) =>
                c.callId === capture.toolCallId &&
                c.status === 'complete' &&
                c.sourceIds.includes(source.physicalId),
            ) &&
            observed(capture.tenantId, source.tenantId) &&
            observed(capture.clientId, null) &&
            observed(capture.currentVersion, source.sourceVersion) &&
            observed(capture.fullRead, true) &&
            observed(capture.passageSha256, source.contentSha256) &&
            observed(capture.byteSha256, source.contentSha256) &&
            observed(capture.locator, 'page 14'),
        ),
      'CONTROLLED_READ_FULL_PASSAGE_UNPROVED',
    );
    need(
      sourceReadback?.kind === 'controlled_read' &&
        sourceReadback.status === 'available' &&
        sourceReadback.recordId === source.physicalId &&
        sourceReadback.sourceVersion === source.sourceVersion &&
        sourceReadback.tenantId === expected.tenantId &&
        sourceReadback.clientId === expected.clientId &&
        sourceReadback.conversationId === expected.conversationId &&
        sourceReadback.section === 'page 14' &&
        sourceReadback.nextCursor === null &&
        sourceReadback.offset === 0 &&
        sourceReadback.controlled === true &&
        typeof sourceReadback.text === 'string' &&
        sha256Bytes(sourceReadback.text) === source.contentSha256,
      'CONTROLLED_READ_CANONICAL_SOURCE_BYTES_MISMATCH',
    );
    need(
      citations.length === 1 &&
        citations.every(
          (c) =>
            c.id === source.physicalId &&
            tools.has(c.tool) &&
            typeof c.snippet === 'string' &&
            sha256Bytes(c.snippet) === source.contentSha256 &&
            c.source?.kind === 'controlled_read' &&
            c.source.recordId === source.physicalId &&
            c.source.version === source.sourceVersion &&
            c.source.section === 'page 14' &&
            c.source.conversationId === expected.conversationId &&
            c.source.clientId === expected.clientId,
        ),
      'CONTROLLED_READ_CITATION_BYTES_MISMATCH',
    );
  } else {
    need(
      isDeepStrictEqual(source.fault, {
        httpStatus: 200,
        error: 'document unavailable',
        repeated: true,
      }) &&
        source.contentSha256 === sha256Bytes('') &&
        sourceReadback === null &&
        receipt.sources.length === 0 &&
        citations.length === 0,
      'CONTROLLED_READ_ERROR_CANNOT_BE_EVIDENCE',
    );
    need(
      attempts.every((a) => {
        const call = calls.find((c) => c.callId === a.callId);
        return a.logicalError === null
          ? call.status === 'complete' && call.sourceIds.length === 0
          : ['failed', 'partial', 'unavailable'].includes(call.status) &&
              call.sourceIds.length === 0;
      }),
      'CONTROLLED_READ_LOGICAL_ERROR_MISCLASSIFIED',
    );
  }
  const bounded = receipt.boundedRuntime;
  need(
    bounded &&
      ['toolCalls', 'modelCalls', 'retryCalls'].every(
        (key) => Number.isSafeInteger(bounded[key]) && bounded[key] >= 0,
      ) &&
      bounded.toolCalls >= calls.length &&
      typeof bounded.acquisitionStopped === 'boolean' &&
      [
        null,
        'cancelled',
        'deadline',
        'model_calls',
        'tool_calls',
        'retry_calls',
        'no_progress',
      ].includes(bounded.stopReason) &&
      bounded.acquisitionStopped === (bounded.stopReason !== null),
    'CONTROLLED_READ_RUNTIME_BOUND_UNPROVED',
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
    'CONTROLLED_READ_EFFECT_BOUNDARY_UNPROVED',
  );
  for (const [kind, id] of [
    ['conversation_user_message', policy.turnId],
    ['conversation_assistant_message', authority.messageId],
    ['assistant_receipt_metadata', authority.messageId],
  ]) {
    const matches = writes.filter((write) => write.kind === kind);
    need(
      matches.length === 1 && matches[0].recordId === id,
      'CONTROLLED_READ_EFFECT_RECORD_JOIN_MISMATCH',
    );
  }
  const budget = receipt.providerBudget;
  need(
    budget?.version === 1 &&
      budget.boundary === `case${expected.caseId}_controlled_read_turn` &&
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
      budget.maxCostMicros <= 3_000_000 &&
      budget.qualificationSha256 === admission.providerBudget?.qualificationSha256 &&
      budget.qualificationSha256 === authority.providerBudget?.qualificationSha256,
    'CONTROLLED_READ_PROVIDER_RESERVATION_UNPROVED',
  );
  need(
    Number.isSafeInteger(budget.attempts) &&
      budget.attempts > 0 &&
      Number.isSafeInteger(budget.chargedTokens) &&
      budget.chargedTokens >= receipt.usage.inputTokens.value + receipt.usage.outputTokens.value,
    'CONTROLLED_READ_PROVIDER_LEDGER_USAGE_UNPROVED',
  );
  const ledgerWrites = writes.filter((write) => write.kind === 'provider_budget_ledger');
  need(
    ledgerWrites.length === 1 &&
      ledgerWrites[0].recordId === policy.conversationId &&
      ledgerWrites[0].logicalWriteId === policy.requestId + ':provider-budget-ledger' &&
      ledgerWrites[0].phase === 'during',
    'CONTROLLED_READ_PROVIDER_LEDGER_WRITE_UNPROVED',
  );
  const accountingEffect = effects.logicalEffects[0];
  need(
    accountingEffect.logicalEffectId === policy.requestId + ':provider-budget-ledger' &&
      accountingEffect.operationId === budget.admissionId &&
      accountingEffect.receiptId === budget.ledgerSha256 &&
      accountingEffect.status === 'observed',
    'CONTROLLED_READ_UNEXPECTED_LOGICAL_EFFECT',
  );
  // R2-27 is explicitly a tenant-owned global fixture (null source client).
  // Reconcile only this exact owner-proved null-client blocker, never arbitrary
  // source scope gaps or failures. Memo failure has no successfully read sources.
  const reconciledBlockers = new Set(
    isBudget ? [`source_client_authority_unproved:${source.physicalId}`] : [],
  );
  need(
    Array.isArray(receipt.blockers) &&
      receipt.blockers.every((blocker) => reconciledBlockers.has(blocker)) &&
      receipt.status === (receipt.blockers.length ? 'BLOCKED' : 'COMPLETE'),
    'CONTROLLED_READ_PRODUCER_GAP_UNRESOLVED',
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
    controlledReadAttempts: attempts,
    boundedRuntime: bounded,
    providerBudget: budget,
  };
}
