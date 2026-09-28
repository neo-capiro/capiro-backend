import type { MeriGovernedTurnContext } from '../registry/types';
import { attestMeriGovernedContext, verifyMeriGovernedContext } from './governed-evidence-auth';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const binding = {
  conversationId: 'conversation-1',
  clientId: 'client-1',
  messages: [{ role: 'user', text: 'Brief me on the meeting.' }],
};
const secret = 'test-only-internal-secret';
const now = 1_000_000;
function context(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'meri.chat',
    prompt: 'Meeting is at 10.',
    contextPacket: {
      packetId: 'packet-1',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: { coverage: { complete: false } } as MeriGovernedTurnContext['retrieval'],
    evidence: {
      version: 1,
      ...actor,
      packetId: 'packet-1',
      sourceRecordCount: 1,
      projectedRecordCount: 1,
      truncated: false,
      records: [
        {
          domain: 'meetings',
          recordId: 'meeting-1',
          payload: { title: 'Meeting', body: 'At 10.' },
          projection: { truncated: false, originalCharacters: 10, returnedCharacters: 10 },
        },
      ],
    },
  };
}

function procedure() {
  return {
    version: 1 as const,
    tenantId: actor.tenantId,
    identity: {
      source: 'firm' as const,
      recordId: 'procedure-row-1',
      canonicalId: 'commitments_audit',
      version: 4,
    },
    manifestDigest: 'a'.repeat(64),
    instruction: 'Run the canonical read-only commitments audit.',
    scope: 'client' as const,
    clientId: binding.clientId ?? null,
    clientRequired: true,
    resolvedAt: now,
    validUntil: now + 60_000,
    policy: {
      effectMode: 'read_only' as const,
      allowedCapabilities: ['tasks.read'],
      allowedTools: ['query_tasks'],
      requiredTools: ['query_tasks'],
    },
    contract: {
      outputFields: ['auditStatus'],
      completionChecks: ['Report source coverage'],
      coverageStates: ['checked'],
      caseIds: ['CD-01'],
    },
  };
}

describe('authenticated governed evidence transport', () => {
  it('round trips the exact API payload through JSON under the resolved identity', () => {
    const signed = JSON.parse(
      JSON.stringify(attestMeriGovernedContext(context(), binding, secret, now)),
    );
    expect(() => verifyMeriGovernedContext(signed, binding, actor, secret, now + 1)).not.toThrow();
    expect(JSON.stringify(signed)).not.toContain(secret);
  });
  it.each(['prompt', 'coverage', 'payload', 'packet'] as const)('rejects altered %s', (field) => {
    const signed = attestMeriGovernedContext(context(), binding, secret, now);
    if (field === 'prompt') signed.prompt = 'Invented official evidence';
    if (field === 'coverage') signed.retrieval.coverage.complete = true;
    if (field === 'payload') signed.evidence!.records[0]!.payload.body = 'At 11.';
    if (field === 'packet') signed.contextPacket.packetId = 'packet-2';
    expect(() => verifyMeriGovernedContext(signed, binding, actor, secret, now)).toThrow(
      'authentication_failed',
    );
  });
  it.each(['version', 'client', 'policy', 'tools'] as const)(
    'rejects an altered served-procedure %s',
    (field) => {
      const source = context();
      source.procedure = procedure();
      const signed = attestMeriGovernedContext(source, binding, secret, now);
      if (field === 'version') signed.procedure!.identity.version += 1;
      if (field === 'client') signed.procedure!.clientId = 'client-2';
      if (field === 'policy') signed.procedure!.policy.effectMode = 'approval_required';
      if (field === 'tools') signed.procedure!.policy.allowedTools.push('send_email');
      expect(() => verifyMeriGovernedContext(signed, binding, actor, secret, now)).toThrow(
        'authentication_failed',
      );
    },
  );
  it.each([
    { conversationId: 'conversation-2' },
    { clientId: 'client-2' },
    { messages: [{ role: 'user', text: 'A different question.' }] },
  ])('rejects replay in a changed request %j', (changed) => {
    const signed = attestMeriGovernedContext(context(), binding, secret, now);
    expect(() =>
      verifyMeriGovernedContext(signed, { ...binding, ...changed }, actor, secret, now),
    ).toThrow('authentication_failed');
  });
  it.each([{ tenantId: 'impersonated-tenant' }, { userId: 'different-user' }])(
    'rejects a changed resolved actor %j',
    (changed) => {
      const signed = attestMeriGovernedContext(context(), binding, secret, now);
      expect(() =>
        verifyMeriGovernedContext(signed, binding, { ...actor, ...changed }, secret, now),
      ).toThrow('authentication_failed');
    },
  );
  it('rejects expired, future, unsigned and unconfigured contexts', () => {
    const signed = attestMeriGovernedContext(context(), binding, secret, now);
    for (const time of [now + 300_001, now - 30_001]) {
      expect(() => verifyMeriGovernedContext(signed, binding, actor, secret, time)).toThrow(
        'authentication_failed',
      );
    }
    expect(() => verifyMeriGovernedContext(context(), binding, actor, secret, now)).toThrow(
      'authentication_failed',
    );
    expect(() => verifyMeriGovernedContext(signed, binding, actor, undefined, now)).toThrow(
      'authentication_failed',
    );
    expect(() => attestMeriGovernedContext(context(), binding, undefined, now)).toThrow(
      'service_identity_unavailable',
    );
  });
});
