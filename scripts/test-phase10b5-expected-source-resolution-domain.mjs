#!/usr/bin/env node
/**
 * Phase 10B-5 — expected-source resolution domain gate.
 *
 * Pure resolution of known DefenseBudgetExpectedSource rows onto official
 * document candidates. No HTTP, no DB, no dollars.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  expectedSourceDedupKey,
  resolveExpectedSourceDocument,
  resolveExpectedSourceDocuments,
  catalogCandidateForExpectedSource,
  detectFiscalYearFromText,
  detectSourceFamilyFromDocument,
  COMPTROLLER_DW_CATALOG,
} = domain;

const HOSTS = Object.freeze(['comptroller.defense.gov']);

function pbIdentity(overrides = {}) {
  return {
    fiscalYear: 2024,
    authorityTrack: 'request',
    sourceFamily: 'pb_r1',
    stage: 'president_budget_request',
    chamber: null,
    committee: null,
    component: 'DW',
    adapterId: 'dod-comptroller',
    ...overrides,
  };
}

test('detectFiscalYearFromText reads FY token and path segment', () => {
  assert.equal(detectFiscalYearFromText('FY2024_r1.pdf'), 2024);
  assert.equal(detectFiscalYearFromText('/defbudget/FY2027/x.pdf'), 2027);
  assert.equal(detectFiscalYearFromText('no year here'), null);
});

test('detectSourceFamilyFromDocument prefers filename exhibit tokens', () => {
  assert.equal(
    detectSourceFamilyFromDocument({
      url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
    }),
    'pb_r1',
  );
  assert.equal(
    detectSourceFamilyFromDocument({
      url: 'https://comptroller.defense.gov/x/FY2024_p1.pdf',
    }),
    'pb_p1',
  );
  assert.equal(
    detectSourceFamilyFromDocument({
      url: 'https://comptroller.defense.gov/x/FY2024_o1.pdf',
    }),
    'pb_o1',
  );
  assert.equal(
    detectSourceFamilyFromDocument({
      url: 'https://example.com/book.pdf',
      title: 'Army R-2A Project Justification',
    }),
    'pb_r2a',
  );
});

test('deterministic catalog emits official R-1 URL for DW expected source', () => {
  const identity = pbIdentity();
  const candidate = catalogCandidateForExpectedSource(identity, HOSTS);
  assert.ok(candidate);
  assert.equal(
    candidate.url,
    'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
  );
  assert.equal(candidate.detectedFiscalYear, 2024);
  assert.equal(candidate.detectedSourceFamily, 'pb_r1');
  assert.match(candidate.title ?? '', /R-1/);
});

test('resolveExpectedSourceDocument resolves FY24 pb_r1 from catalog alone', () => {
  const identity = pbIdentity();
  const result = resolveExpectedSourceDocument({
    expectedSource: identity,
    officialHosts: HOSTS,
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.candidate?.detectedSourceFamily, 'pb_r1');
  assert.equal(result.candidate?.detectedFiscalYear, 2024);
  assert.equal(
    result.expectedSourceDedupKey,
    expectedSourceDedupKey({
      fiscalYear: 2024,
      authorityTrack: 'request',
      sourceFamily: 'pb_r1',
      stage: 'president_budget_request',
      chamber: null,
      committee: null,
      component: 'DW',
    }),
  );
  assert.ok(!/amount|usd|dollar/i.test(JSON.stringify(result)));
});

test('resolveExpectedSourceDocument resolves procurement and O&M catalog entries', () => {
  for (const family of ['pb_p1', 'pb_o1']) {
    const result = resolveExpectedSourceDocument({
      expectedSource: pbIdentity({ sourceFamily: family }),
      officialHosts: HOSTS,
    });
    assert.equal(result.outcome, 'resolved', family);
    assert.equal(result.candidate?.detectedSourceFamily, family);
  }
});

test('wrong fiscal year on listing document is refused', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ fiscalYear: 2024 }),
    officialHosts: HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf',
        title: 'FY2027 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_wrong_fiscal_year');
  assert.equal(result.candidate, null);
});

test('wrong exhibit/family is refused', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ sourceFamily: 'pb_r1' }),
    officialHosts: HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_p1.pdf',
        title: 'FY2024 P-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_wrong_family');
});

test('non-official host is refused', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://media.example.com/FY2024_r1.pdf',
        title: 'FY2024 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_non_official_host');
});

test('no candidate is explicit no_match, not fake success', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ sourceFamily: 'pb_r2', component: 'ARMY' }),
    officialHosts: HOSTS,
    useDeterministicCatalog: true,
    listingDocuments: [],
  });
  assert.equal(result.outcome, 'no_match');
  assert.equal(result.candidate, null);
});

test('ambiguous equally-strong listing matches fail closed', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ sourceFamily: 'pb_r1', component: null }),
    officialHosts: HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'FY2024 R-1 A',
      },
      {
        url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/r1_display.pdf',
        title: 'FY2024 R-1 B',
      },
    ],
  });
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.ambiguousCandidates.length, 2);
  assert.equal(result.candidate, null);
});

test('batch resolver only emits for the requested adapter', () => {
  const results = resolveExpectedSourceDocuments({
    expectedSources: [
      pbIdentity({ adapterId: 'dod-comptroller', sourceFamily: 'pb_r1' }),
      pbIdentity({ adapterId: 'army-budget', sourceFamily: 'pb_r1', component: 'ARMY' }),
    ],
    officialHosts: HOSTS,
    adapterId: 'dod-comptroller',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'resolved');
});

test('catalog covers the five DW topline families used for PE canary path', () => {
  const families = new Set(COMPTROLLER_DW_CATALOG.map((row) => row.sourceFamily));
  for (const family of ['pb_overview', 'pb_r1', 'pb_p1', 'pb_o1', 'pb_milcon_c1']) {
    assert.ok(families.has(family), family);
  }
});

test('authorization track expected sources are refused by this resolver', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({
      authorityTrack: 'authorization',
      sourceFamily: 'auth_public_law',
      stage: 'auth_enacted',
      component: null,
    }),
    officialHosts: HOSTS,
  });
  assert.equal(result.outcome, 'refused_unsupported_family');
});

// Phase 10B-6A — comptroller.war.gov successor-host migration.
//
// The publisher migrated its live delivery host from comptroller.defense.gov
// to comptroller.war.gov (confirmed live 2026-08-28: .defense.gov now answers
// every path, including the bare root, with an Akamai 403; .war.gov serves
// the identical FY2024 R-1 exhibit as a real application/pdf response, byte
// SHA256 ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425).
// These tests prove the migration is supported centrally through the
// existing officialHosts + preferredCatalogHost mechanism, with NO new
// adapter and NO broadening of the host allowlist beyond the two exact
// approved hostnames.
const MIGRATED_HOSTS = Object.freeze(['comptroller.defense.gov', 'comptroller.war.gov']);

test('successor host comptroller.war.gov is accepted when added to officialHosts', () => {
  const identity = pbIdentity();
  const result = resolveExpectedSourceDocument({
    expectedSource: identity,
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'Department of Defense Fiscal Year 2024 Budget Request: RDT&E Programs (R-1)',
      },
    ],
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.candidate?.url.startsWith('https://comptroller.war.gov/'), true);
});

test('preferredCatalogHost steers the deterministic catalog onto the successor host without changing identity', () => {
  const identity = pbIdentity();
  const withoutPreference = resolveExpectedSourceDocument({
    expectedSource: identity,
    officialHosts: MIGRATED_HOSTS,
  });
  const withPreference = resolveExpectedSourceDocument({
    expectedSource: identity,
    officialHosts: MIGRATED_HOSTS,
    preferredCatalogHost: 'comptroller.war.gov',
  });
  assert.equal(withoutPreference.outcome, 'resolved');
  assert.equal(withPreference.outcome, 'resolved');
  // Default (no preference) keeps officialHosts[0] — historical host — as the
  // resolved URL's host.
  assert.equal(new URL(withoutPreference.candidate.url).hostname, 'comptroller.defense.gov');
  // Explicit preference steers retrieval onto the successor host.
  assert.equal(new URL(withPreference.candidate.url).hostname, 'comptroller.war.gov');
  // The expected-source dedup identity is unaffected by host selection in
  // either case — hostname is not part of the identity hash.
  assert.equal(withoutPreference.expectedSourceDedupKey, withPreference.expectedSourceDedupKey);
  assert.equal(
    withPreference.expectedSourceDedupKey,
    expectedSourceDedupKey({
      fiscalYear: 2024,
      authorityTrack: 'request',
      sourceFamily: 'pb_r1',
      stage: 'president_budget_request',
      chamber: null,
      committee: null,
      component: 'DW',
    }),
  );
});

test('historical comptroller.defense.gov host remains valid provenance for an existing listing document', () => {
  // A historical observation/candidate already anchored to the old host must
  // not become an unknown host merely because a successor host was added.
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'Department of Defense Fiscal Year 2024 Budget Request: RDT&E Programs (R-1)',
      },
    ],
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(new URL(result.candidate.url).hostname, 'comptroller.defense.gov');
});

test('unrelated .war.gov host is rejected — exact hostname only, never a wildcard', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://army.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'FY2024 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_non_official_host');
  assert.equal(result.candidate, null);
});

test('arbitrary subdomain of comptroller.war.gov is rejected — exact hostname only', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://cdn.comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'FY2024 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_non_official_host');
});

test('plain HTTP (non-TLS) on an otherwise official host is rejected', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'http://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'FY2024 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_non_official_host');
});

test('third-party mirror is rejected even when it hosts byte-identical content', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity(),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://govinfo-mirror.example.org/defbudget/FY2024/FY2024_r1.pdf',
        title: 'FY2024 R-1 (mirror)',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_non_official_host');
});

test('FY mismatch on the successor host is refused exactly like the historical host', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ fiscalYear: 2024 }),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2025/FY2025_r1.pdf',
        title: 'FY2025 R-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_wrong_fiscal_year');
});

test('family mismatch on the successor host is refused exactly like the historical host', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ sourceFamily: 'pb_r1' }),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_p1.pdf',
        title: 'FY2024 P-1',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_wrong_family');
});

test('component mismatch on the successor host is refused exactly like the historical host', () => {
  const result = resolveExpectedSourceDocument({
    expectedSource: pbIdentity({ sourceFamily: 'pb_r1', component: 'ARMY' }),
    officialHosts: MIGRATED_HOSTS,
    useDeterministicCatalog: false,
    listingDocuments: [
      {
        url: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
        title: 'Department of Defense Fiscal Year 2024 Budget Request: RDT&E Programs (R-1), Air Force',
      },
    ],
  });
  assert.equal(result.outcome, 'refused_wrong_component');
});
