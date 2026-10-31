export interface OwnerHistoryEntry {
  id: string;
  revision: string;
  createdAt: string;
  title: string;
  status: 'current' | 'superseded';
  content:
    | { availability: 'available'; text: string }
    | { availability: 'unavailable'; reason: 'malformed' | 'size_limit' };
}
export interface OwnerHistoryPage {
  schemaVersion: 1;
  anchor: { kind: 'item'; id: string; revision: string };
  availability: 'available';
  entries: OwnerHistoryEntry[];
  nextCursor: string | null;
}
export interface OwnerHistoryInput {
  cursor?: unknown;
  limit?: unknown;
  visibleClientIds?: readonly string[];
}
