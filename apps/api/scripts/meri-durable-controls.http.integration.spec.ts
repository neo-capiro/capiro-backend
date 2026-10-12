import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../src/auth/roles.guard.js';
import { ClientKbService } from '../src/embeddings/client-kb.service.js';
import { admitDurableResearchCoordinator } from '../src/meri/meri-research-coordinator.js';
import { MeriResearchService } from '../src/meri/meri-research.service.js';
import { admitResearchToolBudget } from '../src/meri/meri-research-tool-budget.js';
import type { ResearchPlanV1 } from '../src/meri/meri-research-plan.js';
import type { ResearchRunState } from '../src/meri/meri-research-run-state.js';
import { MeriApprovalService } from '../src/meri/meri-approval.service.js';
import { MeriClaimWriterService } from '../src/meri/meri-claim-writer.js';
import { MeriComplianceAuditService } from '../src/meri/meri-compliance-audit.service.js';
import { MeriController } from '../src/meri/meri.controller.js';
import { MeriFirmSkillsService } from '../src/meri/meri-firm-skills.service.js';
import { MeriMcpOAuthService } from '../src/meri/meri-mcp-oauth.service.js';
import { MeriMcpService } from '../src/meri/meri-mcp.service.js';
import { MeriProcedureRuntimeValidationService } from '../src/meri/meri-procedure-runtime-validation.service.js';
import { MeriService } from '../src/meri/meri.service.js';
import { MeriToolsService } from '../src/meri/meri-tools.service.js';
import {
  cancelMeriDurableResearch,
  fetchMeriDurableResearchSnapshot,
  steerMeriDurableResearch,
} from './lib/meri-durable-research-contract-client.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'tenant',
  userId: 'user-1',
  clerkUserId: 'clerk-user-1',
  role: 'standard_user',
};

const plan: ResearchPlanV1 = {
  version: 1,
  title: 'HTTP integration contract',
  scope: {
    sessionId: 'session-1',
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    clientId: null,
    conversationId: null,
  },
  budget: { toolCalls: 2, tokens: 4_000 },
  steps: [
    {
      id: 'read-current-record',
      objective: 'Read the current canonical record.',
      dependsOn: [],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'A qualified owner receipt is saved.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
    {
      id: 'read-current-status',
      objective: 'Read status after the record.',
      dependsOn: ['read-current-record'],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'A qualified status receipt is saved.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
  ],
  clarifyingQuestions: [],
};

function serviceFixture() {
  const now = new Date().toISOString();
  const run: ResearchRunState = {
    id: 'run-1',
    leaseEpoch: 1,
    eventSequence: 0,
    phase: 'research',
    status: 'running',
    stage: 'Gathering evidence',
    startedAt: now,
    heartbeatAt: now,
  };
  const budgeted = admitResearchToolBudget({ run, retainedProviderReviewField: { kept: true } }, 2);
  const admitted = admitDurableResearchCoordinator({
    metadata: budgeted.metadata,
    plan,
    objective: 'Assess the current status',
    run,
    now: new Date(now),
  });
  const coordinator = admitted.metadata.durableCoordinator as Record<string, any>;
  coordinator.steps[0] = {
    ...coordinator.steps[0],
    outcome: 'completed',
    sourceRefs: ['receipt:accepted-source'],
    operationRefs: ['owner:accepted-read', 'fingerprint:private-value'],
    completedAt: now,
  };

  let session: Record<string, any> = {
    id: 'session-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    topic: 'Assess the current status',
    title: plan.title,
    status: 'researching',
    plan: plan.steps.map((step) => step.objective),
    clarifyingQuestions: [],
    clarifyingAnswers: {},
    reportArtifactId: null,
    sources: null,
    metadata: admitted.metadata,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  const tx: any = {
    clioResearchSession: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === session.id &&
        where.tenantId === session.tenantId &&
        where.userId === session.userId
          ? structuredClone(session)
          : null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          where.id !== session.id ||
          where.tenantId !== session.tenantId ||
          where.userId !== session.userId ||
          JSON.stringify(where.metadata?.equals) !== JSON.stringify(session.metadata)
        )
          return { count: 0 };
        session = { ...session, ...structuredClone(data) };
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (db: typeof tx) => unknown) =>
      callback(tx),
    ),
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, callback: (db: typeof tx) => unknown) =>
        callback(tx),
    ),
  };
  const service = new MeriResearchService(
    prisma as never,
    { get: jest.fn() } as never,
    {
      anthropicToolSchemas: jest.fn(() => []),
      isConcurrencySafe: jest.fn(() => true),
      isSideEffecting: jest.fn(() => false),
    } as never,
    {} as never,
    {} as never,
  );
  return { service, getSession: () => session };
}

