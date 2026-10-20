import type { TenantContext } from '@capiro/shared';
import * as dispatchHelpers from '../meri/meri-prospect-scope.helpers.js';
import { authorizeMeriProspectScope } from './bizdev-meri-scope.authorization.js';
import {
  MeriProspectScopeConflictError,
  type BizDevMeriScopeService,
  type MeriProspectScope,
} from './bizdev-meri-scope.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const scope: MeriProspectScope = {
  prospectId: '33333333-3333-4333-8333-333333333333',
  prospectName: 'Synthetic prospect',
  canonicalOrganizationId: null,
  linkedClientId: null,
  scopeVersion: 'a'.repeat(64),
};

describe('canonical prospect authorization and compatibility identity', () => {
  it('retires the authorization shim while retaining only directive and receipt helpers', () => {
    expect(Object.keys(dispatchHelpers).sort()).toEqual(['prospectScopeDirective', 'prospectTurnScopeReceipt']);
    expect(dispatchHelpers.prospectScopeDirective(scope)).toContain(scope.prospectId);
    expect(dispatchHelpers.prospectTurnScopeReceipt(scope)).toMatchObject({
      kind: 'prospect', prospectId: scope.prospectId, scopeVersion: scope.scopeVersion,
    });
  });

  it('passes the original actor and metadata to the current owner and preserves result identity', async () => {
    const metadata = { bizdevProspectScope: scope };
    let resolve!: (value: MeriProspectScope) => void;
    const current = new Promise<MeriProspectScope>((complete) => { resolve = complete; });
    const assertCurrent = jest.fn((_ctx: TenantContext, _metadata: unknown) => current);
    const service = { assertCurrent } as unknown as BizDevMeriScopeService;
    const pending = authorizeMeriProspectScope(service, ctx, metadata);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(assertCurrent.mock.calls[0]).toEqual([ctx, metadata]);
    resolve(scope);
    await expect(pending).resolves.toBe(scope);
  });

  it('propagates the exact current-authority conflict without a retry or replacement error', async () => {
    const error = new MeriProspectScopeConflictError('changed');
    const assertCurrent = jest.fn(async () => { throw error; });
    const service = { assertCurrent } as unknown as BizDevMeriScopeService;
    await expect(authorizeMeriProspectScope(service, ctx, { bizdevProspectScope: scope })).rejects.toBe(error);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });
});
