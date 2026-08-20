import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const CORPUS_REVIEW_SCHEMA_VERSION =
  'phase8_session5_corpus_review_ledger_v1';
export const GOLD_EVIDENCE_SCHEMA_VERSION =
  'phase8_session5_gold_evidence_v1';
export const BENCHMARK_CORPUS_SCHEMA_VERSION =
  'phase8_session5_benchmark_corpus_v1';

export const SESSION5_REQUIRED_STRATA = Object.freeze([
  'r1_zero_native_tables',
  'r2_identity_banner',
  'r2a_project_cost_table',
  'scanned_image_only',
  'navy_ba6_duplicate_flattening',
  'p1_table',
  'o1_op5_table',
  'defense_wide_volume',
]);

export class CorpusReviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CorpusReviewError';
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeCorpusValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeCorpusValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeCorpusValue(value[key])]),
    );
  }
  return value;
}

export function canonicalCorpusJson(value) {
  return JSON.stringify(canonicalizeCorpusValue(value));
}

export function corpusSha256(value) {
  const bytes =
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : canonicalCorpusJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertCorpusSha(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CorpusReviewError(
      'INVALID_SHA256',
      `${fieldName} must be a lowercase 64-character SHA-256`,
    );
  }
  return value;
}

export function computeDocumentContentSha(document) {
  const withoutHash = { ...document };
  delete withoutHash.contentSha256;
  return corpusSha256(withoutHash);
}

export function verifyDocumentContentSha(document, fieldName = 'document') {
  assertCorpusSha(document?.contentSha256, `${fieldName}.contentSha256`);
  const expected = computeDocumentContentSha(document);
  if (expected !== document.contentSha256) {
    throw new CorpusReviewError(
      'CONTENT_HASH_MISMATCH',
      `${fieldName} content SHA does not match canonical document bytes`,
      { expected, actual: document.contentSha256 },
    );
  }
  return document;
}

function requireNonblank(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CorpusReviewError(
      'FIELD_REQUIRED',
      `${fieldName} must be a nonblank string`,
    );
  }
  return value;
}

function validateMoney(money, fieldName) {
  if (!isObject(money)) {
    throw new CorpusReviewError('INVALID_GOLD', `${fieldName} must be an object`);
  }
  requireNonblank(money.value, `${fieldName}.value`);
  requireNonblank(money.unit, `${fieldName}.unit`);
  if (!Number.isInteger(money.fy) || money.fy !== 2027) {
    throw new CorpusReviewError(
      'INVALID_GOLD',
      `${fieldName}.fy must be the integer 2027`,
    );
  }
  if (!Number.isInteger(money.evidencePage) || money.evidencePage < 1) {
    throw new CorpusReviewError(
      'INVALID_GOLD',
      `${fieldName}.evidencePage must be a positive physical PDF page`,
    );
  }
}

export function validateGoldAssertions(gold, fieldName = 'gold') {
  if (!isObject(gold)) {
    throw new CorpusReviewError('INVALID_GOLD', `${fieldName} must be an object`);
  }
  const names = [
    'peIdentities',
    'projectIdentities',
    'lineIdentities',
    'money',
    'tableCells',
  ];
  for (const name of names) {
    if (!Array.isArray(gold[name])) {
      throw new CorpusReviewError(
        'INVALID_GOLD',
        `${fieldName}.${name} must be an explicit array`,
      );
    }
  }
  const scorableCount = names.reduce(
    (count, name) => count + gold[name].length,
    0,
  );
  if (scorableCount === 0) {
    throw new CorpusReviewError(
      'EMPTY_GOLD',
      `${fieldName} must contain at least one source-grounded assertion`,
    );
  }
  gold.money.forEach((money, index) =>
    validateMoney(money, `${fieldName}.money[${index}]`),
  );
  for (const name of [
    'peIdentities',
    'projectIdentities',
    'lineIdentities',
    'tableCells',
  ]) {
    gold[name].forEach((value, index) =>
      requireNonblank(value, `${fieldName}.${name}[${index}]`),
    );
  }
  return gold;
}

