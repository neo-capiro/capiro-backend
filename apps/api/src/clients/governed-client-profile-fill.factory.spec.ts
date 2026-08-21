import type { TenantContext } from '@capiro/shared';
import { createGovernedClientProfileFillService } from './governed-client-profile-fill.factory.js';
import type { ClientProfileFillGovernedContext } from './client-profile-fill-context-plane.service.js';
import type { ClientProfileFillService } from './client-profile-fill.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const clientId = '33333333-3333-4333-8333-333333333333';

function bundle(): ClientProfileFillGovernedContext {
  return {
    kind: 'governed_packet',
    packet: { version: 2 } as never,
    packetId: 'packet-1',
    traceHash: 'trace-1',
    canonicalClient: {
      id: clientId,
      name: 'Acme Corp',
      website: 'https://acme.example',
      description: null,
      productDescription: null,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      uei: null,
      cageCode: null,
      naicsCodes: [],
      pscCodes: [],
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    },
    coverage: {
      complete: true,
      requestedDomains: ['clients', 'contacts'],
      searchedDomains: ['clients', 'contacts'],
      missingDomains: [],
      partialDomains: [],
      recordsReturned: 1,
      paginationComplete: true,
      truncated: false,
      stopReason: 'complete',
    },
    records: [
      {
        domain: 'contacts',
        recordId: 'contact-1',
        payload: {
          clientId,
          fullName: 'Jamie Contact',
          email: 'jamie@acme.example',
          title: 'VP Government Affairs',
          organization: 'Acme Corp',
          source: 'mail_sync',
        },
        provenance: { source: 'engagement_contacts' },
      } as never,
    ],
    modelContextBlock:
      '<capiro_crm_context_plane>\nCANONICAL CRM IDENTITY\nPRIVATE CONTEXT, not evidence\n</capiro_crm_context_plane>',
  };
}

/**
 * Explicit `this` shape for the legacy-seam fakes below. A concrete interface
 * (rather than an index signature) keeps these calls type-safe under
 * noUncheckedIndexedAccess, which reports indexed access as possibly undefined.
 */
interface RawFillSeams {
  executeRun: (...args: unknown[]) => Promise<unknown>;
  executeCapabilityDocumentRun: (...args: unknown[]) => Promise<unknown>;
  gatherSyncedEmail: (...args: unknown[]) => Promise<unknown>;
  callOpenAiJson: (...args: unknown[]) => Promise<unknown>;
  callAnthropicJson: (...args: unknown[]) => Promise<unknown>;
}

function fakeRaw() {
  const events: string[] = [];
  const prompts: string[] = [];
  const addFinding = jest.fn().mockResolvedValue(true);
  const raw = {
    startRun: jest.fn(async function (
      this: RawFillSeams,
      value: TenantContext,
      id: string,
      sources?: string[],
      attachmentId?: string,
    ) {
      events.push('raw-start');
      if (attachmentId) {
        await this.executeCapabilityDocumentRun(value, id, 'run-1', attachmentId);
      } else {
        await this.executeRun(value, id, 'run-1', sources ?? ['synced_email']);
      }
      return { id: 'run-1', clientId: id };
    }),
    executeRun: async function (
      this: RawFillSeams,
      value: TenantContext,
      id: string,
      runId: string,
    ) {
      events.push('raw-execute');
      await this.gatherSyncedEmail(value, id, runId);
      await this.callOpenAiJson('key', 'model', 'SYSTEM', 'PUBLIC EVIDENCE', {});
    },
    executeCapabilityDocumentRun: async function (
      this: RawFillSeams,
    ) {
      events.push('raw-document-execute');
      await this.callAnthropicJson('key', 'model', 'SYSTEM', 'UNTRUSTED DOCUMENT', {});
    },
    gatherSyncedEmail: async () => {
      throw new Error('legacy direct contact lookup must be replaced');
    },
    addFinding,
    callOpenAiJson: async (
      _apiKey: string,
      _model: string,
      system: string,
      prompt: string,
    ) => {
      prompts.push(`${system}\n${prompt}`);
      return '{}';
    },
    callAnthropicJson: async (
      _apiKey: string,
      _model: string,
      system: string,
      prompt: string,
    ) => {
      prompts.push(`${system}\n${prompt}`);
      return '{}';
    },
  };
  return { raw, events, prompts, addFinding };
}

