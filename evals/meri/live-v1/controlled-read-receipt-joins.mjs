import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes, sha256Stable } from './artifact-collector.mjs';
import { createControlledReadDefinition } from './fixture-provisioning/controlled-read-definitions.mjs';

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
    ['20', '21', '22', '23', '24', '26', '27', '72'].includes(expected?.caseId) &&
      receipt &&
      policy &&
      authority &&
      admission,
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
  const definition = createControlledReadDefinition({
    caseId: expected.caseId,
    tenantId: expected.tenantId,
    clientId: expected.clientId,
    captureRunId: expected.captureRunId,
  });
  need(
    definition.physicalMapSha256 === expected.physicalMapSha256,
    'CONTROLLED_READ_FROZEN_MAP_MISMATCH',
  );
  const isBudget = expected.caseId !== '72';
  const expanded = !['20', '72'].includes(expected.caseId);
  const sources = fixture.sources;
  need(
    Array.isArray(sources) &&
      sources.length === definition.reads.length &&
      new Set(sources.map((s) => s?.physicalId)).size === sources.length,
    'CONTROLLED_READ_SOURCE_OWNER_MISSING',
  );
  const source = sources[0];
  const byId = new Map(sources.map((s) => [s.physicalId, s]));
  const sections = new Map(
    definition.reads.map((r) => [
      r.physicalId,
      r.facts.page ? `page ${r.facts.page}` : r.logicalId,
    ]),
  );
  need(
    definition.reads.every((read) => {
      const s = byId.get(read.physicalId);
      return (
        s &&
        s.logicalId === read.logicalId &&
        s.tenantId === expected.tenantId &&
        s.clientId === (isBudget ? null : expected.clientId) &&
        s.sourceVersion === read.version &&
        s.kind === read.kind &&
        s.sourceStorage === 'immutable_source_owned_controlled_adapter' &&
        s.contentSha256 === read.contentSha256
      );
    }),
    'CONTROLLED_READ_SOURCE_OWNER_INVALID',
  );
  if (expanded)
    need(
      isDeepStrictEqual(fixture.coverage, definition.coverage),
      'CONTROLLED_READ_CANONICAL_COVERAGE_MISMATCH',
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
          new Set(c.sourceIds).size === c.sourceIds.length &&
          c.sourceIds.every((id) => byId.has(id)),
      ),
    'CONTROLLED_READ_TOOL_AUTHORITY_UNPROVED',
  );
  const passages = (a) => (expanded ? a.sourceReads : [a]);
  need(
    Array.isArray(attempts) &&
      attempts.length > 0 &&
      new Set(attempts.map((a) => a.callId)).size === attempts.length &&
      attempts.every((a) => {
        const seen = passages(a);
        return (
          calls.some((c) => c.callId === a.callId && c.name === a.tool) &&
          ['caseId', 'captureRunId', 'requestId', 'traceId', 'turnId'].every(
            (k) => a[k] === policy[k],
          ) &&
          a.httpStatus === 200 &&
          a.currentVerifySha256 === fixture.currentVerifySha256 &&
          HASH.test(a.responseSha256 ?? '') &&
          Array.isArray(seen) &&
          seen.length === sources.length &&
          new Set(seen.map((r) => r.sourceId)).size === sources.length &&
          (!expanded ||
            (isDeepStrictEqual(a.coverage, definition.coverage) &&
              [
                'sourceId',
                'logicalSourceId',
                'sourceVersion',
                'contentSha256',
                'sourceTenantId',
                'sourceClientId',
                'fullRead',
                'passageSha256',
              ].every((k) => a[k] === seen[0]?.[k]))) &&
          seen.every((r) => {
            const s = byId.get(r.sourceId);
            return (
              s &&
              r.logicalSourceId === s.logicalId &&
              r.sourceVersion === s.sourceVersion &&
              r.sourceTenantId === expected.tenantId &&
              r.sourceClientId === s.clientId &&
              r.contentSha256 === s.contentSha256 &&
              (isBudget
                ? a.logicalError === null &&
                  r.fullRead === true &&
                  r.passageSha256 === s.contentSha256
                : [null, 'document unavailable'].includes(a.logicalError) &&
                  r.fullRead === false &&
                  r.passageSha256 === null)
            );
          })
        );
      }),
    'CONTROLLED_READ_HTTP_JOIN_UNPROVED',
  );
  need(calls.length === attempts.length, 'CONTROLLED_READ_HTTP_ATTEMPT_MISSING');
  need(
    Array.isArray(receipt.sources) && Array.isArray(citations),
    'CONTROLLED_READ_SOURCE_ARRAY_MISSING',
  );
  if (isBudget) {
    need(
      receipt.sources.length >= sources.length &&
        sources.every((s) => receipt.sources.some((r) => r.sourceId === s.physicalId)) &&
        receipt.sources.every((capture) => {
          const s = byId.get(capture.sourceId);
          return (
            s &&
            attempts.some(
              (a) =>
                a.callId === capture.toolCallId &&
                passages(a).some(
                  (r) =>
                    r.sourceId === s.physicalId &&
                    r.fullRead &&
                    r.passageSha256 === s.contentSha256,
                ),
            ) &&
            calls.some(
              (c) =>
                c.callId === capture.toolCallId &&
                c.status === 'complete' &&
                c.sourceIds.includes(s.physicalId),
            ) &&
            observed(capture.tenantId, s.tenantId) &&
            observed(capture.clientId, null) &&
            observed(capture.currentVersion, s.sourceVersion) &&
            observed(capture.fullRead, true) &&
            observed(capture.passageSha256, s.contentSha256) &&
            observed(capture.byteSha256, s.contentSha256) &&
            observed(capture.locator, sections.get(s.physicalId))
          );
        }),
      'CONTROLLED_READ_FULL_PASSAGE_UNPROVED',
    );
    const opened = expanded ? sourceReadback : [sourceReadback];
    need(
      Array.isArray(opened) &&
        opened.length === sources.length &&
        new Set(opened.map((r) => r?.recordId)).size === sources.length &&
        opened.every((r) => {
          const s = byId.get(r?.recordId);
          return (
            s &&
            r.kind === 'controlled_read' &&
            r.status === 'available' &&
            r.sourceVersion === s.sourceVersion &&
            r.tenantId === expected.tenantId &&
            r.clientId === expected.clientId &&
            r.conversationId === expected.conversationId &&
            r.section === sections.get(s.physicalId) &&
            r.nextCursor === null &&
            r.offset === 0 &&
            r.controlled === true &&
            typeof r.text === 'string' &&
            sha256Bytes(r.text) === s.contentSha256
          );
        }),
      'CONTROLLED_READ_CANONICAL_SOURCE_BYTES_MISMATCH',
    );
    need(
      citations.length === sources.length &&
        new Set(citations.map((c) => c.id)).size === sources.length &&
        citations.every((c) => {
          const s = byId.get(c.id);
          return (
            s &&
            tools.has(c.tool) &&
            typeof c.snippet === 'string' &&
            sha256Bytes(c.snippet) === s.contentSha256 &&
            c.source?.kind === 'controlled_read' &&
            c.source.recordId === s.physicalId &&
            c.source.version === s.sourceVersion &&
            c.source.section === sections.get(s.physicalId) &&
            c.source.conversationId === expected.conversationId &&
            c.source.clientId === expected.clientId &&
            calls.some(
              (call) =>
                call.name === c.tool &&
                call.status === 'complete' &&
                call.sourceIds.includes(s.physicalId),
            )
          );
        }),
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
    isBudget ? sources.map((s) => `source_client_authority_unproved:${s.physicalId}`) : [],
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
    sources,
    coverage: definition.coverage ?? null,
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
