import { useEffect, useState } from 'react';
import type { ChatMessage, MeriCitation } from '../../components/chat/chat-store.js';
import { messageMeriTurnScope, type MeriTurnScope } from '../../components/chat/meri-turn-scope.js';

type Selection = { key: string; conversationId: string; messageId: string; citationNumber: number };
type Detail = { citations: MeriCitation[]; index: number; turnScope: MeriTurnScope };

/** Store only a turn/citation locator in this tab. Content and scope must come
 * from the authenticated conversation response, including after a reload. */
export function useMeriSourceSelection(input: {
  tenantId?: string; userId?: string; conversationId: string | null; messages: ChatMessage[];
}) {
  const key = input.tenantId && input.userId
    ? `meri-source-selection:${input.tenantId}:${input.userId}` : null;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [transient, setTransient] = useState<{ key: string | null; conversationId: string | null; detail: Detail } | null>(null);

  useEffect(() => {
    setTransient(null);
    let restored: Selection | null = null;
    if (key && input.conversationId) {
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (value?.conversationId === input.conversationId && typeof value.messageId === 'string' &&
          Number.isSafeInteger(value.citationNumber) && value.citationNumber > 0) {
          restored = { key, conversationId: input.conversationId, messageId: value.messageId, citationNumber: value.citationNumber };
        }
      } catch { /* Storage can be disabled or contain an obsolete locator. */ }
    }
    setSelection(restored);
  }, [key, input.conversationId]);

  const selectedMessage = selection?.key === key && selection?.conversationId === input.conversationId
    ? input.messages.find((message) => message.id === selection.messageId) : undefined;
  const selectedIndex = selectedMessage?.citations?.findIndex((citation) => citation.n === selection?.citationNumber) ?? -1;
  const active: Detail | null = selectedMessage?.citations && selectedIndex >= 0
    ? { citations: selectedMessage.citations, index: selectedIndex, turnScope: messageMeriTurnScope(selectedMessage) }
    : transient?.key === key && transient?.conversationId === input.conversationId ? transient.detail : null;

  function open(citations: MeriCitation[], index: number, turnScope: MeriTurnScope) {
    if (!citations[index]) return;
    const message = input.messages.find((row) => row.citations === citations);
    const next = key && input.conversationId && message
      ? { key, conversationId: input.conversationId, messageId: message.id, citationNumber: citations[index].n } : null;
    setSelection(next);
    setTransient(next ? null : { key, conversationId: input.conversationId, detail: { citations, index, turnScope } });
    try {
      if (key && next) sessionStorage.setItem(key, JSON.stringify({
        conversationId: next.conversationId, messageId: next.messageId, citationNumber: next.citationNumber,
      }));
      else if (key) sessionStorage.removeItem(key);
    } catch { /* Source navigation works without browser storage. */ }
  }

  function close() {
    setSelection(null);
    setTransient(null);
    try { if (key) sessionStorage.removeItem(key); } catch { /* Best effort. */ }
  }

  return { active, open, close, changeIndex: (index: number) => {
    if (active) open(active.citations, index, active.turnScope);
  } };
}
