#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
/**
 * Phase 8 Session 8 — publisher-native document-kind gate.
 *
 * The Session 7 classifier resolves document kind from the official GovInfo
 * package id. Nine of the fourteen registered adapters publish on their own
 * websites and issue no package id at all, so under that rule alone none of them
 * could ever resolve to an expected source and live discovery would be
 * GovInfo-only. This gate covers the extension that closes that, and — more
 * importantly — the guards that keep it from being abusable.
 *
 * Runs against the BUILT @capiro/defense-domain output.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

console.error('Usage: node scripts/test-phase8-session8-publisher-native-domain.mjs (no arguments run the domain gate)');
if (process.argv.length > 2) process.exit(2);

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  classifyLifecycleSource,
  resolveDiscoveredCandidate,
  resolvePublisherNativeKind,
  exhibitFamilyFromTitle,
  bootstrapFiscalYearCycle,
  PUBLISHER_NATIVE_ADAPTER_IDS,
  PUBLISHER_NATIVE_CONFIDENCE_CEILING,
  CLASSIFICATION_ACCEPT_THRESHOLD,
} = domain;

const BASE = {
  url: 'https://example.gov/x.pdf',
  packageId: null,
  declaredFiscalYear: 2027,
  contentExcerpt: null,
  contentExcerptAvailable: false,
  divisionEvidence: null,
};

const FY2027 = bootstrapFiscalYearCycle({ fiscalYear: 2027 });
const FY2027_KEYS = new Set(FY2027.expectedSources.map((source) => source.dedupKey));
const HORIZON = [2026, 2027, 2028];

const resolveNative = (adapterId, title) =>
  resolveDiscoveredCandidate({
    adapterId,
    url: 'https://example.gov/x.pdf',
    packageId: null,
    title,
    declaredFiscalYear: 2027,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2027_KEYS,
  });

test('every publisher-native adapter class resolves to a REGISTERED expected source', () => {
  // One representative document per publisher class. Each must land on an
  // expected source the governed template actually created — membership, not
  // plausibility, is what makes a candidate resolvable.
  const cases = [
    ['dod-comptroller', 'FY 2027 Department of Defense Budget Request Overview Book', 'request', 'pb_overview', null],
    ['dod-comptroller', 'FY 2027 Defense-Wide Budget Justification R-2 Exhibit', 'request', 'pb_r2', 'DW'],
    ['army-budget', 'Fiscal Year 2027 Army Budget Estimates Justification Book R-2 Exhibit', 'request', 'pb_r2', 'ARMY'],
    ['navy-budget', 'FY 2027 Navy Budget Justification Book P-1 Exhibit', 'request', 'pb_p1', 'NAVY'],
    ['saf-fm-budget', 'FY2027 Air Force Budget Justification R-1 Exhibit', 'request', 'pb_r1', 'AF'],
    ['saf-fm-budget', 'FY2027 Space Force Budget Justification R-2 Exhibit', 'request', 'pb_r2', 'SF'],
    ['dod-comptroller-reprogramming', 'FY 2027 Reprogramming Action DD-1415 Prior Approval', 'alternative_funding', 'alt_reprogramming', null],
    ['dod-comptroller-reprogramming', 'FY 2027 General Transfer Authority action', 'alternative_funding', 'alt_transfer', null],
    ['hasc', 'FY2027 National Defense Authorization Act Chairman Mark', 'authorization', 'auth_committee_mark', null],
    ['sasc', 'SASC Markup National Defense Authorization Act for Fiscal Year 2027', 'authorization', 'auth_committee_mark', null],
    ['house-appropriations', 'Department of Defense Appropriations Bill, 2027 Subcommittee Mark', 'appropriations', 'appr_committee_mark', null],
    ['senate-appropriations', 'Defense Appropriations Bill, 2027 Subcommittee Markup', 'appropriations', 'appr_committee_mark', null],
    ['dod-contract-announcements', 'FY2027 Contracts for August 20, 2026', 'execution', 'exec_award', null],
  ];

  for (const [adapterId, title, track, family, component] of cases) {
    const resolved = resolveNative(adapterId, title);
    assert.equal(resolved.outcome, 'resolved', `${adapterId} / ${title} must resolve`);
    assert.ok(
      FY2027_KEYS.has(resolved.expectedSourceDedupKey),
      `${adapterId} must resolve to a REGISTERED expected source`,
    );
    assert.equal(resolved.provisionalClassification.authorityTrack, track, adapterId);
    assert.equal(resolved.provisionalClassification.sourceFamily, family, adapterId);
    assert.equal(resolved.provisionalClassification.component, component ?? null, adapterId);
  }
});

test('all five authority tracks are reachable through live discovery', () => {
  const tracks = new Set();
  for (const [adapterId, title] of [
    ['dod-comptroller', 'FY 2027 Department of Defense Budget Request Overview Book'],
    ['hasc', 'FY2027 National Defense Authorization Act Chairman Mark'],
    ['house-appropriations', 'Department of Defense Appropriations Bill, 2027 Subcommittee Mark'],
    ['dod-comptroller-reprogramming', 'FY 2027 Reprogramming Action DD-1415 Prior Approval'],
    ['dod-contract-announcements', 'FY2027 Contracts for August 20, 2026'],
  ]) {
    const resolved = resolveNative(adapterId, title);
    assert.equal(resolved.outcome, 'resolved', adapterId);
    tracks.add(resolved.provisionalClassification.authorityTrack);
  }
  assert.deepEqual(
    [...tracks].sort(),
    ['alternative_funding', 'appropriations', 'authorization', 'execution', 'request'],
    'discovery must be able to reach every authority track',
  );
});

test('the Marine Corps volume folds into NAVY because the template registers no USMC', () => {
  // Measured against the governed template rather than assumed: it registers
  // ARMY/NAVY/AF/SF/DW with 11 families each and ZERO USMC entries. Narrowing to
  // USMC would mint a dedup key no bootstrapped cycle expects, turning a real
  // registered Navy exhibit into an unresolved candidate.
  assert.equal(FY2027.expectedSources.filter((s) => s.component === 'USMC').length, 0);
  assert.equal(FY2027.expectedSources.filter((s) => s.component === 'SF').length, 11);

  const resolved = resolveNative(
    'navy-budget',
    'FY 2027 Marine Corps Budget Justification O-1 Exhibit',
  );
  assert.equal(resolved.outcome, 'resolved');
  assert.equal(resolved.provisionalClassification.component, 'NAVY');
});

test('a publisher-native kind can never auto-accept', () => {
  for (const [adapterId, title] of [
    ['hasc', 'FY2027 National Defense Authorization Act Chairman Mark'],
    ['army-budget', 'Fiscal Year 2027 Army Budget Estimates Justification Book R-2 Exhibit'],
    ['dod-contract-announcements', 'FY2027 Contracts for August 20, 2026'],
  ]) {
    const classified = classifyLifecycleSource({ ...BASE, title, adapterId });
    assert.ok(classified.classification, `${adapterId} must classify`);
    assert.ok(
      classified.classification.confidence < CLASSIFICATION_ACCEPT_THRESHOLD,
      'a document with no official package id must never reach the accept threshold',
    );
    assert.equal(
      classified.decision,
      'review',
      'publisher identity may route a document but must not advance a stage',
    );
  }
  assert.ok(PUBLISHER_NATIVE_CONFIDENCE_CEILING < CLASSIFICATION_ACCEPT_THRESHOLD);
});

test('publisher identity narrows the kind but does not excuse the document', () => {
  // A press release on a committee site is not a chairman mark.
  for (const [adapterId, title] of [
    ['hasc', 'Chairman Statement on Readiness Hearing'],
    ['sasc', 'Weekly Digest August 2027'],
    ['house-appropriations', 'Members Announce Community Project Funding'],
    ['army-budget', 'Army Names New Financial Management Director'],
    ['dod-comptroller-reprogramming', 'Comptroller Office Holiday Schedule'],
  ]) {
    const classified = classifyLifecycleSource({ ...BASE, title, adapterId });
    assert.equal(classified.classification, null, `${adapterId}: "${title}" must not classify`);
    assert.equal(classified.decision, 'review');
  }
});

test('document evidence beats the publisher default when they disagree', () => {
  // Appropriations wording on the authorization committee's own adapter. The text
  // resolved a track, so the publisher default must not override it, and the
  // contradiction must not be invented into a stage.
  const classified = classifyLifecycleSource({
    ...BASE,
    title: 'Department of Defense Appropriations Bill, 2027 Subcommittee Mark',
    adapterId: 'hasc',
  });
  assert.equal(classified.classification, null);
  assert.match(classified.reasons.join(' '), /refusing to override document evidence/);
});

test('an unknown or absent adapter changes nothing', () => {
  for (const adapterId of ['some-blog', 'unregistered-adapter', null, undefined]) {
    const classified = classifyLifecycleSource({
      ...BASE,
      title: 'FY2027 National Defense Authorization Act Chairman Mark',
      adapterId,
    });
    assert.equal(
      classified.classification,
      null,
      `adapter ${String(adapterId)} must not gain publisher-native resolution`,
    );
  }
});

test('no GovInfo or congress.gov adapter is publisher-native', () => {
  assert.ok(PUBLISHER_NATIVE_ADAPTER_IDS.length > 0);
  for (const adapterId of PUBLISHER_NATIVE_ADAPTER_IDS) {
    assert.ok(
      !adapterId.startsWith('govinfo'),
      `${adapterId} must not be publisher-native; GovInfo documents carry a package id`,
    );
    assert.notEqual(adapterId, 'congress-gov');
  }
});

test('the omnibus ambiguity is untouched by the extension', () => {
  // The real FY2024 omnibus with no defence division still resolves to nothing.
  const classified = classifyLifecycleSource({
    ...BASE,
    packageId: 'PLAW-118publ42',
    title: 'Consolidated Appropriations Act, 2024',
    declaredFiscalYear: 2024,
    adapterId: 'govinfo-public-laws',
  });
  assert.equal(classified.classification, null);
  assert.match(classified.reasons.join(' '), /omnibus\/consolidated appropriations vehicle/);
});

test('a GovInfo document classifies exactly as Session 7 classified it', () => {
  // The publisher-native branch must be unreachable when a package id resolved.
  const hasc = classifyLifecycleSource({
    ...BASE,
    packageId: 'CRPT-118hrpt125',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    declaredFiscalYear: 2024,
    adapterId: 'govinfo-committee-reports',
  });
  assert.equal(hasc.decision, 'accept');
  assert.equal(hasc.classification.authorityTrack, 'authorization');
  assert.equal(hasc.classification.stage, 'hasc_report');
  assert.equal(hasc.classification.confidence, 0.95);

  const hacd = classifyLifecycleSource({
    ...BASE,
    packageId: 'CRPT-118hrpt121',
    title: 'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
    declaredFiscalYear: 2024,
    adapterId: 'govinfo-committee-reports',
  });
  assert.equal(hacd.decision, 'accept');
  assert.equal(hacd.classification.stage, 'hac_d_report');
  assert.equal(hacd.classification.confidence, 0.95);
});

test('exhibit designators map to registered families, longest match first', () => {
  assert.equal(exhibitFamilyFromTitle('Army R-2A Exhibit'), 'pb_r2a', 'R-2A must beat R-2');
  assert.equal(exhibitFamilyFromTitle('Navy OP-5 Exhibit'), 'pb_op5', 'OP-5 must beat P-series');
  assert.equal(exhibitFamilyFromTitle('R-1 Exhibit'), 'pb_r1');
  assert.equal(exhibitFamilyFromTitle('P-1 Exhibit'), 'pb_p1');
  assert.equal(exhibitFamilyFromTitle('O-1 Exhibit'), 'pb_o1');
  assert.equal(exhibitFamilyFromTitle('C-1 MILCON Exhibit'), 'pb_milcon_c1');
  assert.equal(exhibitFamilyFromTitle('DD 1391 project'), 'pb_dd1391');
  assert.equal(exhibitFamilyFromTitle('P-40 justification'), 'pb_p_series');
  assert.equal(exhibitFamilyFromTitle('Overview Book'), null, 'the overview names no exhibit');
});

test('every exhibit family the resolver can emit is registered by the template', () => {
  // The Session 7 closeout found a real bug of exactly this shape: a stage the
  // classifier could emit that no template entry could receive.
  const registered = new Set(FY2027.expectedSources.map((source) => source.sourceFamily));
  for (const designator of [
    'R-1', 'R-2', 'R-2A', 'R-3', 'R-4', 'P-1', 'P-40', 'O-1', 'OP-5', 'C-1', 'DD 1391',
  ]) {
    const family = exhibitFamilyFromTitle(`FY2027 Army Budget Justification ${designator} Exhibit`);
    assert.ok(family, `${designator} must map to a family`);
    assert.ok(registered.has(family), `family ${family} (${designator}) must be registered`);
  }
});

test('the resolver refuses on its own when nothing matches', () => {
  assert.equal(resolvePublisherNativeKind({ adapterId: null, text: 'anything' }), null);
  assert.equal(resolvePublisherNativeKind({ adapterId: 'govinfo-bills', text: 'markup' }), null);
  assert.equal(resolvePublisherNativeKind({ adapterId: 'hasc', text: 'press release' }), null);

  const kind = resolvePublisherNativeKind({ adapterId: 'hasc', text: 'chairman mark' });
  assert.ok(kind);
  assert.equal(kind.stage, 'hasc_mark');
  assert.equal(kind.committee, 'HASC');
  assert.equal(kind.chamber, 'house');
  assert.match(kind.reason, /no official package id/);
});

test('a publisher-native resolution still carries no dollars', () => {
  const resolved = resolveNative('hasc', 'FY2027 National Defense Authorization Act Chairman Mark');
  assert.ok(
    !/amount|usd|dollar|obligat|outlay/i.test(JSON.stringify(resolved)),
    'no monetary field may appear in a publisher-native resolution',
  );
});

test('a fiscal year is still required; publisher identity does not supply one', () => {
  const classified = classifyLifecycleSource({
    ...BASE,
    declaredFiscalYear: null,
    title: 'National Defense Authorization Act Chairman Mark',
    adapterId: 'hasc',
  });
  assert.equal(
    classified.classification,
    null,
    'a mark with no fiscal year anywhere must not classify',
  );
});
