import { governProfileExtraction } from './profile-extraction-context.js';
import type { TenantContext } from '@capiro/shared';
import { createGovernedClientProfileFillService, runWithGovernedCrmFillBundle } from './governed-client-profile-fill.factory.js';
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

function fixture(existingPeople: Array<{name: string; email: string}> = []) {
  const addFinding = jest.fn().mockResolvedValue(true);
  const raw = {gatherSyncedEmail: async (_ctx: TenantContext, _clientId: string, _runId: string) => 0, addFinding};
  createGovernedClientProfileFillService(raw as unknown as ClientProfileFillService,
    {listPeople: jest.fn().mockResolvedValue(existingPeople)} as never);
  return {raw, addFinding};
}

describe('governed portfolio source adapter', () => {
  test('the worker bundle supplies explicitly linked contact proposals and provenance', async () => {
    const f = fixture();
    await runWithGovernedCrmFillBundle(bundle(), () => f.raw.gatherSyncedEmail(ctx, clientId, 'run-1'));
    expect(f.addFinding).toHaveBeenCalledTimes(1);
    expect(f.addFinding).toHaveBeenCalledWith('tenant-1', clientId, 'run-1', expect.objectContaining({
      kind: 'person', source: 'synced_email',
      proposedValue: expect.objectContaining({name: 'Jamie Contact', email: 'jamie@acme.example'}),
      evidence: [expect.objectContaining({metadata: expect.objectContaining({packetId: 'packet-1', association: 'explicit_client_link'})})],
    }));
  });
  test('missing governed context refuses source work before any finding is written', async () => {
    const f = fixture();
    await expect(f.raw.gatherSyncedEmail(ctx, clientId, 'run-1')).rejects.toThrow('phase23_crm_context_plane_bundle_required');
    expect(f.addFinding).not.toHaveBeenCalled();
  });
  test('a different client cannot consume another profile bundle', async () => {
    const f = fixture();
    await expect(runWithGovernedCrmFillBundle(bundle(), () => f.raw.gatherSyncedEmail(ctx, 'other-client', 'run-1')))
      .rejects.toThrow('phase23_crm_context_plane_client_mismatch');
    expect(f.addFinding).not.toHaveBeenCalled();
  });
  test('existing people are not resurrected as proposals', async () => {
    const f = fixture([{name: 'Jamie Contact', email: 'jamie@acme.example'}]);
    await runWithGovernedCrmFillBundle(bundle(), () => f.raw.gatherSyncedEmail(ctx, clientId, 'run-1'));
    expect(f.addFinding).not.toHaveBeenCalled();
  });
  test('governed private context remains separate from untrusted source evidence', async () => {
    const governed = await runWithGovernedCrmFillBundle(bundle(), async () =>
      governProfileExtraction({kind: 'client', id: clientId}, 'SYSTEM', 'UNTRUSTED DOCUMENT'));
    expect(governed.instructions).toContain('It is not evidence');
    expect(governed.prompt).toContain('UNTRUSTED DOCUMENT');
    expect(governed.prompt).toContain('<capiro_crm_context_plane>');
  });
});
