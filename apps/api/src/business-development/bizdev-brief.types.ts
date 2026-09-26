import type { EvidenceItem } from './bizdev-evidence.types.js';

/**
 * Business Development Phase 4 — prospect brief contract.
 *
 * A brief is a stable root artifact (one per tenant+prospect) plus immutable
 * versions. Each version carries exactly five sections with per-section
 * provenance, a bounded source snapshot of the dossier evidence it was built
 * from, and a bounded citation list. Citation identities are validated against
 * the authorized current dossier / the saved snapshot — the dossier is the
 * ONLY external factual source for this slice.
 *
 * Section text is generated deterministically from dossier evidence (no LLM):
 * every sentence restates what an EvidenceItem records. BD-CLAIM Jev semantic
 * validation stays DARK; the deterministic claim checker below is the only
 * validation path.
 */

/** The exact five section keys — no more, no fewer, no aliases. */
export const BRIEF_SECTION_KEYS = [
  'companyAndFirmImplication',
  'verifiedEvidence',
  'judgment',
  'practicalAction',
  'missingInformation',
] as const;
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number];

/** Per-section generated-versus-edited provenance. */
export const BRIEF_SECTION_PROVENANCES = ['generated', 'edited'] as const;
export type BriefSectionProvenance = (typeof BRIEF_SECTION_PROVENANCES)[number];

export interface BriefSectionContent {
  /** Human-readable section text (bounded). */
  text: string;
  /** Deterministic (generated) or user-authored (edited). */
  provenance: BriefSectionProvenance;
  /** Citation indexes into the version's citations array (0-based, bounded). */
  citationIndexes: number[];
}

/** The exact five-section payload of a version. */
export type BriefSections = Readonly<Record<BriefSectionKey, BriefSectionContent>>;

/**
 * A citation record: stable source identity + locator + separated dates.
 * Missing dates stay null — never invented.
 */
export interface BriefCitation {
  /** Stable identity within the source family (award id, filing uuid, ...). */
  sourceFamily: string;
  recordId: string;
  /** Human-usable locator (deep link) when the source provides one. */
  locator: string | null;
  originalSourceName: string | null;
  originalSourceId: string | null;
  /** Date the underlying event happened, when the record states one. */
  eventDate: string | null;
  /** Date the source published/updated the record, when known. */
  sourceUpdatedAt: string | null;
  /** When Capiro retrieved/synced the record, when known. */
  retrievedAt: string | null;
  /** The evidence card title, for inspectable display. */
  title: string;
  /** Relationship strength carried from the evidence item. */
  relationshipStrength: string;
  /** Lifecycle stage when the source supports the distinction. */
  stage: string | null;
}

/** Bounded immutable snapshot of the dossier evidence a version rests on. */
export interface BriefSourceSnapshot {
  generatedAt: string;
  /** The dossier identity basis at generation time. */
  identityBasis: string;
  canonicalEntityId: string | null;
  canonicalName: string | null;
  /** The cited evidence items, verbatim (bounded by CITATION_CAP). */
  evidence: EvidenceItem[];
}

/** Bounds — payload-size ceilings enforced server-side. */
export const BRIEF_TEXT_MAX = 4000;
export const BRIEF_CITATION_CAP = 12;
export const BRIEF_EVIDENCE_SNAPSHOT_CAP = 24;
export const BRIEF_TITLE_MAX = 300;
export const BRIEF_IDEMPOTENCY_KEY_MAX = 400;
export const BRIEF_MAX_VERSIONS = 100;

/** Typed brief conflict (concurrent edit; carries the latest saved version). */
export interface BriefVersionConflict {
  code: 'BIZDEV_BRIEF_VERSION_CONFLICT';
  message: string;
  briefId: string;
  /** The version the caller expected. */
  expectedVersionNumber: number;
  /** The latest actually-saved version (what the caller should merge onto). */
  latestVersion: BriefVersionSummary;
}

export interface BriefVersionSummary {
  id: string;
  versionNumber: number;
  createdAt: string;
  createdByUserId: string | null;
  sectionsHash: string;
  citationCount: number;
}

export interface BriefVersionDetail extends BriefVersionSummary {
  sections: BriefSections;
  citations: BriefCitation[];
  sourceSnapshot: BriefSourceSnapshot;
  snapshotHash: string;
}

export interface BriefSummary {
  id: string;
  tenantId: string;
  prospectId: string;
  title: string;
  status: 'draft' | 'archived';
  currentVersionNumber: number | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
}

/** Result of building a refresh proposal (never writes). */
export interface BriefRefreshProposal {
  baseVersionNumber: number;
  /** Fresh dossier generation, built the same way as create. */
  proposed: BriefSections;
  /** Per-section plain diff (base → proposed). */
  diff: BriefSectionDiff[];
  /** Fresh source snapshot backing the proposal. */
  sourceSnapshot: BriefSourceSnapshot;
  snapshotHash: string;
}

export interface BriefSectionDiff {
  section: BriefSectionKey;
  changed: boolean;
  baseText: string;
  proposedText: string;
}

/** Deterministic claim-check outcomes (BD-CLAIM Jev stays DARK). */
export type BriefClaimCheckOutcome =
  | { kind: 'supported'; basis: string }
  | { kind: 'qualified'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface BriefClaimCheck {
  /** What was checked, in plain English. */
  claim: string;
  outcome: BriefClaimCheckOutcome;
  /** Citation index validated against, when one applies. */
  citationIndex: number | null;
}