export function validateGoldEvidence(evidence, expected = {}) {
  if (
    !isObject(evidence) ||
    evidence.schemaVersion !== GOLD_EVIDENCE_SCHEMA_VERSION
  ) {
    throw new CorpusReviewError(
      'INVALID_EVIDENCE_SCHEMA',
      'Gold evidence must use phase8_session5_gold_evidence_v1',
    );
  }
  verifyDocumentContentSha(evidence, `evidence:${evidence.id ?? 'unknown'}`);
  requireNonblank(evidence.id, 'evidence.id');
  requireNonblank(evidence.stratum, 'evidence.stratum');
  requireNonblank(evidence.pageClass, 'evidence.pageClass');
  if (!SESSION5_REQUIRED_STRATA.includes(evidence.stratum)) {
    throw new CorpusReviewError(
      'INVALID_STRATUM',
      `Unsupported evidence stratum ${evidence.stratum}`,
    );
  }
  if (expected.id && evidence.id !== expected.id) {
    throw new CorpusReviewError(
      'EVIDENCE_ID_MISMATCH',
      `Expected evidence id ${expected.id}, received ${evidence.id}`,
    );
  }
  if (expected.stratum && evidence.stratum !== expected.stratum) {
    throw new CorpusReviewError(
      'EVIDENCE_STRATUM_MISMATCH',
      `Expected stratum ${expected.stratum}, received ${evidence.stratum}`,
    );
  }

  const source = evidence.source;
  if (!isObject(source)) {
    throw new CorpusReviewError('SOURCE_REQUIRED', 'evidence.source is required');
  }
  assertCorpusSha(source.sourcePdfSha256, 'evidence.source.sourcePdfSha256');
  if (!Number.isInteger(source.fiscalYear) || source.fiscalYear !== 2027) {
    throw new CorpusReviewError(
      'INVALID_SOURCE',
      'evidence.source.fiscalYear must be 2027',
    );
  }
  if (!Number.isInteger(source.physicalPage) || source.physicalPage < 1) {
    throw new CorpusReviewError(
      'INVALID_SOURCE',
      'evidence.source.physicalPage must be positive',
    );
  }
  requireNonblank(source.sourceUrl, 'evidence.source.sourceUrl');

  const review = evidence.review;
  if (!isObject(review) || review.reviewStatus !== 'accepted') {
    throw new CorpusReviewError(
      'GOLD_NOT_ACCEPTED',
      'Evidence must have review.reviewStatus=accepted',
    );
  }
  if (review.incomplete === true || review.conflicted === true) {
    throw new CorpusReviewError(
      'GOLD_NOT_ACCEPTABLE',
      'Incomplete or conflicted evidence cannot enter the live corpus',
    );
  }
  requireNonblank(review.reviewer, 'evidence.review.reviewer');
  requireNonblank(review.reviewedAt, 'evidence.review.reviewedAt');
  validateGoldAssertions(evidence.gold, 'evidence.gold');

  if (
    evidence.stratum === 'r2_identity_banner' &&
    evidence.gold.peIdentities.length === 0
  ) {
    throw new CorpusReviewError(
      'R2_IDENTITY_REQUIRED',
      'R-2 identity gold must contain a Program Element identity',
    );
  }
  if (
    evidence.stratum === 'r2a_project_cost_table' &&
    evidence.gold.projectIdentities.length === 0 &&
    evidence.gold.money.length === 0 &&
    evidence.gold.tableCells.length === 0
  ) {
    throw new CorpusReviewError(
      'R2A_ASSERTION_REQUIRED',
      'R-2A gold must contain project, money, or table assertions',
    );
  }
  return evidence;
}

function assertSafeRepositoryPath(repositoryRoot, value, fieldName) {
  requireNonblank(value, fieldName);
  if (isAbsolute(value)) {
    throw new CorpusReviewError(
      'UNSAFE_PATH',
      `${fieldName} must be repository-relative`,
    );
  }
  const root = resolve(repositoryRoot);
  const resolved = resolve(root, value);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CorpusReviewError(
      'UNSAFE_PATH',
      `${fieldName} resolves outside the repository`,
    );
  }
  return resolved;
}

