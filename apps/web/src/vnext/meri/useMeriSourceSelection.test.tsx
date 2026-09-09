import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import { useMeriSourceSelection } from './useMeriSourceSelection.js';

const scope = { kind: 'client' as const, clientId: 'original-client', clientName: 'Original client', targetHint: null };
const message: ChatMessage = { id: 'turn-1', role: 'assistant', content: 'Private answer', createdAt: new Date(), turnScope: scope,
  citations: [{ n: 1, id: 'record-a', title: 'Private source A', snippet: 'Private excerpt A', type: 'memory', tool: 'search_memory', url: null },
    { n: 2, id: 'record-b', title: 'Private source B', snippet: 'Private excerpt B', type: 'memory', tool: 'search_memory', url: null }] };
const initial = { tenantId: 'tenant', userId: 'user', conversationId: 'thread', messages: [message] };

describe('source selection reload and navigation', () => {
  beforeEach(() => sessionStorage.clear());

  it('restores the exact turn and next source after delayed message hydration, storing no content or scope', () => {
    const first = renderHook(() => useMeriSourceSelection(initial));
    act(() => first.result.current.open(message.citations!, 0, scope));
    act(() => first.result.current.changeIndex(1));
    expect(JSON.parse(sessionStorage.getItem('meri-source-selection:tenant:user')!)).toEqual({
      conversationId: 'thread', messageId: 'turn-1', citationNumber: 2,
    });
    first.unmount();
    const reloaded = renderHook((props) => useMeriSourceSelection(props), { initialProps: { ...initial, messages: [] as ChatMessage[] } });
    expect(reloaded.result.current.active).toBeNull();
    reloaded.rerender({ ...initial, messages: [{ ...message, citations: message.citations!.map((row) => ({ ...row })) }] });
    expect(reloaded.result.current.active).toMatchObject({ index: 1, turnScope: scope });
    expect(reloaded.result.current.active?.citations[1]?.id).toBe('record-b');
    act(() => reloaded.result.current.changeIndex(0));
    expect(reloaded.result.current.active?.index).toBe(0);
  });

  it('clears the panel across thread, tenant and user boundaries', () => {
    const hook = renderHook((props) => useMeriSourceSelection(props), { initialProps: initial });
    act(() => hook.result.current.open(message.citations!, 0, scope));
    hook.rerender({ ...initial, conversationId: 'other-thread' });
    expect(hook.result.current.active).toBeNull();
    hook.rerender({ ...initial, userId: 'other-user' });
    expect(hook.result.current.active).toBeNull();
    hook.rerender({ ...initial, tenantId: 'other-tenant' });
    expect(hook.result.current.active).toBeNull();
  });

  it('Back removes the locator and cannot reopen on reload', () => {
    const hook = renderHook(() => useMeriSourceSelection(initial));
    act(() => hook.result.current.open(message.citations!, 0, scope));
    act(() => hook.result.current.close());
    hook.unmount();
    expect(renderHook(() => useMeriSourceSelection(initial)).result.current.active).toBeNull();
  });

  it('does not substitute another answer or citation when the saved selection is missing', () => {
    sessionStorage.setItem('meri-source-selection:tenant:user', JSON.stringify({
      conversationId: 'thread', messageId: 'turn-1', citationNumber: 99,
    }));
    const hook = renderHook((props) => useMeriSourceSelection(props), { initialProps: initial });
    expect(hook.result.current.active).toBeNull();
    hook.rerender({ ...initial, messages: [{ ...message, id: 'turn-2' }] });
    expect(hook.result.current.active).toBeNull();
  });
});
