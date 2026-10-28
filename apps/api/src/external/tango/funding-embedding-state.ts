import { object, stable, type RecordData } from './funding-catalog.mapper.js';

// These are the canonical fields used by embed-funding-catalog's body and
// source metadata. Observing an unchanged record must not recreate its backlog.
const INPUTS = {
  grant: ['title','agency','description','eligibilityText','eligibility','url'],
  notice: ['title','agency','description','setAside','naicsCode','pscCode','sourceUrl'],
} as const;
function refreshed(existing: RecordData, clock: string, now: Date): { embeddedAt?: Date } {
  return existing.embeddedContentHash && existing.embeddedAt instanceof Date && existing[clock] instanceof Date
    && existing.embeddedAt >= existing[clock] ? { embeddedAt: now } : {};
}
export function catalogEmbeddingState(existing: RecordData | null, fields: RecordData, kind: keyof typeof INPUTS, now: Date): { embeddedAt?: Date | null } {
  if (!existing) return {};
  const next = { ...existing, ...fields };
  if (INPUTS[kind].some(key => stable(existing[key]) !== stable(next[key]))) return { embeddedAt: null };
  return refreshed(existing, kind === 'grant' ? 'syncedAt' : 'lastSyncedAt', now);
}
export function attachmentEmbeddingState(existing: RecordData | null, fields: RecordData, now: Date): { embeddedAt?: Date | null } {
  if (!existing) return {};
  const next = { ...existing, ...fields };
  // Local PDF text can be published by the archive worker concurrently. Only
  // paid-text inputs can be proved unchanged from this catalog observation.
  if (String(object(next.providerData).extracted_text ?? '').trim().length <= 10) return { embeddedAt: null };
  const keys = ['samOpportunityId','federalGrantId','providerAttachmentId','sourceUrl','fileName','providerData'];
  if (keys.some(key => stable(existing[key]) !== stable(next[key]))) return { embeddedAt: null };
  return refreshed(existing, 'providerObservedAt', now);
}
