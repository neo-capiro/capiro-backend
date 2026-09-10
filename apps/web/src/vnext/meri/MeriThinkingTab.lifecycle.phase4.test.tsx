import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { appendChatMessage, getChatStateSnapshot, resetChatStoreForTests, setChatMessageRuntimeStatus } from '../../components/chat/chat-store.js';
import { meriRuntimeStatus, mergeMeriRuntimeStatus } from '../../components/chat/meri-runtime-status.js';
import { MeriThinkingTab } from './MeriThinkingTab.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

const base = {
  plan: 'Read the client evidence', intent: 'general', tier: 'deep' as const,
  steps: [{ tool: 'read_email', label: 'Read exact email', status: 'running' as const }],
};

describe('persisted turn lifecycle', () => {
  it.each([
    ['stop', false, 'COMPLETED'],
    ['completed', false, 'COMPLETED'],
    ['aborted', true, 'STOPPED'],
    ['cancelled', true, 'STOPPED'],
    ['error', true, 'FAILED'],
    ['runtime_error', true, 'FAILED'],
    ['max_output_tokens', true, 'INCOMPLETE'],
  ])('reopens %s with its saved outcome and no running tool assertion', (finishReason, partial, label) => {
    const saved = JSON.parse(JSON.stringify({ finishReason, partial }));
    render(<MeriThinkingTab {...base} runtimeStatus={meriRuntimeStatus(saved)} />);
    expect(screen.getByText(label, { selector: '.vnext-meri__evidence-section-label' })).toBeVisible();
    expect(screen.getByText('INCOMPLETE', { selector: '.meri-agent-step__pill' })).toBeVisible();
    expect(screen.queryByText('WORKING')).not.toBeInTheDocument();
    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument();
  });

  it('keeps a metadata-free historical row neutral even if a stored step says running', () => {
    render(<MeriThinkingTab {...base} />);
    expect(screen.getByText('TURN DETAILS')).toBeVisible();
    expect(screen.queryByText('WORKING')).not.toBeInTheDocument();
    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument();
  });

  it('a completed provider round does not complete an active tool loop', () => {
    const status = meriRuntimeStatus({ type: 'runtime', telemetry: { finishReason: 'completed', partial: false } });
    render(<MeriThinkingTab {...base} runtimeStatus={status} />);
    expect(screen.getByText('WORKING')).toBeVisible();
    expect(screen.getByText('RUNNING')).toBeVisible();
    expect(screen.queryByText('COMPLETED')).not.toBeInTheDocument();
  });

  it.each(['stop', 'aborted', 'error'])('late telemetry cannot reopen saved %s or erase its final receipt', (finishReason) => {
    resetChatStoreForTests();
    const saved = meriRuntimeStatus({ finishReason, partial: finishReason !== 'stop' })!;
    appendChatMessage({ id: 'terminal-turn', role: 'assistant', content: 'Result', createdAt: new Date(), runtimeStatus: saved });
    setChatMessageRuntimeStatus('terminal-turn', meriRuntimeStatus({ type: 'runtime', telemetry: { finishReason: 'completed', partial: false } })!);
    expect(getChatStateSnapshot().messages[0]?.runtimeStatus).toMatchObject({
      lifecycle: saved.lifecycle, partial: saved.partial, stopped: saved.stopped,
    });
  });

  it('keeps provider evidence on a lifecycle-only completion and respects explicit provider omissions', () => {
    const running = meriRuntimeStatus({ type: 'runtime', reasoningMode: 'max', telemetry: {
      requestedModel: 'requested-model', effectiveModel: 'served-model',
      requestedReasoningEffort: 'max', effectiveReasoningEffort: 'high',
      reasoningFallbackReasons: ['max_unsupported'],
    } })!;
    const completed = mergeMeriRuntimeStatus(running, meriRuntimeStatus({ type: 'done', finishReason: 'completed' })!);
    expect(completed).toMatchObject({ lifecycle: 'completed', effectiveModel: 'served-model', requestedEffort: 'max', effectiveEffort: 'high', adjusted: true });
    render(<MeriThinkingTab {...base} runtimeStatus={completed} />);
    expect(screen.getByText('COMPLETED')).toBeVisible();
    expect(screen.getByText('MAX SELECTED')).toBeVisible();
    expect(screen.getByText('Final effort').nextElementSibling).toHaveTextContent('high');
    const omitted = mergeMeriRuntimeStatus(running, meriRuntimeStatus({ type: 'done', finishReason: 'completed', telemetry: {
      requestedReasoningEffort: 'max', effectiveReasoningEffort: null,
      reasoningFallbackReasons: ['reasoning_parameter_unsupported'],
    } })!);
    expect(omitted.effectiveEffort).toBeNull();
  });
});
