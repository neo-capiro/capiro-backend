/**
 * Evidence-first contract layer (v3 plan Wave 3, ADR-1/4/5).
 *
 * The durable machine underneath the post-hoc auditor: every model-bound fact
 * becomes an immutable, content-addressed `EvidencePacket` compiled from a typed
 * truth record — never a bare authoritative field. Claims are `PlannedClaim`s
 * that reference packets by id; artifacts carry `ArtifactDependency` edges so a
 * source-version change can invalidate exactly the claims that rest on it.
 *
 * This module is the SHARED, pure contract + the first compiler adapter (PE /
 * procurement funding, generalizing RC1's `renderPeFundingForModel`) + the
 * versioned predicate registry. The dependency-graph TABLES, invalidation
 * events, and the pre-synthesis gate that CONSUMES these are later Wave-3/4
 * slices; this slice is the type system + compiler + hashing + taxonomy, fully
 * unit-tested, so those build on a fixed contract.
 */

import { currentCycleFyOf } from '@capiro/shared';

// ── Core contracts (v3 plan §3.3) ────────────────────────────────────────────

export type EvidenceEntityType =
  | 'bill'
  | 'floor_rule'
  | 'program_element'
  | 'procurement_line_item'
  | 'member'
  | 'district'
  | 'vote'
  | 'document'
  | 'client_record';

export type EvidenceStage =
  | 'request'
  | 'HASC'
  | 'SASC'
  | 'HAC-D'
  | 'SAC-D'
  | 'conference'
  | 'enacted';

export type EvidenceVehicleClass = 'request' | 'authorization' | 'appropriation';

export interface EvidenceAmount {
  value: number;
  unit: 'USD' | 'USD_thousands' | 'USD_millions';
}

export interface EvidenceComparison {
  basisEvidenceId: string;
  delta: number;
  direction: 'increase' | 'decrease' | 'flat';
}

/**
 * One immutable, content-addressed unit of retrieved truth. The auditor and the
 * pre-synthesis gate read `semantics` (never a raw payload field); `source`
 * carries the content hash + captured-at for version resolution; `provenance`
 * gates page/section precision and secondary-vs-authoritative weighting.
 */
export interface EvidencePacket {
  readonly evidenceId: string;
  readonly source: {
    tool: string;
    recordId: string;
    sourceVersion?: string;
    contentHash: string;
    capturedAt: string;
  };
  readonly entity: {
    entityType: EvidenceEntityType;
    entityId: string;
    identifierKind?: 'pe' | 'procurement_line_item' | 'bill' | 'roll_call' | 'other';
  };
  readonly semantics: {
    fiscalYear?: number;
    stage?: EvidenceStage;
    vehicleClass?: EvidenceVehicleClass;
    cycle?: 'historical' | 'current' | 'outyear';
    status?: string;
    asOf?: string;
    amount?: EvidenceAmount;
    comparison?: EvidenceComparison;
    matchBasis?: 'pe_code' | 'program_alias' | 'text' | 'structured_join';
    reviewStatus?: 'accepted' | 'candidate' | 'rejected';
  };
  readonly provenance: {
    documentId?: string;
    page?: number;
    boundingBox?: [number, number, number, number];
    sourceTextHash?: string;
    extractionMethod: 'structured_db' | 'document_parser' | 'public_web' | 'user';
    evidenceClass: 'authoritative' | 'secondary' | 'candidate' | 'user';
  };
}

export interface PlannedClaim {
  readonly claimId: string;
  readonly subject: { entityType: string; entityId: string };
  /** Constrained per the predicate taxonomy (see PREDICATE_REGISTRY). */
  readonly predicate: string;
  readonly object: unknown;
  readonly qualifiers: Record<string, string | number | boolean>;
  readonly evidenceIds: string[];
  readonly inference: boolean;
  readonly importance: 'load_bearing' | 'supporting' | 'incidental';
}

export interface ClaimPlan {
  readonly planId: string;
  readonly surface: 'chat' | 'research' | 'outreach' | 'memo' | 'alert';
  readonly claims: PlannedClaim[];
  readonly recommendations: Array<{
    recommendationId: string;
    textIntent: string;
    supportingClaimIds: string[];
  }>;
}

export interface ArtifactDependency {
  readonly artifactId: string;
  readonly claimId: string;
  readonly evidenceId: string;
  readonly sourceVersion?: string;
  readonly contentHash: string;
  readonly loadBearing: boolean;
}

// ── Content hashing (version resolution / change detection) ──────────────────

/**
 * Deterministic 64-bit FNV-1a hash of a value's canonical JSON, as a 16-char hex
 * string. Used to content-address EvidencePackets so a changed source record
 * yields a new hash (→ dependency invalidation) and an unchanged one is a cache
 * hit. This is change-detection, NOT security — a fast, dependency-free,
 * runtime-portable hash is the right tool (no node:crypto import in shared logic).
 * Keys are sorted so field order never changes the hash.
 */
