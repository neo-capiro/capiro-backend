import { describe, expect, test } from '@jest/globals';
import {
  allocateBoundedReplayHistory,
  boundReplayMessageBody,
  buildProtocolCompactionState,
  buildCompactionPrompt,
  clampTurnForSummary,
  estimateTokens,
  formatSummaryBlockForPrompt,
  MERI_PROTOCOL_COMPACTION_METADATA_KEY,
  MAX_REPLAY_HISTORY_CHARS,
  planCompaction,
  protocolCompactionReplay,
  sanitizeSummaryOutput,
} from './meri-compaction.helpers.js';

const msg = (id: string, role: string, chars: number) => ({
  id,
  role,
  body: 'x'.repeat(chars),
});

describe('estimateTokens', () => {
  test('chars/4, rounded up, 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('planCompaction', () => {
  const base = { existingSummary: null, triggerTokens: 1000, tailMessages: 12 };

  test('does nothing while the conversation is short', () => {
    const plan = planCompaction({
      ...base,
      messages: Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'user', 4000)),
    });
    expect(plan.compact).toBe(false);
    expect(plan.toSummarize).toHaveLength(0);
  });

  test('does nothing while text beyond the tail is under the trigger', () => {
    // 16 messages, 4 beyond the tail, each tiny (25 tokens) => 100 tokens < 1000.
    const plan = planCompaction({
      ...base,
      messages: Array.from({ length: 16 }, (_, i) => msg(`m${i}`, 'user', 100)),
    });
    expect(plan.compact).toBe(false);
  });

  test('preserves an early material constraint through more than 40 short messages', () => {
    const constraint = 'Never recommend FY2027 requested amounts as enacted funding.';
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      body: i === 0 ? constraint : `Short exchange ${i}`,
    }));
    // The default 5,000-token trigger is never reached by this entire thread.
    const first = planCompaction({
      ...base,
      triggerTokens: 5000,
      messages: messages.slice(0, 38),
    });
    expect(first.compact).toBe(true);
    expect(first.toSummarize[0]?.body).toBe(constraint);
    const prompt = buildCompactionPrompt({
      existingSummary: null,
      turns: first.toSummarize,
    });
    expect(prompt.user).toContain(constraint);
    // Simulated provider summary: the test proves transport/retention, not model quality.
    const summary = `Decisions & preferences: ${constraint}`;
    const remaining = messages.slice(first.toSummarize.length);
    const next = planCompaction({
      ...base,
      triggerTokens: 5000,
      existingSummary: summary,
      messages: remaining,
    });
    expect(next.compact).toBe(false);
    const replay = `${formatSummaryBlockForPrompt(summary)}\n${remaining.map((m) => m.body).join('\n')}`;
    expect(replay).toContain(constraint);
    expect(remaining).toHaveLength(34);
    expect(replay).toContain('Short exchange 59');
  });

  test('compacts the oldest messages once beyond-tail text reaches the trigger', () => {
    // 18 messages, 6 beyond the tail at 1000 chars (250 tokens) each = 1500 tokens.
    const messages = Array.from({ length: 18 }, (_, i) =>
      msg(`m${i}`, i % 2 ? 'assistant' : 'user', 1000),
    );
    const plan = planCompaction({ ...base, messages });
    expect(plan.compact).toBe(true);
    expect(plan.toSummarize.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(plan.upToMessageId).toBe('m5');
  });

  test('respects minMessagesToSummarize even when tokens are huge', () => {
    const messages = Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', 50_000));
    const plan = planCompaction({
      ...base,
      messages,
      minMessagesToSummarize: 4,
    });
    // 2 beyond the tail < 4 minimum.
    expect(plan.compact).toBe(false);
  });

  test('call frequency: a 300-message conversation triggers bounded compactions', () => {
    // Simulate the after-turn job across a 300-message conversation with
    // ~150-token turns. Each compaction folds everything beyond the tail, so
    // the number of small-model calls stays well under 1 per 15 turns.
    const turnChars = 600; // 150 tokens
    let boundary = 0;
    let calls = 0;
    for (let count = 1; count <= 300; count += 1) {
      const since = Array.from({ length: count - boundary }, (_, i) =>
        msg(`m${boundary + i}`, i % 2 ? 'assistant' : 'user', turnChars),
      );
      const plan = planCompaction({
        messages: since,
        existingSummary: boundary > 0 ? 'summary' : null,
        // The production default (config.schema.ts) — the frequency criterion
        // is tied to it, so keep them in sync.
        triggerTokens: 5000,
        tailMessages: 12,
      });
      if (plan.compact) {
        calls += 1;
        boundary += plan.toSummarize.length;
      }
    }
    expect(calls).toBeGreaterThan(0);
    // 300 messages = 150 user turns; <= 1 call per ~15 turns means <= 10 calls.
    expect(calls).toBeLessThanOrEqual(10);
  });
});

