import { MeriToolsService } from './meri-tools.service.js';
import { withMeriFundingReadObservation } from './meri-funding-read-observation.js';
import type { TenantContext } from '@capiro/shared';

const context = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'standard_user' } as TenantContext;
const clientId = '33333333-3333-4333-8333-333333333333';
const asOf = '2026-10-29T12:00:00.000Z';
const source = { source: 'sam_gov', sourceRecordId: '44444444-4444-4444-8444-444444444444' };
const cases = [
  ['explain_opportunity_match', 'explainOpportunityMatch', { clientId, ...source }],
  ['compare_funding_opportunities', 'compareFundingOpportunities', { clientId, opportunities: [source, { ...source, sourceRecordId: 'another' }] }],
  ['build_opportunity_action_plan', 'buildOpportunityActionPlan', { clientId, ...source }],
] as const;

describe('advanced native dispatch', () => {
  it.each(cases)('%s consumes the exact operation observation and retains the request', async (operationId, method, input) => {
    const native = jest.fn(async () => ({ state: 'available' }));
    const service = Object.assign(Object.create(MeriToolsService.prototype), { opportunityTools: { [method]: native } }) as MeriToolsService;
    await withMeriFundingReadObservation({ operationId, asOf }, () => service.execute(context, operationId, input));
    expect(native).toHaveBeenCalledWith({ tenantId: context.tenantId, userId: context.userId, role: context.role }, input, new Date(asOf));
    native.mockClear();
    await expect(withMeriFundingReadObservation({ operationId: 'search_funding_opportunities', asOf }, () => service.execute(context, operationId, input))).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
    await service.execute(context, operationId, input);
    expect(native).toHaveBeenCalledWith(expect.anything(), input, undefined);
  });

  it('forwards all four buyer section continuations through the native tool', async () => {
    const read = jest.fn(async () => ({ subject: { type: 'pe', id: '0601234A' } }));
    const service = Object.assign(Object.create(MeriToolsService.prototype), { buyerWorkspace: { read } }) as MeriToolsService;
    const input = { peCode: '0601234A', asOfFy: 2026, knownAt: asOf, acquisitionCursor: 'acquisition-page',
      fundingCursor: 'funding-page', mentionsCursor: 'mentions-page', lifecycleCursor: 'lifecycle-page' };
    await service.execute(context, 'get_pe_buyer_workspace', input);
    expect(read).toHaveBeenCalledWith(input);
  });

  it.each(['acquisitionCursor', 'fundingCursor', 'mentionsCursor', 'lifecycleCursor'])('never truncates or silently resets native %s', async key => {
    const read = jest.fn();
    const service = Object.assign(Object.create(MeriToolsService.prototype), { buyerWorkspace: { read } }) as MeriToolsService;
    for (const value of [null, 4, '', ' cursor ', 'a'.repeat(4097)])
      await expect(service.execute(context, 'get_pe_buyer_workspace', {
        peCode: '0601234A', asOfFy: 2026, knownAt: asOf, [key]: value,
      })).rejects.toThrow('cursor');
    expect(read).not.toHaveBeenCalled();
  });
});
