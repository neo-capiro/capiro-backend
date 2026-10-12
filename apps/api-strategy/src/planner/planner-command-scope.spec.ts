import { requirePlannerCommandScope } from './planner-command-scope.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_actor',
  role: 'org:member',
};
describe('Planner command narrowing preconditions', () => {
  it('preserves calls without constraints', () =>
    expect(() => requirePlannerCommandScope(ctx, {})).not.toThrow());
  it('accepts exact independently authenticated scope', () =>
    expect(() =>
      requirePlannerCommandScope(ctx, {
        'x-capiro-expected-tenant-id': ctx.tenantId,
        'x-capiro-expected-actor-id': ctx.clerkUserId,
      }),
    ).not.toThrow());
  it.each([
    { 'x-capiro-expected-tenant-id': 'foreign' },
    { 'x-capiro-expected-actor-id': 'foreign' },
    { 'x-capiro-expected-tenant-id': '' },
    { 'x-capiro-expected-actor-id': '' },
    { 'x-capiro-expected-tenant-id': [ctx.tenantId] },
    { 'x-capiro-expected-actor-id': [ctx.clerkUserId] },
  ])('rejects mismatch or ambiguous header %j', (headers) =>
    expect(() => requirePlannerCommandScope(ctx, headers)).toThrow('scope mismatch'),
  );
});