describe('Phase 23 governed ClientProfileFillService wrapper', () => {
  test('one governed bundle is resolved before run execution and reused by contact + model seams', async () => {
    const f = fakeRaw();
    const contextPlane = {
      resolve: jest.fn().mockImplementation(async () => {
        f.events.push('context-resolved');
        return bundle();
      }),
      recordRunContext: jest.fn().mockImplementation(async () => {
        f.events.push('context-recorded');
      }),
      failRun: jest.fn(),
    };
    const people = { listPeople: jest.fn().mockResolvedValue([]) };
    const service = createGovernedClientProfileFillService(
      f.raw as unknown as ClientProfileFillService,
      contextPlane as never,
      people as never,
    );

    await service.startRun(ctx, clientId, ['synced_email']);

    expect(contextPlane.resolve).toHaveBeenCalledTimes(1);
    expect(contextPlane.resolve).toHaveBeenCalledWith(ctx, {
      clientId,
      requestedSources: ['synced_email'],
      attachmentId: null,
    });
    expect(f.events.indexOf('context-resolved')).toBeLessThan(f.events.indexOf('raw-start'));
    expect(f.events.indexOf('context-recorded')).toBeLessThan(f.events.indexOf('raw-execute'));
    expect(f.addFinding).toHaveBeenCalledWith(
      'tenant-1',
      clientId,
      'run-1',
      expect.objectContaining({
        kind: 'person',
        source: 'synced_email',
        confidence: 0.97,
        proposedValue: expect.objectContaining({
          name: 'Jamie Contact',
          email: 'jamie@acme.example',
        }),
      }),
    );
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('<capiro_crm_context_plane>');
    expect(f.prompts[0]).toContain('It is not evidence');
    expect(f.prompts[0]).toContain('PUBLIC EVIDENCE');
  });

  test('capability-document extraction receives the same governed non-evidentiary context', async () => {
    const f = fakeRaw();
    const contextPlane = {
      resolve: jest.fn().mockResolvedValue(bundle()),
      recordRunContext: jest.fn(),
      failRun: jest.fn(),
    };
    const service = createGovernedClientProfileFillService(
      f.raw as unknown as ClientProfileFillService,
      contextPlane as never,
      { listPeople: jest.fn().mockResolvedValue([]) } as never,
    );

    await service.startRun(ctx, clientId, undefined, 'attachment-1');

    expect(contextPlane.recordRunContext).toHaveBeenCalledTimes(1);
    expect(f.prompts[0]).toContain('<capiro_crm_context_plane>');
    expect(f.prompts[0]).toContain('UNTRUSTED DOCUMENT');
  });

  test('Context Plane failure blocks the durable raw run and provider work', async () => {
    const f = fakeRaw();
    const contextPlane = {
      resolve: jest.fn().mockRejectedValue(new Error('context_plane_unavailable')),
      recordRunContext: jest.fn(),
      failRun: jest.fn(),
    };
    const service = createGovernedClientProfileFillService(
      f.raw as unknown as ClientProfileFillService,
      contextPlane as never,
      { listPeople: jest.fn().mockResolvedValue([]) } as never,
    );

    await expect(service.startRun(ctx, clientId, ['public_web'])).rejects.toThrow(
      'context_plane_unavailable',
    );
    expect(f.events).not.toContain('raw-start');
    expect(f.prompts).toHaveLength(0);
  });

  test('invalid document-plus-source request is rejected before packet persistence', async () => {
    const f = fakeRaw();
    const contextPlane = {
      resolve: jest.fn().mockResolvedValue(bundle()),
      recordRunContext: jest.fn(),
      failRun: jest.fn(),
    };
    const service = createGovernedClientProfileFillService(
      f.raw as unknown as ClientProfileFillService,
      contextPlane as never,
      { listPeople: jest.fn().mockResolvedValue([]) } as never,
    );

    await expect(
      service.startRun(ctx, clientId, ['public_web'], 'attachment-1'),
    ).rejects.toMatchObject({ status: 400 });
    expect(contextPlane.resolve).not.toHaveBeenCalled();
    expect(f.events).not.toContain('raw-start');
  });

  test('existing CRM people are never resurrected as automatic proposals', async () => {
    const f = fakeRaw();
    const contextPlane = {
      resolve: jest.fn().mockResolvedValue(bundle()),
      recordRunContext: jest.fn(),
      failRun: jest.fn(),
    };
    const service = createGovernedClientProfileFillService(
      f.raw as unknown as ClientProfileFillService,
      contextPlane as never,
      {
        listPeople: jest.fn().mockResolvedValue([
          { name: 'Jamie Contact', email: 'jamie@acme.example' },
        ]),
      } as never,
    );

    await service.startRun(ctx, clientId, ['synced_email']);
    expect(f.addFinding).not.toHaveBeenCalled();
  });
});
