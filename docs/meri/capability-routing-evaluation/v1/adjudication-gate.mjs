#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const HEX = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DIMENSIONS = ['routing', 'execution', 'answer', 'accuracy', 'coverage', 'cost', 'latency'];
const UNVERIFIED = new Set(['unverified', 'unknown']);
const SCORE_VALUES = {
  routing: new Set(['correct', 'incorrect', 'acceptable_alternative', 'clarification_required', 'unverified']),
  execution: new Set(['usable_evidence', 'empty_result', 'failed', 'not_exercised', 'unverified']),
  answer: new Set(['supported', 'unsupported', 'appropriately_limited', 'unverified']),
  accuracy: new Set(['reference_verified', 'contradicted', 'unverified']),
  coverage: new Set(['complete_for_declared_scope', 'partial', 'unknown']),
};
const SPLITS = new Set(['development', 'calibration', 'locked_holdout']);
const SOURCE_KINDS = new Set(['reviewed_traffic', 'authoritative_fixture']);
const RESOLUTIONS = new Set(['agreement', 'resolved_disagreement']);
const ORACLE_STATUSES = new Set(['available', 'not_applicable']);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closedObject(value, path, fields, add) {
  if (!isObject(value)) { add(path, 'must be an object'); return false; }
  for (const key of Object.keys(value)) if (!fields.includes(key)) add(`${path}.${key}`, 'unexpected field');
  for (const key of fields) if (!Object.hasOwn(value, key)) add(`${path}.${key}`, 'required');
  return true;
}

function nonEmptyString(value, path, add) {
  if (typeof value !== 'string' || value.length === 0) add(path, 'must be a non-empty string');
}

function isSha256(value) {
  return typeof value === 'string' && HEX.test(value);
}

function sha256(value, path, add) {
  if (!isSha256(value)) add(path, 'must be a lowercase SHA-256 digest');
}

function oneOf(value, path, values, add) {
  if (!values.has(value)) add(path, 'unknown value');
}

function eachSlot(values, visit) {
  for (const [index, value] of values.entries()) visit(value, index);
}

function isRfc3339DateTime(value) {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(Number(year), Number(month), 0);
  return !(Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > lastDay.getUTCDate() ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)));
}

function dateTime(value, path, add) {
  if (!isRfc3339DateTime(value)) add(path, 'must be a valid RFC 3339 date-time');
}

function routes(value, path, add) {
  if (!Array.isArray(value) || value.length === 0) { add(path, 'must be a non-empty route array'); return; }
  eachSlot(value, (route, index) => nonEmptyString(route, `${path}[${index}]`, add));
}

function sequences(value, path, add) {
  if (!Array.isArray(value)) { add(path, 'must be a sequence array'); return; }
  eachSlot(value, (sequence, index) => {
    const sequencePath = `${path}[${index}]`;
    if (!Array.isArray(sequence) || sequence.length === 0) { add(sequencePath, 'must be a non-empty route sequence'); return; }
    eachSlot(sequence, (route, routeIndex) => nonEmptyString(route, `${sequencePath}[${routeIndex}]`, add));
  });
}

function acceptableSignature(entry) {
  if (!isObject(entry) || !Array.isArray(entry.acceptableRoutes) || entry.acceptableRoutes.length === 0 ||
      !Array.isArray(entry.acceptableSequences)) return null;
  const routeLabels = [];
  for (const route of entry.acceptableRoutes) {
    if (typeof route !== 'string' || route.length === 0) return null;
    routeLabels.push(route);
  }
  const sequenceLabels = [];
  for (const sequence of entry.acceptableSequences) {
    if (!Array.isArray(sequence) || sequence.length === 0) return null;
    for (const route of sequence) if (typeof route !== 'string' || route.length === 0) return null;
    sequenceLabels.push(JSON.stringify(sequence));
  }
  // Route collections are sets; order inside each sequence is meaningful.
  return JSON.stringify([[...new Set(routeLabels)].sort(), [...new Set(sequenceLabels)].sort()]);
}

