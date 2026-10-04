jest.mock('./meri-case12-capture-authority.js', () => ({assertMeriCase12BindingInTx: jest.fn()}));
jest.mock('./meri-server-readonly-capture.js', () => ({
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(),
  issueMeriServerReadonlyCapturePolicy: jest.fn(),
  meriReadonlyCaptureCatalogSha256: () => 'f'.repeat(64),
}));
jest.mock('./meri-capture-provider-budget-owner.js', () => ({inspectCaptureProviderBudgetReadiness: jest.fn()}));
import { createHash } from 'node:crypto';
import { completeMeriCaptureEvidenceReceipt, observed, signMeriCaptureEvidenceReceipt,
  type MeriCaptureEvidenceReceipt, type MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority, issueMeriServerReadonlyCapturePolicy } from './meri-server-readonly-capture.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';
import { readMeriCase12CaptureAdmission, readMeriCase12CaptureReadback } from './meri-case12-capture-readback.js';
import { buildApiOnlyMeriServerCaptureEvidence } from './meri-server-capture-evidence.js';
import { captureBudgetTestContext as ctx, captureBudgetTestPolicy } from './meri-capture-provider-budget.spec-helper.js';

const SECRET = 'local-case12-readback-signature-test', NOW = Date.parse('2026-10-04T11:00:00Z');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const originalEnv = {...process.env};
beforeEach(() => {
  jest.resetAllMocks(); jest.useFakeTimers().setSystemTime(NOW);
  process.env.INTERNAL_SERVICE_SECRET = SECRET; process.env.GIT_SHA = 'a'.repeat(40);
  jest.mocked(inspectCaptureProviderBudgetReadiness).mockResolvedValue({ready: true} as never);
});
afterEach(() => {jest.useRealTimers(); process.env = {...originalEnv};});

function harness() {
  const policy: MeriServerReadonlyCapturePolicy = {...captureBudgetTestPolicy(), caseId: '12',
    captureRunId: id('3'), clientId: id('4'), fixtureVersion: 'meri-live-v1-2026-09-26.1',
    resetReceiptId: null, seedReceiptId: null, issuedAt: NOW - 1000,
    case12Setup: {setupRunId: id('1'), fixtureInstanceId: id('2'), setupPlanSha256: 'a'.repeat(64),
      setupClaimSha256: 'b'.repeat(64), setupLedgerSha256: 'c'.repeat(64)},
    semanticClock: {version: 1, kind: 'qualified_original_fixture_semantic_clock',
      instant: '2026-09-26T16:00:00.000Z', timeZone: 'America/New_York', caseId: '12',
      captureRunId: id('3'), currentVerifySha256: 'd'.repeat(64), observedAt: NOW - 1000}};
  const text = 'The complete canonical MA510 passage.', sourceId = id('5'), version = 'fixture-current-v1';
  const fixture = {fixtureNamespace: policy.fixtureNamespace, fixtureVersion: policy.fixtureVersion!,
    physicalMapSha256: policy.physicalMapSha256!, currentVerifySha256: 'd'.repeat(64),
    case12Setup: policy.case12Setup!, approvedText: text, approvedPassageSha256: hash(text),
    sources: [{logicalId: 'MA510' as const, physicalId: sourceId, tenantId: ctx.tenantId,
      clientId: policy.clientId!, sourceVersion: version, contentSha256: hash('title\0' + text)}]};
  jest.mocked(assertMeriCase12BindingInTx).mockResolvedValue(fixture);
  jest.mocked(issueMeriServerReadonlyCapturePolicy).mockResolvedValue(policy);
  const raw = buildApiOnlyMeriServerCaptureEvidence({policy, userMessageId: policy.turnId!,
    assistantMessageId: id('6'), citations: [], usage: {inputTokens: 1, outputTokens: 1}, secret: SECRET}).receipt;
  raw.sources = [{sourceId, toolCallId: 'actual-call', tenantId: observed(ctx.tenantId),
    clientId: observed(policy.clientId), currentVersion: observed('content:' + hash(text + '\0' + version)),
    fullRead: observed(true), locator: observed(`characters 0-${text.length}`),
    passageSha256: observed(hash(text)), byteSha256: observed(hash(text))}];
  raw.toolCalls = [{callId: 'actual-call', name: 'search_memory', attempt: 1, status: 'complete', readOnly: true, sourceIds: [sourceId]}];
  raw.usage.provider = observed('test-provider'); raw.usage.model = observed('test-model');
  raw.releases.orchestrator.releaseRevision = observed('b'.repeat(40));
  raw.providerBudget = {version: 1, boundary: 'case12_memory_turn', status: 'SETTLED', admissionId: id('7'),
    turnId: policy.turnId!, ledgerSha256: 'e'.repeat(64), qualificationSha256: 'f'.repeat(64),
    attempts: 1, chargedTokens: 2, chargedCostMicros: 1, maxCostMicros: 10, unaccountedBoundaries: []};
  const packet = (n: string) => ({packetId: id(n), persisted: true as const,
    clockUse: {instant: policy.semanticClock!.instant, timeZone: policy.semanticClock!.timeZone,
      eligibilityAt: new Date(NOW - 500).toISOString(), scoring: 'used' as const}});
  raw.semanticClock = {binding: policy.semanticClock!, prompt: observed({instant: policy.semanticClock!.instant,
    timeZone: policy.semanticClock!.timeZone, date: '2026-09-26', renderedAt: NOW - 300, groundingSha256: 'a'.repeat(64)}),
    invocations: [{callId: 'actual-call', tool: 'search_memory', outcome: 'returned', httpAttempts: 1,
      httpStatus: 200, responseSha256: 'b'.repeat(64), packets: [packet('9')]}],
    apiJoin: 'VERIFIED', api: {initial: packet('8'), tools: [packet('9')], relativeToolWindows: 'NOT_APPLICABLE'}};
  const tx = {}, prisma = {withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (tx: any) => any) => fn(tx))};
  const message = {id: id('6'), role: 'assistant', body: 'saved answer', metadata: {} as Record<string, unknown>};
  const sign = () => { const receipt = completeMeriCaptureEvidenceReceipt(raw);
    message.metadata = {serverReadonlyCapturePolicy: policy, serverCaptureEvidenceReceipt: signMeriCaptureEvidenceReceipt(receipt, SECRET)};
    return receipt; };
  expect(sign().blockers).toEqual([]);
  return {policy, fixture, raw, sign, message, tx,
    args: {prisma: prisma as never, ctx, conversationId: policy.conversationId, message}};
}

