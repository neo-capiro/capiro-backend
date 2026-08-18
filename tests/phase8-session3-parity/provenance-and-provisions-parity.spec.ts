/**
 * OLD-vs-NEW parity: provenance ordering, and the committee-provision merge.
 *
 * Provenance is load-bearing for the whole Phase 8 architecture (immutable,
 * replayable source attribution), so this suite pins both the ORDER citations come
 * back in and the exact attribution wording on a program-level provision.
 *
 * Both sides are real implementations:
 *   - apps/api's `compareProofPackSources` / `proofPackRank` vs the package copies;
 *   - apps/api's `getProvisionsForPe` merge block, transcribed, vs the shared
 *     `mergeProvisionLinks` that defense-api actually calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareProofPackSources as legacyCompare,
  proofPackRank as legacyRank,
} from '../../apps/api/src/program-element/proof-pack.ts';
import {
  compareProofPackSources as nextCompare,
  proofPackRank as nextRank,
  mergeProvisionLinks,
  PROGRAM_LEVEL_ATTRIBUTION_CAVEAT,
  provisionBasisRank,
  provisionMatchScope,
  type ProvisionLinkRow,
} from '@capiro/defense-domain/pe-read';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Provenance ordering
// ---------------------------------------------------------------------------

const SOURCES = [
  { docType: 'R', exhibitType: 'R-2', fy: 2026, pageNumber: 40 },
  { docType: 'P', exhibitType: 'P-40', fy: 2027, pageNumber: 5 },
  { docType: 'R', exhibitType: 'R-1', fy: 2027, pageNumber: 12 },
  { docType: 'R', exhibitType: 'R-2A', fy: 2027, pageNumber: 144 },
  { docType: 'R', exhibitType: 'R-2', fy: 2027, pageNumber: 3 },
  { docType: 'P', exhibitType: 'P-1', fy: 2027, pageNumber: 27 },
  { docType: 'R', exhibitType: 'R-3', fy: 2027, pageNumber: 200 },
  { docType: 'O', exhibitType: null, fy: 2027, pageNumber: 1 },
  { docType: 'P', exhibitType: null, fy: 2027, pageNumber: 9 },
  { docType: 'R', exhibitType: 'r-2a', fy: 2025, pageNumber: null },
  { docType: 'R', exhibitType: 'R 2 A', fy: 2028, pageNumber: 7 },
  { docType: null as unknown as string, exhibitType: null, fy: null, pageNumber: null },
];

test('PARITY: proofPackRank agrees on every exhibit/docType combination', () => {
  const docTypes = [null, '', 'R', 'P', 'O', 'r', 'p', 'x'];
  const exhibits = [null, '', 'R-1', 'R-2', 'R-2A', 'R-3', 'P-1', 'P-40', 'r-2a', 'R 2 A', 'Z-9'];
  for (const d of docTypes) {
    for (const e of exhibits) {
      assert.equal(
        nextRank(d, e),
        legacyRank(d, e),
        `proofPackRank diverged for docType=${d} exhibitType=${e}`,
      );
    }
  }
});

test('PARITY: the proof-pack comparator induces the identical citation order', () => {
  const legacyOrder = [...SOURCES].sort(legacyCompare).map((s) => `${s.exhibitType}|${s.fy}|${s.pageNumber}`);
  const nextOrder = [...SOURCES].sort(nextCompare).map((s) => `${s.exhibitType}|${s.fy}|${s.pageNumber}`);
  assert.deepEqual(nextOrder, legacyOrder);
});

test('PARITY: getSources selects every provenance column apps/api serves', () => {
  // getSources' value IS its provenance. A static check on both sources catches a
  // dropped column that a fixture-only test would never see, because the reduced
  // implementation returned a well-formed object with the fields simply absent.
  const nextSource = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/defense-api/src/program-elements/program-element-read.service.ts'),
    'utf8',
  );
  const nextGetSources = nextSource.slice(
    nextSource.indexOf('async getSources('),
    nextSource.indexOf('async getRelatedProgramElements('),
  );
  assert.ok(nextGetSources.length > 0, 'could not locate defense-api getSources');

  for (const field of [
    'exhibitType',
    'publisher',
    'snippet',
    'confidence',
    'pageEnd',
    'sourceDocument',
    'budgetCycle',
    'sha256',
  ]) {
    assert.ok(
      nextGetSources.includes(field),
      `defense-api getSources does not project provenance field "${field}"`,
    );
  }

  // Envelope: apps/api returns a BARE ARRAY. A `{ data: [...] }` wrapper here is a
  // breaking contract change for every existing consumer.
  assert.ok(
    /return \[\.\.\.rows\]\.sort\(/.test(nextGetSources),
    'defense-api getSources must return a bare sorted array, matching apps/api',
  );
  assert.ok(
    !/return \{\s*data:/.test(nextGetSources),
    'defense-api getSources must not wrap its result in a { data } envelope',
  );

  // 404 on an unknown PE, same as apps/api.
  assert.ok(
    /NotFoundException\(`Program element \$\{peCode\} not found`\)/.test(nextGetSources),
    'defense-api getSources must 404 for an unknown PE',
  );
});

// ---------------------------------------------------------------------------
// Committee provisions
// ---------------------------------------------------------------------------

const provision = (id: string, fy: number) => ({
  id,
  committee: 'HASC',
  fy,
  heading: `Heading ${id}`,
  text: `Text ${id}`,
  pageStart: 1,
  pageEnd: 2,
  actionType: 'directs_report',
  sourceDocument: { sourceUrl: `https://example.test/${id}` },
});

const link = (
  id: string,
  matchBasis: string,
  reviewStatus: string,
  confidence: number,
  fy = 2027,
): ProvisionLinkRow => ({
  matchBasis,
  reviewStatus,
  confidence,
  provision: provision(id, fy),
});

/** apps/api's getProvisionsForPe merge block, transcribed. */
function legacyMerge(directLinks: ProvisionLinkRow[], programLinks: ProvisionLinkRow[]) {
  const byProvision = new Map<string, Record<string, unknown>>();
  const rank = (m: string) => (m === 'pe_code' ? 0 : m === 'project_title' ? 1 : 2);
  const scopeOf = (m: string): 'pe_specific' | 'program_level' =>
    m === 'pe_code' || m === 'project_title' ? 'pe_specific' : 'program_level';
  for (const l of [...directLinks, ...programLinks]) {
    const existing = byProvision.get(l.provision.id);
    if (existing && rank(existing.matchBasis as string) <= rank(l.matchBasis)) continue;
    const matchScope = scopeOf(l.matchBasis);
    byProvision.set(l.provision.id, {
      id: l.provision.id,
      committee: l.provision.committee,
      fy: l.provision.fy,
      heading: l.provision.heading,
      text: l.provision.text,
      pageStart: l.provision.pageStart,
      pageEnd: l.provision.pageEnd,
      actionType: l.provision.actionType,
      sourceUrl: l.provision.sourceDocument?.sourceUrl ?? null,
      matchBasis: l.matchBasis,
      reviewStatus: l.reviewStatus,
      confidence: l.confidence,
      matchScope,
      attributionCaveat:
        matchScope === 'program_level'
          ? 'Program-level match: this provision names a program that maps to this PE, not this PE code directly. It may apply to sibling PEs in the same program — attribute it at the program level, not exclusively to this PE.'
          : null,
    });
  }
  const items = [...byProvision.values()];
  const statusRank = (s: unknown) => (s === 'accepted' ? 0 : 1);
  items.sort(
    (a, b) =>
      statusRank(a.reviewStatus) - statusRank(b.reviewStatus) ||
      rank(a.matchBasis as string) - rank(b.matchBasis as string) ||
      (b.fy as number) - (a.fy as number) ||
      (b.confidence as number) - (a.confidence as number),
  );
  return items.slice(0, 50);
}