// Mirror adjudication.schema.json at the trust boundary. The semantic checks below
// add independence, freeze, score completeness, and cohort requirements.
function validateRecordShape(record, add) {
  if (!closedObject(record, 'record', ['schemaVersion', 'datasetId', 'datasetSha256', 'catalogVersion', 'splitPlan', 'cases', 'runs'], add)) return;
  if (record.schemaVersion !== 'meri-capability-routing-adjudication.v1') add('schemaVersion', 'unsupported version');
  nonEmptyString(record.datasetId, 'datasetId', add);
  sha256(record.datasetSha256, 'datasetSha256', add);
  nonEmptyString(record.catalogVersion, 'catalogVersion', add);

  if (closedObject(record.splitPlan, 'splitPlan', ['version', 'frozenAt', 'membershipSha256'], add)) {
    nonEmptyString(record.splitPlan.version, 'splitPlan.version', add);
    dateTime(record.splitPlan.frozenAt, 'splitPlan.frozenAt', add);
    sha256(record.splitPlan.membershipSha256, 'splitPlan.membershipSha256', add);
  }
  if (!Array.isArray(record.cases)) add('cases', 'must be an array');
  else eachSlot(record.cases, (item, index) => {
    const path = `cases[${index}]`;
    if (!closedObject(item, path, ['caseId', 'naturalLanguage', 'familyIds', 'split', 'source', 'annotations', 'adjudication', 'oracles'], add)) return;
    nonEmptyString(item.caseId, `${path}.caseId`, add);
    if (item.naturalLanguage !== true) add(`${path}.naturalLanguage`, 'must be true');
    if (!Array.isArray(item.familyIds) || item.familyIds.length === 0) add(`${path}.familyIds`, 'must be a non-empty family array');
    else eachSlot(item.familyIds, (family, familyIndex) => nonEmptyString(family, `${path}.familyIds[${familyIndex}]`, add));
    oneOf(item.split, `${path}.split`, SPLITS, add);

    if (closedObject(item.source, `${path}.source`, ['kind', 'reference', 'contentSha256', 'reviewerId'], add)) {
      oneOf(item.source.kind, `${path}.source.kind`, SOURCE_KINDS, add);
      nonEmptyString(item.source.reference, `${path}.source.reference`, add);
      sha256(item.source.contentSha256, `${path}.source.contentSha256`, add);
      nonEmptyString(item.source.reviewerId, `${path}.source.reviewerId`, add);
    }
    if (!Array.isArray(item.annotations) || item.annotations.length < 2) add(`${path}.annotations`, 'must have at least two annotations');
    if (Array.isArray(item.annotations)) eachSlot(item.annotations, (annotation, annotationIndex) => {
      const annotationPath = `${path}.annotations[${annotationIndex}]`;
      if (!closedObject(annotation, annotationPath, ['annotatorId', 'independent', 'acceptableRoutes', 'acceptableSequences', 'notes'], add)) return;
      nonEmptyString(annotation.annotatorId, `${annotationPath}.annotatorId`, add);
      if (annotation.independent !== true) add(`${annotationPath}.independent`, 'must be true');
      routes(annotation.acceptableRoutes, `${annotationPath}.acceptableRoutes`, add);
      sequences(annotation.acceptableSequences, `${annotationPath}.acceptableSequences`, add);
      if (typeof annotation.notes !== 'string') add(`${annotationPath}.notes`, 'must be a string');
    });

    if (closedObject(item.adjudication, `${path}.adjudication`, ['reviewerId', 'resolution', 'acceptableRoutes', 'acceptableSequences'], add)) {
      nonEmptyString(item.adjudication.reviewerId, `${path}.adjudication.reviewerId`, add);
      oneOf(item.adjudication.resolution, `${path}.adjudication.resolution`, RESOLUTIONS, add);
      routes(item.adjudication.acceptableRoutes, `${path}.adjudication.acceptableRoutes`, add);
      sequences(item.adjudication.acceptableSequences, `${path}.adjudication.acceptableSequences`, add);
    }
    if (closedObject(item.oracles, `${path}.oracles`, ['execution', 'factual'], add)) {
      for (const dimension of ['execution', 'factual']) {
        const oracle = item.oracles[dimension];
        const oraclePath = `${path}.oracles.${dimension}`;
        if (!closedObject(oracle, oraclePath, ['status', 'reference', 'version', 'sha256'], add)) continue;
        oneOf(oracle.status, `${oraclePath}.status`, ORACLE_STATUSES, add);
        nonEmptyString(oracle.reference, `${oraclePath}.reference`, add);
        nonEmptyString(oracle.version, `${oraclePath}.version`, add);
        sha256(oracle.sha256, `${oraclePath}.sha256`, add);
      }
    }
  });

  if (!Array.isArray(record.runs)) add('runs', 'must be an array');
  else eachSlot(record.runs, (run, index) => {
    const path = `runs[${index}]`;
    if (!closedObject(run, path, ['caseId', 'split', 'scores'], add)) return;
    nonEmptyString(run.caseId, `${path}.caseId`, add);
    oneOf(run.split, `${path}.split`, SPLITS, add);
    if (!closedObject(run.scores, `${path}.scores`, DIMENSIONS, add)) return;
    for (const dimension of DIMENSIONS) {
      const value = run.scores[dimension];
      if (dimension in SCORE_VALUES) oneOf(value, `${path}.scores.${dimension}`, SCORE_VALUES[dimension], add);
      else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) add(`${path}.scores.${dimension}`, 'must be a finite non-negative number');
    }
  });
}