describe('buildCompactionPrompt', () => {
  test('keeps client scope, evidence identities and unresolved decisions without arbitrary metadata', () => {
    const prompt = buildCompactionPrompt({
      existingSummary: 'Open threads: verify the enacted amount before sending.',
      clientId: 'client-1',
      turns: [
        {
          id: 'message-1',
          role: 'assistant',
          body: 'Requested amount is $10M [1].',
          clientId: 'client-1',
          metadata: {
            citations: [
              {
                index: 1,
                sourceId: 'source-1',
                url: 'https://example.gov/budget',
                secret: 'must-not-enter',
              },
            ],
            attachments: [{ id: 'attachment-1', filename: 'budget.pdf' }],
            contextPacketId: 'packet-1',
            arbitrary: 'must-not-enter',
          },
        },
      ],
    });
    expect(prompt.user).toContain('Current client scope: client-1');
    expect(prompt.user).toContain('verify the enacted amount before sending');
    for (const reference of [
      'message-1',
      'source-1',
      'https://example.gov/budget',
      'attachment-1',
      'packet-1',
    ]) {
      expect(prompt.user).toContain(reference);
    }
    expect(prompt.user).not.toContain('must-not-enter');
    expect(prompt.system).toContain('Citation numbers are local');
  });
  test('includes the old summary and the new turns, labeled by speaker', () => {
    const prompt = buildCompactionPrompt({
      existingSummary: 'Facts & context: client is Acme Defense.',
      turns: [
        { role: 'user', body: 'What is the status of HR 2670?' },
        { role: 'assistant', body: 'HR 2670 passed the House on July 14 [2].' },
      ],
    });
    expect(prompt.user).toContain('Acme Defense');
    expect(prompt.user).toContain('User: What is the status of HR 2670?');
    expect(prompt.user).toContain('Meri: HR 2670 passed the House on July 14 [2].');
    expect(prompt.system).toContain('Preserve concrete identifiers');
    expect(prompt.system).toContain('400 words');
  });

  test('first compaction works without an existing summary', () => {
    const prompt = buildCompactionPrompt({
      existingSummary: null,
      turns: [{ role: 'user', body: 'hello' }],
    });
    expect(prompt.user).toContain('(none yet)');
  });

  test('bounds reference metadata and reports omitted references for later history lookup', () => {
    const prompt = buildCompactionPrompt({
      existingSummary: null,
      turns: [
        {
          id: 'source-message',
          role: 'assistant',
          body: 'Budget evidence.',
          metadata: {
            citations: Array.from({ length: 100 }, (_, i) => ({
              sourceId: `source-${i}`,
              title: 'Long title '.repeat(100),
              url: 'https://example.gov/budget',
            })),
          },
        },
      ],
    });
    expect(prompt.user.length).toBeLessThan(4000);
    expect(prompt.user).toContain('source-message');
    expect(prompt.user).toContain('citationsOmittedCount');
  });

  test('structural guarantee: only the provided turn bodies enter the prompt', () => {
    // Encrypted meeting notes can never leak into a summary because the
    // prompt builder has no input other than the message turns handed to it.
    const prompt = buildCompactionPrompt({
      existingSummary: null,
      turns: [{ role: 'user', body: 'only this text' }],
    });
    const corpus = prompt.system + prompt.user;
    expect(corpus).toContain('only this text');
    expect(corpus).not.toContain('meeting');
  });

  test('clamps giant pasted turns', () => {
    const prompt = buildCompactionPrompt({
      existingSummary: null,
      turns: [{ role: 'user', body: 'y'.repeat(10_000) }],
    });
    expect(prompt.user.length).toBeLessThan(4000);
  });
});

