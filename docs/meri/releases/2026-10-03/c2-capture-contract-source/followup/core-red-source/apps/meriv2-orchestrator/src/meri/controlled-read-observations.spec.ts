import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { MERI_CAPABILITY_REGISTRY, type MeriCitation } from '@capiro/shared';
import {
  meriCaptureClockExecutionBlockers,
  type MeriServerReadonlyCapturePolicy,
  type MeriContext,
} from '@capiro/meriv2-core';
import { withTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { MeriRunBudget } from './meriv3/meriv3-run-budget.js';
import {
  observeMeriV3CaptureExecution,
  buildSignedOrchestratorCaptureEvidence,
} from './meriv3/meriv3-capture-evidence.js';
import {
  withControlledReadInvocation,
  observeControlledReadHttpResponse,
  readControlledReadHttpObservations,
  readCaptureClockInvocations,
} from './controlled-read-observations.js';
import { projectMeriToolEvidence } from './meriv3/meriv3-tool-evidence.js';

const id = (n: number) =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function policy(caseId = '72'): MeriServerReadonlyCapturePolicy {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: id(1),
    requestId: 'request',
    traceId: 'trace',
    turnId: id(2),
    caseId,
    captureRunId: id(3),
    fixtureVersion: 'test',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: 'reset',
    seedReceiptId: 'seed',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: id(4),
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: id(5),
    conversationId: id(6),
    clientId: id(7),
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: hash(
      MERI_CAPABILITY_REGISTRY.filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort()
        .join('\n'),
    ),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
    ],
  };
}
function scope<T>(p: MeriServerReadonlyCapturePolicy, fn: () => T): T {
  return withTrustedCurrentTurnScope(
    {
      tenantId: p.tenantId,
      userId: p.actorUserId,
      conversationId: p.conversationId,
      selectedClientId: p.clientId,
      capturePolicy: p,
    },
    fn,
  );
}
function payload(p: MeriServerReadonlyCapturePolicy): {
  error?: string;
  records?: Array<{ id: string; text: string }>;
  controlledRead: Record<string, any>;
} {
  const text = 'R2-27, page 14. PE 0912345T. FY27 President\u2019s Budget request: $42M.';
  return {
    ...(p.caseId === '72' ? { error: 'document unavailable' } : { records: [{ id: id(8), text }] }),
    controlledRead: {
      owner: 'meri_controlled_read_v1',
      ...Object.fromEntries(
        [
          'caseId',
          'captureRunId',
          'requestId',
          'traceId',
          'turnId',
          'tenantId',
          'actorUserId',
          'clientId',
          'conversationId',
          'physicalMapSha256',
        ].map((k) => [k, (p as any)[k]]),
      ),
      sourceTenantId: p.tenantId,
      sourceClientId: p.caseId === '20' ? null : p.clientId,
      currentVerifySha256: 'b'.repeat(64),
      sourceId: id(8),
      logicalSourceId: p.caseId === '20' ? 'R2-27' : 'MEMO-A-LATEST',
      sourceVersion: 'v1',
      contentSha256: hash(p.caseId === '20' ? text : ''),
    },
  };
}