test('signed exact full MA510 passage joins its current native source and leaves human grading NOT_RUN', async () => {
  const h = harness(); const result = await readMeriCase12CaptureReadback(h.args);
  expect(result).toMatchObject({status: 'QUALIFIED', ma510FullPassageQualified: true, humanAcceptance: 'NOT_RUN',
    answerSha256: hash(h.message.body), fixture: h.fixture});
  expect(assertMeriCase12BindingInTx).toHaveBeenCalledWith(h.args.prisma, h.tx, ctx, h.policy);
});

test.each(['partial', 'wrong-source', 'wrong-version', 'wrong-passage', 'wrong-bytes', 'wrong-locator',
  'wrong-tenant', 'wrong-client', 'missing-source', 'duplicate-source', 'missing-call', 'wrong-call',
  'failed-call', 'duplicate-call', 'http-retry', 'http-failure'])(
  'validly signed %s cannot qualify MA510', async fault => {
    const h = harness(), r = h.raw, source = r.sources[0]!, call = r.toolCalls[0]!;
    if (fault === 'partial') source.fullRead = observed(false);
    if (fault === 'wrong-source') source.sourceId = id('a');
    if (fault === 'wrong-version') source.currentVersion = observed('content:' + '0'.repeat(64));
    if (fault === 'wrong-passage') source.passageSha256 = observed('0'.repeat(64));
    if (fault === 'wrong-bytes') source.byteSha256 = observed('0'.repeat(64));
    if (fault === 'wrong-locator') source.locator = observed('characters 1-3');
    if (fault === 'wrong-tenant') source.tenantId = observed(id('a'));
    if (fault === 'wrong-client') source.clientId = observed(id('a'));
    if (fault === 'missing-source') r.sources = [];
    if (fault === 'duplicate-source') r.sources.push(structuredClone(source));
    if (fault === 'missing-call') r.toolCalls = [];
    if (fault === 'wrong-call') call.sourceIds = [];
    if (fault === 'failed-call') call.status = 'failed';
    if (fault === 'duplicate-call') r.toolCalls.push(structuredClone(call));
    if (fault === 'http-retry') r.semanticClock!.invocations![0]!.httpAttempts = 2;
    if (fault === 'http-failure') r.semanticClock!.invocations![0]!.httpStatus = 500;
    h.sign();
    expect(await readMeriCase12CaptureReadback(h.args)).toMatchObject({status: 'BLOCKED', ma510FullPassageQualified: false});
  });

test('signature forgery is denied before native reads', async () => {
  const h = harness(); const envelope = h.message.metadata.serverCaptureEvidenceReceipt as {receipt: MeriCaptureEvidenceReceipt};
  envelope.receipt.sources[0]!.passageSha256.value = '0'.repeat(64);
  await expect(readMeriCase12CaptureReadback(h.args)).rejects.toThrow('policy_readback_denied');
  expect(assertMeriCase12BindingInTx).not.toHaveBeenCalled();
});
test('current native revocation denies admission and readback', async () => {
  const h = harness(); jest.mocked(assertMeriCase12BindingInTx).mockRejectedValue(new Error('REVOKED'));
  await expect(readMeriCase12CaptureAdmission(h.args)).rejects.toThrow('REVOKED');
  await expect(readMeriCase12CaptureReadback(h.args)).rejects.toThrow('REVOKED');
  expect(inspectCaptureProviderBudgetReadiness).not.toHaveBeenCalled();
});
test('read-only admission joins budget and current source without issuing a capture result', async () => {
  const h = harness();
  expect(await readMeriCase12CaptureAdmission(h.args)).toMatchObject({status: 'READY', caseId: '12', fixture: h.fixture});
  expect(assertMeriServerReadonlyCaptureCurrentAuthority).toHaveBeenCalledTimes(2);
});
