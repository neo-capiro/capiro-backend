export interface CapabilityProvenance {
  recordType: string;
  recordId: string;
  sourceSystem: string;
  sourceDocument?: string | null;
  sourceDate?: string | null;
  lastVerifiedAt?: string | null;
  retrievedAt: string;
  verificationClass: 'first_party' | 'authoritative' | 'derived' | 'unverified';
  classification: 'fact' | 'inference' | 'recommendation' | 'instruction';
}

/** Exclusions intentionally carry no inaccessible object identifiers. */
export interface CapabilityExclusion {
  category: string;
  reasonCode: string;
  count: number;
}

export interface CapabilityResult<T> {
  capability: string;
  schemaVersion: number;
  data: T;
  provenance: CapabilityProvenance[];
  exclusions: CapabilityExclusion[];
  scope: {
    tenantId: string;
    clientId?: string | null;
  };
  freshness: {
    asOf: string;
    degraded: boolean;
    reasons: string[];
  };
  authorization: {
    filtered: boolean;
    restrictedCount: number;
  };
}

export function assertCapabilityResult<T>(
  value: unknown,
  capability: string,
): CapabilityResult<T> {
  if (!value || typeof value !== 'object') throw new Error('capability result is required');
  const result = value as Partial<CapabilityResult<T>>;
  if (result.capability !== capability) throw new Error('capability result name mismatch');
  if (result.schemaVersion !== 1) throw new Error('unsupported capability schema version');
  if (!Array.isArray(result.provenance) || !Array.isArray(result.exclusions)) {
    throw new Error('capability provenance envelope is required');
  }
  if (!result.scope?.tenantId || !result.freshness?.asOf || !result.authorization) {
    throw new Error('capability result envelope is incomplete');
  }
  return result as CapabilityResult<T>;
}
