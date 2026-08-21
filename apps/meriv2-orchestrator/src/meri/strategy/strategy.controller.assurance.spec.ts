import type { Request } from 'express';
import type {
  MeriContext,
  MeriGovernedTurnContext,
} from '@capiro/meriv2-core';
import { assuranceReleaseArmedFor } from '@capiro/meriv2-core';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import type { MeriContextResolver } from '../meri-context.resolver.js';
import type { StrategyAssistantService } from './strategy-assistant.service.js';
import { StrategyController } from './strategy.controller.js';
import type { StrategyDocumentDraftInput } from './strategy-prompt.js';

const TENANT: OrchestratorTenantContext = {
  tenantId: 'tenant-a',
  clerkUserId: 'clerk-a',
  role: 'org:member',
};
const REQUEST = {
  headers: { 'x-internal-service-secret': 'phase26-secret' },
} as unknown as Request;
const CONTEXT = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as MeriContext;

function governed(
  kind: 'workspace_draft' | 'outreach_record',
): MeriGovernedTurnContext {
  const operationId = kind === 'workspace_draft' ? 'workspace.generate' : 'outreach.generate';
  return {
    version: 1,
    operationId,
    prompt: 'governed destination context',
    contextPacket: {
      packetId: 'packet-a',
      persisted: true,
      surface: kind === 'workspace_draft' ? 'workspace-gen' : 'outreach',
      clientId: 'client-a',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: ['clients'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients'],
        searchedDomains: ['clients'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  };
}

function input(kind: 'workspace_draft' | 'outreach_record') {
  return {
    kind,
    clientId: 'client-a',
    type: 'appropriations',
    goal: 'Protect the request.',
    node: {
      id: 'node-a',
      kind: 'action',
      subject: 'deliverable',
      title: 'Draft the client artifact',
      note: null,
      startsOn: '2027-01-01',
      endsOn: null,
    },
    fiscal: {
      today: '2026-08-01',
      fys: [2026, 2027, 2028],
      fyLabels: ['FY26', 'FY27', 'FY28'],
      focalFy: 'FY27',
    },
    firmPhases: [],
    reference: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [] },
    stewardFacts: [],
    stewardHealth: { status: 'ok', missingRequired: [], openMaterialConflicts: [] },
    attachments: [],
    governedContext: governed(kind),
  } as StrategyDocumentDraftInput & { governedContext: MeriGovernedTurnContext };
}

describe('StrategyController governed document assurance scope', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'phase26-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  function build() {
    const resolveIdentity = jest.fn().mockResolvedValue({ ...CONTEXT });
    const draftDocument = jest.fn(async (_ctx: MeriContext, dto: StrategyDocumentDraftInput) => {
      const selectedSurface = dto.kind === 'outreach_record' ? 'outreach' : 'strategy';
      return {
        armed: assuranceReleaseArmedFor(
          selectedSurface,
          'strategy',
          'enforce',
          'tenant-a',
        ),
      };
    });
    const controller = new StrategyController(
      { resolveIdentity } as unknown as MeriContextResolver,
      { draftDocument } as unknown as StrategyAssistantService,
    );
    return { controller, resolveIdentity, draftDocument };
  }

  it('requires an Outreach packet and outreach release canary for outreach artifacts', async () => {
    const { controller, resolveIdentity } = build();
    await expect(
      controller.documentDraft(input('outreach_record'), TENANT, REQUEST),
    ).resolves.toEqual({ armed: true });
    expect(resolveIdentity).toHaveBeenCalledWith(TENANT);
  });

  it('requires a Workspace packet while retaining the Strategy release canary for Workspace artifacts', async () => {
    const { controller, resolveIdentity } = build();
    await expect(
      controller.documentDraft(input('workspace_draft'), TENANT, REQUEST),
    ).resolves.toEqual({ armed: true });
    expect(resolveIdentity).toHaveBeenCalledWith(TENANT);
  });

  it('rejects packet relabeling before the model', async () => {
    const { controller, draftDocument } = build();
    const invalid = input('outreach_record');
    invalid.governedContext = {
      ...invalid.governedContext,
      operationId: 'strategies.generate',
      contextPacket: { ...invalid.governedContext.contextPacket, surface: 'strategy' },
    };
    await expect(controller.documentDraft(invalid, TENANT, REQUEST)).rejects.toThrow(
      'Strategy reasoning requires matching governed Context Plane input',
    );
    expect(draftDocument).not.toHaveBeenCalled();
  });

  it('rejects an unknown artifact kind before resolving identity or calling the model', async () => {
    const { controller, resolveIdentity, draftDocument } = build();
    const invalid = {
      ...input('workspace_draft'),
      kind: 'unknown_artifact',
    } as unknown as StrategyDocumentDraftInput & { governedContext: MeriGovernedTurnContext };
    await expect(controller.documentDraft(invalid, TENANT, REQUEST)).rejects.toThrow(
      'Unsupported strategy document artifact kind',
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(draftDocument).not.toHaveBeenCalled();
  });
});
