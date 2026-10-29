import { composeRefresh, refreshSourceHash } from './composition.js';
import {
  citationsFromEvidence,
  generateSections,
  hashSections,
  hashSnapshot,
} from '../bizdev-brief.util.js';
import type { BriefVersionDetail } from '../bizdev-brief.types.js';
import type { EvidenceItem } from '../bizdev-evidence.types.js';
const ev = (id: string): EvidenceItem => ({
  sourceFamily: 'sam_entity',
  recordId: id,
  locator: null,
  originalSourceName: 'SAM',
  originalSourceId: id,
  claimType: 'identity',
  relationshipStrength: 'direct',
  eventDate: null,
  effectiveDate: null,
  fiscalYear: null,
  stage: null,
  sourceUpdatedAt: null,
  fetchedAt: '2026-01-01T00:00:00Z',
  scopeChecked: 'fixture',
  status: 'available',
  title: id,
  detail: {},
});
const auth = (evidence: EvidenceItem[]) => ({
  identityName: 'Fixture',
  identityBasis: 'exact',
  canonicalName: 'Fixture',
  canonicalEntityId: null,
  evidence,
});
function base(evidence: EvidenceItem[]): BriefVersionDetail {
  const sections = generateSections(auth(evidence)),
    sourceSnapshot = { generatedAt: '2026-01-01T00:00:00Z', ...auth(evidence) };
  return {
    id: 'version',
    versionNumber: 1,
    createdAt: sourceSnapshot.generatedAt,
    createdByUserId: null,
    sections,
    citations: citationsFromEvidence(evidence),
    citationCount: evidence.length,
    sectionsHash: hashSections(sections),
    sourceSnapshot,
    snapshotHash: hashSnapshot(sourceSnapshot),
  };
}
test('preserved edited text keeps its exact original citation when fresh citation order changes', () => {
  const a = ev('A'),
    b = ev('B'),
    v = base([a, b]);
  v.sections.judgment = { text: 'User judgment of A', provenance: 'edited', citationIndexes: [0] };
  const p = composeRefresh(v, auth([b, a]), true);
  expect(p.proposed.judgment.text).toBe('User judgment of A');
  expect(p.proposed.judgment.citationIndexes).toEqual([1]);
  expect(p.citations[1]).toEqual(v.citations[0]);
  expect(p.diff.find((d) => d.section === 'judgment')?.proposedText).toBe(p.proposed.judgment.text);
});
test('a revised source cannot silently replace an edited section original citation', () => {
  const a = ev('A'),
    v = base([a]);
  v.sections.judgment = { text: 'Original judgment', provenance: 'edited', citationIndexes: [0] };
  const revised = { ...a, title: 'Revised fact', sourceUpdatedAt: '2026-02-01' };
  const p = composeRefresh(v, auth([revised]), true);
  expect(p.citations[p.proposed.judgment.citationIndexes[0]]).toEqual(v.citations[0]);
  expect(p.sourceSnapshot.evidence).toEqual([revised, a]);
});
test('source identity ignores observation clock but binds source dates and factual content', () => {
  const a = ev('A');
  expect(refreshSourceHash(auth([a]))).toBe(
    refreshSourceHash(auth([{ ...a, fetchedAt: '2026-01-02T00:00:00Z' }])),
  );
  expect(refreshSourceHash(auth([a]))).not.toBe(
    refreshSourceHash(auth([{ ...a, sourceUpdatedAt: '2026-02-01' }])),
  );
  expect(refreshSourceHash(auth([a]))).not.toBe(
    refreshSourceHash(auth([{ ...a, detail: { amount: 10 } }])),
  );
});
