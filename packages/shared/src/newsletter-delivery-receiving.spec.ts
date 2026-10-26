import {
  parseNewsletterPrepareResult,
  parseNewsletterSendReadback,
  parseNewsletterSendReceipt,
  type NewsletterOutreachVersion,
  type NewsletterSendReadback,
} from './newsletter.js';
const recordId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const senderConnectionId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const foreignId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestKey = 'synthetic-send-request';
const time = '2026-10-26T10:00:00.000Z';
const binding = {
  recordId,
  requestKey,
  senderConnectionId,
  versionIds: [versionId],
  testMode: false,
};
function readback(): NewsletterSendReadback {
  return {
    outreachRecordId: recordId,
    requestKey,
    intent: {
      id: intentId,
      outreachRecordId: recordId,
      requestKey,
      senderConnectionId,
      versionIds: [versionId],
      status: 'unknown',
      testMode: false,
      totals: { total: 1, unknown: 1 },
      error: null,
      startedAt: time,
      finishedAt: null,
      createdAt: time,
      deliveries: [
        {
          id: foreignId,
          generationKey: 'newsletter:synthetic',
          recipientKey: 'newsletter:synthetic',
          status: 'unknown',
          attempt: 1,
          provider: 'gmail',
          correlationId: foreignId,
          to: [{ email: 'synthetic@example.test', name: null }],
          cc: [],
          bcc: [],
          subject: 'Synthetic',
          providerMessageId: null,
          providerThreadId: null,
          providerDraftId: null,
          errorCode: 'PROVIDER_ACK_UNKNOWN',
          errorMessage: null,
          acceptedAt: null,
        },
      ],
    },
  };
}
function version(): NewsletterOutreachVersion {
  return {
    id: versionId,
    artifactId: foreignId,
    outreachRecordId: recordId,
    version: 1,
    sourceVersionId: null,
    generationKey: 'newsletter:synthetic',
    recipientKey: 'newsletter:synthetic',
    audienceKind: 'individual',
    subject: 'Synthetic',
    body: '<p>Saved prepared body</p>',
    contentHash: `sha256:${'a'.repeat(64)}`,
    generationStatus: 'manually_authored',
    auditStatus: 'not_required',
    approvalStatus: 'not_required',
    auditDecision: null,
    auditChecks: [],
    reviewRequestId: null,
    provider: null,
    model: null,
    promptSpecVersion: 'workspace-newsletter-v1',
    sendable: true,
    createdAt: time,
    recipientEmail: 'synthetic@example.test',
  };
}
describe('newsletter delivery public receiving', () => {
  it('binds prepared immutable bodies to the requested record and preserves empty exclusions', () => {
    const input = { versions: [version()], excluded: [] };
    const result = parseNewsletterPrepareResult(input, { recordId });
    expect(result).toEqual({ ok: true, value: input });
    input.versions[0]!.body = 'changed';
    if (result.ok) expect(result.value.versions[0]?.body).toBe('<p>Saved prepared body</p>');
    expect(
      parseNewsletterPrepareResult(
        { versions: [], excluded: ['opted-out@example.test'] },
        { recordId },
      ).ok,
    ).toBe(true);
    expect(
      parseNewsletterPrepareResult({ versions: [version(), version()], excluded: [] }, { recordId })
        .ok,
    ).toBe(false);
    expect(
      parseNewsletterPrepareResult(
        { versions: [{ ...version(), outreachRecordId: foreignId }], excluded: [] },
        { recordId },
      ).ok,
    ).toBe(false);
  });
  it('admits only the actual send receipt without inventing request binding or delivery success', () => {
    expect(parseNewsletterSendReceipt({ intentId, deduped: true })).toEqual({
      ok: true,
      value: { intentId, deduped: true },
    });
    expect(parseNewsletterSendReceipt({ intentId }).ok).toBe(false);
    expect(parseNewsletterSendReceipt({ intentId: 'bad', deduped: false }).ok).toBe(false);
  });
  it('preserves unknown and nullable provider outcomes and binds the complete captured send request', () => {
    const input = readback();
    expect(parseNewsletterSendReadback(input, binding)).toEqual({ ok: true, value: input });
    expect(parseNewsletterSendReadback(input, { recordId, intentId }).ok).toBe(true);
    input.intent!.status = 'future_status';
    expect(parseNewsletterSendReadback(input, binding).ok).toBe(true);
  });
  it.each(['record', 'request', 'sender', 'version', 'mode', 'intent'])(
    'refuses wrong captured %s binding',
    (field) => {
      const expected = {
        ...binding,
        ...(field === 'record' ? { recordId: foreignId } : {}),
        ...(field === 'request' ? { requestKey: 'different-request' } : {}),
        ...(field === 'sender' ? { senderConnectionId: foreignId } : {}),
        ...(field === 'version' ? { versionIds: [foreignId] } : {}),
        ...(field === 'mode' ? { testMode: true } : {}),
        ...(field === 'intent' ? { intentId: foreignId } : {}),
      };
      expect(parseNewsletterSendReadback(readback(), expected).ok).toBe(false);
    },
  );
  it('keeps absent observations distinct from a known intent and rejects contradictory nested identity', () => {
    const absent = { outreachRecordId: recordId, requestKey, intent: null };
    expect(parseNewsletterSendReadback(absent, binding)).toEqual({ ok: true, value: absent });
    expect(parseNewsletterSendReadback(absent, { recordId, intentId }).ok).toBe(false);
    for (const change of [
      { outreachRecordId: foreignId },
      { requestKey: 'different-request' },
      { versionIds: [versionId, versionId] },
      { deliveries: [] },
    ]) {
      const input = readback();
      Object.assign(input.intent!, change);
      expect(parseNewsletterSendReadback(input, binding).ok).toBe(false);
    }
  });
  it('compares UUID case and version-set order without weakening exact request-key matching', () => {
    const input = readback();
    input.intent!.senderConnectionId = foreignId;
    expect(
      parseNewsletterSendReadback(input, {
        recordId,
        requestKey,
        senderConnectionId: foreignId.toUpperCase(),
      }).ok,
    ).toBe(true);
    expect(
      parseNewsletterSendReadback(input, { recordId, requestKey: requestKey.toUpperCase() }).ok,
    ).toBe(false);
  });
  it('refuses malformed and hostile values without invoking accessors or throwing', () => {
    const getter = jest.fn(() => recordId);
    const hostile = Object.defineProperty({}, 'outreachRecordId', {
      enumerable: true,
      get: getter,
    });
    for (const value of [
      undefined,
      null,
      [],
      hostile,
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error('hostile');
          },
        },
      ),
    ]) {
      expect(parseNewsletterSendReadback(value, binding).ok).toBe(false);
      expect(parseNewsletterSendReceipt(value).ok).toBe(false);
      expect(parseNewsletterPrepareResult(value, { recordId }).ok).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    const input = readback();
    input.intent!.totals.total = -1;
    expect(parseNewsletterSendReadback(input, binding).ok).toBe(false);
  });
});
