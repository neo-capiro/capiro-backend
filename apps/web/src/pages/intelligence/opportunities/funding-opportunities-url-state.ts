import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Every tab, filter and page number for this surface lives in the URL.
 *
 * WHY, beyond "it is nice to share links": the page has two views, six inbox
 * queues, seven explore tabs, eight filters and a cursor. Held in component state,
 * a refresh silently dropped all of it and dumped the reader back on the default
 * queue — after they had narrowed to the one row they were working on. Held in the
 * URL, a refresh, a back button, a bookmark and a link pasted to a colleague all
 * restore the same view.
 *
 * The helpers below are deliberately thin. They exist so that "absent" and "empty
 * string" collapse to the same thing in one place: a param written as `''` would
 * otherwise survive in the URL as a bare `&agency=`, and the next reader would see
 * a filter chip for a filter that filters nothing.
 */

/** Params written by a filter/tab interaction, which must not stack history entries. */
const REPLACE = { replace: true } as const;

export interface UrlState {
  get(key: string): string | null;
  /** `null` or `''` REMOVES the key rather than writing an empty value. */
  set(patch: Record<string, string | number | null | undefined>): void;
}

export function useUrlState(): UrlState {
  const [searchParams, setSearchParams] = useSearchParams();

  const get = useCallback((key: string) => searchParams.get(key), [searchParams]);

  const set = useCallback(
    (patch: Record<string, string | number | null | undefined>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      setSearchParams(next, REPLACE);
    },
    [searchParams, setSearchParams],
  );

  return useMemo(() => ({ get, set }), [get, set]);
}

/** A param constrained to a known vocabulary. An unknown value falls back rather than 404s. */
export function readEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** A comma-separated multi-select param, filtered to the known vocabulary. */
export function readEnumList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is T => (allowed as readonly string[]).includes(v));
}

/** A bounded integer param. Anything unparseable or out of range becomes null. */
export function readInt(raw: string | null, min: number, max: number): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
