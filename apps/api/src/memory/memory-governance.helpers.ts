// Institutional Memory — Phase 4 governance helpers (plan §11.2, §6).
//
// Retention is NOT enforced in v1 (Neo: no regulation yet), but the metadata
// hook IS enforced now so a future purge/redaction/e-discovery job can target
// notes precisely. These pure selectors operate on item metadata only — the
// service layer turns a selection into actual deletes/exports later.
//
// Design: every selector is a pure predicate over MemoryItem metadata
// (tenantId, clientId, ownerUserId, type, createdAt). That metadata is the only
// thing a governance job needs (plan §11.2 "cheap hedge").

import type { MemoryItem } from './memory.types.js';

export interface RetentionPolicy {
  /** Max age in days before an item is eligible for purge; null = keep forever. */
  maxAgeDays: number | null;
  /** Item types this policy applies to; empty = all types. */
  types: string[];
}

/** Items eligible for purge under a policy, as of `now`. Pure.
 *  A legal hold (Phase 1, blueprint §5.4) always wins: a held item is never
 *  eligible for any purge selector, regardless of age or scope. */
export function selectForPurge(
  items: MemoryItem[],
  policy: RetentionPolicy,
  now: Date,
): MemoryItem[] {
  if (policy.maxAgeDays === null) return [];
  const cutoff = now.getTime() - policy.maxAgeDays * 86_400_000;
  return items.filter((i) => {
    if (i.legalHold) return false;
    if (policy.types.length > 0 && !policy.types.includes(i.type)) return false;
    return new Date(i.createdAt).getTime() < cutoff;
  });
}

/** Right-to-delete on client offboarding: every item scoped to the client,
 *  excluding anything under legal hold. */
export function selectForClientPurge(items: MemoryItem[], clientId: string): MemoryItem[] {
  return items.filter((i) => i.clientId === clientId && !i.legalHold);
}

/** Right-to-delete on user offboarding: that user's PRIVATE items only,
 *  excluding anything under legal hold. Firm-shared items they authored are
 *  NOT purged (they belong to the firm). */
export function selectForUserPurge(items: MemoryItem[], userId: string): MemoryItem[] {
  return items.filter((i) => i.visibility === 'user' && i.ownerUserId === userId && !i.legalHold);
}

/** e-discovery / legal hold: every item touching a client, for export. The
 *  selection is intentionally broad (hold preserves; it does not delete). */
export function selectForLegalHold(items: MemoryItem[], clientId: string): MemoryItem[] {
  return items.filter((i) => i.clientId === clientId);
}

/** A redaction directive: which section bodies to blank, by key. Pure shaping. */
export function redactSections(item: MemoryItem, sectionKeys: string[]): MemoryItem {
  const keys = new Set(sectionKeys);
  return {
    ...item,
    sections: item.sections.map((s) =>
      keys.has(s.key) ? { ...s, body: '[redacted]' } : s,
    ),
  };
}

/** Export manifest row — what an e-discovery dump records per item (provenance). */
export interface ExportManifestRow {
  id: string;
  type: string;
  clientId: string | null;
  ownerUserId: string | null;
  visibility: string;
  source: string;
  sourceRef: string | null;
  provenance: string;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export function toManifestRow(item: MemoryItem): ExportManifestRow {
  return {
    id: item.id,
    type: item.type,
    clientId: item.clientId,
    ownerUserId: item.ownerUserId,
    visibility: item.visibility,
    source: item.source,
    sourceRef: item.sourceRef,
    provenance: item.provenance,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: item.status,
  };
}

/** Items eligible to appear in a GET /memory/export manifest — excludes
 *  anything explicitly marked non-exportable (blueprint §5.4 "structured
 *  export of a customer's own data"; not every item a tenant can see is
 *  necessarily theirs to re-export, e.g. a future restricted-scope class). */
export function selectForExport(items: MemoryItem[]): MemoryItem[] {
  return items.filter((i) => i.exportable);
}
