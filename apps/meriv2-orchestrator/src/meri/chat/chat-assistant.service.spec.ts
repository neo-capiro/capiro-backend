import type { ConfigService } from '@nestjs/config';
import { ChatAssistantService } from './chat-assistant.service';
import { MeriRegistryService } from '../meri-registry.service';
import type { ApiClientContextRepo } from '../api-client-context.repo';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo';
import type { ApiComplianceAuditRepo } from '../api-compliance-audit.repo';
import type {
  ApiActionProposalRepo,
  ActionProposalResult,
  CreateActionProposalInput,
} from '../api-action-proposal.repo';
import { RequestCredentialsStore } from '../../request/request-credentials.store';
import type { MeriContext } from '@capiro/meriv2-core';

/**
 * The full chat loop, driven end-to-end with mocked I/O:
 * - global.fetch handles the Anthropic tool-use rounds AND the tool-schema GET.
 * - tool EXECUTION goes through the REAL registry (delegated reads → fake
 *   executor; gated writes ALWAYS hold — Phase 0 has no "already approved"
 *   path through the registry, so every WARN write becomes a proposal).
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

function fakeProposal(input: CreateActionProposalInput): ActionProposalResult {
  return {
    proposalId: 'proposal-1',
    status: 'proposed',
    tool: input.tool,
    preview: {
      label: `Proposed ${input.tool}`,
      riskTier: 'restricted',
      leavesFirm: false,
      reversible: true,
      fields: {},
      counts: {},
      reason: 'Requires approval',
    },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    reason: 'Requires approval',
    ruleId: null,
    riskTier: 'restricted',
    policyCode: null,
    attemptCount: 0,
    resultSummary: null,
    policy: {
      source: 'persisted',
      mode: 'enforce',
      packKey: 'default',
      packVersion: '1',
      binding: 'binding-1',
      decisionHash: 'decision-hash-1',
      contextHash: 'context-hash-1',
      decision: 'WARN',
      jurisdiction: 'federal',
      channel: 'internal',
      recipientType: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Module-level spy so individual tests can assert on create() without depending
// on a single fixed disposition. makeService rebinds the implementation so PASS
// tools execute (via the test executor) and WARN tools stay held.
const actionProposalsRepo = {
  create: jest.fn(),
} as unknown as ApiActionProposalRepo;

/** Tools the product holds for human approval (WARN / external) in these tests. */
const HELD_WRITE_TOOLS = new Set([
  'send_email',
  'reply_email',
  'update_client_profile',
]);

// Phase 1 M5.0 (H-1): the chat loop meters every round via recordAiUsageEvent,
// which needs prisma.withTenant/withSystem. A no-op fake is enough here — the
// metering write itself is unit-tested in @capiro/shared's own spec.
const fakePrisma = {
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  withSystem: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
} as never;

function makeService(executor: ApiToolExecutorRepo) {
  (actionProposalsRepo.create as jest.Mock).mockImplementation(
    async (input: CreateActionProposalInput) => {
      if (HELD_WRITE_TOOLS.has(input.tool)) {
        return {
          disposition: 'pending_approval' as const,
          proposal: fakeProposal(input),
        };
      }
      // PASS / internal-artifact tools: apps/api executes immediately under
      // server-owned authority. Mirror that by running the local test executor
      // and returning disposition/executed with its result.
      const executionResult = await executor.execute(ctx, input.tool, input.input);
      return {
        disposition: 'executed' as const,
        proposal: { ...fakeProposal(input), status: 'succeeded' },
        executionResult,
      };
    },
  );
  const registryService = new MeriRegistryService(clientRepo, executor, config);
  return new ChatAssistantService(
    registryService,
    config,
    auditRepo,
    fakePrisma,
    actionProposalsRepo,
  );
}

