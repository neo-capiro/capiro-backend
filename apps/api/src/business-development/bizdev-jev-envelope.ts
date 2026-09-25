import { createHash } from 'node:crypto';
import {
  buildBdEntityQuestion,
  buildBdSignalQuestion,
  type BdEntityOrganization,
  type BdSignalInput,
} from '@capiro/meriv2-core';
import { hashEvidenceEnvelope, type EvidenceEnvelope } from '@capiro/meriv2-core';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import type { BdJevTask } from './bizdev-jev-mode.js';

/**
 * Bounded evidence-envelope construction for the BD Jev tasks.
 *
 * Inputs are PUBLIC/MINIMAL ONLY — Phase 2's normalized evidence items and
 * identity candidates. Never included, by construction: prospect
 * description/serviceHypothesis, preferences, notes/activity, conflict
 * reasons, contacts/people, client files, or any PDL payload (the Phase 2
 * dossier never returns those either). All source text that DOES flow in is
 * treated as untrusted data at the question boundary (the shared question
 * instructions say so) and is never persisted: the trace stores hashes and
 * public source ids only.
 *
 * The core registry deliberately requires `financial_stage` on every BD
 * source. A signal whose source does not explicitly state one of the allowed
 * stages is SKIPPED here — never assigned a default — and if no staged source
 * remains the caller must treat the evaluation as `source_unavailable`.
 */