/** Bind the entire frozen family manifest to a digest supplied by a trusted evaluator. */
export function familyFreezeSha256(freeze) {
  return createHash('sha256').update(JSON.stringify([
    'meri-promoted-family-freeze.v1',
    freeze.version,
    freeze.frozenAt,
    freeze.reference,
    [...freeze.familyIds].sort(),
  ])).digest('hex');
}

function validFamilyId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function validateFamilyFreeze(freeze, trustedFamilyFreezeSha256, add) {
  if (!freeze || typeof freeze !== 'object' || Array.isArray(freeze)) {
    add('familyFreeze', 'an externally frozen promoted family manifest is required');
    return [];
  }
  for (const key of Object.keys(freeze)) {
    if (!['version', 'frozenAt', 'reference', 'familyIds'].includes(key)) add(`familyFreeze.${key}`, 'unexpected manifest field');
  }
  if (typeof freeze.version !== 'string' || !freeze.version.trim()) add('familyFreeze.version', 'required');
  if (typeof freeze.frozenAt !== 'string' || !UTC_TIMESTAMP.test(freeze.frozenAt) || !isRfc3339DateTime(freeze.frozenAt)) add('familyFreeze.frozenAt', 'valid UTC freeze timestamp required');
  if (typeof freeze.reference !== 'string' || !freeze.reference.trim()) add('familyFreeze.reference', 'protected external freeze reference required');
  const families = freeze.familyIds;
  if (!Array.isArray(families) || families.length === 0) {
    add('familyFreeze.familyIds', 'at least one promoted family is required');
    return [];
  }
  const seen = new Set();
  for (const [index, family] of families.entries()) {
    if (!validFamilyId(family)) add(`familyFreeze.familyIds[${index}]`, 'must be a non-empty, trimmed string');
    else if (seen.has(family)) add(`familyFreeze.familyIds[${index}]`, 'duplicate promoted family');
    else seen.add(family);
  }
  if (!isSha256(trustedFamilyFreezeSha256)) add('trustedFamilyFreezeSha256', 'trusted external freeze digest is required');
  else if (seen.size === families.length &&
      typeof freeze.version === 'string' &&
      typeof freeze.frozenAt === 'string' &&
      typeof freeze.reference === 'string' &&
      familyFreezeSha256(freeze) !== trustedFamilyFreezeSha256) {
    add('trustedFamilyFreezeSha256', 'does not match the promoted family freeze');
  }
  return [...seen];
}

/** Content-address the actual case-to-split assignment, not a supplied label. */
export function splitMembershipSha256(cases) {
  const membership = cases.map((item) => [item.caseId, item.split])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(['meri-split-membership.v1', membership])).digest('hex');
}