// The chat loop now STREAMS (2.4): completeWithTools reads `.body` as an SSE
// event stream when onTextDelta is passed (every real tool round), and falls
// back to `.json()` only for the non-streaming synthesizeFinalAnswer pass
// (tool_choice:none). So a mock response must serve BOTH: encode the same
// content blocks + stop_reason as an Anthropic SSE stream (reconstructed 1:1 by
// parseAnthropicToolStream) AND expose the legacy JSON body.
interface MockBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
const sseFromContent = (content: unknown[], stop_reason: string): string => {
  const ev = (o: Record<string, unknown>) =>
    `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;
  let out = ev({ type: 'message_start', message: { usage: { input_tokens: 1 } } });
  (content as MockBlock[]).forEach((b, index) => {
    if (b.type === 'tool_use') {
      out += ev({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name },
      });
      out += ev({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
      });
    } else {
      out += ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += ev({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: b.text ?? '' },
      });
    }
    out += ev({ type: 'content_block_stop', index });
  });
  out += ev({ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5 } });
  out += ev({ type: 'message_stop' });
  return out;
};
// One-shot fake web-stream body (jest's node sandbox has no ReadableStream).
const streamBody = (sse: string) => {
  const value = new TextEncoder().encode(sse);
  let done = false;
  return {
    getReader: () => ({
      read: async () =>
        done ? { done: true, value: undefined } : ((done = true), { done: false, value }),
    }),
  };
};

const anthropic = (content: unknown[], stop_reason: string) => ({
  ok: true,
  status: 200,
  body: streamBody(sseFromContent(content, stop_reason)),
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
    // Phase 0: EVERY WARN write holds — there is no "already approved" path
    // through the registry anymore, so the gate always throws and the caller
    // always creates a durable proposal instead.
    const executeSpy = jest.fn(async () => ({ ok: true }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;
    const emailInput = { to: 'a@b.com', subject: 's', body: 'b' };
    (actionProposalsRepo.create as jest.Mock).mockClear();

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
    // Only the opaque, server-created proposal id is surfaced — never the tool
    // payload or a browser-computable fingerprint.
    expect(out.pendingApprovals?.[0]).toMatchObject({
      tool: 'send_email',
      proposalId: 'proposal-1',
      status: 'proposed',
    });
    expect(actionProposalsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'send_email', input: emailInput, surface: 'chat' }),
    );
  });

  it("audits a PASS write directly, but leaves a held WARN to apps/api's durable proposal transaction (no duplicate row)", async () => {
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
    // The read tool produced NO audit row.
    expect(calls.some((c) => c.trigger === 'search_congress_bills')).toBe(false);
    // The held write produced NO orchestrator-side audit row either — apps/api's
    // MeriActionProposalService.create() already recorded this WARN decision
    // durably, inside the same transaction as the proposal row itself.
    expect(calls.some((c) => c.trigger === 'send_email')).toBe(false);
  });

  it('replaces a model-supplied NON-UUID clientId with the conversation focus', async () => {
    // Regression: augmentToolInput used to only backfill clientId when the model
    // left it unset. But required-clientId tools (e.g. update_client_profile)
    // ALWAYS send one — frequently a display name, not the UUID — which reached
    // apps/api as an invalid clientId ("Error creating UUID" → the user-visible
    // "Action approved but failed to run"). A name must lose to the focus.
    const executeSpy = jest.fn(
      async (_ctx: MeriContext, _name: string, _input: Record<string, unknown>) => ({
        tool: 'create_word',
        format: 'docx',
        title: 'Doc',
        filename: 'doc.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        artifact: { id: 'art-x', title: 'Doc', kind: 'word_document' },
        downloadUrl: '/api/clio/artifacts/art-x/download',
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
              // Model passed a NAME as clientId — the classic failure input.
              input: { title: 'Doc', sections: [], clientId: 'RADD' },
            },
          ],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'done' }], 'end_turn');
    });

    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        {
          messages: [{ role: 'user', text: 'update the client profile' }],
          clientId: 'client-9', // conversation focus — the authoritative id
          conversationId: 'conv-9',
        },
        { onEvent: () => {} },
      ),
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const passedInput = executeSpy.mock.calls[0]?.[2] as { clientId?: string };
    // The conversation's client id wins over the model's "RADD".
    expect(passedInput.clientId).toBe('client-9');
  });

  it('respects a model-supplied UUID so one turn can write to several clients', async () => {
    // The 2026-07-16 override was unconditional, which fixed the display-name
    // case and silently broke every multi-client turn: "update all my client
    // profiles" proposes N writes against N ids in ONE focused conversation and
    // all N were rewritten to the focused client — so N-1 clients received
    // another client's data while the user was told all N succeeded.
    const other = 'b7c9e1a2-0000-4000-8000-00000000abcd';
    const executeSpy = jest.fn(
      async (_ctx: MeriContext, _name: string, _input: Record<string, unknown>) => ({
        tool: 'create_word',
        format: 'docx',
        title: 'Doc',
        filename: 'doc.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        artifact: { id: 'art-y', title: 'Doc', kind: 'word_document' },
        downloadUrl: '/api/clio/artifacts/art-y/download',
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
              input: { title: 'Doc', sections: [], clientId: other },
            },
          ],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'done' }], 'end_turn');
    });

    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        {
          messages: [{ role: 'user', text: 'update every client profile' }],
          clientId: 'client-9',
          conversationId: 'conv-9',
        },
        { onEvent: () => {} },
      ),
    );

    const passedInput = executeSpy.mock.calls[0]?.[2] as { clientId?: string };
    // A real id names a real client the user asked for; apps/api still 404s on
    // anything outside the tenant, so honouring it cannot cross a boundary.
    expect(passedInput.clientId).toBe(other);
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

  it('emits a page_write event carrying the draft body when pageWrite is set (2.1)', async () => {
    // draft_policy_memo is PASS-classified (internal_artifacts) → runs without a hold.
    const executeSpy = jest.fn(async () => ({
      tool: 'draft_policy_memo',
      artifact: {
        id: 'draft-1',
        title: 'Outreach to Rep. Smith',
        kind: 'policy_memo',
        bodyText: 'Dear Representative Smith, regarding the FY27 NDAA…',
      },
    }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['draft_policy_memo']);
      call += 1;
      if (call === 1)
        return anthropic(
          [{ type: 'tool_use', id: 't1', name: 'draft_policy_memo', input: { topic: 'x' } }],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'Your draft is on the page.' }], 'end_turn');
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        {
          messages: [{ role: 'user', text: 'outreach to Rep Smith' }],
          conversationId: 'conv-1',
          pageWrite: true,
        },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    // The produced draft is applied to the open page as a page_write frame.
    expect(events.find((e) => e.type === 'page_write')).toMatchObject({
      type: 'page_write',
      target: 'outreach_draft',
      subject: 'Outreach to Rep. Smith',
      body: 'Dear Representative Smith, regarding the FY27 NDAA…',
    });
  });

  it('does NOT emit page_write when pageWrite is unset — dormant by default (2.1)', async () => {
    const executeSpy = jest.fn(async () => ({
      tool: 'draft_policy_memo',
      artifact: { id: 'draft-2', title: 'Memo', kind: 'policy_memo', bodyText: 'Body' },
    }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['draft_policy_memo']);
      call += 1;
      if (call === 1)
        return anthropic(
          [{ type: 'tool_use', id: 't1', name: 'draft_policy_memo', input: {} }],
          'tool_use',
        );
      return anthropic([{ type: 'text', text: 'Done.' }], 'end_turn');
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'draft a memo' }], conversationId: 'conv-2' },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    // No page mutation when the caller did not opt in…
    expect(events.find((e) => e.type === 'page_write')).toBeUndefined();
    // …but the deliverable still surfaces as a normal artifact card.
    expect(events.find((e) => e.type === 'artifact')).toBeDefined();
  });

  it('attaches current-turn images as vision blocks on the last user message (2.2)', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    let sentBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: { body?: string }) => {
        if (url.includes('/api/clio/tool-schemas')) return schemasResponse([]);
        sentBody = init?.body ? JSON.parse(init.body) : null;
        return anthropic([{ type: 'text', text: 'The chart shows FY27 PE cuts.' }], 'end_turn');
      },
    );

    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, {
        messages: [{ role: 'user', text: 'what does this chart show?' }],
        currentTurnImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
      }),
    );

    // Re-widen: TS narrows sentBody to its init (null) since it's assigned only
    // inside the fetch closure it can't track.
    const msgs =
      (sentBody as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages ?? [];
    const lastUser = msgs[msgs.length - 1];
    expect(Array.isArray(lastUser?.content)).toBe(true);
    const blocks = lastUser?.content as Array<Record<string, unknown>>;
    // Legacy parity: image block(s) first, then the text.
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(blocks[blocks.length - 1]).toMatchObject({
      type: 'text',
      text: 'what does this chart show?',
    });
  });

  it('sends a plain string message (no vision block) when there are no images (2.2)', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    let sentBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: { body?: string }) => {
        if (url.includes('/api/clio/tool-schemas')) return schemasResponse([]);
        sentBody = init?.body ? JSON.parse(init.body) : null;
        return anthropic([{ type: 'text', text: 'Hello.' }], 'end_turn');
      },
    );

    await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: 'hi' }] }),
    );

    // Re-widen: TS narrows sentBody to its init (null) since it's assigned only
    // inside the fetch closure it can't track.
    const msgs =
      (sentBody as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages ?? [];
    expect(typeof msgs[msgs.length - 1]?.content).toBe('string');
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
    // Under token streaming (2.4) the model's text arrives as live deltas: the
    // intermediate round streams its prose ("Let me look that up.") then the loop
    // adds a "\n\n" round separator (the text already went out, so it is NOT
    // re-emitted whole); the final round streams "Final answer." as a delta.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['text', 'text', 'tool_call', 'tool_done', 'text']);
    expect(events[0]).toMatchObject({ type: 'text', text: 'Let me look that up.' });
    expect(events[1]).toMatchObject({ type: 'text', text: '\n\n' });
    expect(events[2]).toMatchObject({ type: 'tool_call', tool: 'search_congress_bills' });
    expect(events[3]).toMatchObject({
      type: 'tool_done',
      tool: 'search_congress_bills',
      status: 'done',
    });
    expect(events[4]).toMatchObject({ type: 'text', text: 'Final answer.' });
  });

  it('streams pending_approval (with the durable proposal id) for a held write, only after the API call resolves', async () => {
    (actionProposalsRepo.create as jest.Mock).mockClear();
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
        { messages: [{ role: 'user', text: 'email them' }], conversationId: 'conv-9' },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    const pending = events.find((e) => e.type === 'pending_approval');
    expect(pending).toMatchObject({
      tool: 'send_email',
      proposalId: 'proposal-1',
      status: 'proposed',
    });
    // Never a tool/payload/fingerprint the browser could forge or replay.
    expect(pending).not.toHaveProperty('fingerprint');
    expect(pending).not.toHaveProperty('input');
    // The trust-step resolution frame marks the write as held, never done.
    expect(events.find((e) => e.type === 'tool_done' && e.tool === 'send_email')).toMatchObject({
      status: 'pending_approval',
    });
    // The durable proposal is created with exactly the tool/input/conversation
    // the model proposed — the API, not the orchestrator, computes the
    // fingerprint/policy/tenant/user authority server-side. augmentToolInput
    // (pre-existing behavior) also threads conversationId onto the input
    // object itself, same as every other write tool call.
    expect(actionProposalsRepo.create).toHaveBeenCalledWith({
      tool: 'send_email',
      input: { ...emailInput, conversationId: 'conv-9' },
      conversationId: 'conv-9',
      surface: 'chat',
    });
  });

  it('proposal API failure emits no usable approval card and tells the model nothing was proposed', async () => {
    (actionProposalsRepo.create as jest.Mock).mockRejectedValueOnce(
      new Error('Action proposal creation failed: 500 Internal Server Error'),
    );
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
        [{ type: 'text', text: 'Something went wrong proposing that.' }],
        'end_turn',
      );
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(
        ctx,
        { messages: [{ role: 'user', text: 'email them' }] },
        { onEvent: (e) => events.push(e as never) },
      ),
    );

    // No usable card was ever shown — persistence never durably succeeded.
    expect(events.find((e) => e.type === 'pending_approval')).toBeUndefined();
    expect(out.pendingApprovals).toBeUndefined();
    // The tool never ran either.
    expect(executeSpy).not.toHaveBeenCalled();
    // A failed step is surfaced instead of a silent drop.
    const failedStep = out.steps?.find((s) => s.tool === 'send_email');
    expect(failedStep?.status).toBe('error');
    expect(events.find((e) => e.type === 'tool_done' && e.tool === 'send_email')).toMatchObject({
      status: 'error',
    });
  });

  it('forces a final synthesis when the tool-round budget is exhausted (no canned fallback, context not discarded)', async () => {
    // The reported bug: a complex question keeps asking for tools past the round
    // cap; the old loop returned "ran out of steps" and threw the research away.
    const executor = {
      execute: jest.fn(async () => ({ items: [{ id: 'x' }], count: 1 })),
    } as unknown as ApiToolExecutorRepo;
    const bodies: Array<Record<string, unknown>> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: { body?: string }) => {
        if (url.includes('/api/clio/tool-schemas'))
          return schemasResponse(['search_congress_bills']);
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        bodies.push(body);
        if ((body.tool_choice as { type?: string } | undefined)?.type === 'none') {
          return anthropic(
            [{ type: 'text', text: 'Synthesized answer from everything I gathered.' }],
            'end_turn',
          );
        }
        // Every tool round keeps requesting a tool → the loop never terminates on its own.
        return anthropic(
          [
            {
              type: 'tool_use',
              id: `t${bodies.length}`,
              name: 'search_congress_bills',
              input: { q: 'x' },
            },
          ],
          'tool_use',
        );
      },
    );

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, {
        messages: [{ role: 'user', text: 'deep analytical question' }],
      }),
    );

    expect(out.reply).toBe('Synthesized answer from everything I gathered.');
    expect(out.reply).not.toMatch(/ran out of steps/i);
    // The forced synthesis turn ran exactly once and disabled tools (tool_choice:none)…
    const synth = bodies.filter(
      (b) => (b.tool_choice as { type?: string } | undefined)?.type === 'none',
    );
    expect(synth).toHaveLength(1);
    // …after the full 14-round tool budget was spent.
    const toolRounds = bodies.filter((b) => !b.tool_choice);
    expect(toolRounds).toHaveLength(14);
  });

  it('forces synthesis when a turn ends with no prose (never ships a bare "Done.")', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    const bodies: Array<Record<string, unknown>> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: { body?: string }) => {
        if (url.includes('/api/clio/tool-schemas'))
          return schemasResponse(['search_congress_bills']);
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        bodies.push(body);
        if ((body.tool_choice as { type?: string } | undefined)?.type === 'none')
          return anthropic([{ type: 'text', text: 'Here is the answer.' }], 'end_turn');
        // First turn: model ends with NO text and NO tools (a stray stop).
        return anthropic([], 'end_turn');
      },
    );

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: 'q' }] }),
    );

    expect(out.reply).toBe('Here is the answer.');
    expect(
      bodies.filter((b) => (b.tool_choice as { type?: string } | undefined)?.type === 'none'),
    ).toHaveLength(1);
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

/**
 * PRE-PERSISTENCE hold for model-authored draft bodies.
 *
 * `draft_policy_memo` persists a durable ClioArtifact inside apps/api, so the
 * release gate at finalize was structurally too late: by then the row exists and
 * the orchestrator cannot retract it. These tests pin (a) that the hold is dark
 * by default and (b) that when armed the persisting call is never made at all —
 * not merely that the reply was replaced.
 */
describe('ChatAssistantService pre-persistence hold', () => {
  const FABRICATED_BODY =
    '<p>PE 0604270F received $412.5 million in FY27, a 22% increase, and H.R. 1234 was enacted on July 1.</p>';
  const HIGH_RISK_REQUEST = 'draft a memo on the FY27 budget amount for PE 0604270F';

  function driveMemoDraft(executeSpy: jest.Mock) {
    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['draft_policy_memo']);
      call += 1;
      if (call === 1) {
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'draft_policy_memo',
              input: { clientId: 'c1', title: 'FY27 memo', body: FABRICATED_BODY },
            },
          ],
          'tool_use',
        );
      }
      return anthropic([{ type: 'text', text: 'Memo drafted.' }], 'end_turn');
    });
    return { execute: executeSpy } as unknown as ApiToolExecutorRepo;
  }

  const memoResult = {
    tool: 'draft_policy_memo',
    artifact: { id: 'artifact-1', title: 'FY27 memo', kind: 'policy_memo', bodyText: 'x' },
  };

  const original = process.env.MERI_RELEASE_GATE;
  afterEach(() => {
    if (original === undefined) delete process.env.MERI_RELEASE_GATE;
    else process.env.MERI_RELEASE_GATE = original;
  });

  it('is DARK by default — the memo is persisted and the artifact card is returned', async () => {
    delete process.env.MERI_RELEASE_GATE;
    const executeSpy = jest.fn(async () => memoResult);
    const executor = driveMemoDraft(executeSpy);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe('Memo drafted.');
    expect(out.artifacts).toEqual([
      { id: 'artifact-1', title: 'FY27 memo', kind: 'policy_memo', bodyText: 'x' },
    ]);
  });

  it('when armed, NEVER calls the persisting tool and returns no artifact card', async () => {
    process.env.MERI_RELEASE_GATE = 'enforce';
    const executeSpy = jest.fn(async () => memoResult);
    const executor = driveMemoDraft(executeSpy);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService(executor).run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    // The whole point: the durable write never happened.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(out.artifacts).toBeUndefined();
    const step = out.steps?.find((s) => s.tool === 'draft_policy_memo');
    expect(step?.status).toBe('blocked');
  });

  it('does not hold a draft tool that carries no model-authored body', async () => {
    // create_meeting_brief renders server-side from meeting records, so there is
    // no model claim to gate; arming the surface must not break it.
    process.env.MERI_RELEASE_GATE = 'enforce';
    const executeSpy = jest.fn(async () => ({
      tool: 'create_meeting_brief',
      artifact: { id: 'brief-1', title: 'Brief', kind: 'meeting_brief' },
    }));
    let call = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) return schemasResponse(['create_meeting_brief']);
      call += 1;
      if (call === 1) {
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'create_meeting_brief',
              input: { meetingId: 'm1' },
            },
          ],
          'tool_use',
        );
      }
      return anthropic([{ type: 'text', text: 'Brief ready.' }], 'end_turn');
    });
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      makeService({ execute: executeSpy } as unknown as ApiToolExecutorRepo).run(ctx, {
        messages: [{ role: 'user', text: 'build the brief for tomorrow' }],
      }),
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(out.steps?.find((s) => s.tool === 'create_meeting_brief')?.status).toBe('done');
  });
});