describe('controlled read actual HTTP observations', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });
  test.each(['unwrapped', 'missing-call-id', 'wrong-tool'])(
    'refused %s execution poisons the clock census even when its caller catches the error',
    async (boundary) => {
      const p = policy('01');
      p.fixtureVersion = 'meri-live-v1-2026-09-26.1';
      p.semanticClock = {
        version: 1,
        kind: 'qualified_original_fixture_semantic_clock',
        instant: '2026-09-26T16:00:00.000Z',
        timeZone: 'America/New_York',
        caseId: '01',
        captureRunId: p.captureRunId!,
        currentVerifySha256: 'b'.repeat(64),
        observedAt: p.issuedAt,
      };
      const repo = new ApiToolExecutorRepo({
        get: (key: string) =>
          (
            ({
              MERIV2_API_BASE_URL: 'http://127.0.0.1:1',
              INTERNAL_SERVICE_SECRET: 'synthetic-secret',
            }) as Record<string, string>
          )[key],
      } as never);
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      try {
        await scope(p, () =>
          RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, async () => {
            const invoke = () => repo.execute({} as MeriContext, 'search_memory', {});
            const refused =
              boundary === 'unwrapped'
                ? invoke()
                : withControlledReadInvocation(
                    boundary === 'missing-call-id' ? undefined : 'actual-call',
                    invoke,
                    boundary === 'wrong-tool' ? 'get_program_element' : 'search_memory',
                  );
            await expect(refused).rejects.toThrow(
              boundary === 'missing-call-id' ? 'identity missing' : 'invocation missing',
            );
            expect(fetchSpy).not.toHaveBeenCalled();
            const signed = buildSignedOrchestratorCaptureEvidence({
              policy: p,
              startedAt: p.issuedAt,
              completedAt: Date.now(),
              providerCallObserved: false,
              provider: 'synthetic',
              model: null,
              usage: null,
              secret: 'synthetic-signing-secret',
              execution: {
                toolCalls: [],
                sources: [],
                clockInvocations: readCaptureClockInvocations(),
                promptClockUse: {
                  instant: p.semanticClock!.instant,
                  timeZone: p.semanticClock!.timeZone,
                  date: '2026-09-26',
                  renderedAt: Date.now(),
                  groundingSha256: 'c'.repeat(64),
                },
                estimatedCostUsd: { status: 'UNKNOWN', value: null, reason: 'not_run' },
              },
            });
            expect(meriCaptureClockExecutionBlockers(signed.receipt)).toContain(
              'semantic_clock_invocation_join_unproved',
            );
            expect(signed.receipt.semanticClock!.invocations).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  callId: '',
                  tool: 'search_memory',
                  outcome: 'threw',
                  httpAttempts: 0,
                  httpStatus: null,
                  responseSha256: null,
                  packets: [],
                }),
              ]),
            );
          }),
        );
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
  test.each(['01', '14', '20', '72', 'failed'])(
    'retains actual %s HTTP clock evidence before truncation',
    async (caseName) => {
      const p = policy(caseName === 'failed' ? '01' : caseName);
      p.fixtureVersion = 'meri-live-v1-2026-09-26.1';
      p.semanticClock = {
        version: 1,
        kind: 'qualified_original_fixture_semantic_clock',
        instant: '2026-09-26T16:00:00.000Z',
        timeZone: 'America/New_York',
        caseId: p.caseId as '01' | '14' | '20' | '72',
        captureRunId: p.captureRunId!,
        currentVerifySha256: 'b'.repeat(64),
        observedAt: p.issuedAt,
      };
      const memory = ['01', '14'].includes(p.caseId!);
      const tool = memory
        ? 'search_memory'
        : p.caseId === '20'
          ? 'get_program_element'
          : 'read_client_documents';
      const packets = [8, 9].map((n) => ({
        packetId: id(n),
        persisted: true,
        clockUse: {
          instant: p.semanticClock!.instant,
          timeZone: p.semanticClock!.timeZone,
          eligibilityAt: new Date().toISOString(),
          scoring: 'used',
        },
      }));
      const body = memory
        ? {
            tool: 'search_memory',
            contextPacket: packets[1],
            contextPackets: packets,
            coverage: {
              complete: false,
              paginationComplete: false,
              sources: [
                {
                  domain: 'institutional_knowledge',
                  sourceStatus: 'healthy',
                  hasMore: true,
                  truncated: true,
                  paginationComplete: false,
                  coverageComplete: false,
                },
              ],
            },
            factContentUnavailableCount: 0,
            contentStatus: 'available',
            contentTruncated: true,
            nextCursor: 'next',
            results: [{ id: 'memory' }],
            records: [{ id: 'memory', text: 'source '.repeat(20000) }],
          }
        : payload(p);
      let hits = 0;
      server = createServer((req, res) => {
        hits++;
        req.resume();
        res.writeHead(caseName === 'failed' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const repo = new ApiToolExecutorRepo({
        get: (key: string) =>
          (
            ({
              MERIV2_API_BASE_URL: `http://127.0.0.1:${(server!.address() as { port: number }).port}`,
              INTERNAL_SERVICE_SECRET: 'synthetic-secret',
            }) as Record<string, string>
          )[key],
      } as never);
      await scope(p, () =>
        RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, async () => {
          const call = () =>
            withControlledReadInvocation(
              'actual-call',
              () => repo.execute({} as MeriContext, tool, {}),
              tool,
            );
          if (caseName === 'failed' || p.caseId === '72') await expect(call()).rejects.toThrow();
          else {
            const response = await call();
            if (memory) {
              const visible = projectMeriToolEvidence({
                result: response,
                maxCharacters: 1800,
                readOnly: true,
              });
              expect(visible).not.toHaveProperty('contextPackets');
              expect(visible).not.toHaveProperty('contextPacket');
            }
          }
          const actual = readCaptureClockInvocations()!;
          expect(actual).toHaveLength(1);
          expect(actual[0]).toMatchObject({
            callId: 'actual-call',
            tool,
            httpAttempts: 1,
            outcome: caseName === 'failed' || p.caseId === '72' ? 'threw' : 'returned',
            httpStatus: caseName === 'failed' ? null : 200,
            packets: memory && caseName !== 'failed' ? packets : [],
          });
          if (caseName !== 'failed')
            expect(actual[0]!.responseSha256).toBe(hash(JSON.stringify(body)));
          if (p.caseId === '72')
            expect(readControlledReadHttpObservations()![0]!.logicalError).toBe(
              'document unavailable',
            );
          const signed = buildSignedOrchestratorCaptureEvidence({
            policy: p,
            startedAt: p.issuedAt,
            completedAt: Date.now(),
            providerCallObserved: false,
            provider: 'synthetic',
            model: null,
            usage: null,
            secret: 'synthetic-signing-secret',
            execution: {
              ...observeMeriV3CaptureExecution({
                callId: 'actual-call',
                tool,
                readOnly: true,
                result: caseName === 'failed' ? { error: 'failed' } : body,
                citations: [],
                coverage: [],
              }),
              clockInvocations: actual,
              controlledReadAttempts: readControlledReadHttpObservations(),
              estimatedCostUsd: { status: 'UNKNOWN', value: null, reason: 'not_run' },
            },
          });
          expect(signed.receipt.semanticClock!.invocations).toEqual(actual);
          expect(signed.receipt.semanticClock!.apiJoin).toBe('PENDING');
          expect(signed.receipt.blockers).toContain('semantic_clock_api_tool_join_pending');
          actual.length = 0;
          expect(readCaptureClockInvocations()).toHaveLength(1);
        }),
      );
      expect(hits).toBe(1);
    },
  );
  test.each([
    '01-empty',
    '01-complete',
    '01-partial',
    '14-complete',
    'tenant',
    'actor',
    'client',
    'missing-client',
    'compiler',
    'approved',
    'disabled',
    'http-failure',
  ])(
    'observes the actual own-proposal response as a bounded no-clock-consumer read: %s',
    async (name) => {
      const p = policy(name.startsWith('14') ? '14' : '01');
      p.fixtureVersion = 'meri-live-v1-2026-09-26.1';
      p.semanticClock = {
        version: 1,
        kind: 'qualified_original_fixture_semantic_clock',
        instant: '2026-09-26T16:00:00.000Z',
        timeZone: 'America/New_York',
        caseId: p.caseId as '01' | '14',
        captureRunId: p.captureRunId!,
        currentVerifySha256: 'b'.repeat(64),
        observedAt: p.issuedAt,
      };
      const partial = name.endsWith('partial'),
        empty = name.endsWith('empty');
      const body: any = {
        tool: 'list_memory_proposals',
        enabled: true,
        authority: 'own_pending_proposals',
        claimsAreApprovedFacts: false,
        scope: { tenantId: p.tenantId, userId: p.actorUserId, clientId: p.clientId },
        candidates: empty
          ? []
          : [
              {
                id: id(8),
                status: 'pending',
                approvedFact: false,
                scope: 'client',
                clientId: p.clientId,
                sourceKind: 'user_chat',
                createdAt: '2026-09-26T12:00:00.000Z',
                restricted: false,
                title: 'Pending only',
                proposedText: 'Unapproved preference',
                contentTruncated: false,
              },
            ],
        nextCursor: partial ? 'next' : null,
        coverage: { firstPage: true, complete: !partial, reason: 'owned-read' },
      };
      if (name === 'tenant') body.scope.tenantId = id(9);
      if (name === 'actor') body.scope.userId = id(9);
      if (name === 'client') body.scope.clientId = body.candidates[0].clientId = id(9);
      if (name === 'missing-client') body.scope.clientId = null;
      if (name === 'compiler') body.contextPackets = [];
      if (name === 'approved') body.claimsAreApprovedFacts = true;
      if (name === 'disabled') {
        body.enabled = false;
        body.candidates = [];
        body.coverage.complete = false;
      }
      const succeeds = name.startsWith('01-') || name.startsWith('14-');
      let hits = 0;
      server = createServer((req, res) => {
        hits++;
        req.resume();
        res.writeHead(name === 'http-failure' ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const repo = new ApiToolExecutorRepo({
        get: (key: string) =>
          ({
            MERIV2_API_BASE_URL: `http://127.0.0.1:${(server!.address() as { port: number }).port}`,
            INTERNAL_SERVICE_SECRET: 'synthetic-secret',
          })[key],
      } as never);
      await scope(p, () =>
        RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, async () => {
          const call = () =>
            withControlledReadInvocation(
              'proposal-call',
              () =>
                repo.execute({} as MeriContext, 'list_memory_proposals', { clientId: p.clientId }),
              'list_memory_proposals',
            );
          if (succeeds) await expect(call()).resolves.toBeDefined();
          else await expect(call()).rejects.toThrow();
          const actual = readCaptureClockInvocations()!;
          expect(actual).toHaveLength(1);
          expect(actual[0]!.packets).toEqual([]);
          if (succeeds)
            expect((actual[0] as any).proposalRead).toEqual({
              authority: 'own_pending_proposals',
              tenantId: p.tenantId,
              actorUserId: p.actorUserId,
              clientId: p.clientId,
              semanticTime: 'not_used',
              compiler: 'not_run',
              claimsAreApprovedFacts: false,
              coverage: partial ? 'partial' : empty ? 'empty' : 'complete',
            });
          else expect((actual[0] as any).proposalRead).toBeUndefined();
          const signed = buildSignedOrchestratorCaptureEvidence({
            policy: p,
            startedAt: p.issuedAt,
            completedAt: Date.now(),
            providerCallObserved: false,
            provider: 'synthetic',
            model: null,
            usage: null,
            secret: 'synthetic-secret',
            execution: {
              ...observeMeriV3CaptureExecution({
                callId: 'proposal-call',
                tool: 'list_memory_proposals',
                readOnly: true,
                result: succeeds ? body : { error: 'failed' },
                citations: [],
                coverage: [],
              }),
              clockInvocations: actual,
              promptClockUse: {
                instant: p.semanticClock!.instant,
                timeZone: p.semanticClock!.timeZone,
                date: '2026-09-26',
                renderedAt: Date.now(),
                groundingSha256: 'c'.repeat(64),
              },
              estimatedCostUsd: { status: 'UNKNOWN', value: null, reason: 'not_run' },
            },
          });
          if (succeeds) expect(meriCaptureClockExecutionBlockers(signed.receipt)).toEqual([]);
          else
            expect(meriCaptureClockExecutionBlockers(signed.receipt)).toContain(
              'semantic_clock_invocation_join_unproved',
            );
        }),
      );
      expect(hits).toBe(1);
    },
  );
  function multiPayload(p: MeriServerReadonlyCapturePolicy): any {
    const original = payload(policy('20'));
    const sourceReads = [8, 9].map((n) => ({
      sourceId: id(n),
      logicalSourceId: n === 8 ? 'ENACT-26' : 'R2-27',
      sourceVersion: 'v1',
      sourceTenantId: p.tenantId,
      sourceClientId: null,
      contentSha256: hash(`actual passage ${n}`),
    }));
    return {
      tool: 'get_pe_budget_timeline',
      records: sourceReads.map((s, i) => ({
        id: s.sourceId,
        sourceId: s.sourceId,
        sourceVersion: s.sourceVersion,
        contentSha256: s.contentSha256,
        text: `actual passage ${i + 8}`,
      })),
      controlledRead: {
        ...original.controlledRead,
        ...Object.fromEntries(
          [
            'caseId',
            'captureRunId',
            'requestId',
            'traceId',
            'turnId',
            'tenantId',
            'actorUserId',
            'clientId',
            'conversationId',
            'physicalMapSha256',
          ].map((k) => [k, (p as any)[k]]),
        ),
        ...sourceReads[0],
        sourceReads,
        coverage: null,
      },
    };
  }
  test('one actual loopback HTTP response captures two independent passages under one provider call', async () => {
    const p = policy('21'),
      body = multiPayload(p);
    let hits = 0;
    server = createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const repo = new ApiToolExecutorRepo({
      get: (k: string) =>
        (
          ({
            MERIV2_API_BASE_URL: `http://127.0.0.1:${port}`,
            INTERNAL_SERVICE_SECRET: 'synthetic-test-secret',
          }) as any
        )[k],
    } as never);
    await scope(p, () =>
      RequestCredentialsStore.run({ bearerToken: 'synthetic-test-bearer' }, async () => {
        await withControlledReadInvocation('one-provider-call', () =>
          repo.execute({} as MeriContext, 'get_pe_budget_timeline', { peCode: '0912345T' }),
        );
        const observed = readControlledReadHttpObservations()!;
        expect(observed).toHaveLength(1);
        expect(observed[0]!.callId).toBe('one-provider-call');
        expect(observed[0]!.sourceReads).toHaveLength(2);
        expect(new Set(observed[0]!.sourceReads!.map((s) => s.passageSha256)).size).toBe(2);
      }),
    );
    expect(hits).toBe(1);
  });
  test.each(['duplicate', 'missing', 'hash', 'foreign', 'coverage'])(
    'multi-source observation refuses %s before recording anything',
    async (fault) => {
      const p = policy('21'),
        body = multiPayload(p);
      if (fault === 'duplicate')
        body.controlledRead.sourceReads[1] = body.controlledRead.sourceReads[0];
      if (fault === 'missing') body.records.pop();
      if (fault === 'hash') body.records[1].text += ' modified';
      if (fault === 'foreign') body.controlledRead.sourceReads[1].sourceTenantId = id(9);
      if (fault === 'coverage') body.controlledRead.coverage = { complete: true, sourceIds: [] };
      await scope(p, () =>
        withControlledReadInvocation('call', async () => {
          expect(() =>
            observeControlledReadHttpResponse('get_pe_budget_timeline', 200, body),
          ).toThrow();
          expect(readControlledReadHttpObservations()).toEqual([]);
        }),
      );
    },
  );
  test('native API executor observes HTTP200 logical errors before failure and native no-progress suppresses call four', async () => {
    const p = policy(),
      body = payload(p);
    let hits = 0;
    server = createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const repo = new ApiToolExecutorRepo({
      get: (k: string) =>
        (
          ({
            MERIV2_API_BASE_URL: `http://127.0.0.1:${port}`,
            INTERNAL_SERVICE_SECRET: 'synthetic-test-secret',
          }) as any
        )[k],
    } as never);
    const budget = MeriRunBudget.fromToolRoundCeiling(4),
      tool = 'read_client_documents';
    const signature = budget.toolSignature(
      {
        actorId: p.actorUserId,
        tenantId: p.tenantId,
        clientId: p.clientId,
        conversationId: p.conversationId,
        runId: p.captureRunId,
      },
      tool,
      { clientId: p.clientId, documentId: id(8) },
    );
    await scope(p, () =>
      RequestCredentialsStore.run({ bearerToken: 'synthetic-test-bearer' }, async () => {
        for (let i = 0; i < 3; i++) {
          expect(budget.reserveToolBatch(1)).toBe(true);
          expect(budget.beginTool(signature)).toBe(true);
          let failure: unknown;
          try {
            await withControlledReadInvocation(`actual-call-${i}`, () =>
              repo.execute({} as MeriContext, tool, { clientId: p.clientId, documentId: id(8) }),
            );
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).toContain('document unavailable');
          budget.observeToolResult({ signature, result: { error: String(failure) }, failed: true });
        }
        expect(budget.snapshot()).toMatchObject({
          toolCalls: 3,
          retryCalls: 2,
          acquisitionStopped: true,
          stopReason: 'no_progress',
        });
        expect(budget.reserveToolBatch(1)).toBe(false);
        expect(budget.beginTool(signature)).toBe(false);
        const attempts = readControlledReadHttpObservations()!;
        expect(attempts).toHaveLength(3);
        expect(new Set(attempts.map((a) => a.responseSha256)).size).toBe(1);
        expect(
          attempts.every(
            (a) =>
              a.httpStatus === 200 &&
              a.logicalError === 'document unavailable' &&
              !a.fullRead &&
              a.passageSha256 === null,
          ),
        ).toBe(true);
      }),
    );
    expect(hits).toBe(3);
    expect(readControlledReadHttpObservations()).toBeUndefined();
  });
  test('actual full passage joins call/source/hash and records tenant-global null client', async () => {
    const p = policy('20'),
      body = payload(p),
      text = body.records![0]!.text;
    await scope(p, () =>
      withControlledReadInvocation('provider-call', async () => {
        observeControlledReadHttpResponse('get_program_element', 200, body);
        const execution = observeMeriV3CaptureExecution({
          callId: 'provider-call',
          tool: 'get_program_element',
          readOnly: true,
          result: body,
          coverage: [],
          citations: [{ id: id(8), snippet: text, tool: 'get_program_element' } as MeriCitation],
        });
        expect(execution.sources[0]).toMatchObject({
          toolCallId: 'provider-call',
          sourceId: id(8),
          fullRead: { status: 'OBSERVED', value: true },
          clientId: { status: 'OBSERVED', value: null },
          passageSha256: { value: hash(text) },
        });
        expect(() => observeControlledReadHttpResponse('get_program_element', 200, body)).toThrow(
          'duplicate',
        );
      }),
    );
  });
  test.each([
    'captureRunId',
    'requestId',
    'traceId',
    'turnId',
    'tenantId',
    'actorUserId',
    'clientId',
    'conversationId',
    'physicalMapSha256',
  ])('rejects mismatched %s before accepting HTTP evidence', async (key) => {
    const p = policy(),
      body = payload(p);
    (body.controlledRead as any)[key] = 'other';
    await expect(
      scope(p, () =>
        withControlledReadInvocation('call', async () =>
          observeControlledReadHttpResponse('read_client_documents', 200, body),
        ),
      ),
    ).rejects.toThrow('provenance');
  });
  test('rejects absent real call identity, non200 transport, modified full text, and wrong source client', async () => {
    const p = policy('20');
    await expect(
      scope(p, () => withControlledReadInvocation(undefined, async () => null)),
    ).rejects.toThrow('identity');
    await scope(p, () =>
      withControlledReadInvocation('call', async () => {
        expect(() =>
          observeControlledReadHttpResponse('get_program_element', 201, payload(p)),
        ).toThrow('provenance');
        const altered = payload(p);
        altered.records![0]!.text += ' altered';
        expect(() =>
          observeControlledReadHttpResponse('get_program_element', 200, altered),
        ).toThrow('hash');
        const foreign = payload(p);
        foreign.controlledRead.sourceClientId = p.clientId;
        expect(() =>
          observeControlledReadHttpResponse('get_program_element', 200, foreign),
        ).toThrow('source scope');
      }),
    );
  });
  test('ordinary and case01 requests are unchanged and cannot access another request observations', async () => {
    expect(() => observeControlledReadHttpResponse('search_memory', 200, {})).not.toThrow();
    const p = policy('01');
    await scope(p, () =>
      withControlledReadInvocation(undefined, async () => {
        observeControlledReadHttpResponse('search_memory', 200, {});
        expect(readControlledReadHttpObservations()).toBeUndefined();
      }),
    );
  });
});