export async function loadCorpusReviewLedger(
  ledgerPath,
  repositoryRoot = process.cwd(),
) {
  const resolvedLedgerPath = assertSafeRepositoryPath(
    repositoryRoot,
    ledgerPath,
    'ledgerPath',
  );
  const ledger = JSON.parse(await readFile(resolvedLedgerPath, 'utf8'));
  const evidenceByPath = new Map();
  for (const entry of ledger.entries ?? []) {
    if (entry.status !== 'accepted') continue;
    const evidencePath = assertSafeRepositoryPath(
      repositoryRoot,
      entry.evidencePath,
      `entry:${entry.id}.evidencePath`,
    );
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidenceByPath.set(entry.evidencePath, evidence);
  }
  return { ledger, evidenceByPath, resolvedLedgerPath };
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

export function validateCorpusReviewLedger(ledger, evidenceByPath = new Map()) {
  if (
    !isObject(ledger) ||
    ledger.schemaVersion !== CORPUS_REVIEW_SCHEMA_VERSION
  ) {
    throw new CorpusReviewError(
      'INVALID_LEDGER_SCHEMA',
      'Corpus ledger must use phase8_session5_corpus_review_ledger_v1',
    );
  }
  verifyDocumentContentSha(ledger, 'ledger');
  if (!sameStringSet(ledger.requiredStrata, SESSION5_REQUIRED_STRATA)) {
    throw new CorpusReviewError(
      'REQUIRED_STRATA_MISMATCH',
      'Ledger requiredStrata must contain each Session 5 stratum exactly once',
    );
  }
  if (!Array.isArray(ledger.entries)) {
    throw new CorpusReviewError(
      'ENTRIES_REQUIRED',
      'ledger.entries must be an array',
    );
  }

  const ids = new Set();
  const acceptedByStratum = new Map(
    SESSION5_REQUIRED_STRATA.map((stratum) => [stratum, []]),
  );
  const blockedByStratum = new Map(
    SESSION5_REQUIRED_STRATA.map((stratum) => [stratum, []]),
  );

  for (const [index, entry] of ledger.entries.entries()) {
    if (!isObject(entry)) {
      throw new CorpusReviewError(
        'INVALID_ENTRY',
        `ledger.entries[${index}] must be an object`,
      );
    }
    requireNonblank(entry.id, `ledger.entries[${index}].id`);
    if (ids.has(entry.id)) {
      throw new CorpusReviewError(
        'DUPLICATE_ENTRY',
        `Duplicate corpus entry id ${entry.id}`,
      );
    }
    ids.add(entry.id);
    if (!SESSION5_REQUIRED_STRATA.includes(entry.stratum)) {
      throw new CorpusReviewError(
        'INVALID_STRATUM',
        `Unsupported corpus stratum ${entry.stratum}`,
      );
    }
    if (!['accepted', 'blocked'].includes(entry.status)) {
      throw new CorpusReviewError(
        'INVALID_ENTRY_STATUS',
        `${entry.id}.status must be accepted or blocked`,
      );
    }

    if (entry.status === 'accepted') {
      requireNonblank(entry.evidencePath, `${entry.id}.evidencePath`);
      const evidence = evidenceByPath.get(entry.evidencePath);
      if (!evidence) {
        throw new CorpusReviewError(
          'EVIDENCE_MISSING',
          `Accepted entry ${entry.id} has no loaded evidence document`,
        );
      }
      validateGoldEvidence(evidence, {
        id: entry.id,
        stratum: entry.stratum,
      });
      if (
        entry.sourceSummary?.sourcePdfSha256 !==
          evidence.source.sourcePdfSha256 ||
        entry.sourceSummary?.physicalPage !== evidence.source.physicalPage
      ) {
        throw new CorpusReviewError(
          'SOURCE_SUMMARY_MISMATCH',
          `Accepted entry ${entry.id} source summary differs from evidence`,
        );
      }
      acceptedByStratum.get(entry.stratum).push({ entry, evidence });
    } else {
      if (!Array.isArray(entry.blockers) || entry.blockers.length === 0) {
        throw new CorpusReviewError(
          'BLOCKER_REQUIRED',
          `Blocked entry ${entry.id} must record at least one blocker`,
        );
      }
      for (const [blockerIndex, blocker] of entry.blockers.entries()) {
        requireNonblank(
          blocker?.code,
          `${entry.id}.blockers[${blockerIndex}].code`,
        );
        requireNonblank(
          blocker?.message,
          `${entry.id}.blockers[${blockerIndex}].message`,
        );
      }
      blockedByStratum.get(entry.stratum).push(entry);
    }
  }

  const acceptedStrata = SESSION5_REQUIRED_STRATA.filter(
    (stratum) => acceptedByStratum.get(stratum).length > 0,
  );
  const blockedStrata = SESSION5_REQUIRED_STRATA.filter(
    (stratum) => acceptedByStratum.get(stratum).length === 0,
  );

  for (const stratum of SESSION5_REQUIRED_STRATA) {
    if (
      acceptedByStratum.get(stratum).length === 0 &&
      blockedByStratum.get(stratum).length === 0
    ) {
      throw new CorpusReviewError(
        'STRATUM_UNACCOUNTED',
        `Stratum ${stratum} has neither accepted evidence nor a blocker`,
      );
    }
  }

  const analysis = Object.freeze({
    requiredStrataCount: SESSION5_REQUIRED_STRATA.length,
    acceptedEntryCount: [...acceptedByStratum.values()].reduce(
      (sum, entries) => sum + entries.length,
      0,
    ),
    acceptedStrata,
    blockedStrata,
    acceptedByStratum,
    blockedByStratum,
    liveCorpusReady: blockedStrata.length === 0,
  });

  const summary = ledger.summary ?? {};
  if (
    summary.requiredStrataCount !== analysis.requiredStrataCount ||
    summary.acceptedStrataCount !== acceptedStrata.length ||
    summary.blockedStrataCount !== blockedStrata.length ||
    summary.liveCorpusReady !== analysis.liveCorpusReady ||
    !sameStringSet(summary.acceptedStrata, acceptedStrata) ||
    !sameStringSet(summary.blockedStrata, blockedStrata)
  ) {
    throw new CorpusReviewError(
      'LEDGER_SUMMARY_MISMATCH',
      'Ledger summary does not match validated evidence and blockers',
    );
  }
  return analysis;
}

export function buildSession5BenchmarkCorpus(ledger, analysis) {
  if (!analysis?.liveCorpusReady) {
    throw new CorpusReviewError(
      'LIVE_CORPUS_NOT_READY',
      'Every Session 5 stratum needs accepted source-grounded gold before corpus output',
      { blockedStrata: analysis?.blockedStrata ?? SESSION5_REQUIRED_STRATA },
    );
  }
  assertCorpusSha(
    ledger.model?.parserOptionsHash,
    'ledger.model.parserOptionsHash',
  );

  const accepted = [];
  for (const stratum of SESSION5_REQUIRED_STRATA) {
    const records = analysis.acceptedByStratum.get(stratum);
    for (const { entry, evidence } of records) {
      accepted.push({
        id: entry.id,
        stratum,
        pageClass: evidence.pageClass,
        sourceSha256: evidence.source.sourcePdfSha256,
        pageNumber: evidence.source.physicalPage,
        source: {
          sourceDocumentId: evidence.source.sourceDocumentId,
          sourceUrl: evidence.source.sourceUrl,
          printedPage: evidence.source.printedPage,
          evidencePackageSha256: evidence.contentSha256,
        },
        gold: {
          reviewStatus: 'accepted',
          incomplete: false,
          conflicted: false,
          sourceEvidenceSha256: evidence.contentSha256,
          peIdentities: evidence.gold.peIdentities,
          projectIdentities: evidence.gold.projectIdentities,
          lineIdentities: evidence.gold.lineIdentities,
          money: evidence.gold.money,
          tableCells: evidence.gold.tableCells,
        },
        observations: {},
      });
    }
  }

  return Object.freeze({
    schemaVersion: BENCHMARK_CORPUS_SCHEMA_VERSION,
    runId: `phase8-session5-fy27-${ledger.contentSha256.slice(0, 16)}`,
    baselineProviderId: 'deterministic_current',
    providers: [
      {
        id: 'deterministic_current',
        kind: 'deterministic',
        modelName: 'capiro-defense-parser',
        modelVersion: 'accepted-session4-runtime',
      },
      {
        id: 'nemotron_parse',
        kind: 'nvidia',
        modelName: ledger.model.modelName,
        modelVersion: ledger.model.modelVersion,
        parserOptionsHash: ledger.model.parserOptionsHash,
      },
    ],
    entries: accepted,
  });
}
