import type {
  CanonicalSourceKind,
  CanonicalSourceSyncStatus,
} from './canonical-source-adapter.types.js';

export type CanonicalBackfillSource =
  | 'confirmed_client_mapping'
  | 'client'
  | 'client_person'
  | 'engagement_contact';

export interface CanonicalSourceBackfillOptions {
  source: CanonicalBackfillSource;
  afterId?: string | null;
  limit?: number;
  dryRun?: boolean;
  actorUserId?: string | null;
}

export interface CanonicalSourceBackfillFailure {
  sourceKind: CanonicalSourceKind;
  sourceId: string;
  errorCode: string;
}

export interface CanonicalSourceBackfillPageResult {
  tenantId: string;
  source: CanonicalBackfillSource;
  dryRun: boolean;
  scanned: number;
  counts: Record<CanonicalSourceSyncStatus, number>;
  failures: CanonicalSourceBackfillFailure[];
  nextCursor: string | null;
  complete: boolean;
}
