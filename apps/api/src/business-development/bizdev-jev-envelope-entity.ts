import {
  buildBdEntityQuestion,
  type BdEntityOrganization,
} from '@capiro/meriv2-core';
import { hashEvidenceEnvelope, type EvidenceEnvelope } from '@capiro/meriv2-core';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import type { BdJevTask } from './bizdev-jev-mode.js';
import {
  buildBdEvidenceEnvelope,
  neutralCanonicalDescription,
  stagedSignals,
  type BdCandidateProjection,
} from './bizdev-jev-envelope.js';

/**
 * BD-ENTITY question pair: the UNRESOLVED PROSPECT organization (bounded to
 * its display name — no private description, notes, or hypothesis) against
 * ONE bounded canonical candidate. One provider call; one evaluated candidate
 * UUID, which the caller stores in the trace's canonicalEntityId so identity
 * review feedback can be classified later.
 */

/** Bounded prospect-side description: display name only. */
export function prospectOrganization(displayName: string): BdEntityOrganization {
  return { name: displayName };
}

/** Bounded candidate-side description from the canonical projection. */
export function candidateOrganization(candidate: BdCandidateProjection): BdEntityOrganization {
  const identifiers = (candidate.identifiers ?? [])
    .filter((identifier) => identifier.type === 'uei' || identifier.type === 'cage')
    .slice(0, 8)
    .map((identifier) => ({ kind: identifier.type as 'uei' | 'cage', value: identifier.value }));
  return {
    name: candidate.canonicalName,
    identifiers,
  };
}

export interface BdEntityQuestionPair {
  envelope: EvidenceEnvelope;
  question: ReturnType<typeof buildBdEntityQuestion>;
  envelopeHash: string;
}

/**
 * Prospect-vs-candidate BD-ENTITY question. Returns null when the packet
 * preconditions fail (no explicitly staged evidence source) — the caller must
 * then record an explicit skipped/source_unavailable trace, never a silent
 * no-op and never a manufactured stage.
 */
export function buildBdEntityProspectQuestion(input: {
  tenantId: string;
  prospectId: string;
  prospectDisplayName: string;
  candidate: BdCandidateProjection;
  evidence: EvidenceItem[];
}): BdEntityQuestionPair | null {
  const envelope = buildBdEvidenceEnvelope({
    task: 'bd_entity' as BdJevTask,
    tenantId: input.tenantId,
    prospectId: input.prospectId,
    canonicalEntityId: input.candidate.canonicalEntityId,
    evidence: input.evidence,
  });
  if (!envelope) return null;
  const question = buildBdEntityQuestion({
    organizationA: prospectOrganization(input.prospectDisplayName),
    organizationB: candidateOrganization(input.candidate),
    envelope,
  });
  return { envelope, question, envelopeHash: hashEvidenceEnvelope(envelope) };
}

export { stagedSignals, neutralCanonicalDescription };