test('PARITY: provision basis rank + match scope agree with apps/api', () => {
  for (const basis of ['pe_code', 'project_title', 'program_alias', 'other', '']) {
    const legacyRankValue = basis === 'pe_code' ? 0 : basis === 'project_title' ? 1 : 2;
    assert.equal(provisionBasisRank(basis), legacyRankValue, `basis rank diverged for ${basis}`);
    assert.equal(
      provisionMatchScope(basis),
      basis === 'pe_code' || basis === 'project_title' ? 'pe_specific' : 'program_level',
      `match scope diverged for ${basis}`,
    );
  }
});

test('PARITY: the provision merge keeps the strongest link and orders identically', () => {
  const cases: Array<{ label: string; direct: ProvisionLinkRow[]; program: ProvisionLinkRow[] }> = [
    { label: 'empty', direct: [], program: [] },
    {
      label: 'same provision reachable both ways -> direct wins',
      direct: [link('p1', 'pe_code', 'accepted', 0.9)],
      program: [link('p1', 'program_alias', 'candidate', 0.6)],
    },
    {
      label: 'program-only link is surfaced (the original bug dropped these entirely)',
      direct: [],
      program: [link('p2', 'program_alias', 'accepted', 0.8)],
    },
    {
      label: 'accepted before candidate, then pe-direct before program-level',
      direct: [link('p3', 'project_title', 'candidate', 0.7), link('p4', 'pe_code', 'accepted', 0.5)],
      program: [link('p5', 'program_alias', 'candidate', 0.95)],
    },
    {
      label: 'newest FY first, then highest confidence',
      direct: [
        link('p6', 'pe_code', 'accepted', 0.5, 2026),
        link('p7', 'pe_code', 'accepted', 0.9, 2027),
        link('p8', 'pe_code', 'accepted', 0.4, 2027),
      ],
      program: [],
    },
    {
      label: 'program link arriving first must still lose to a later direct link',
      direct: [link('p9', 'pe_code', 'candidate', 0.3)],
      program: [link('p9', 'program_alias', 'accepted', 0.99)],
    },
  ];

  for (const c of cases) {
    assert.deepEqual(
      mergeProvisionLinks(c.direct, c.program),
      legacyMerge(c.direct, c.program),
      `provision merge diverged: ${c.label}`,
    );
  }
});

