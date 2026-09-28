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
    const replay = boundReplayMessageBody(
      { id: 'huge-output', body: 'z'.repeat(100_000) },
      2000,
    );
    expect(replay.length).toBeLessThanOrEqual(2000);
    expect(replay).toContain('characters were omitted');
    expect(replay).toContain('Ask the user to restate');
    expect(replay).not.toContain('retrieve that message');
  });

  test('allocates the 81-message counterexample on a complete boundary under one aggregate cap', () => {
    const messages = Array.from({ length: 81 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' as const : 'user' as const,
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
      { id: 'a-objective', role: 'assistant', body: 'Acknowledged.', metadata: { finishReason: 'completed' } },
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
