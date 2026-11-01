import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const digest = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const json = (v: unknown) => JSON.parse(JSON.stringify(v));
export function storedRendering(value: unknown): { html: string; text: string } {
  const rendered = object(value);
  if (typeof rendered.html !== 'string' || typeof rendered.text !== 'string')
    throw new BadRequestException('FROZEN_DRAFT_EXPORT_UNAVAILABLE');
  return { html: rendered.html, text: rendered.text };
}
export function dateOnly(v: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new BadRequestException('VALID_LEGISLATIVE_DATE_REQUIRED');
  return v;
}
export function text(v: unknown, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new BadRequestException('INVALID_TEXT');
  return v.trim();
}
export function ids(v: unknown, max = 100): string[] {
  if (
    !Array.isArray(v) ||
    v.length > max ||
    v.some((x) => typeof x !== 'string' || !x || x.length > 200)
  )
    throw new BadRequestException('INVALID_ID_SELECTION');
  return [...new Set(v as string[])];
}
export function version(v: unknown): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw new BadRequestException('EXPECTED_VERSION_REQUIRED');
  return Number(v);
}
export interface PublishedEvent {
  key: string;
  kind: string;
  sourceIdentity: string;
  revisionHash: string;
  date: string | null;
  text: string;
  order: number;
  observedAt: string;
  url: string | null;
  adopted?: boolean | null;
  notificationEligible?: boolean;
}
export interface Committee {
  id: string;
  name: string;
  current: boolean;
  date: string | null;
}
export interface RelatedBill {
  id: string | null;
  number: string | null;
  title: string | null;
  category: string;
  sourceUrl: string | null;
  actions: PublishedEvent[];
}
export interface PublishedBill {
  id: string;
  number: string;
  title: string;
  sponsor: string | null;
  jurisdiction: string;
  sessionKey: string;
  status: string | null;
  sourceUrl: string | null;
  summary: string | null;
  sourceCheckedAt: string | null;
  sourceCheckAttemptedAt: string | null;
  sourceCheckStatus: string | null;
  coverage: { actions: boolean; committees: boolean; relations: boolean; amendments: boolean };
  committees: Committee[];
  relations: RelatedBill[];
  events: PublishedEvent[];
}
export const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** Keep existing task configuration valid through the monitoring rollout. */
export function legislativeAppOrigin() {
  return (
    process.env.LEGISLATIVE_APP_ORIGIN ??
    process.env.REPORT_APP_ORIGIN ??
    'https://app.capiro.ai'
  ).replace(/\/+$/, '');
}
