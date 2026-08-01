import type { Request } from 'express';
import type { MeriContext } from '@capiro/meriv2-core';
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
const REQUEST = { headers: {} } as Request;
const CONTEXT = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as MeriContext;

function input(kind: 'workspace_draft' | 'outreach_record'): StrategyDocumentDraftInput {
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
  } as StrategyDocumentDraftInput;
}

describe('StrategyController document assurance scope', () => {
  function build() {
    const resolve = jest.fn().mockResolvedValue(CONTEXT);
    const draftDocument = jest.fn(async (_ctx: MeriContext, dto: StrategyDocumentDraftInput) => {
      const selectedSurface = dto.kind === 'outreach_record' ? 'outreach' : 'strategy';
      return {
        armed: assuranceReleaseArmedFor(
          selectedSurface,
          // The inherited service call still passes strategy; request scope must
          // carry the actual surface without widening the canary.
          'strategy',
          'enforce',
          'tenant-a',
        ),
      };
    });
    const controller = new StrategyController(
      { resolve } as unknown as MeriContextResolver,
      { draftDocument } as unknown as StrategyAssistantService,
    );
    return { controller, resolve, draftDocument };
  }

  it('uses the outreach Context Packet and outreach release canary for outreach artifacts', async () => {
    const { controller, resolve } = build();
    await expect(
      controller.documentDraft(input('outreach_record'), TENANT, REQUEST),
    ).resolves.toEqual({
      armed: true,
    });
    expect(resolve).toHaveBeenCalledWith(TENANT, 'client-a', 'outreach');
  });

  it('uses the strategy Context Packet and strategy release canary for Workspace artifacts', async () => {
    const { controller, resolve } = build();
    await expect(
      controller.documentDraft(input('workspace_draft'), TENANT, REQUEST),
    ).resolves.toEqual({
      armed: true,
    });
    expect(resolve).toHaveBeenCalledWith(TENANT, 'client-a', 'strategy');
  });

  it('rejects an unknown artifact kind before compiling context or calling the model', async () => {
    const { controller, resolve, draftDocument } = build();
    const invalid = {
      ...input('workspace_draft'),
      kind: 'unknown_artifact',
    } as unknown as StrategyDocumentDraftInput;
    await expect(controller.documentDraft(invalid, TENANT, REQUEST)).rejects.toThrow(
      'Unsupported strategy document artifact kind',
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(draftDocument).not.toHaveBeenCalled();
  });
});