export function validateAdjudication(record, options = {}) {
  const mode = Object.hasOwn(options ?? {}, 'mode') ? options.mode : 'development';
  const { familyFreeze, trustedFamilyFreezeSha256 } = options ?? {};
  const errors = [];
  const add = (path, why) => errors.push(`${path}: ${why}`);
  const promotedFamilies = validateFamilyFreeze(familyFreeze, trustedFamilyFreezeSha256, add);
  validateRecordShape(record, add);
  if (!isObject(record)) return errors;
  if (record.schemaVersion !== 'meri-capability-routing-adjudication.v1') add('schemaVersion', 'unsupported version');
  if (!record.datasetId || !isSha256(record.datasetSha256)) add('dataset', 'dataset ID and SHA-256 are required');
  if (!record.catalogVersion) add('catalogVersion', 'required');
  const plan = record.splitPlan;
  if (!plan?.version || !plan?.frozenAt || !isSha256(plan?.membershipSha256)) add('splitPlan', 'version, freeze timestamp, and membership SHA-256 are required');
  if (!SPLITS.has(mode)) { add('mode', 'unknown reporting mode'); return errors; }
  if (!Array.isArray(record.cases)) add('cases', 'must be an array');
  if (!Array.isArray(record.runs)) add('runs', 'must be an array');
  if (!Array.isArray(record.cases) || !Array.isArray(record.runs)) return errors;
  if (record.cases.every((item) => item && typeof item.caseId === 'string' && typeof item.split === 'string') &&
      isSha256(plan?.membershipSha256) &&
      splitMembershipSha256(record.cases) !== plan.membershipSha256) {
    add('splitPlan.membershipSha256', 'does not match the actual case-to-split assignment');
  }

  const ids = new Set();
  const familyCounts = new Map();
  const splitsSeen = new Set();
  for (const [index, item] of record.cases.entries()) {
    const p = `cases[${index}]`;
    if (!item || typeof item !== 'object') { add(p, 'must be an object'); continue; }
    if (!item.caseId || ids.has(item.caseId)) add(`${p}.caseId`, 'must be present and unique');
    ids.add(item.caseId);
    if (item.naturalLanguage !== true) add(`${p}.naturalLanguage`, 'promotion cases must be natural-language cases');
    if (!['development', 'calibration', 'locked_holdout'].includes(item.split)) add(`${p}.split`, 'must have a preassigned split');
    else splitsSeen.add(item.split);
    if (!Array.isArray(item.familyIds) || !item.familyIds.length ||
        item.familyIds.some((family) => typeof family !== 'string' || !family) ||
        new Set(item.familyIds).size !== item.familyIds.length) {
      add(`${p}.familyIds`, 'must be distinct non-empty family IDs');
    }
    for (const family of new Set(Array.isArray(item.familyIds) ? item.familyIds : [])) {
      if (typeof family === 'string' && family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }
    const source = item.source;
    if (!source || !['reviewed_traffic', 'authoritative_fixture'].includes(source.kind) || !source.reference || !source.reviewerId || !isSha256(source.contentSha256)) add(`${p}.source`, 'reviewed source reference, reviewer, and content hash are required');
    const annotations = item.annotations;
    if (!Array.isArray(annotations) || annotations.length < 2) add(`${p}.annotations`, 'two independent annotations are required');
    else {
      const people = new Set();
      annotations.forEach((a, j) => {
        if (!a?.annotatorId || a.independent !== true || !Array.isArray(a.acceptableRoutes) || !a.acceptableRoutes.length) add(`${p}.annotations[${j}]`, 'independent annotator and non-empty route labels are required');
        if (people.has(a?.annotatorId)) add(`${p}.annotations[${j}]`, 'annotator must be distinct');
        people.add(a?.annotatorId);
      });
      if (people.has(source?.reviewerId)) add(`${p}.source.reviewerId`, 'source reviewer must not be an annotator');
    }
    const adj = item.adjudication;
    if (!adj?.reviewerId || !['agreement', 'resolved_disagreement'].includes(adj.resolution) || !Array.isArray(adj.acceptableRoutes) || !adj.acceptableRoutes.length) add(`${p}.adjudication`, 'independent adjudicator and resolved route labels are required');
    else if (Array.isArray(item.annotations) && item.annotations.some((a) => a?.annotatorId === adj.reviewerId)) add(`${p}.adjudication.reviewerId`, 'adjudicator must be independent of both annotators');
    if (adj?.resolution === 'agreement' && Array.isArray(annotations) && annotations.length >= 2) {
      const signatures = [acceptableSignature(adj)];
      for (const annotation of annotations) signatures.push(acceptableSignature(annotation));
      if (signatures.some((signature) => signature === null || signature !== signatures[0])) {
        add(`${p}.adjudication.resolution`, 'agreement requires matching route and sequence labels from every independent annotation and the adjudicator');
      }
    }
    for (const dimension of ['execution', 'factual']) {
      const oracle = item.oracles?.[dimension];
      if (!oracle || !['available', 'not_applicable'].includes(oracle.status) || !oracle.reference || !oracle.version || !isSha256(oracle.sha256)) add(`${p}.oracles.${dimension}`, 'versioned authoritative oracle or explicit not_applicable record required');
      else if (oracle.status !== 'available') add(`${p}.oracles.${dimension}`, 'promotion requires an available authoritative oracle');
    }
  }

  if (record.cases.length < 300) add('cases', `requires at least 300 independently adjudicated natural-language cases; found ${record.cases.length}`);
  for (const split of ['development', 'calibration', 'locked_holdout']) if (!splitsSeen.has(split)) add('cases.split', `missing required ${split} partition`);
  for (const family of promotedFamilies) if ((familyCounts.get(family) ?? 0) < 50) add(`family.${family}`, `requires at least 50 cases; found ${familyCounts.get(family) ?? 0}`);

  const caseById = new Map(record.cases.filter((c) => isObject(c) && typeof c.caseId === 'string').map((c) => [c.caseId, c]));
  const runIds = new Set();
  for (const [index, run] of record.runs.entries()) {
    const p = `runs[${index}]`;
    if (!isObject(run)) { add(p, 'must be an object'); continue; }
    const item = caseById.get(run.caseId);
    if (!item) { add(p, 'run must reference a known case'); continue; }
    if (runIds.has(run.caseId)) add(`${p}.caseId`, 'duplicate scorecard for case');
    runIds.add(run.caseId);
    if (run.split !== item.split) add(`${p}.split`, 'must match frozen case split');
    if (mode !== run.split) add(p, `contains ${typeof run.split === 'string' ? run.split : 'invalid'} outcomes while reporting ${mode}`);
    for (const dim of DIMENSIONS) {
      const value = run.scores?.[dim];
      if (value === undefined || value === null || UNVERIFIED.has(value)) add(`${p}.scores.${dim}`, 'missing or unverified outcomes block promotion');
      if (dim in SCORE_VALUES && !SCORE_VALUES[dim].has(value)) add(`${p}.scores.${dim}`, 'unknown outcome label');
      if (['cost', 'latency'].includes(dim) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) add(`${p}.scores.${dim}`, 'must be a finite non-negative number');
    }
  }
  if (!record.runs.length) add('runs', 'at least one scored run is required');
  for (const [index, item] of record.cases.entries()) {
    if (isObject(item) && item.split === mode && !runIds.has(item.caseId)) {
      add(`cases[${index}].caseId`, `missing ${mode} scorecard`);
    }
  }
  return errors;
}

export function scoreReport(record, mode = 'development') {
  const rows = Array.isArray(record?.runs) ? record.runs.filter((run) => run?.split === mode) : [];
  const categories = ['routing', 'execution', 'answer', 'accuracy', 'coverage'];
  const report = { mode, cases: rows.length, dimensions: {} };
  for (const dim of categories) {
    const counts = Object.create(null);
    for (const row of rows) {
      const value = row.scores?.[dim];
      const label = value === undefined || value === null ? 'missing' : typeof value === 'string' ? value : 'invalid';
      counts[label] = (counts[label] ?? 0) + 1;
    }
    report.dimensions[dim] = { counts, denominator: rows.length };
  }
  for (const dim of ['cost', 'latency']) {
    const values = rows.map((row) => row.scores?.[dim]).filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    let mean = 0;
    for (const [index, value] of values.entries()) mean += (value - mean) / (index + 1);
    report.dimensions[dim] = { count: values.length, mean: values.length ? mean : null, p95: values.length ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : null, unit: dim === 'cost' ? 'USD' : 'milliseconds' };
  }
  return report;
}

export function promotionGate(record, options = {}) {
  const mode = Object.hasOwn(options ?? {}, 'mode') ? options.mode : 'development';
  const errors = validateAdjudication(record, { ...options, mode });
  const report = scoreReport(record, mode);
  return {
    evidenceReady: errors.length === 0,
    promotionAllowed: false,
    status: errors.length === 0 ? 'evidence_ready_for_threshold_review' : 'blocked',
    errors,
    report,
    promotionNote: 'Evidence completeness is not a promotion decision; evaluate the frozen Phase 5 acceptance targets and live gates separately.',
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const [, , input, mode = 'development', familyFreezeFile, trustedFamilyFreezeSha256] = process.argv;
  if (!input || !familyFreezeFile || !trustedFamilyFreezeSha256) { console.error('Usage: node adjudication-gate.mjs <record.json> <development|calibration|locked_holdout> <family-freeze.json> <trusted-family-freeze-sha256>'); process.exitCode = 2; }
  else {
    const record = JSON.parse(await readFile(input, 'utf8'));
    const familyFreeze = JSON.parse(await readFile(familyFreezeFile, 'utf8'));
    const result = promotionGate(record, { mode, familyFreeze, trustedFamilyFreezeSha256 });
    console.log(JSON.stringify(result, null, 2));
    if (!result.evidenceReady) process.exitCode = 1;
  }
}