export function hashEvidenceContent(value: unknown): string {
  const canonical = canonicalJson(value);
  // FNV-1a, 64-bit, via BigInt.
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Stable JSON with object keys sorted recursively (arrays keep order). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

// ── First compiler adapter: PE / procurement funding ─────────────────────────

/** One FY of funding marks — the shape RC1's renderer already produces. */
export interface FundingYearRecord {
  fy: number;
  request?: number | null;
  hascMark?: number | null;
  sascMark?: number | null;
  hacDMark?: number | null;
  sacDMark?: number | null;
  conference?: number | null;
  enacted?: number | null;
  ndaaConference?: number | null;
}

export interface PeFundingRecord {
  peCode: string;
  /** 'pe' | 'procurement_line_item' | 'other' from RC2's identifierKind. */
  identifierKind?: 'pe' | 'procurement_line_item' | 'other';
  sourceVersion?: string;
  /** ISO timestamp the record was retrieved; passed in (no clock in pure code). */
  capturedAt: string;
  currentCycleFy?: number | null;
  years: FundingYearRecord[];
}

interface StageField {
  field: keyof FundingYearRecord;
  stage: EvidenceStage | undefined; // undefined = NDAA conference (outside the ladder)
  vehicle: EvidenceVehicleClass;
}

const STAGE_FIELDS: StageField[] = [
  { field: 'request', stage: 'request', vehicle: 'request' },
  { field: 'hascMark', stage: 'HASC', vehicle: 'authorization' },
  { field: 'sascMark', stage: 'SASC', vehicle: 'authorization' },
  { field: 'ndaaConference', stage: undefined, vehicle: 'authorization' },
  { field: 'hacDMark', stage: 'HAC-D', vehicle: 'appropriation' },
  { field: 'sacDMark', stage: 'SAC-D', vehicle: 'appropriation' },
  { field: 'conference', stage: 'conference', vehicle: 'appropriation' },
  { field: 'enacted', stage: 'enacted', vehicle: 'appropriation' },
];

/**
 * Compile a PE / procurement funding record into EvidencePackets — one per
 * present figure (request + each ladder mark + NDAA conference), each carrying
 * {fiscalYear, stage, vehicleClass, cycle, amount} so no consumer ever serializes
 * a bare dollar. A same-FY mark also gets a `comparison` back to that FY's
 * request packet, with the SOURCE-DERIVED signed direction (the fix for the S1-3
 * reversal). evidenceId is deterministic (`<code>:FY:<stage>`) so re-compilation
 * is idempotent and version-comparable. Generalizes RC1's renderPeFundingForModel.
 */
export function compilePeFundingEvidence(record: PeFundingRecord): EvidencePacket[] {
  const packets: EvidencePacket[] = [];
  const cycleFy =
    record.currentCycleFy ??
    currentCycleFyOf(
      record.years.map((y) => ({
        fy: y.fy,
        request: y.request,
        hascMark: y.hascMark,
        sascMark: y.sascMark,
        hacDMark: y.hacDMark,
        sacDMark: y.sacDMark,
        conference: y.conference,
      })),
    );
  const entityType: EvidenceEntityType =
    record.identifierKind === 'procurement_line_item' ? 'procurement_line_item' : 'program_element';
  const identifierKind =
    record.identifierKind === 'procurement_line_item'
      ? 'procurement_line_item'
      : record.identifierKind === 'pe'
        ? 'pe'
        : 'other';

  const cycleOf = (fy: number): 'historical' | 'current' | 'outyear' | undefined => {
    if (cycleFy == null) return undefined;
    if (fy === cycleFy) return 'current';
    return fy > cycleFy ? 'outyear' : 'historical';
  };

  for (const y of record.years) {
    // Resolve the request packet id for same-FY comparisons.
    const requestVal = y.request;
    const requestId = requestVal != null ? `${record.peCode}:${y.fy}:request` : null;

    for (const sf of STAGE_FIELDS) {
      const raw = y[sf.field];
      if (raw == null || typeof raw !== 'number') continue;
      const stageKey = sf.stage ?? 'ndaa_conference';
      const evidenceId = `${record.peCode}:${y.fy}:${stageKey}`;
      const isMark = sf.field !== 'request';
      const comparison: EvidenceComparison | undefined =
        isMark && requestVal != null && requestId != null
          ? {
              basisEvidenceId: requestId,
              delta: raw - requestVal,
              direction: raw > requestVal ? 'increase' : raw < requestVal ? 'decrease' : 'flat',
            }
          : undefined;
      packets.push({
        evidenceId,
        source: {
          tool: 'get_pe_budget_timeline',
          recordId: record.peCode,
          sourceVersion: record.sourceVersion,
          contentHash: hashEvidenceContent({
            code: record.peCode,
            fy: y.fy,
            stage: stageKey,
            value: raw,
          }),
          capturedAt: record.capturedAt,
        },
        entity: { entityType, entityId: record.peCode, identifierKind },
        semantics: {
          fiscalYear: y.fy,
          stage: sf.stage,
          vehicleClass: sf.vehicle,
          cycle: cycleOf(y.fy),
          amount: { value: raw, unit: 'USD_millions' },
          comparison,
        },
        provenance: {
          extractionMethod: 'structured_db',
          evidenceClass: 'authoritative',
        },
      });
    }
  }
  return packets;
}

/** Convenience: the funding vehicle for a ladder stage key (mirrors the shared map). */
export function vehicleClassForStage(stage: EvidenceStage): EvidenceVehicleClass {
  const map: Record<EvidenceStage, EvidenceVehicleClass> = {
    request: 'request',
    HASC: 'authorization',
    SASC: 'authorization',
    'HAC-D': 'appropriation',
    'SAC-D': 'appropriation',
    conference: 'appropriation',
    enacted: 'appropriation',
  };
  return map[stage];
}

// ── Versioned predicate taxonomy (v3 plan §3.3) ──────────────────────────────

export interface PredicateSpec {
  predicate: string;
  /** Human description of the claim's object schema. */
  objectSchema: string;
  /** EvidencePacket.semantics fields the checker reads. */
  evidenceFields: string[];
  /** 'deterministic' when a coded checker exists; else 'skeptic-only'. */
  checker: 'deterministic' | 'skeptic-only';
  /** The auditor D-check id backing a deterministic predicate. */
  check?: string;
}

/**
 * The predicate registry. The pre-synthesis gate is deterministic ONLY for the
 * predicates marked `deterministic`; everything else is LLM-judged (skeptic).
 * `predicateCoverage()` tracks the ratio — every adjudicated escape that maps to
 * a `skeptic-only` predicate is the signal to build its deterministic checker.
 */
export const PREDICATE_REGISTRY: Readonly<Record<string, PredicateSpec>> = {
  funding_at_stage: {
    predicate: 'funding_at_stage',
    objectSchema: '{ amount: EvidenceAmount, stage: EvidenceStage, fiscalYear: number }',
    evidenceFields: ['amount', 'stage', 'vehicleClass', 'fiscalYear'],
    checker: 'deterministic',
    check: 'D3/D4b',
  },
  funding_direction_vs_request: {
    predicate: 'funding_direction_vs_request',
    objectSchema: "{ direction: 'increase'|'decrease'|'flat', fiscalYear: number }",
    evidenceFields: ['comparison', 'fiscalYear', 'stage'],
    checker: 'deterministic',
    check: 'D4',
  },
  bill_status: {
    predicate: 'bill_status',
    objectSchema: '{ status: string, asOf: string }',
    evidenceFields: ['status', 'asOf'],
    checker: 'deterministic',
    check: 'D6',
  },
  rule_operative: {
    predicate: 'rule_operative',
    objectSchema: '{ operative: boolean }',
    evidenceFields: ['status'],
    checker: 'deterministic',
    check: 'D6',
  },
  identifier_kind: {
    predicate: 'identifier_kind',
    objectSchema: "{ kind: 'pe'|'procurement_line_item' }",
    evidenceFields: ['entity'],
    checker: 'deterministic',
    check: 'D7',
  },
  provision_directs_pe: {
    predicate: 'provision_directs_pe',
    objectSchema: '{ peCode: string, confirmed: boolean }',
    evidenceFields: ['matchBasis', 'reviewStatus'],
    checker: 'deterministic',
    check: 'D9',
  },
  plus_up_to_pe: {
    predicate: 'plus_up_to_pe',
    objectSchema: '{ peCode: string, amount: EvidenceAmount }',
    evidenceFields: ['amount', 'comparison', 'matchBasis'],
    checker: 'skeptic-only',
  },
  sponsor_of: {
    predicate: 'sponsor_of',
    objectSchema: '{ bill: string, member: string }',
    evidenceFields: ['status'],
    checker: 'skeptic-only',
  },
  member_represents_district: {
    predicate: 'member_represents_district',
    objectSchema: '{ member: string, district: string }',
    evidenceFields: ['entity'],
    checker: 'skeptic-only',
  },
  procurement_quantity: {
    predicate: 'procurement_quantity',
    objectSchema: '{ quantity: number, fiscalYear: number }',
    evidenceFields: ['amount', 'fiscalYear'],
    checker: 'skeptic-only',
  },
  client_fit: {
    predicate: 'client_fit',
    objectSchema: "{ fit: 'direct_match'|'conditional_niche'|'adjacency' }",
    evidenceFields: ['status'],
    checker: 'skeptic-only',
  },
};

/** Deterministic-vs-total predicate coverage — a tracked quality metric. */
export function predicateCoverage(): {
  deterministic: number;
  total: number;
  fraction: number;
  skepticOnly: string[];
} {
  const specs = Object.values(PREDICATE_REGISTRY);
  const deterministic = specs.filter((s) => s.checker === 'deterministic').length;
  const skepticOnly = specs.filter((s) => s.checker === 'skeptic-only').map((s) => s.predicate);
  return {
    deterministic,
    total: specs.length,
    fraction: specs.length ? deterministic / specs.length : 0,
    skepticOnly,
  };
}
