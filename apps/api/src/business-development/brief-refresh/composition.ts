import { ConflictException } from '@nestjs/common';
import type { EvidenceItem } from '../bizdev-evidence.types.js';
import {
  BRIEF_CITATION_CAP,
  BRIEF_EVIDENCE_SNAPSHOT_CAP,
  BRIEF_SECTION_KEYS,
  type BriefCitation,
  type BriefSections,
  type BriefSourceSnapshot,
  type BriefVersionDetail,
} from '../bizdev-brief.types.js';
import {
  buildSourceSnapshot,
  citationsFromEvidence,
  diffSections,
  generateSections,
  hashSnapshot,
  sha256Hex,
  validateSections,
} from '../bizdev-brief.util.js';

export interface RefreshEvidence {
  identityName: string | null;
  identityBasis: string;
  canonicalEntityId: string | null;
  canonicalName: string | null;
  evidence: EvidenceItem[];
}
export function refreshConflict(message: string): never {
  throw new ConflictException({ code: 'BIZDEV_BRIEF_REFRESH_CONFLICT', message });
}
/** Observation time can change on a live read. Facts, source dates, order and coverage cannot.
 * The exact observation timestamps are still retained in the reviewed snapshot/citations. */
export function refreshSourceHash(auth: RefreshEvidence): string {
  return sha256Hex({
    ...auth,
    evidence: auth.evidence.map(({ fetchedAt: _observation, ...fact }) => fact),
  });
}
export function composeRefresh(
  base: BriefVersionDetail,
  auth: RefreshEvidence,
  keepUserEdits: boolean,
) {
  const fresh = generateSections(auth);
  const freshCitations = citationsFromEvidence(auth.evidence);
  const citations: BriefCitation[] = [];
  const evidence: EvidenceItem[] = [];
  const proposed = {} as Record<
    (typeof BRIEF_SECTION_KEYS)[number],
    BriefSections[(typeof BRIEF_SECTION_KEYS)[number]]
  >;
  const addEvidence = (item: EvidenceItem) => {
    if (!evidence.some((existing) => sha256Hex(existing) === sha256Hex(item))) evidence.push(item);
  };
  // Fresh citations stay first: generated text's numbered references must keep their meaning.
  const addCitation = (citation: BriefCitation) => {
    let index = citations.findIndex((c) => sha256Hex(c) === sha256Hex(citation));
    if (index < 0) {
      index = citations.length;
      citations.push(citation);
    }
    if (citations.length > BRIEF_CITATION_CAP)
      refreshConflict(
        'The refresh needs too many citations to preserve your edits. Review the saved brief before preparing another refresh.',
      );
    return index;
  };
  freshCitations.forEach(addCitation);
  auth.evidence.slice(0, BRIEF_EVIDENCE_SNAPSHOT_CAP).forEach(addEvidence);
  for (const key of BRIEF_SECTION_KEYS) {
    const edited = keepUserEdits && base.sections[key].provenance === 'edited';
    const section = edited ? base.sections[key] : fresh[key];
    const source = edited ? base.citations : freshCitations;
    const citationIndexes = section.citationIndexes.map((index) => {
      const citation = source[index];
      if (!citation)
        refreshConflict(
          'A saved citation is unavailable. The refresh cannot preserve its attribution.',
        );
      if (edited) {
        const retained = base.sourceSnapshot.evidence.find(
          (item) => sha256Hex(citationsFromEvidence([item])[0]) === sha256Hex(citation),
        );
        if (!retained)
          refreshConflict(
            'A saved source snapshot is unavailable. The refresh cannot preserve its attribution.',
          );
        addEvidence(retained);
      }
      return addCitation(citation);
    });
    proposed[key] = { ...section, citationIndexes };
  }
  if (
    evidence.length > BRIEF_EVIDENCE_SNAPSHOT_CAP ||
    validateSections(proposed, citations.length).length
  )
    refreshConflict('The refresh exceeds the saved brief bounds. Review the saved brief first.');
  const sourceSnapshot: BriefSourceSnapshot = buildSourceSnapshot(
    new Date().toISOString(),
    auth,
    evidence,
  );
  return {
    baseVersionNumber: base.versionNumber,
    proposed,
    citations,
    diff: diffSections(base.sections, proposed),
    sourceSnapshot,
    snapshotHash: hashSnapshot(sourceSnapshot),
  };
}
