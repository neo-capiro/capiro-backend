export const DAY_MS = 86_400_000;

export const MAX_ACTIONS = 50;

export const MAX_VOTES = 25;

export const MAX_HEARINGS = 20;

export const MAX_FISCAL_NOTES = 10;

export const NO_TARGET_VOTE = 'No roll call vote has been recorded on this bill.';

export function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toIso(d: Date | null | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export function capitalize(s: string | null): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function byDateDesc(a: { date: string | null }, b: { date: string | null }): number {
  return (b.date ?? '').localeCompare(a.date ?? '');
}