describe('durable controls web adapter to actual coordinator HTTP controller/service', () => {
  let app: INestApplication;
  let baseUrl: string;
  let fixture: ReturnType<typeof serviceFixture>;
  const headers = {
    Authorization: 'Bearer current-token',
    'Content-Type': 'application/json',
    'x-capiro-impersonate-tenant': 'current-scope',
  };

  beforeAll(async () => {
    fixture = serviceFixture();
    const moduleRef = await Test.createTestingModule({
      controllers: [MeriController],
      providers: [
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: MeriResearchService, useValue: fixture.service },
        { provide: MeriService, useValue: {} },
        { provide: MeriToolsService, useValue: {} },
        { provide: ClientKbService, useValue: {} },
        { provide: MeriMcpService, useValue: {} },
        { provide: MeriMcpOAuthService, useValue: {} },
        { provide: MeriFirmSkillsService, useValue: {} },
        { provide: MeriProcedureRuntimeValidationService, useValue: {} },
        { provide: MeriApprovalService, useValue: {} },
        { provide: MeriComplianceAuditService, useValue: {} },
        { provide: MeriClaimWriterService, useValue: {} },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (execution: {
          switchToHttp: () => { getRequest: () => { headers: Record<string, string> } };
        }) =>
          execution.switchToHttp().getRequest().headers.authorization === 'Bearer current-token',
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('round-trips snapshot, /steer conflict, retained effects, cursor, and two-stage Stop', async () => {
    const initial = await fetchMeriDurableResearchSnapshot({
      apiBaseUrl: baseUrl,
      researchId: 'session-1',
      afterSequence: 0,
      headers,
    });
    expect(initial.run).toMatchObject({ id: 'run-1', status: 'running', leaseEpoch: 1 });
    expect(initial.coordinator.steps[0]).toMatchObject({
      outcome: 'completed',
      sourceRefs: ['receipt:accepted-source'],
      operationRefs: ['owner:accepted-read'],
    });

    const accepted = await steerMeriDurableResearch({
      apiBaseUrl: baseUrl,
      researchId: 'session-1',
      headers,
      requestId: 'web-steer-house-only',
      expectedGoalRevision: 0,
      message: 'Use the House version only.',
    });
    expect(accepted).toMatchObject({
      version: 1,
      accepted: true,
      idempotentReplay: false,
      receipt: {
        version: 1,
        previousGoalRevision: 0,
        goalRevision: 1,
        state: 'pending_safe_boundary',
        appliedAt: null,
      },
    });

    await expect(
      steerMeriDurableResearch({
        apiBaseUrl: baseUrl,
        researchId: 'session-1',
        headers,
        requestId: 'web-steer-stale',
        expectedGoalRevision: 0,
        message: 'Use the Senate version.',
      }),
    ).rejects.toMatchObject({ status: 409 });

    const revised = await fetchMeriDurableResearchSnapshot({
      apiBaseUrl: baseUrl,
      researchId: 'session-1',
      afterSequence: initial.nextSequence,
      headers,
    });
    expect(revised.run).toMatchObject({
      id: 'run-1',
      status: 'interrupted',
      readyToStart: true,
    });
    expect(revised.coordinator.goalRevision).toBe(1);
    expect(revised.events.every((event) => event.sequence > initial.nextSequence)).toBe(true);
    expect(revised.coordinator.steps[0]?.sourceRefs).toEqual(['receipt:accepted-source']);
    expect(fixture.getSession().metadata.retainedProviderReviewField).toEqual({ kept: true });

    const requested = await cancelMeriDurableResearch({
      apiBaseUrl: baseUrl,
      researchId: 'session-1',
      headers,
      requestId: 'web-stop-1',
    });
    expect(requested.run).toMatchObject({ status: 'cancel_requested' });

    const observed = await fetchMeriDurableResearchSnapshot({
      apiBaseUrl: baseUrl,
      researchId: 'session-1',
      afterSequence: revised.nextSequence,
      headers,
    });
    expect(observed.run).toMatchObject({ status: 'cancelled' });
    expect(observed.coordinator.cancellation).toMatchObject({
      state: 'observed',
      requestId: 'web-stop-1',
    });
    expect(observed.coordinator.steps[0]?.sourceRefs).toEqual(['receipt:accepted-source']);
  });
});
