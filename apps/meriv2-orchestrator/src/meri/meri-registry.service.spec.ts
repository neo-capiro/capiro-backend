import { MeriRegistryService } from './meri-registry.service';
import type { ApiClientContextRepo } from './api-client-context.repo';
import type { ApiToolExecutorRepo } from './api-tool-executor.repo';
import type { ApiApprovalRepo } from './api-approval.repo';
import type { ConfigService } from '@nestjs/config';

describe('MeriRegistryService', () => {
  const fakeRepo = {
    loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
  } as unknown as ApiClientContextRepo;
  const fakeExecutor = { execute: async () => ({ ok: true }) } as unknown as ApiToolExecutorRepo;
  // Fail-closed default: the approval repo denies everything (no human approval).
  const denyApprovals = { isApproved: async () => false } as unknown as ApiApprovalRepo;
  const make = (config: ConfigService) =>
    new MeriRegistryService(fakeRepo, fakeExecutor, denyApprovals, config);

  it('registers the get_client_context migration-template tool', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(make(config).registry.list()).toContain('get_client_context');
  });

  it('registers hearing reasoning tools when ANTHROPIC_API_KEY is set', () => {
    const config = {
      get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined),
    } as unknown as ConfigService;
    const svc = make(config);
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });

  it('registers hearing tools even with NO global key (BYOK2: tenant key may arrive per-request)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const svc = make(config);
    expect(svc.registry.list()).toContain('tag_live_policy_mentions');
    expect(svc.registry.list()).toContain('generate_post_hearing_summary');
  });

  it('registers the delegated read-only tool surface (Workstream C)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const list = make(config).registry.list();
    // A sample of the delegated read tools + the count sanity (24 catalog tools,
    // get_client_context registered natively once → 24 unique names total).
    expect(list).toContain('search_congress_bills');
    expect(list).toContain('search_lda_filings');
    expect(list).toContain('get_pe_budget_timeline');
    expect(list).toContain('query_economic_data');
    // get_client_context is registered exactly once (native), not duplicated.
    expect(list.filter((n) => n === 'get_client_context')).toHaveLength(1);
  });

  it('registers the delegated write tool surface, gated (Workstream C write-tool porting)', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const list = make(config).registry.list();
    expect(list).toContain('send_email');
    expect(list).toContain('update_client_profile');
    expect(list).toContain('create_task');
  });

  it('fails closed: invoking a write tool throws ApprovalPendingError and NEVER reaches apps/api', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const spyExecutor = {
      execute: jest.fn(async () => ({ ok: true })),
    } as unknown as ApiToolExecutorRepo;
    const svc = new MeriRegistryService(fakeRepo, spyExecutor, denyApprovals, config);
    const ctx = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      clerkUserId: 'clerk_1',
      role: 'standard_user' as const,
    };
    await expect(
      svc.registry.invoke('send_email', { to: 'a@b.com', subject: 's', body: 'b' }, ctx),
    ).rejects.toThrow(/requires approval|ApprovalPendingError/i);
    expect(spyExecutor.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('B4: once the approval repo approves the action, the write executes (delegates)', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const spyExecutor = {
      execute: jest.fn(async () => ({ ok: true })),
    } as unknown as ApiToolExecutorRepo;
    // Approve everything → the gate's WARN clears and the delegated call runs.
    const approveAll = { isApproved: async () => true } as unknown as ApiApprovalRepo;
    const svc = new MeriRegistryService(fakeRepo, spyExecutor, approveAll, config);
    const ctx = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      clerkUserId: 'clerk_1',
      role: 'standard_user' as const,
    };
    await expect(
      svc.registry.invoke('send_email', { to: 'a@b.com', subject: 's', body: 'b' }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(spyExecutor.execute as jest.Mock).toHaveBeenCalledTimes(1);
  });
});
