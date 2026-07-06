import type { ConfigService } from '@nestjs/config';
import { ChatAssistantService } from './chat-assistant.service';
import { MeriRegistryService } from '../meri-registry.service';
import type { ApiClientContextRepo } from '../api-client-context.repo';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo';
import type { ApiApprovalRepo } from '../api-approval.repo';
import { RequestCredentialsStore } from '../../request/request-credentials.store';
import { computeActionFingerprint, type MeriContext } from '@capiro/meriv2-core';

/**
 * The full chat loop, driven end-to-end with mocked I/O:
 * - global.fetch handles the Anthropic tool-use rounds AND the tool-schema GET.
 * - tool EXECUTION goes through the REAL registry (delegated reads → fake
 *   executor; gated writes → real gate + fake approval repo).
 */
const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

const config = {
  get: (k: string) =>
    k === 'MERIV2_API_BASE_URL'
      ? 'http://api.test'
      : k === 'ANTHROPIC_API_KEY'
        ? 'sk-global'
        : undefined,
} as unknown as ConfigService;

const clientRepo = {
  loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
} as unknown as ApiClientContextRepo;

function makeService(executor: ApiToolExecutorRepo, approvals?: ApiApprovalRepo) {
  const approvalRepo =
    approvals ?? ({ isApproved: async () => false } as unknown as ApiApprovalRepo);
  const registryService = new MeriRegistryService(clientRepo, executor, approvalRepo, config);
  return new ChatAssistantService(registryService, config);
}

const anthropic = (content: unknown[], stop_reason: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ content, stop_reason }),
});

const schemasResponse = (names: string[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    schemas: names.map((name) => ({ name, description: 'x', input_schema: { type: 'object' } })),
  }),
});

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('ChatAssistantService.run', () => {
  it('runs a read tool through the registry, then answers in prose', async () => {
    const executeSpy = jest.fn(async () => ({ items: [{ id: 'hr1' }], count: 1 }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas'))
        return schemasResponse(['search_congress_bills', 'send_email']);
      call += 1;
      if (call === 1)
        return anthropic(
          [{ type: 'tool_use', id: 't1', name: 'search_congress_bills', input: { q: 'ndaa' } }],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'Here is what I found on the NDAA.' }], 'end_turn');
    });

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: 'ndaa status?' }] }),
    );
    expect(out.reply).toBe('Here is what I found on the NDAA.');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(out.steps?.some((s) => s.tool === 'search_congress_bills' && s.status === 'done')).toBe(
      true,
    );
    expect(out.pendingApprovals).toBeUndefined();
  });

  it('a write tool comes back as pending_approval (gate held), NOT executed', async () => {
    // Fail-closed approval repo → the gate holds send_email.
    const executeSpy = jest.fn(async () => ({ ok: true }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;
    const emailInput = { to: 'a@b.com', subject: 's', body: 'b' };

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['send_email']);
      call += 1;
      if (call === 1)
        return anthropic(
          [{ type: 'tool_use', id: 't1', name: 'send_email', input: emailInput }],
          'tool_use',
        );
      return anthropic(
        [{ type: 'text', text: "I've proposed the email; it's awaiting your approval." }],
        'end_turn',
      );
    });

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: 'email them' }] }),
    );

    // The delegated executor was NEVER called (gate held the write).
    expect(executeSpy).not.toHaveBeenCalled();
    expect(out.steps?.some((s) => s.tool === 'send_email' && s.status === 'pending_approval')).toBe(
      true,
    );
    expect(out.pendingApprovals).toHaveLength(1);
    // The surfaced fingerprint matches what the gate computed for this action.
    expect(out.pendingApprovals?.[0]?.fingerprint).toBe(
      computeActionFingerprint('send_email', emailInput, ctx),
    );
  });

  it('a write tool executes once its action is approved', async () => {
    const executeSpy = jest.fn(async () => ({ sent: true }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;
    const approveAll = { isApproved: async () => true } as unknown as ApiApprovalRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['send_email']);
      call += 1;
      if (call === 1)
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 't1',
              name: 'send_email',
              input: { to: 'a@b.com', subject: 's', body: 'b' },
            },
          ],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'Sent.' }], 'end_turn');
    });

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor, approveAll).run(ctx, {
        messages: [{ role: 'user', text: 'email them' }],
      }),
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(out.steps?.some((s) => s.tool === 'send_email' && s.status === 'done')).toBe(true);
    expect(out.pendingApprovals).toBeUndefined();
  });

  it('prompts for input when the last message is not from the user (no model call)', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const out = await makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo).run(
      ctx,
      {
        messages: [{ role: 'assistant', text: 'hi' }],
      },
    );
    expect(out.reply).toMatch(/What can I help/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
