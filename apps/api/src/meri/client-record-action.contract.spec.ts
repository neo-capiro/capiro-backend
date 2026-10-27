import {
  assertClientRecordAccess,
  clientRecordReceipt,
  clientRecordRequest,
  CLIENT_RECORD_SCOPE_KEY,
  type ClientRecordAccess,
} from './client-record-action.contract.js';
const id = '11111111-1111-4111-8111-111111111111';
const scope = {
  conversationId: id,
  selectedClientId: null,
  identityRevision: 'a'.repeat(64),
  membershipRevision: 'b'.repeat(64),
  contextRevision: 'c'.repeat(64),
};
const access = (): ClientRecordAccess => ({
  scope: { ...scope },
  mode: 'execute',
  clientIds: [id],
  assertCurrent: jest.fn(async () => {}),
});
const profile = { clientId: id, description: 'Exact approved text', issueCodes: [] };
const result = {
  tool: 'update_client_profile',
  updated: true,
  clientId: id,
  clientName: 'Sample',
  fieldsWritten: ['description', 'issueCodes'],
  facilitiesCreated: [],
  capabilitiesCreated: [],
  peopleCreated: ['Person'],
  peopleUpdated: [],
  skipped: [],
  rowErrors: ['facility failed'],
};
describe('client record action contract', () => {
  it('preserves unconditional patch fields and an intentional empty replacement list', () => {
    expect(clientRecordRequest('update_client_profile', profile).input).toEqual(profile);
    expect(() =>
      clientRecordRequest('update_client_profile', { ...profile, expectedVersion: 2 }),
    ).toThrow();
    expect(() => clientRecordRequest('create_client', { name: 'Sample', tenantId: id })).toThrow();
    expect(() =>
      clientRecordRequest('update_client_profile', { clientId: id, people: [] }),
    ).toThrow();
  });
  it('preserves canonical partial, unchanged and failed-row outcomes without asserting atomic success', () => {
    expect(clientRecordReceipt('update_client_profile', result, profile).outcome).toBe(
      'partially_updated',
    );
    const input = { clientId: id, people: [{ name: 'Person' }] };
    const empty = {
      ...result,
      fieldsWritten: [],
      peopleCreated: [],
      rowErrors: [],
      skipped: ['already present'],
    };
    expect(clientRecordReceipt('update_client_profile', empty, input).outcome).toBe('unchanged');
    expect(
      clientRecordReceipt('update_client_profile', { ...empty, rowErrors: ['failed'] }, input)
        .outcome,
    ).toBe('not_updated');
  });
  it('requires exact created identity and confirmed LDA selection, not prose success', () => {
    const input = { name: 'Sample', ldaClientId: 7 };
    const receipt = {
      created: true,
      client: { id, name: 'Sample', website: null },
      ldaMatch: { ldaClientId: 7, name: 'Registry', totalFilings: 1, latestFilingYear: null },
    };
    expect(clientRecordReceipt('create_client', receipt, input).outcome).toBe('created');
    expect(() =>
      clientRecordReceipt('create_client', { ...receipt, ldaMatch: null }, input),
    ).toThrow();
    expect(() => clientRecordReceipt('create_client', { created: true }, input)).toThrow();
  });
  it('rejects wrong target or omitted written fields in a profile receipt', () => {
    expect(() =>
      clientRecordReceipt(
        'update_client_profile',
        { ...result, clientId: '22222222-2222-4222-8222-222222222222' },
        profile,
      ),
    ).toThrow();
    expect(() =>
      clientRecordReceipt(
        'update_client_profile',
        { ...result, fieldsWritten: ['description'] },
        profile,
      ),
    ).toThrow();
  });
  it('allows a terminal read after the own-write membership revision changes, never an old decision', async () => {
    const fresh = access();
    fresh.scope.membershipRevision = 'd'.repeat(64);
    fresh.mode = 'observe';
    const stored = { [CLIENT_RECORD_SCOPE_KEY]: scope };
    await expect(
      assertClientRecordAccess(fresh, id, 'update_client_profile', profile, stored, true, true),
    ).resolves.toEqual(fresh.scope);
    await expect(
      assertClientRecordAccess(fresh, id, 'update_client_profile', profile, stored),
    ).rejects.toThrow();
    await expect(
      assertClientRecordAccess(fresh, id, 'update_client_profile', profile, stored, false, true),
    ).rejects.toThrow();
  });
  it('refuses revoked target, changed identity/context and late revocation even for terminal observations', async () => {
    for (const change of [
      'target',
      'identityRevision',
      'contextRevision',
      'selectedClientId',
      'late',
    ]) {
      const fresh = access();
      fresh.mode = 'observe';
      if (change === 'target') fresh.clientIds = [];
      else if (change === 'late')
        fresh.assertCurrent = async () => {
          throw Error('revoked');
        };
      else if (change === 'selectedClientId')
        fresh.scope.selectedClientId = '22222222-2222-4222-8222-222222222222' as never;
      else fresh.scope[change as 'identityRevision'] = 'd'.repeat(64);
      await expect(
        assertClientRecordAccess(
          fresh,
          id,
          'update_client_profile',
          profile,
          { [CLIENT_RECORD_SCOPE_KEY]: scope },
          true,
          true,
        ),
      ).rejects.toThrow();
    }
  });
});
