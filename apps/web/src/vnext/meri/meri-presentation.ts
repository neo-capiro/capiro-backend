import type { MeriIconName } from './meri-icons.js';

const PLACEHOLDER_TITLES = new Set(['', 'chat session', 'untitled thread']);

export function isPlaceholderThreadTitle(title: string | undefined | null): boolean {
  return PLACEHOLDER_TITLES.has((title ?? '').trim().toLowerCase());
}

/**
 * Server title wins. Literal "Chat session" / empty / the list-normalizer's
 * "Untitled thread" fall back to the first available user text, trimmed to 48.
 */
export function displayThreadTitle(
  title: string | undefined | null,
  fallbackText?: string | null,
): string {
  const trimmed = title?.trim() ?? '';
  if (!isPlaceholderThreadTitle(trimmed)) return trimmed;
  const fallback = fallbackText?.replace(/\s+/g, ' ').trim() ?? '';
  if (!fallback) return trimmed || 'Untitled thread';
  return fallback.length > 48 ? `${fallback.slice(0, 48)}…` : fallback;
}

export function titleCaseWords(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (char) => char.toUpperCase());
}

/**
 * Retrieval plan metadata forwarded by the backend in the SSE `done` frame.
 * Only the fields the scope label needs are required here — the full frame
 * (coverage, domains, timeWindow, …) is typed on the SseEvent side and stays
 * optional end-to-end so legacy turns without retrieval still render.
 */
export interface RetrievalScopeMeta {
  subjectScope: 'client' | 'portfolio' | 'external_entity' | 'general' | string;
  targetHint?: string | null;
  recipeTool?: string | null;
}

/**
 * Truthful scope badge for a finished assistant turn.
 *
 * The backend retrieval plan already classifies a turn as `client`,
 * `portfolio`, `external_entity`, or `general`. The old `threadScopeSubline`
 * always printed "Scoped · <client>" regardless, which misrepresents a
 * portfolio/external/general turn as client-scoped. This function uses the
 * backend's own classification when available and only falls back to the
 * client-name sub-line when no retrieval metadata was sent.
 *
 * Returns `null` for `general` scope so the caller can omit the badge
 * entirely instead of printing a misleading client-scope label.
 */
export function threadScopeLabel(
  clientName: string | null | undefined,
  retrieval?: RetrievalScopeMeta | null,
): string | null {
  if (!retrieval) {
    // Legacy path: no retrieval metadata — keep the old sub-line semantics.
    return threadScopeSubline(clientName);
  }
  switch (retrieval.subjectScope) {
    case 'client': {
      const name = clientName?.trim() || retrieval.targetHint?.trim() || 'Unknown client';
      return `CLIENT · ${titleCaseWords(name)}`;
    }
    case 'portfolio':
      return 'PORTFOLIO · ALL CLIENTS';
    case 'external_entity': {
      const hint = retrieval.targetHint?.trim() || 'External source';
      return `EXTERNAL RESEARCH · ${titleCaseWords(hint)}`;
    }
    case 'general':
      // No misleading client-scope badge for a general-knowledge turn.
      return null;
    default:
      // Unknown subjectScope value — fall back to the legacy sub-line rather
      // than printing a wrong badge.
      return threadScopeSubline(clientName);
  }
}

/**
 * Legacy sub-line kept for backward compatibility. New callers should prefer
 * {@link threadScopeLabel}, which delegates here when no retrieval metadata
 * is available.
 *
 * The wording is "Client context · <name>" (not "Scoped · <name>") so the
 * label describes what the client selector represents — the conversation's
 * client context — without implying the backend retrieval plan was
 * client-scoped when it may not have been.
 */
export function threadScopeSubline(clientName: string | null | undefined): string {
  if (clientName?.trim()) return `Client context · ${titleCaseWords(clientName)}`;
  return 'Portfolio · All clients';
}

export function threadKindIcon(input: {
  isNew?: boolean;
  isResearch?: boolean;
  hasArtifact?: boolean;
}): MeriIconName {
  if (input.isNew) return 'Stars02';
  if (input.isResearch) return 'SearchLg';
  if (input.hasArtifact) return 'File05';
  return 'MessageTextSquare01';
}

/**
 * While a reply is still streaming, hide an unterminated fence so the raw
 * ticks and info string never print as body copy.
 */
export function visibleMarkdown(source: string, streaming: boolean): string {
  if (!streaming) return source;
  let fences = 0;
  let last = -1;
  const pattern = /```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    fences += 1;
    last = match.index;
  }
  if (fences % 2 === 1 && last >= 0) {
    return source.slice(0, last).replace(/\s+$/u, '');
  }
  return source;
}

export function formatRecordTime(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return 'TIME UNKNOWN';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function sameLocalDay(value: string | Date, now = new Date()): boolean {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function localDayKey(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayDividerLabel(value: Date | string | undefined, now = new Date()): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return 'DATE UNKNOWN';
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAgo = Math.round((today - target) / 86_400_000);
  if (daysAgo === 0) return 'TODAY';
  if (daysAgo === 1) return 'YESTERDAY';
  return date
    .toLocaleDateString([], {
      weekday: daysAgo < 7 ? 'long' : undefined,
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    })
    .toUpperCase();
}

export const MERI_LOGO_SRC = '/assets/meri-logo.png';
