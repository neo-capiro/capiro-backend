import type { ConfigService } from '@nestjs/config';
import { ChatAssistantService } from './chat-assistant.service';
import { MeriRegistryService } from '../meri-registry.service';
import type { ApiClientContextRepo } from '../api-client-context.repo';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo';
import type { ApiApprovalRepo } from '../api-approval.repo';
import type { ApiComplianceAuditRepo } from '../api-compliance-audit.repo';
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

const auditRepo = { record: jest.fn() } as unknown as ApiComplianceAuditRepo;

function makeService(executor: ApiToolExecutorRepo, approvals?: ApiApprovalRepo) {
  const approvalRepo =
    approvals ?? ({ isApproved: async () => false } as unknown as ApiApprovalRepo);
  const registryService = new MeriRegistryService(clientRepo, executor, approvalRepo, config);
  return new ChatAssistantService(registryService, config, auditRepo);
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

  it('audits every write-gate decision (WARN when held) and never audits a read tool', async () => {
    (auditRepo.record as jest.Mock).mockClear();
    const executor = {
      execute: jest.fn(async () => ({ items: [] })),
    } as unknown as ApiToolExecutorRepo;
    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas'))
        return schemasResponse(['search_congress_bills', 'send_email']);
      call += 1;
      if (call === 1)
        return anthropic(
          [
            { type: 'tool_use', id: 't1', name: 'search_congress_bills', input: { q: 'x' } },
            {
              type: 'tool_use',
              id: 't2',
              name: 'send_email',
              input: { to: 'a@b.com', subject: 's', body: 'b' },
            },
          ],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'done' }], 'end_turn');
    });

    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: 'go' }] }),
    );

    const calls = (auditRepo.record as jest.Mock).mock.calls.map((c) => c[0]);
    // The read tool produced NO audit row; the held write produced exactly one WARN.
    expect(calls.some((c) => c.trigger === 'search_congress_bills')).toBe(false);
    expect(calls).toContainEqual(
      expect.objectContaining({ trigger: 'send_email', decision: 'WARN' }),
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

  it('threads conversationId + clientId into a document tool and surfaces the download artifact', async () => {
    // create_word is PASS-classified (internal_artifacts.pass), so it runs even
    // with the fail-closed approval repo — no approval hold for a document.
    const executeSpy = jest.fn(
      async (_ctx: MeriContext, _name: string, _input: Record<string, unknown>) => ({
        tool: 'create_word',
        format: 'docx',
        title: 'Defense Brief',
        filename: 'defense-brief.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        artifact: { id: 'art-1', title: 'Defense Brief', kind: 'word_document' },
        downloadUrl: '/api/clio/artifacts/art-1/download',
        note: 'Document generated and available for download.',
      }),
    );
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['create_word']);
      call += 1;
      if (call === 1)
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 't1',
              name: 'create_word',
              input: { title: 'Defense Brief', sections: [] },
            },
          ],
          'tool_use',
        );
      return anthropic(
        [{ type: 'text', text: 'Your Word document is ready to download.' }],
        'end_turn',
      );
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        {
          messages: [{ role: 'user', text: 'make me a word doc' }],
          clientId: 'client-9',
          conversationId: 'conv-9',
        },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    // Gap 1: the delegated create_word received the context the model never sees —
    // without conversationId apps/api can't persist the artifact (no download).
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const passedInput = executeSpy.mock.calls[0]?.[2];
    expect(passedInput).toMatchObject({ conversationId: 'conv-9', clientId: 'client-9' });

    // Gap 2: the persisted deliverable is surfaced on the result AND as a live
    // event, so the proxy renders a download card.
    expect(out.artifacts).toEqual([
      expect.objectContaining({
        id: 'art-1',
        kind: 'word_document',
        downloadUrl: '/api/clio/artifacts/art-1/download',
      }),
    ]);
    expect(events.find((e) => e.type === 'artifact')).toMatchObject({
      artifact: { id: 'art-1', kind: 'word_document' },
    });
  });

  it('does NOT surface an artifact when a document tool could not persist (no download)', async () => {
    // Missing conversationId → apps/api returns { persisted: false }, null URL.
    const executeSpy = jest.fn(async () => ({
      tool: 'create_word',
      format: 'docx',
      title: 'Brief',
      filename: 'brief.docx',
      artifact: { persisted: false, reason: 'No conversationId was supplied to the tool call.' },
      downloadUrl: null,
      note: 'Document generated but not persisted (no conversation context); ask the user to retry within a chat.',
    }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['create_word']);
      call += 1;
      if (call === 1)
        return anthropic(
          [{ type: 'tool_use', id: 't1', name: 'create_word', input: { title: 'Brief' } }],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'I could not save the document.' }], 'end_turn');
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      // No conversationId in the dto (direct caller, not the proxy).
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'make a doc' }] },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    expect(out.artifacts).toBeUndefined();
    expect(events.find((e) => e.type === 'artifact')).toBeUndefined();
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

  it('streams progressive events (onEvent) without changing the returned ChatResult', async () => {
    const executor = {
      execute: jest.fn(async () => ({ items: [], count: 0 })),
    } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['search_congress_bills']);
      call += 1;
      if (call === 1)
        return anthropic(
          [
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', id: 't1', name: 'search_congress_bills', input: { q: 'ndaa' } },
          ],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'Final answer.' }], 'end_turn');
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'ndaa status?' }] },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    // Contract: reply stays the FINAL round's text (streaming must not change it).
    expect(out.reply).toBe('Final answer.');
    // Progressive order: intermediate text → tool_call → tool_done → final text.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['text', 'tool_call', 'tool_done', 'text']);
    expect(events[0]).toMatchObject({ type: 'text', text: 'Let me look that up.\n\n' });
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'search_congress_bills' });
    expect(events[2]).toMatchObject({
      type: 'tool_done',
      tool: 'search_congress_bills',
      status: 'done',
    });
    expect(events[3]).toMatchObject({ type: 'text', text: 'Final answer.' });
  });

  it('streams pending_approval (with the gate fingerprint) for a held write', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
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
      return anthropic([{ type: 'text', text: 'Awaiting your approval.' }], 'end_turn');
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'email them' }] },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    const pending = events.find((e) => e.type === 'pending_approval');
    expect(pending).toMatchObject({
      tool: 'send_email',
      fingerprint: computeActionFingerprint('send_email', emailInput, ctx),
    });
    // The trust-step resolution frame marks the write as held, never done.
    expect(events.find((e) => e.type === 'tool_done' && e.tool === 'send_email')).toMatchObject({
      status: 'pending_approval',
    });
  });

  it('stops the loop when the signal aborts (no further model calls)', async () => {
    const abort = new AbortController();
    const executor = {
      execute: jest.fn(async () => ({ items: [] })),
    } as unknown as ApiToolExecutorRepo;
    const fetchSpy = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['search_congress_bills']);
      // Round 1 answers with tool_use — the loop WOULD normally run round 2.
      // The abort fires mid-round; the round-2 loop-top guard must catch it.
      abort.abort();
      return anthropic(
        [{ type: 'tool_use', id: 't1', name: 'search_congress_bills', input: { q: 'x' } }],
        'tool_use',
      );
    });
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'hi' }] },
        { signal: abort.signal },
      ),
    );
    const modelCalls = fetchSpy.mock.calls.filter(
      (c) => !(c[0] as string).includes('tool-schemas'),
    );
    expect(modelCalls).toHaveLength(1); // round 2 never ran
    expect(out.reply).toBe(''); // aborted turns return empty, not an apology
  });
});
