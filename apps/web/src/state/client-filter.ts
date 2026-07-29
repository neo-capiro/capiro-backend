import { useCallback, useEffect, useState } from 'react';

/**
 * Global client-view filter for top-level work surfaces.
 *
 * This is intentionally in-memory only: a fresh page load starts with no
 * selected client so users see all available data by default.
 */
let selectedClientId: string | null = null;
let listeners: Array<() => void> = [];

function notify() {
  for (const listener of listeners) listener();
}

function write(clientId: string | null) {
  selectedClientId = clientId;
  notify();
}

/** Imperative bridge for source-context actions that open Meri outside React. */
export function setGlobalClientFilter(clientId: string | null): void {
  write(clientId);
}

export function useClientFilter() {
  const [selected, setSelected] = useState<string | null>(selectedClientId);
  const setSelectedClientId = useCallback((clientId: string | null) => write(clientId), []);
  const clearClientFilter = useCallback(() => write(null), []);

  useEffect(() => {
    const listener = () => setSelected(selectedClientId);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((entry) => entry !== listener);
    };
  }, []);

  return {
    selectedClientId: selected,
    setSelectedClientId,
    clearClientFilter,
  };
}