const hash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value) ?? 'null', 'utf8').digest('hex')}`;

const MAX_ENVELOPE_SOURCES = 16;

/** Explicit shape of one envelope source row (mirrors decision-contract). */
interface BdEnvelopeSource {
  evidenceId: string;
  sourceType: string;
  sourceId: string;
  documentId: string | null;
  version: string | null;
  locator: string | null;
  passage: string;
  sourceDate: string | null;
  publishedAt: string | null;
  effectiveAt: string | null;
  retrievedAt: string | null;
  authority: { sourceAuthority: string; publisher: string | null; jurisdiction: null };
  documentCompleteness: 'complete' | 'partial';
  relationScope: 'pe_specific' | 'program_wide' | 'capability_only';
  /** bd_entity canonical identity evidence legitimately carries no financial
   * stage; the task's registry requires `relation_scope` instead. bd_signal
   * sources are pre-filtered to explicitly staged ones (never defaulted). */
  financialStage: string | null;
  provenance: { evidenceClass: string; primary: boolean; authoritative: boolean };
}

export interface BdCandidateProjection {
  canonicalEntityId: string;
  canonicalName: string;
  identityScope: string;
  identifiers: Array<{ type: string; value: string }>;
}

/** Bounded organization description for the BD-ENTITY question. */
export function toBdEntityOrganization(candidate: BdCandidateProjection): BdEntityOrganization {
  const identifiers = (candidate.identifiers ?? [])
    .filter((identifier) => identifier.type === 'uei' || identifier.type === 'cage')
    .slice(0, 8)
    .map((identifier) => ({ kind: identifier.type as 'uei' | 'cage', value: identifier.value }));
  return {
    name: candidate.canonicalName,
    identifiers,
  };
}

/**
 * Neutral, public company description for the BD-SIGNAL question. Derived
 * ONLY from the canonical organization name — never from the prospect's
 * private description/service hypothesis — so no tenant-private text can
 * reach the provider boundary through this field.
 */
export function neutralCanonicalDescription(companyName: string): string {
  return `The organization “${companyName}” as recorded in the Capiro canonical organization registry.`;
}

/**
 * Select signals that carry an EXPLICIT allowed financial stage. Signals
 * without one are skipped (the registry requires financial_stage; a missing
 * stage must never be manufactured as a default).
 */
export function stagedSignals(signals: EvidenceItem[]): EvidenceItem[] {
  const allowed = ['requested', 'authorized', 'obligated', 'awarded', 'ceiling', 'forecast'];
  return signals.filter((signal) => signal.stage != null && allowed.includes(signal.stage));
}

/**
 * Phase 2 BASELINE mapping for ONE staged bd_signal evidence item: the
 * deterministic relationship-strength classification the dossier already
 * assigns, expressed in the BD-SIGNAL outcome vocabulary so the provider
 * decision and the deterministic baseline are directly comparable.
 *   direct      → explicit_link
 *   conditional → conditional_alignment
 *   thematic    → thematic_fit
 *   unresolved  → insufficient_evidence
 * Never a generic section availability status.
 */
export function signalItemOutcome(signal: EvidenceItem): string {
  switch (signal.relationshipStrength) {
    case 'direct':
      return 'explicit_link';
    case 'conditional':
      return 'conditional_alignment';
    case 'thematic':
      return 'thematic_fit';
    default:
      return 'insufficient_evidence';
  }
}

/** Bounded signal records for the BD-SIGNAL question (staged signals only). */
export function toBdSignalInput(input: {
  companyName: string;
  signals: EvidenceItem[];
}): BdSignalInput {
  const bounded = stagedSignals(input.signals).slice(0, 8);
  return {
    company: {
      name: input.companyName,
      description: neutralCanonicalDescription(input.companyName),
    },
    signals: bounded.map((signal) => ({
      recordType: signal.sourceFamily === 'sam_opportunity'
        ? 'contract_opportunity'
        : signal.sourceFamily === 'lda_filing'
          ? 'lobbying_filing'
          : signal.stage === 'obligated' || signal.stage === 'awarded'
            ? 'award'
            : 'other',
      text: signal.title,
      financialStage: signal.stage as NonNullable<EvidenceItem['stage']>,
    })),
  };
}

/**
 * Build the meriv2-core evidence envelope from Phase 2 evidence items. The
 * claimText is a minimal public statement (a stable task label), never
 * tenant-private content; sources carry the public record ids, versions and
 * locators so a source revision changes the envelope hash and invalidates any
 * cached/stale judgment.
 *
 * Task-aware staging: `financial_stage` is REQUIRED by the bd_signal
 * registry, so a signal without an explicit allowed stage is SKIPPED (never
 * manufactured as a default) and if none remain the caller records
 * `source_unavailable`. bd_entity requires `relation_scope` instead, and
 * accepts canonical identity evidence whose financialStage is null.
 */
export function buildBdEvidenceEnvelope(input: {
  task: BdJevTask;
  tenantId: string;
  prospectId: string | null;
  canonicalEntityId: string | null;
  evidence: EvidenceItem[];
}): EvidenceEnvelope | null {
  const taskRelevant = input.task === 'bd_signal'
    ? stagedSignals(input.evidence) // financial_stage required per source
    : input.evidence; // relation_scope required; stage may be null
  if (taskRelevant.length === 0) return null;
  const byId = new Set<string>();
  const sources: BdEnvelopeSource[] = [];
  for (const item of taskRelevant.slice(0, MAX_ENVELOPE_SOURCES)) {
    const evidenceId = `${item.sourceFamily}:${item.recordId ?? item.originalSourceId ?? 'unknown'}`;
    if (byId.has(evidenceId)) continue; // provider boundary rejects repeats
    byId.add(evidenceId);
    sources.push({
      evidenceId,
      sourceType: item.sourceFamily,
      sourceId: item.recordId ?? item.originalSourceId ?? 'unknown',
      documentId: item.originalSourceId,
      version: item.sourceUpdatedAt ?? item.fetchedAt ?? item.eventDate ?? 'unknown',
      locator: item.locator ?? (item.sourceFamily === 'capiro_canonical_identity' && item.recordId
        ? `canonical_entity_id=${item.recordId}`
        : null),
      passage: item.title,
      sourceDate: item.eventDate,
      publishedAt: item.sourceUpdatedAt,
      effectiveAt: item.effectiveDate,
      retrievedAt: item.fetchedAt,
      authority: {
        sourceAuthority: item.originalSourceName ?? item.sourceFamily,
        publisher: item.originalSourceName,
        jurisdiction: null,
      },
      documentCompleteness: item.status === 'available' ? 'complete' : 'partial',
      relationScope: item.relationshipStrength === 'direct'
        ? 'pe_specific'
        : item.relationshipStrength === 'conditional'
          ? 'program_wide'
          : 'capability_only',
      financialStage: item.stage,
      provenance: {
        evidenceClass: item.sourceFamily === 'capiro_canonical_identity'
          ? 'capiro_system_of_record'
          : item.sourceFamily === 'lda_filing'
            || item.sourceFamily.startsWith('usaspending')
            || item.sourceFamily.startsWith('sam_')
            ? 'official_government_data'
            : 'secondary_reporting',
        primary: item.relationshipStrength === 'direct',
        authoritative: item.sourceFamily !== 'tango_vehicle',
      },
    });
  }
  if (sources.length === 0) return null;
  return {
    envelopeVersion: 'meri-evidence-envelope-v1',
    // Redacted subject binding: a stable hash of the private subject id, never
    // the raw prospect UUID (tenant binding stays explicit via tenantId).
    claimId: `bd-${input.task}-${input.canonicalEntityId ?? hash(input.prospectId ?? 'subject')}`,
    claimText: input.task === 'bd_entity'
      ? 'Identity relationship between two organization candidates'
      : 'Relevance of proposed signals to a company',
    claimKind: 'inference',
    claimCategory: input.task,
    tenantId: input.tenantId,
    clientId: null,
    scopeQualifiers: [
      `task=${input.task}`,
      input.canonicalEntityId ? `canonical_entity=${input.canonicalEntityId}` : 'canonical_entity=none',
    ],
    asOf: null,
    sources,
  } as unknown as EvidenceEnvelope;
}

/**
 * Source-hash list per task: signals filter to staged sources; entity uses all
 * (incl. the canonical identity item). Source-REVISION-sensitive: the hash
 * covers the public source version markers (sourceUpdatedAt/fetchedAt/eventDate)
 * plus stage and locator, so a revised source, restaged record, changed
 * locator or changed stage invalidates the key. Still redacted: hashes only,
 * never source text.
 */
export function bdSourceHashesForTask(task: BdJevTask, evidence: EvidenceItem[]): string[] {
  const taskRelevant = task === 'bd_signal' ? stagedSignals(evidence) : evidence;
  return taskRelevant.map((item) =>
    hash([
      item.sourceFamily,
      item.recordId,
      item.title,
      item.sourceUpdatedAt,
      item.fetchedAt,
      item.eventDate,
      item.stage,
      item.locator,
    ]),
  );
}

/** Envelope + question pair for the BD-ENTITY task (null → source_unavailable). */
export function buildBdEntityQuestionFromCandidates(input: {
  tenantId: string;
  prospectId: string | null;
  organizationA: BdCandidateProjection;
  organizationB: BdCandidateProjection;
  evidence: EvidenceItem[];
}) {
  const envelope = buildBdEvidenceEnvelope({
    task: 'bd_entity',
    tenantId: input.tenantId,
    prospectId: input.prospectId,
    canonicalEntityId: input.organizationA.canonicalEntityId,
    evidence: input.evidence,
  });
  if (!envelope) return null;
  const question = buildBdEntityQuestion({
    organizationA: toBdEntityOrganization(input.organizationA),
    organizationB: toBdEntityOrganization(input.organizationB),
    envelope,
  });
  return { envelope, question, envelopeHash: hashEvidenceEnvelope(envelope) };
}

/** Envelope + question pair for the BD-SIGNAL task (null → source_unavailable). */
export function buildBdSignalQuestionFromCards(input: {
  tenantId: string;
  prospectId: string | null;
  canonicalEntityId: string | null;
  companyName: string;
  signals: EvidenceItem[];
}) {
  const envelope = buildBdEvidenceEnvelope({
    task: 'bd_signal',
    tenantId: input.tenantId,
    prospectId: input.prospectId,
    canonicalEntityId: input.canonicalEntityId,
    evidence: input.signals,
  });
  if (!envelope) return null;
  const question = buildBdSignalQuestion({
    ...toBdSignalInput({ companyName: input.companyName, signals: input.signals }),
    envelope,
  });
  return { envelope, question, envelopeHash: hashEvidenceEnvelope(envelope) };
}

/** Stable idempotency key: tenant, task/mode, question/model/registry versions, envelope/source/candidate hashes. */
export function bdJevIdempotencyKey(input: {
  tenantId: string;
  task: BdJevTask;
  mode: 'shadow' | 'internal_canary';
  questionVersion: string;
  modelVersion: string;
  registryVersion: string;
  envelopeHash: string;
  sourceHashes: string[];
  candidateInventoryHash: string | null;
}): string {
  return [
    input.tenantId,
    input.task,
    input.mode,
    input.questionVersion,
    input.modelVersion,
    input.registryVersion,
    input.envelopeHash,
    hash(input.sourceHashes.slice().sort()),
    input.candidateInventoryHash ?? 'no-candidates',
  ].join('|');
}

/**
 * Hash of the candidate inventory over the BOUNDED PROJECTION (id, name,
 * identityScope, identifiers): a rename, identifier change, scope change or
 * reorder invalidates the key. Order-sensitive; redacted digest only — never
 * the projection itself.
 */
export function candidateInventoryHash(candidates: BdCandidateProjection[]): string {
  return hash(
    candidates.map((candidate) => ({
      canonicalEntityId: candidate.canonicalEntityId,
      canonicalName: candidate.canonicalName,
      identityScope: candidate.identityScope,
      identifiers: candidate.identifiers ?? [],
    })),
  );
}

/**
 * Minimal provider-only Capiro canonical-registry evidence item for the
 * evaluated candidate of an unresolved prospect. The Phase 2 unresolved
 * identity section carries no evidence cards, so BD-ENTITY constructs exactly
 * one bounded, public item from the candidate id/name (stable internal
 * locator `canonical_entity_id=<uuid>`, direct relation scope, no stage, no
 * private fields) — sourced from Capiro's own registry, never from the
 * tenant's private prospect data.
 */
export function canonicalCandidateEvidenceItem(candidate: BdCandidateProjection): EvidenceItem {
  return {
    sourceFamily: 'capiro_canonical_identity',
    recordId: candidate.canonicalEntityId,
    locator: `canonical_entity_id=${candidate.canonicalEntityId}`,
    originalSourceName: 'Capiro identity registry',
    originalSourceId: candidate.canonicalEntityId,
    claimType: 'identity',
    relationshipStrength: 'direct',
    eventDate: null,
    effectiveDate: null,
    fiscalYear: null,
    stage: null,
    sourceUpdatedAt: null,
    fetchedAt: null,
    scopeChecked: `canonical_entity_id=${candidate.canonicalEntityId}`,
    status: 'available',
    title: `Canonical organization “${candidate.canonicalName}”`,
    detail: { identityScope: candidate.identityScope },
  };
}