test('PARITY: the program-level attribution caveat is byte-identical to apps/api', () => {
  // The prior defense-api implementation shipped a REWORDED caveat. This is
  // user-visible attribution language on a governed claim, so it is pinned against
  // apps/api's source text, not against a paraphrase in this test.
  const legacySource = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/api/src/program-element/program-element-read.service.ts'),
    'utf8',
  );
  const match = /'(Program-level match: [^']*)'/.exec(legacySource);
  assert.ok(match, 'could not find the attribution caveat in apps/api source');
  assert.equal(
    PROGRAM_LEVEL_ATTRIBUTION_CAVEAT,
    match![1],
    'the program-level attribution caveat diverged from apps/api',
  );
});

test('PARITY: a program-level provision always carries the caveat; a PE-direct one never does', () => {
  const merged = mergeProvisionLinks(
    [link('direct', 'pe_code', 'accepted', 0.9)],
    [link('viaProgram', 'program_alias', 'accepted', 0.9)],
  );
  const direct = merged.find((p) => p.id === 'direct')!;
  const viaProgram = merged.find((p) => p.id === 'viaProgram')!;
  assert.equal(direct.matchScope, 'pe_specific');
  assert.equal(direct.attributionCaveat, null);
  assert.equal(viaProgram.matchScope, 'program_level');
  assert.equal(viaProgram.attributionCaveat, PROGRAM_LEVEL_ATTRIBUTION_CAVEAT);
});
