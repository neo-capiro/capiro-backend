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

export function threadScopeSubline(clientName: string | null | undefined): string {
  if (clientName?.trim()) return `Scoped · ${titleCaseWords(clientName)}`;
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
