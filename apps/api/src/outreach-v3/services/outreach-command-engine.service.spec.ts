import type { TenantContext } from '@capiro/shared';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import type { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import {
  createManualTargetLocator,
  createResolvedTargetRefV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import type { OutreachTargetReferenceService } from '../../capabilities/targets/outreach-target-reference.service.js';
import {
  createManualContextLocator,
  createResolvedContextRefV1,
  type OutreachContextSelectionV1,
} from '../../capabilities/context/outreach-context.contract.js';
import type { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  OutreachEventRow,
  OutreachSessionRow,
  OutreachStateRepository,
  OutreachStateVersionRow,
} from '../persistence/outreach-state.repository.js';
import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { hashNormalizedOutreachCommandBatch } from '../state/outreach-command-normalization.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachCommandEngineService } from './outreach-command-engine.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

const sessionId = '00000000-0000-4000-8000-000000000010';
const clientId = '00000000-0000-4000-8000-000000000030';
const blank = createBlankCampaignSpecV1();
const blankHash = hashCampaignSpecV1(blank);
const manualTargetInput = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Alex Example',
  email: 'alex@example.test',
};
const manualLocator = createManualTargetLocator(manualTargetInput);
const resolvedManualTarget = createResolvedTargetRefV1({
  locator: manualLocator,
  displayName: manualTargetInput.name,
  email: manualTargetInput.email,
  phone: null,
  title: null,
  organization: null,
  clientId: null,
  jurisdiction: {
    governmentLevel: 'unknown',
    chamber: null,
    state: null,
    district: null,
    committees: [],
    issueAreas: [],
  },
  roleStatus: 'unknown',
  emailStatus: 'available',
  profileStatus: 'limited',
  sourceSnapshot: { system: 'user_supplied', version: null, lastVerifiedAt: null },
});

const manualContextInput = {
  id: '00000000-0000-4000-8000-000000000120',
  title: 'Campaign fact supplied by user',
  text: 'Use this as an unverified campaign fact.',
  sourceLabel: 'user',
};
const manualContextLocator = createManualContextLocator(manualContextInput);
const manualContextSelection: OutreachContextSelectionV1 = {
  locator: manualContextLocator,
  contextClass: 'campaign_fact',
  scope: { kind: 'campaign' },
};
const resolvedManualContext = createResolvedContextRefV1({
  ...manualContextSelection,
  title: manualContextInput.title,
  summary: manualContextInput.text,
  clientId: null,
  verificationClass: 'user_supplied',
  sensitivity: 'normal',
  instructionsAllowed: false,
  usableAsEvidence: false,
  usableAsWritingGuidance: false,
  sourceSnapshot: { system: 'user', version: null, lastVerifiedAt: null },
});

const clientMemorySelection: OutreachContextSelectionV1 = {
  locator: {
    source: 'memory_item',
    id: '00000000-0000-4000-8000-000000000121',
    clientId,
  },
  contextClass: 'campaign_fact',
  scope: { kind: 'campaign' },
};
const resolvedClientMemory = createResolvedContextRefV1({
  ...clientMemorySelection,
  title: 'Client fact',
  summary: 'Approved client-specific fact.',
  clientId,
  verificationClass: 'first_party',
  sensitivity: 'confidential',
  instructionsAllowed: false,
  usableAsEvidence: true,
  usableAsWritingGuidance: false,
  sourceSnapshot: {
    system: 'capiro_memory',
    version: 'v1',
    lastVerifiedAt: '2026-08-09T00:00:00.000Z',
  },
});

function session(version = 1): OutreachSessionRow {
  return {
    id: sessionId,
    tenantId: ctx.tenantId,
    createdByUserId: ctx.userId,
    status: 'active',
    currentStateVersion: version,
    title: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    archivedAt: null,
  };
}

function stateVersion(version = 1, specJsonb = blank): OutreachStateVersionRow {
  return {
    id: `00000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
    tenantId: ctx.tenantId,
    sessionId,
    version,
    schemaVersion: 'outreach_campaign_spec_v1',
    specJsonb,
    specHash: hashCampaignSpecV1(specJsonb),
    mutationBatchId: null,
    createdByUserId: ctx.userId,
    createdAt: new Date('2026-08-08T00:00:00Z'),
  };
}

function harness(input?: {
  currentVersion?: number;
  prior?: OutreachEventRow | null;
  authorize?: jest.Mock;
  resolveTargets?: jest.Mock;
  reauthorizeTargets?: jest.Mock;
  resolveContexts?: jest.Mock;
  reauthorizeContexts?: jest.Mock;
  currentSpec?: ReturnType<typeof createBlankCampaignSpecV1>;
}) {
  const tx = {};
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (value: unknown) => unknown) => fn(tx),
    ),
  } as unknown as PrismaService;

  const repositoryMethods = {
    lockOwnedSession: jest.fn(async () => session(input?.currentVersion ?? 1)),
    findBatchResult: jest.fn(async () => input?.prior ?? null),
    loadStateVersion: jest.fn(
      async (_tx: unknown, _ctx: TenantContext, _sessionId: string, version: number) =>
        stateVersion(version, input?.currentSpec ?? blank),
    ),
    insertStateVersion: jest.fn(async () => undefined),
    updateCurrentVersion: jest.fn(async () => undefined),
    appendEvent: jest.fn(async () => ({ id: 'event' })),
    supersedeStaleProposals: jest.fn(async () => 0),
  };
  const repository = repositoryMethods as unknown as OutreachStateRepository;

  const authorizeClientWithinTx =
    input?.authorize ?? jest.fn(async () => ({ id: clientId, name: 'Client' }));
  const authorization = { authorizeClientWithinTx } as unknown as CapabilityAuthorizationService;
  const resolveManyWithinTx =
    input?.resolveTargets ?? jest.fn(async () => [resolvedManualTarget]);
  const reauthorizeSnapshotsWithinTx = input?.reauthorizeTargets ?? jest.fn(async () => undefined);
  const targetReferences = {
    resolveManyWithinTx,
    reauthorizeSnapshotsWithinTx,
  } as unknown as OutreachTargetReferenceService;

  const resolveContextManyWithinTx =
    input?.resolveContexts ?? jest.fn(async () => [resolvedManualContext]);
  const reauthorizeContextSnapshotsWithinTx =
    input?.reauthorizeContexts ?? jest.fn(async () => undefined);
  const contextReferences = {
    resolveManyWithinTx: resolveContextManyWithinTx,
    reauthorizeSnapshotsWithinTx: reauthorizeContextSnapshotsWithinTx,
  } as unknown as OutreachContextReferenceService;

  return {
    service: new OutreachCommandEngineService(
      prisma,
      repository,
      authorization,
      targetReferences,
      contextReferences,
    ),
    tx,
    repository: repositoryMethods,
    authorizeClientWithinTx,
    resolveManyWithinTx,
    reauthorizeSnapshotsWithinTx,
    resolveContextManyWithinTx,
    reauthorizeContextSnapshotsWithinTx,
  };
}

const batch = (input: {
  batchId: string;
  expectedStateVersion?: number;
  commands: unknown[];
}) => ({
  batchId: input.batchId,
  expectedStateVersion: input.expectedStateVersion ?? 1,
  commands: input.commands,
});

describe('OutreachCommandEngineService', () => {
  it('replays a committed batch before evaluating the now-stale expected version', async () => {
    const raw = batch({
      batchId: '00000000-0000-4000-8000-000000000100',
      expectedStateVersion: 1,
      commands: [{ type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'Goal' } }],
    });
    const probe = harness();
    const parsed = probe.service.parseNormalizeAndValidateBatch(raw);
    const prior: OutreachEventRow = {
      id: '00000000-0000-4000-8000-000000000200',
      sequence: 3n,
      eventType: 'command_batch_result',
      actorUserId: ctx.userId,
      source: 'user_control',
      stateVersionBefore: 1,
      stateVersionAfter: 2,
      commandBatchId: parsed.batchId,
      commandType: null,
      payloadHash: hashNormalizedOutreachCommandBatch(parsed),
      safeMetadataJsonb: {
        status: 'applied',
        batchId: parsed.batchId,
        stateVersion: 2,
        specHash: 'a'.repeat(64),
        changed: true,
        commandCount: 1,
        replayed: false,
      },
      createdAt: new Date('2026-08-08T00:02:00Z'),
    };
    const h = harness({ currentVersion: 2, prior });

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).resolves.toMatchObject({ stateVersion: 2, replayed: true });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });

  it('rejects reuse of a batch id with a different normalized payload', async () => {
    const raw = batch({
      batchId: '00000000-0000-4000-8000-000000000101',
      commands: [{ type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'Goal' } }],
    });
    const probe = harness();
    const parsed = probe.service.parseNormalizeAndValidateBatch(raw);
    const prior = {
      ...({} as OutreachEventRow),
      payloadHash: 'b'.repeat(64),
      safeMetadataJsonb: {},
    } as OutreachEventRow;
    const h = harness({ prior });

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE', httpStatus: 409 });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
  });

  it('records an idempotent no-op result without creating a new state version', async () => {
    const h = harness();
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000102',
        commands: [{ type: 'SET_GOAL', schemaVersion: 1, payload: { value: null } }],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).resolves.toMatchObject({ status: 'no_change', stateVersion: 1, changed: false });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.updateCurrentVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).toHaveBeenCalledTimes(1);
  });

  it('creates a new immutable version for restore even when the restored hash equals current', async () => {
    const h = harness();
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000103',
        commands: [{ type: 'RESTORE_STATE_VERSION', schemaVersion: 1, payload: { version: 1 } }],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).resolves.toMatchObject({ status: 'applied', stateVersion: 2, changed: true });
    expect(h.reauthorizeSnapshotsWithinTx).toHaveBeenCalledWith(h.tx, ctx, []);
    expect(h.reauthorizeContextSnapshotsWithinTx).toHaveBeenCalledWith(h.tx, ctx, []);
    expect(h.repository.insertStateVersion).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ version: 2, specHash: blankHash }),
    );
  });

  it('fails a multi-client sponsor command atomically when any client is unauthorized', async () => {
    const authorize = jest
      .fn()
      .mockResolvedValueOnce({ id: 'client-a' })
      .mockRejectedValueOnce(new CapabilityError('CAPABILITY_ETHICAL_WALL', 'restricted client'));
    const h = harness({ authorize });
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000104',
        commands: [
          {
            type: 'SET_SPONSOR_SCOPE',
            schemaVersion: 1,
            payload: {
              kind: 'multi_client',
              label: null,
              clientRefs: [
                { clientId: '00000000-0000-4000-8000-000000000030' },
                { clientId: '00000000-0000-4000-8000-000000000031' },
              ],
            },
          },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED', httpStatus: 403 });
    expect(h.authorizeClientWithinTx).toHaveBeenCalledTimes(2);
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });

  it('resolves ADD_TARGET_REFS server-side before the pure reducer persists a snapshot', async () => {
    const h = harness();
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000106',
        commands: [
          { type: 'ADD_TARGET_REFS', schemaVersion: 1, payload: { refs: [manualLocator] } },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).resolves.toMatchObject({ status: 'applied', stateVersion: 2, changed: true });
    expect(h.resolveManyWithinTx).toHaveBeenCalledWith(h.tx, ctx, [manualLocator]);
    expect(h.repository.insertStateVersion).toHaveBeenCalledWith(
      h.tx,
      ctx,
      expect.objectContaining({
        specJsonb: expect.objectContaining({
          targeting: expect.objectContaining({ selectedTargetRefs: [resolvedManualTarget] }),
        }),
      }),
    );
  });

  it('fails target addition before persistence when resolution is not authorized', async () => {
    const resolveTargets = jest.fn().mockRejectedValue(
      new CapabilityError('CAPABILITY_NOT_FOUND', 'secret target id'),
    );
    const h = harness({ resolveTargets });
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000107',
        commands: [
          { type: 'ADD_TARGET_REFS', schemaVersion: 1, payload: { refs: [manualLocator] } },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED', httpStatus: 403 });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });

  it('resolves ACCEPT_CONTEXT_REFS server-side before persisting the governed snapshot', async () => {
    const h = harness();
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000108',
        commands: [
          {
            type: 'ACCEPT_CONTEXT_REFS',
            schemaVersion: 1,
            payload: { selections: [manualContextSelection] },
          },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).resolves.toMatchObject({ status: 'applied', stateVersion: 2, changed: true });
    expect(h.resolveContextManyWithinTx).toHaveBeenCalledWith(
      h.tx,
      ctx,
      [manualContextSelection],
    );
    expect(h.repository.insertStateVersion).toHaveBeenCalledWith(
      h.tx,
      ctx,
      expect.objectContaining({
        specJsonb: expect.objectContaining({
          context: expect.objectContaining({ campaignFactRefs: [resolvedManualContext] }),
        }),
      }),
    );
  });

  it('fails context acceptance before persistence when resolution is not authorized', async () => {
    const resolveContexts = jest.fn().mockRejectedValue(
      new CapabilityError('CAPABILITY_ETHICAL_WALL', 'secret context id'),
    );
    const h = harness({ resolveContexts });
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000109',
        commands: [
          {
            type: 'ACCEPT_CONTEXT_REFS',
            schemaVersion: 1,
            payload: { selections: [manualContextSelection] },
          },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED', httpStatus: 403 });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });

  it('blocks changing away from a sole sponsor while client-specific context is accepted', async () => {
    const currentSpec = {
      ...createBlankCampaignSpecV1(),
      sponsor: { kind: 'client' as const, label: null, clientRefs: [{ clientId }] },
      context: {
        ...createBlankCampaignSpecV1().context,
        campaignFactRefs: [resolvedClientMemory],
      },
    };
    const h = harness({ currentSpec });
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000110',
        commands: [
          {
            type: 'SET_SPONSOR_SCOPE',
            schemaVersion: 1,
            payload: { kind: 'firm', label: null, clientRefs: [] },
          },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_BLOCKED', httpStatus: 422 });
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });

  it('rolls back a multi-command reduction when a later command violates a cross-field rule', async () => {
    const h = harness();
    const parsed = h.service.parseNormalizeAndValidateBatch(
      batch({
        batchId: '00000000-0000-4000-8000-000000000105',
        commands: [
          { type: 'SET_DELIVERY_PATTERN', schemaVersion: 1, payload: { value: 'shared_thread' } },
          { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'high' } },
        ],
      }),
    );

    await expect(
      h.service.applyBatchWithinTx(h.tx as never, ctx, sessionId, parsed),
    ).rejects.toBeInstanceOf(OutreachCommandError);
    expect(h.repository.insertStateVersion).not.toHaveBeenCalled();
    expect(h.repository.updateCurrentVersion).not.toHaveBeenCalled();
    expect(h.repository.appendEvent).not.toHaveBeenCalled();
  });
});
