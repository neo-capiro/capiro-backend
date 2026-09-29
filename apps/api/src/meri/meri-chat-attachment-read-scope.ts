import { AsyncLocalStorage } from 'node:async_hooks';

/** Server-established scope for an ordinary Meri chat turn. Model input is not
 * authority for any field in this object. The owning chat/controller path must
 * establish it around tool execution. */
export interface MeriChatAttachmentReadScope {
  tenantId: string;
  userId: string;
  conversationId: string;
  selectedClientId: string | null;
}

const scopeStorage = new AsyncLocalStorage<MeriChatAttachmentReadScope>();

export function currentMeriChatAttachmentReadScope(): MeriChatAttachmentReadScope | undefined {
  return scopeStorage.getStore();
}

export function withMeriChatAttachmentReadScope<T>(
  scope: MeriChatAttachmentReadScope,
  run: () => T,
): T {
  return scopeStorage.run(Object.freeze({ ...scope }), run);
}
