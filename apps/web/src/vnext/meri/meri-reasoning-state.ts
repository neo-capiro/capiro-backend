import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { meriEffectiveIdentityKey } from '../../components/chat/meri-route-guards.js';

export const MERI_REASONING_MODES = [
  { mode: 'fast', label: 'Fast', description: 'Quick answers and direct lookups.' },
  { mode: 'standard', label: 'Standard', description: 'Balanced everyday reasoning.' },
  { mode: 'deep', label: 'Deep', description: 'More investigation for strategic work.' },
  { mode: 'max', label: 'Max', description: 'Highest configured reasoning tier.' },
] as const;

export type MeriReasoningMode = (typeof MERI_REASONING_MODES)[number]['mode'];

export function isMeriReasoningMode(value: unknown): value is MeriReasoningMode {
  return MERI_REASONING_MODES.some((option) => option.mode === value);
}

type ReasoningApi = {
  get: <T>(url: string) => Promise<{ data: T }>;
  patch: (url: string, body: unknown) => Promise<unknown>;
};
type ReasoningSnapshot = {
  mode: MeriReasoningMode;
  saving: boolean;
  error: string | null;
};
type ReasoningEntry = {
  snapshot: ReasoningSnapshot;
  confirmedMode: MeriReasoningMode | null;
  revision: number;
  needsRefresh: boolean;
  read: Promise<void> | null;
  saves: Promise<void>;
  listeners: Set<() => void>;
};

// All controls share this store. Keys include the effective tenant AND user;
// changing org, account or impersonation cannot expose another choice.
const entries = new Map<string, ReasoningEntry>();
const draftStorageKey = (identityKey: string) => `meri.vnext.draftReasoningMode:${identityKey}`;
const entryKey = (identityKey: string, conversationId: string | null) =>
  JSON.stringify([identityKey, conversationId]);

export function readDraftReasoningMode(identityKey: string): MeriReasoningMode {
  const cached = entries.get(entryKey(identityKey, null));
  if (cached) return cached.snapshot.mode;
  try {
    const raw = window.sessionStorage.getItem(draftStorageKey(identityKey));
    if (isMeriReasoningMode(raw)) return raw;
  } catch {
    // Session storage is optional; live controls still share the in-memory entry.
  }
  return 'standard';
}

function entryFor(identityKey: string, conversationId: string | null): ReasoningEntry {
  const key = entryKey(identityKey, conversationId);
  let entry = entries.get(key);
  if (!entry) {
    const mode = conversationId ? 'standard' : readDraftReasoningMode(identityKey);
    entry = {
      snapshot: { mode, saving: false, error: null },
      confirmedMode: conversationId ? null : mode,
      revision: 0,
      needsRefresh: Boolean(conversationId),
      read: null,
      saves: Promise.resolve(),
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function update(entry: ReasoningEntry, changes: Partial<ReasoningSnapshot>): void {
  entry.snapshot = { ...entry.snapshot, ...changes };
  entry.listeners.forEach((listener) => listener());
}

export function writeDraftReasoningMode(mode: MeriReasoningMode, identityKey: string): void {
  const entry = entryFor(identityKey, null);
  entry.revision += 1;
  entry.confirmedMode = mode;
  update(entry, { mode, saving: false, error: null });
  try {
    window.sessionStorage.setItem(draftStorageKey(identityKey), mode);
  } catch {
    // Best effort persistence across remounts; the shared store remains authoritative.
  }
}

export async function applyReasoningModeToConversation(
  api: Pick<ReasoningApi, 'patch'>,
  conversationId: string,
  mode: MeriReasoningMode,
): Promise<void> {
  if (!conversationId) return;
  await api.patch(
    `/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`,
    {
      reasoningMode: mode,
    },
  );
}

function load(entry: ReasoningEntry, api: ReasoningApi, conversationId: string): void {
  if (!entry.needsRefresh || entry.read || entry.snapshot.saving) return;
  entry.needsRefresh = false;
  const revision = entry.revision;
  entry.read = api
    .get<{ reasoningMode?: unknown }>(
      `/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`,
    )
    .then(({ data }) => {
      // A GET dispatched before an explicit choice must never undo that choice.
      if (entry.revision !== revision) return;
      if (!isMeriReasoningMode(data.reasoningMode)) throw new Error('Invalid reasoning mode');
      entry.confirmedMode = data.reasoningMode;
      update(entry, { mode: data.reasoningMode, error: null });
    })
    .catch(() => {
      if (entry.revision === revision) {
        update(entry, {
          error: 'The saved reasoning mode could not be loaded. Choose a mode to save it.',
        });
      }
    })
    .finally(() => {
      entry.read = null;
    });
}

async function selectMode(
  entry: ReasoningEntry,
  api: ReasoningApi,
  identityKey: string,
  conversationId: string | null,
  mode: MeriReasoningMode,
  mayDispatch: () => boolean,
): Promise<boolean> {
  if (!conversationId) {
    writeDraftReasoningMode(mode, identityKey);
    return true;
  }
  const previous = entry.snapshot.mode;
  const revision = ++entry.revision;
  update(entry, { mode, saving: true, error: null });
  let saved = false;
  // Serialize requests so a slower earlier PATCH cannot persist over a later
  // selection. Only the latest selection may settle the visible state.
  const request = entry.saves.then(async () => {
    // useApi obtains its token when dispatched. A queued write must not use
    // credentials from an identity selected since the original choice.
    if (!mayDispatch()) {
      if (entry.revision === revision) {
        update(entry, { mode: entry.confirmedMode ?? previous, saving: false, error: null });
      }
      return;
    }
    try {
      await applyReasoningModeToConversation(api, conversationId, mode);
      entry.confirmedMode = mode;
      saved = true;
      if (entry.revision === revision) update(entry, { mode, saving: false, error: null });
    } catch {
      if (entry.revision === revision) {
        update(entry, {
          mode: entry.confirmedMode ?? previous,
          saving: false,
          error: 'The reasoning mode could not be saved.',
        });
      }
    }
  });
  entry.saves = request;
  await request;
  return saved;
}

export function useMeriReasoningMode(conversationId: string | null = null) {
  const api = useApi();
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const currentIdentityRef = useRef<string | null>(identityKey);
  currentIdentityRef.current = identityKey;
  useEffect(() => {
    currentIdentityRef.current = identityKey;
    return () => {
      currentIdentityRef.current = null;
    };
  }, [identityKey]);
  const entry = useMemo(() => entryFor(identityKey, conversationId), [identityKey, conversationId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry.listeners.size && conversationId) entry.needsRefresh = true;
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [entry, conversationId],
  );
  const getSnapshot = useCallback(() => entry.snapshot, [entry]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (conversationId) load(entry, api, conversationId);
  }, [api, entry, conversationId]);
  const chooseMode = useCallback(
    (mode: MeriReasoningMode) =>
      selectMode(
        entry,
        api,
        identityKey,
        conversationId,
        mode,
        () => currentIdentityRef.current === identityKey,
      ),
    [api, entry, identityKey, conversationId],
  );
  return { ...snapshot, chooseMode };
}
