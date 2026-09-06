import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

const PREFIX = 'capiro:meri:composer-draft:';
const fallback = new Map<string, string>();
const unavailableStorageKeys = new Set<string>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

function draftKey(identityKey: string, conversationId: string | null): string {
  return `${PREFIX}${JSON.stringify([identityKey, conversationId])}`;
}

function read(key: string): string {
  if (unavailableStorageKeys.has(key)) return fallback.get(key) ?? '';
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return fallback.get(key) ?? '';
  }
}

function write(key: string, value: string): number {
  if (value) fallback.set(key, value);
  else fallback.delete(key);
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
    unavailableStorageKeys.delete(key);
  } catch {
    unavailableStorageKeys.add(key);
    // Private browsing / storage limits must not discard an in-session draft.
  }
  const revision = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, revision);
  for (const listener of listeners) listener();
  return revision;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Used by the deferred first-send handoff if the server did not accept its turn. */
export function restoreMeriComposerDraft(
  identityKey: string,
  conversationId: string | null,
  value: string,
): void {
  const key = draftKey(identityKey, conversationId);
  if (!read(key)) write(key, value);
}

/** Only the route that created a durable thread may move its unsent follow-up. */
export function moveMeriComposerDraft(
  identityKey: string,
  fromConversationId: string | null,
  toConversationId: string,
): void {
  const from = draftKey(identityKey, fromConversationId);
  const to = draftKey(identityKey, toConversationId);
  const value = read(from);
  if (!value || read(to)) return;
  write(to, value);
  write(from, '');
}

/**
 * The key is captured by each setter and submission. A delayed failure can
 * restore its originating draft even after unmount, without filling a different
 * conversation or overwriting text entered while Send was pending.
 */
export function useMeriComposerDraft(identityKey: string, conversationId: string | null) {
  const key = draftKey(identityKey, conversationId);
  const getSnapshot = useCallback(() => read(key), [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot, () => '');
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      write(key, typeof value === 'function' ? value(read(key)) : value);
    },
    [key],
  );
  const clearForSubmission = useCallback(() => {
    const value = read(key);
    const revision = write(key, '');
    return () => {
      if (revisions.get(key) === revision && !read(key)) write(key, value);
    };
  }, [key]);
  return { draft, setDraft, clearForSubmission };
}