describe('clampTurnForSummary', () => {
  test('clamps with ellipsis', () => {
    expect(clampTurnForSummary('z'.repeat(3000), 100).length).toBeLessThanOrEqual(101);
    expect(clampTurnForSummary('short')).toBe('short');
  });
});

describe('formatSummaryBlockForPrompt', () => {
  test('labels the block as protected state rather than source authority', () => {
    const block = formatSummaryBlockForPrompt('Facts & context: …');
    expect(block).toContain('Protected conversation state');
    expect(block).toContain('not source or action authority');
  });
});

describe('sanitizeSummaryOutput', () => {
  test('null for empty, clamps oversized', () => {
    expect(sanitizeSummaryOutput('   ')).toBeNull();
    expect(sanitizeSummaryOutput('ok')).toBe('ok');
    expect(sanitizeSummaryOutput('a'.repeat(10_000))?.length).toBeLessThanOrEqual(6001);
  });
});

describe('protocol-safe compaction receipts', () => {
  test('moves the watermark backward instead of splitting a user/assistant protocol unit', () => {
    const messages = Array.from({ length: 18 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      body: 'x'.repeat(1000),
    }));
    messages[5]!.role = 'user';
    const plan = planCompaction({
      messages,
      existingSummary: null,
      triggerTokens: 1000,
      tailMessages: 12,
    });
    expect(plan.toSummarize.map((message) => message.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(plan.upToMessageId).toBe('m3');
  });

  test('preserves objective, corrections, source versions, partial status and pending proposal handles', () => {
    const state = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'a2',
      clientId: 'client-1',
      messages: [
        { id: 'u1', role: 'user', body: 'Prepare a two-page client memo.' },
        {
          id: 'a1',
          role: 'assistant',
          body: 'PRIVATE SOURCE BODY MUST NOT SURVIVE',
          metadata: {
            finishReason: 'completed',
            citations: [
              {
                sourceId: 'source-1',
                sourceVersion: 'version-7',
                snippet: 'REVOKED PRIVATE EXCERPT',
              },
            ],
            trustSteps: [{ tool: 'read_client_documents', status: 'done' }],
            pendingApprovals: [
              { proposalId: 'proposal-1', tool: 'send_email', status: 'proposed' },
            ],
          },
        },
        {
          id: 'u2',
          role: 'user',
          body: 'Correction: use only enacted FY2027 amounts; never call requests enacted.',
        },
        {
          id: 'a2',
          role: 'assistant',
          body: 'Interrupted private draft.',
          metadata: { finishReason: 'deadline_exceeded', partial: true },
        },
      ],
    });
    const replay = protocolCompactionReplay({
      metadata: { [MERI_PROTOCOL_COMPACTION_METADATA_KEY]: state },
      boundaryMessageId: 'a2',
      clientId: 'client-1',
    });

    expect(replay).toContain('Prepare a two-page client memo.');
    expect(replay).toContain('use only enacted FY2027 amounts');
    expect(replay).toContain('source-1 version=version-7');
    expect(replay).toContain('proposal-1 tool=send_email observed=proposed');
    expect(replay).toContain('finish=deadline_exceeded partial=true');
    expect(state.status).toBe('partial');
    for (const forbidden of [
      'PRIVATE SOURCE BODY MUST NOT SURVIVE',
      'REVOKED PRIVATE EXCERPT',
      'Interrupted private draft.',
    ]) {
      expect(replay).not.toContain(forbidden);
    }
  });

  test('fails closed when historical metadata cannot prove the boundary or current client', () => {
    const staleState = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'old-boundary',
      clientId: 'old-client',
      messages: [
        { id: 'u1', role: 'user', body: 'Old instruction' },
        { id: 'a1', role: 'assistant', body: 'Revoked private body' },
      ],
    });
    const replay = protocolCompactionReplay({
      metadata: { [MERI_PROTOCOL_COMPACTION_METADATA_KEY]: staleState },
      boundaryMessageId: 'new-boundary',
      clientId: 'new-client',
    });
    expect(replay).toContain('PARTIAL (fail closed)');
    expect(replay).toContain('was not replayed');
    expect(replay).not.toContain('Old instruction');
    expect(replay).not.toContain('Revoked private body');
  });

  test('bounds a huge provider payload without claiming an unavailable message retriever', () => {
    const replay = boundReplayMessageBody({ id: 'huge-output', body: 'z'.repeat(100_000) }, 2000);
    expect(replay.length).toBeLessThanOrEqual(2000);
    expect(replay).toContain('characters were omitted');
    expect(replay).toContain('Ask the user to restate');
    expect(replay).not.toContain('retrieve that message');
  });

  test('allocates the 81-message counterexample on a complete boundary under one aggregate cap', () => {
    const messages = Array.from({ length: 81 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      body: `${index}:`.padEnd(60_000, 'x'),
    }));
    const protectedStateChars = 12_000;
    const allocation = allocateBoundedReplayHistory(messages, {
      maxChars: MAX_REPLAY_HISTORY_CHARS,
      protectedStateChars,
    });

    expect(allocation.history[0]?.role).toBe('user');
    expect(allocation.history.at(-1)?.id).toBe('m80');
    expect(allocation.history.at(-1)?.role).toBe('user');
    expect(
      allocation.history.reduce((sum, message) => sum + message.body.length, protectedStateChars),
    ).toBeLessThanOrEqual(MAX_REPLAY_HISTORY_CHARS);
    expect(allocation.omittedMessages).toBeGreaterThan(0);
    expect(allocation.history.map((message) => message.body).join('\n')).toContain(
      'Ask the user to restate',
    );
  });

  test('retains a contiguous newest suffix instead of backfilling around an oversized middle unit', () => {
    const exactBody = (prefix: string, length: number, fill: string) => prefix.padEnd(length, fill);
    const bodies = {
      u0: exactBody('FIRST_GOAL: preserve this oldest objective exactly.', 100, '0'),
      a0: exactBody('ACK_FIRST_GOAL: oldest objective received.', 100, 'A'),
      u1: exactBody(
        'MISSING_MIDDLE_CONSTRAINT: never infer that a requested amount was enacted.',
        450,
        '1',
      ),
      a1: exactBody('MIDDLE_ASSISTANT: acknowledged the middle constraint.', 450, 'B'),
      u2: exactBody('RECENT_REQUEST: prepare the bounded replay.', 100, '2'),
      a2: exactBody('RECENT_RESPONSE: bounded replay prepared.', 100, 'C'),
      u3: exactBody('LATEST_PENDING_USER: apply the retained constraints now.', 100, '3'),
    };
    const allocation = allocateBoundedReplayHistory(
      [
        { id: 'u0', role: 'user', body: bodies.u0 },
        { id: 'a0', role: 'assistant', body: bodies.a0 },
        { id: 'u1', role: 'user', body: bodies.u1 },
        { id: 'a1', role: 'assistant', body: bodies.a1 },
        { id: 'u2', role: 'user', body: bodies.u2 },
        { id: 'a2', role: 'assistant', body: bodies.a2 },
        { id: 'u3', role: 'user', body: bodies.u3 },
      ],
      { maxChars: 1200, protectedStateChars: 100 },
    );

    expect(allocation.history.map((message) => message.id)).toEqual(['u2', 'a2', 'u3']);
    expect(allocation.history[0]?.body).toMatch(
      /^\[SERVER REPLAY NOTICE: 4 older conversation message\(s\) and 1100 characters were omitted/,
    );
    expect(allocation.history[0]?.body.endsWith(bodies.u2)).toBe(true);
    expect(allocation.history[1]?.body).toBe(bodies.a2);
    expect(allocation.history[2]?.body).toBe(bodies.u3);
    expect(allocation.omittedMessages).toBe(4);
    expect(allocation.omittedCharacters).toBe(1100);
    expect(allocation.totalChars + 100).toBeLessThanOrEqual(1200);
    expect(allocation.history.map((message) => message.body).join('\n')).not.toContain(
      'FIRST_GOAL',
    );
    expect(allocation.history.map((message) => message.body).join('\n')).not.toContain(
      'MISSING_MIDDLE_CONSTRAINT',
    );
  });

  test('preserves the contiguous suffix when the omission notice evicts another unit', () => {
    const messages = [
      { id: 'u0', role: 'user' as const, body: 'old-user'.padEnd(150, '0') },
      { id: 'a0', role: 'assistant' as const, body: 'old-assistant'.padEnd(150, 'A') },
      { id: 'u1', role: 'user' as const, body: 'middle-user'.padEnd(50, '1') },
      { id: 'a1', role: 'assistant' as const, body: 'middle-assistant'.padEnd(50, 'B') },
      { id: 'u2', role: 'user' as const, body: 'newest-user'.padEnd(50, '2') },
      { id: 'a2', role: 'assistant' as const, body: 'newest-assistant'.padEnd(50, 'C') },
      { id: 'u3', role: 'user' as const, body: 'pending-user'.padEnd(50, '3') },
    ];
    const allocation = allocateBoundedReplayHistory(messages, {
      maxChars: 600,
      protectedStateChars: 100,
    });

    expect(allocation.history.map((message) => message.id)).toEqual(['u2', 'a2', 'u3']);
    expect(allocation.omittedMessages).toBe(4);
    expect(allocation.history[0]?.body).toContain(
      'SERVER REPLAY NOTICE: 4 older conversation message(s)',
    );
    expect(allocation.totalChars + 100).toBeLessThanOrEqual(600);
  });

  test('keeps the pending identity and the aggregate envelope at the exact 120/100 boundary', () => {
    const exactBody = (prefix: string, length: number, fill: string) => prefix.padEnd(length, fill);
    const messages = [
      { id: 'u0', role: 'user' as const, body: exactBody('FIRST_GOAL', 100, '0') },
      { id: 'a0', role: 'assistant' as const, body: exactBody('ACK_FIRST_GOAL', 100, 'A') },
      {
        id: 'u1',
        role: 'user' as const,
        body: exactBody('MISSING_MIDDLE_CONSTRAINT', 450, '1'),
      },
      { id: 'a1', role: 'assistant' as const, body: exactBody('MIDDLE_ASSISTANT', 450, 'B') },
      { id: 'u2', role: 'user' as const, body: exactBody('RECENT_REQUEST', 100, '2') },
      { id: 'a2', role: 'assistant' as const, body: exactBody('RECENT_RESPONSE', 100, 'C') },
      {
        id: 'u3',
        role: 'user' as const,
        body: exactBody('LATEST_PENDING_USER', 100, '3'),
      },
    ];

    const allocation = allocateBoundedReplayHistory(messages, {
      maxChars: 120,
      protectedStateChars: 100,
    });

    expect(allocation.history.map((message) => message.id)).toEqual(['u3']);
    expect(allocation.history[0]?.body).toMatch(/^LATEST_PENDING/);
    expect(allocation.omittedMessages).toBe(6);
    expect(allocation.omittedCharacters).toBe(1381);
    expect(allocation.totalChars).toBe(20);
    expect(allocation.totalChars + 100).toBeLessThanOrEqual(120);
  });

  test('charges the notice separator at no-pending exact-fit and protected-state boundaries', () => {
    const messages = [
      { id: 'u0', role: 'user' as const, body: 'u'.repeat(400) },
      { id: 'a0', role: 'assistant' as const, body: 'a'.repeat(400) },
      { id: 'u1', role: 'user' as const, body: 'x'.repeat(30) },
      { id: 'a1', role: 'assistant' as const, body: 'y'.repeat(30) },
    ];

    for (const { maxChars, protectedStateChars } of [
      { maxChars: 334, protectedStateChars: 0 },
      { maxChars: 335, protectedStateChars: 0 },
      { maxChars: 434, protectedStateChars: 100 },
      { maxChars: 435, protectedStateChars: 100 },
    ]) {
      const allocation = allocateBoundedReplayHistory(messages, {
        maxChars,
        protectedStateChars,
      });
      expect(allocation.history.map((message) => message.id)).toEqual([
        'server-bounded-replay-notice',
      ]);
      expect(allocation.omittedMessages).toBe(4);
      expect(allocation.omittedCharacters).toBe(860);
      expect(allocation.totalChars + protectedStateChars).toBeLessThanOrEqual(maxChars);
    }

    for (const { maxChars, protectedStateChars } of [
      { maxChars: 336, protectedStateChars: 0 },
      { maxChars: 436, protectedStateChars: 100 },
    ]) {
      const allocation = allocateBoundedReplayHistory(messages, {
        maxChars,
        protectedStateChars,
      });
      expect(allocation.history.map((message) => message.id)).toEqual(['u1', 'a1']);
      expect(allocation.history[0]?.body).toMatch(/^\[SERVER REPLAY NOTICE:/);
      expect(allocation.history[0]?.body.endsWith('x'.repeat(30))).toBe(true);
      expect(allocation.omittedMessages).toBe(2);
      expect(allocation.omittedCharacters).toBe(800);
      expect(allocation.totalChars).toBe(336);
      expect(allocation.totalChars + protectedStateChars).toBe(maxChars);
    }
  });

  test('charges the separator for the first retained pair instead of an empty or tiny pending body', () => {
    const complete = [
      { id: 'u0', role: 'user' as const, body: 'u'.repeat(400) },
      { id: 'a0', role: 'assistant' as const, body: 'a'.repeat(400) },
      { id: 'u1', role: 'user' as const, body: 'x'.repeat(30) },
      { id: 'a1', role: 'assistant' as const, body: 'y'.repeat(30) },
    ];

    for (const { body, maxChars } of [
      { body: '', maxChars: 334 },
      { body: 'p', maxChars: 335 },
    ]) {
      const allocation = allocateBoundedReplayHistory(
        [...complete, { id: 'u2', role: 'user', body }],
        { maxChars },
      );
      expect(allocation.history.map((message) => message.id)).toEqual(['u2']);
      expect(allocation.history[0]?.body.endsWith(body)).toBe(true);
      expect(allocation.omittedMessages).toBe(4);
      expect(allocation.omittedCharacters).toBe(860);
      expect(allocation.totalChars).toBeLessThanOrEqual(maxChars);
    }

    for (const { body, maxChars } of [
      { body: '', maxChars: 336 },
      { body: 'p', maxChars: 337 },
    ]) {
      const allocation = allocateBoundedReplayHistory(
        [...complete, { id: 'u2', role: 'user', body }],
        { maxChars },
      );
      expect(allocation.history.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
      expect(allocation.history.at(-1)).toEqual({ id: 'u2', role: 'user', body });
      expect(allocation.omittedMessages).toBe(2);
      expect(allocation.omittedCharacters).toBe(800);
      expect(allocation.totalChars).toBe(maxChars);
    }
  });

  test('rejects invalid budgets and an already-over-budget protected state explicitly', () => {
    const pending = [{ id: 'u0', role: 'user' as const, body: 'pending' }];
    for (const maxChars of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(() => allocateBoundedReplayHistory(pending, { maxChars })).toThrow(RangeError);
    }
    for (const protectedStateChars of [Number.NaN, Number.POSITIVE_INFINITY, -1, 121]) {
      expect(() =>
        allocateBoundedReplayHistory(pending, { maxChars: 120, protectedStateChars }),
      ).toThrow(RangeError);
    }
  });

  test('uses a zero-character tail without exceeding a protected state that exactly fills the cap', () => {
    const allocation = allocateBoundedReplayHistory(
      [{ id: 'pending', role: 'user', body: 'retain my identity' }],
      { maxChars: 100, protectedStateChars: 100 },
    );

    expect(allocation.history).toEqual([{ id: 'pending', role: 'user', body: '' }]);
    expect(allocation.omittedMessages).toBe(0);
    expect(allocation.omittedCharacters).toBe('retain my identity'.length);
    expect(allocation.totalChars + 100).toBe(100);
  });

  test('preserves an only-pending request exactly when it fits and meaningfully when it does not', () => {
    const pending = {
      id: 'pending-only',
      role: 'user' as const,
      body: 'LATEST_PENDING_ONLY: preserve this request.',
    };

    const fitting = allocateBoundedReplayHistory([pending], { maxChars: 80 });
    expect(fitting.history).toEqual([pending]);
    expect(fitting.omittedMessages).toBe(0);
    expect(fitting.omittedCharacters).toBe(0);

    const tight = allocateBoundedReplayHistory([pending], {
      maxChars: 120,
      protectedStateChars: 100,
    });
    expect(tight.history.map((message) => message.id)).toEqual(['pending-only']);
    expect(tight.history[0]?.body).toMatch(/^LATEST_PENDING_ONLY/);
    expect(tight.history[0]?.body.endsWith('…')).toBe(true);
    expect(tight.omittedMessages).toBe(0);
    expect(tight.omittedCharacters).toBe(pending.body.length - 19);
    expect(tight.totalChars + 100).toBeLessThanOrEqual(120);
  });

  test('uses a standalone notice rather than returning half a pair when all pairs are omitted', () => {
    const messages = [
      { id: 'u0', role: 'user' as const, body: 'old request'.padEnd(200, 'u') },
      { id: 'a0', role: 'assistant' as const, body: 'old response'.padEnd(200, 'a') },
    ];
    const allocation = allocateBoundedReplayHistory(messages, {
      maxChars: 400,
      protectedStateChars: 100,
    });

    expect(allocation.history.map((message) => message.id)).toEqual([
      'server-bounded-replay-notice',
    ]);
    expect(allocation.history[0]?.body).toContain('2 older conversation message(s)');
    expect(allocation.omittedMessages).toBe(2);
    expect(allocation.omittedCharacters).toBe(400);
    expect(allocation.totalChars + 100).toBeLessThanOrEqual(400);
  });

  test('keeps only whole contiguous suffix units across budget, state, count, and body boundaries', () => {
    const budgets = [1, 20, 120, 600, MAX_REPLAY_HISTORY_CHARS];
    const bodyLengths = [0, 1, 19, 121, 12_001];
    const messageCounts = [0, 1, 2, 3, 8, 9];

    for (const maxChars of budgets) {
      for (const protectedStateChars of [0, Math.floor(maxChars / 2), maxChars]) {
        for (const bodyLength of bodyLengths) {
          for (const messageCount of messageCounts) {
            const messages = Array.from({ length: messageCount }, (_, index) => ({
              id: `m${index}`,
              role: index % 2 ? ('assistant' as const) : ('user' as const),
              body: `${index}:`.padEnd(bodyLength, 'x'),
            }));
            const allocation = allocateBoundedReplayHistory(messages, {
              maxChars,
              protectedStateChars,
              maxMessages: 5,
            });
            const charged = allocation.history.reduce(
              (sum, message) => sum + message.body.length,
              protectedStateChars,
            );
            expect(charged).toBeLessThanOrEqual(maxChars);
            expect(allocation.totalChars).toBe(charged - protectedStateChars);

            const pending = messageCount % 2 ? messages.at(-1)! : null;
            if (pending) expect(allocation.history.at(-1)?.id).toBe(pending.id);
            const retained = allocation.history.filter(
              (message) => message.id !== 'server-bounded-replay-notice',
            );
            const retainedPairs = pending ? retained.slice(0, -1) : retained;
            expect(retainedPairs.length % 2).toBe(0);
            for (let index = 0; index < retainedPairs.length; index += 2) {
              expect(retainedPairs[index]?.role).toBe('user');
              expect(retainedPairs[index + 1]?.role).toBe('assistant');
            }
            const originalIds = messages.map((message) => message.id);
            const retainedIds = retained.map((message) => message.id);
            expect(retainedIds.length ? originalIds.slice(-retainedIds.length) : []).toEqual(
              retainedIds,
            );
          }
        }
      }
    }
  });

  test('accounts for notice growth with a long decimal omission count', () => {
    const omittedCount = 100_005;
    const messages = [
      ...Array.from({ length: omittedCount }, (_, index) => ({
        id: `orphan-${index}`,
        role: 'assistant' as const,
        body: 'x',
      })),
      { id: 'pending', role: 'user' as const, body: 'Keep the pending request meaningful.' },
    ];
    const allocation = allocateBoundedReplayHistory(messages, {
      maxChars: 600,
      protectedStateChars: 100,
    });

    expect(allocation.history.map((message) => message.id)).toEqual(['pending']);
    expect(allocation.history[0]?.body).toContain(`${omittedCount} older conversation message(s)`);
    expect(allocation.history[0]?.body).toContain('Keep the pending request meaningful.');
    expect(allocation.omittedMessages).toBe(omittedCount);
    expect(allocation.omittedCharacters).toBe(omittedCount);
    expect(allocation.totalChars + 100).toBeLessThanOrEqual(600);
  });

  test('marks a missing or unknown finish reason partial instead of completed', () => {
    const state = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'a2',
      clientId: null,
      messages: [
        { id: 'u1', role: 'user', body: 'First request.' },
        { id: 'a1', role: 'assistant', body: 'Unclassified legacy response.', metadata: {} },
        { id: 'u2', role: 'user', body: 'Second request.' },
        {
          id: 'a2',
          role: 'assistant',
          body: 'Response with a future stop code.',
          metadata: { finishReason: 'future_provider_reason' },
        },
      ],
    });

    expect(state.status).toBe('partial');
    expect(state.completedUnits).toEqual([
      expect.objectContaining({ finishReason: 'unknown', partial: true }),
      expect.objectContaining({ finishReason: 'future_provider_reason', partial: true }),
    ]);
    expect(JSON.stringify(state)).not.toContain('"finishReason":"completed"');
  });

  test('preserves a fitting objective exactly and reports bounded active-constraint omissions', () => {
    const objective = `Prepare the exact objective ${'O'.repeat(620)} CRITICAL_FINAL_CLAUSE`;
    const messages = [
      { id: 'u-objective', role: 'user', body: objective },
      {
        id: 'a-objective',
        role: 'assistant',
        body: 'Acknowledged.',
        metadata: { finishReason: 'completed' },
      },
      ...Array.from({ length: 70 }, (_, index) => [
        {
          id: `u-correction-${index}`,
          role: 'user',
          body: `Correction: constraint ${index} must remain exact.`,
        },
        {
          id: `a-correction-${index}`,
          role: 'assistant',
          body: 'Acknowledged.',
          metadata: { finishReason: 'completed' },
        },
      ]).flat(),
    ];
    const state = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'a-correction-69',
      clientId: null,
      messages,
    });
    const replay = protocolCompactionReplay({
      metadata: { [MERI_PROTOCOL_COMPACTION_METADATA_KEY]: state },
      boundaryMessageId: 'a-correction-69',
      clientId: null,
    });

    expect(state.objective).toMatchObject({ text: objective, truncated: false });
    expect(state.corrections.map((item) => item.messageId)).toEqual(
      Array.from({ length: 64 }, (_, index) => `u-correction-${index + 6}`),
    );
    expect(state.omittedConstraintCount).toBe(6);
    expect(state.status).toBe('partial');
    expect(replay).toContain('Omitted potentially active constraints: 6');
    expect(replay).toContain('Ask the user to restate');
    expect(replay).toContain('CRITICAL_FINAL_CLAUSE');
  });

  test('keeps source receipts as whole records and reports every bounded omission', () => {
    const citations = Array.from({ length: 40 }, (_, index) => ({
      sourceId: `source-${index}-${'s'.repeat(260)}`,
      sourceVersion: `version-${index}`,
    }));
    const state = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'a1',
      clientId: null,
      messages: [
        { id: 'u1', role: 'user', body: 'Prepare the source audit.' },
        {
          id: 'a1',
          role: 'assistant',
          body: 'Source-backed response.',
          metadata: { finishReason: 'completed', citations },
        },
      ],
    });
    const replay = protocolCompactionReplay({
      metadata: { [MERI_PROTOCOL_COMPACTION_METADATA_KEY]: state },
      boundaryMessageId: 'a1',
      clientId: null,
    });

    expect(state.status).toBe('partial');
    expect(state.omittedSourceReceiptCount).toBe(40 - state.sourceReceipts.length);
    expect(state.omittedSourceReceiptCount).toBeGreaterThan(0);
    for (const receipt of state.sourceReceipts) {
      expect(replay).toContain(
        `- ${receipt.handle} version=${receipt.version ?? 'unknown'} from=${receipt.messageId}`,
      );
    }
    expect(replay).toContain(`Omitted source receipts: ${state.omittedSourceReceiptCount}`);
  });

  test('keeps bounded state across many short turns without another model call', () => {
    const messages = Array.from({ length: 160 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      body:
        index === 0
          ? 'Build the committee briefing.'
          : index % 2
            ? 'Done.'
            : `Correction: constraint ${index} must remain explicit.`,
      metadata: index % 2 ? { finishReason: 'completed' } : undefined,
    }));
    const state = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'm159',
      clientId: null,
      messages,
    });
    expect(state.objective?.text).toBe('Build the committee briefing.');
    expect(state.corrections).toHaveLength(64);
    expect(state.completedUnits).toHaveLength(24);
    expect(JSON.stringify(state).length).toBeLessThan(12_000);
  });
});
