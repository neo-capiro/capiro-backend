import { createHash } from 'node:crypto';
import { validateAdjudication } from './adjudication-gate.mjs';

const HEX = /^[a-f0-9]{64}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;
const REPORTING_MODE = 'locked_holdout';
const FIXED_OUTCOMES = new Set(['multi_intent', 'needs_context', 'no_match']);
const RECEIPT_KEYS = ['schemaVersion', 'datasetId', 'datasetSha256', 'catalogVersion', 'catalogSha256', 'splitMembershipSha256', 'familyFreezeSha256', 'candidateManifestVersion', 'candidateManifestSha256', 'evaluationBatchId', 'mode', 'decisions'];
const DECISION_KEYS = ['caseId', 'split', 'producerId', 'reference', 'contentSha256', 'capturedAt', 'candidateManifestVersion', 'candidateManifestSha256', 'evaluationBatchId', 'disposition', 'proposal', 'selection', 'candidateExposedToolIds', 'fallbackReason'];
const ORACLE_KEYS = ['caseId', 'reviewerId', 'reference', 'version', 'contentSha256', 'requiredToolIds'];
const CANDIDATE_FREEZE_KEYS = ['version', 'sha256', 'frozenAt', 'reference', 'evaluationBatchId', 'catalogSha256'];

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.length > 0 && value === value.trim(); }
function digest(value) { return typeof value === 'string' && HEX.test(value); }
function sameSequence(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]); }
function sameToolSet(a, b) {
  const first = new Set(a);
  const second = new Set(b);
  return first.size === second.size && [...first].every((id) => second.has(id));
}
function ratio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }
function validTimestamp(value) {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset, offsetHour, offsetMinute] = match;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(Number(year), Number(month), 0);
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= lastDay.getUTCDate() &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
    (offset.toUpperCase() === 'Z' || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
}
function closed(value, path, keys, errors, optional = []) {
  if (!object(value)) { errors.push(`${path}: must be an object`); return false; }
  for (const key of Object.keys(value)) if (![...keys, ...optional].includes(key)) errors.push(`${path}.${key}: unexpected field`);
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
  return true;
}
function strings(value, path, errors, allowed = null, unique = true) {
  if (!Array.isArray(value)) { errors.push(`${path}: must be an array`); return false; }
  let valid = true;
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const id = value[index];
    if (!nonEmpty(id) || (allowed && !allowed.has(id)) || (unique && seen.has(id))) {
      errors.push(`${path}[${index}]: must be a ${unique ? 'unique, ' : ''}non-empty allowed ID`);
      valid = false;
    }
    seen.add(id);
  }
  return valid;
}
function route(value, path, errors, catalogIds) {
  if (!closed(value, path, ['label', 'sequence'], errors)) return false;
  let valid = true;
  if (!nonEmpty(value.label) || (!FIXED_OUTCOMES.has(value.label) && !catalogIds.has(value.label))) {
    errors.push(`${path}.label: absent from the trusted catalog and fixed outcomes`);
    valid = false;
  }
  if (!strings(value.sequence, `${path}.sequence`, errors, catalogIds, false)) valid = false;
  return valid;
}
function scorelessReport(mode) {
  return {
    mode,
    overall: { cases: 0, acceptableWorkflows: 0, rate: null },
    perFamily: {},
    acceptedDecisionPrecision: { accepted: 0, acceptable: 0, rate: null },
    fallback: { count: 0, rate: null },
    requiredCapabilityRecall: { required: null, retained: null, rate: null },
  };
}

/** Digest only a reviewed catalog manifest; the expected digest must come from a protected record. */
export function routeDecisionCatalogSha256(catalog) {
  return createHash('sha256').update(JSON.stringify([
    'meri-route-decision-catalog.v1', catalog.version, [...catalog.toolIds].sort(),
  ])).digest('hex');
}

/**
 * Offline structural preflight. It never authenticates external evidence or approves promotion.
 * The caller must supply an independently protected catalog/family digest; deriving a trusted
 * digest from the same submitted receipt would defeat the freeze check.
 */
export function routeDecisionMetricsPreflight(record, receiptSet, options = {}) {
  const errors = [];
  const blockers = [];
  const mode = options?.mode;
  if (mode !== REPORTING_MODE) return {
    structuralReady: false, metricInputsComplete: false, evidenceAuthenticated: false, promotionAllowed: false,
    errors: ['mode: this preflight is restricted to protected locked_holdout review'],
    blockers, report: scorelessReport(null),
  };

  const catalog = options?.catalog;
  closed(catalog, 'catalog', ['version', 'toolIds'], errors);
  const catalogIds = new Set(Array.isArray(catalog?.toolIds) ? catalog.toolIds : []);
  if (!object(catalog) || !nonEmpty(catalog.version) || !Array.isArray(catalog.toolIds) || !catalog.toolIds.length ||
      !strings(catalog.toolIds, 'catalog.toolIds', errors) || catalog.toolIds.some((id) => FIXED_OUTCOMES.has(id))) {
    errors.push('catalog: a reviewed non-empty canonical tool manifest is required');
  }
  if (!digest(options?.trustedCatalogSha256)) errors.push('trustedCatalogSha256: protected catalog digest is required');
  else if (object(catalog) && nonEmpty(catalog.version) && Array.isArray(catalog.toolIds) && catalog.toolIds.length &&
      catalogIds.size === catalog.toolIds.length && catalog.toolIds.every(nonEmpty) &&
      routeDecisionCatalogSha256(catalog) !== options.trustedCatalogSha256) {
    errors.push('trustedCatalogSha256: does not match the reviewed catalog manifest');
  }

  const candidateFreeze = options?.trustedCandidateManifest;
  closed(candidateFreeze, 'trustedCandidateManifest', CANDIDATE_FREEZE_KEYS, errors);
  if (!nonEmpty(candidateFreeze?.version) || !digest(candidateFreeze?.sha256) ||
      !validTimestamp(candidateFreeze?.frozenAt) || !nonEmpty(candidateFreeze?.reference) ||
      !nonEmpty(candidateFreeze?.evaluationBatchId) ||
      !digest(candidateFreeze?.catalogSha256) || candidateFreeze?.catalogSha256 !== options?.trustedCatalogSha256) {
    errors.push('trustedCandidateManifest: protected frozen candidate version, digest, batch, catalog, reference, and time are required');
  }

  const baseErrors = validateAdjudication(record, {
    mode,
    familyFreeze: options?.familyFreeze,
    trustedFamilyFreezeSha256: options?.trustedFamilyFreezeSha256,
  });
  errors.push(...baseErrors.map((error) => `adjudication.${error}`));

  if (!closed(receiptSet, 'receiptSet', RECEIPT_KEYS, errors, ['requiredCapabilityOracles'])) {
    return { structuralReady: false, metricInputsComplete: false, evidenceAuthenticated: false, promotionAllowed: false, errors, blockers, report: scorelessReport(mode ?? null) };
  }
  if (receiptSet.schemaVersion !== 'meri-route-decision-receipts.v1') errors.push('receiptSet.schemaVersion: unsupported version');
  if (!nonEmpty(receiptSet.datasetId) || receiptSet.datasetId !== record?.datasetId) errors.push('receiptSet.datasetId: must match the adjudicated dataset');
  if (!digest(receiptSet.datasetSha256) || receiptSet.datasetSha256 !== record?.datasetSha256) errors.push('receiptSet.datasetSha256: must match the adjudicated dataset');
  if (!nonEmpty(receiptSet.catalogVersion) || receiptSet.catalogVersion !== record?.catalogVersion || receiptSet.catalogVersion !== catalog?.version) errors.push('receiptSet.catalogVersion: must match the adjudicated and reviewed catalog');
  if (!digest(receiptSet.catalogSha256) || receiptSet.catalogSha256 !== options?.trustedCatalogSha256) errors.push('receiptSet.catalogSha256: must match the protected catalog digest');
  if (!digest(receiptSet.splitMembershipSha256) || receiptSet.splitMembershipSha256 !== record?.splitPlan?.membershipSha256) errors.push('receiptSet.splitMembershipSha256: must match the adjudicated split');
  if (!digest(receiptSet.familyFreezeSha256) || receiptSet.familyFreezeSha256 !== options?.trustedFamilyFreezeSha256) errors.push('receiptSet.familyFreezeSha256: must match the protected family freeze');
  if (!nonEmpty(receiptSet.candidateManifestVersion) || receiptSet.candidateManifestVersion !== candidateFreeze?.version) errors.push('receiptSet.candidateManifestVersion: must match the protected candidate manifest');
  if (!digest(receiptSet.candidateManifestSha256) || receiptSet.candidateManifestSha256 !== candidateFreeze?.sha256) errors.push('receiptSet.candidateManifestSha256: must match the protected candidate manifest');
  if (!nonEmpty(receiptSet.evaluationBatchId) || receiptSet.evaluationBatchId !== candidateFreeze?.evaluationBatchId) errors.push('receiptSet.evaluationBatchId: must match the protected evaluation batch');
  if (receiptSet.mode !== REPORTING_MODE || mode !== REPORTING_MODE) errors.push('receiptSet.mode: only locked_holdout review is permitted');

  const freezeTimes = [record?.splitPlan?.frozenAt, options?.familyFreeze?.frozenAt, candidateFreeze?.frozenAt];
  const latestFreeze = freezeTimes.every(validTimestamp) && freezeTimes.every((value) => Number.isFinite(Date.parse(value)))
    ? Math.max(...freezeTimes.map((value) => Date.parse(value)))
    : null;
  if (latestFreeze === null) errors.push('freezeTimes: protected split, family, and candidate freeze times must be comparable');

  const modeCases = Array.isArray(record?.cases) && mode === REPORTING_MODE ? record.cases.filter((item) => object(item) && item.split === mode) : [];
  const caseById = new Map(modeCases.map((item) => [item.caseId, item]));
  for (const item of modeCases) {
    const routes = item.adjudication?.acceptableRoutes;
    const sequences = item.adjudication?.acceptableSequences;
    if (Array.isArray(routes) && routes.some((label) => !FIXED_OUTCOMES.has(label) && !catalogIds.has(label))) {
      errors.push(`cases.${item.caseId}.adjudication.acceptableRoutes: route absent from the trusted catalog`);
    }
    if (Array.isArray(sequences) && sequences.length === 0 &&
        Array.isArray(routes) && routes.some((label) => !['needs_context', 'no_match'].includes(label))) {
      errors.push(`cases.${item.caseId}.adjudication.acceptableSequences: executable workflow has no sequence oracle`);
    }
    if (Array.isArray(sequences) && sequences.length && Array.isArray(routes)) {
      if (routes.length !== 1) {
        errors.push(`cases.${item.caseId}.adjudication: route labels and sequences are unpaired; a single executable label is required`);
      } else if (['needs_context', 'no_match'].includes(routes[0])) {
        errors.push(`cases.${item.caseId}.adjudication: non-executable route cannot have a tool sequence`);
      } else if (catalogIds.has(routes[0]) && sequences.some((sequence) => !Array.isArray(sequence) || !sequence.includes(routes[0]))) {
        errors.push(`cases.${item.caseId}.adjudication: executable route label must appear in every acceptable sequence`);
      }
    }
    if (Array.isArray(sequences)) for (const sequence of sequences) {
      if (!Array.isArray(sequence) || sequence.some((id) => !catalogIds.has(id))) {
        errors.push(`cases.${item.caseId}.adjudication.acceptableSequences: tool absent from the trusted catalog`);
      }
    }
  }
  const decisionById = new Map();
  const decisionReferenceByValue = new Map();
  if (!Array.isArray(receiptSet.decisions)) errors.push('receiptSet.decisions: must be an array');
  else for (let index = 0; index < receiptSet.decisions.length; index++) {
    const item = receiptSet.decisions[index];
    const path = `receiptSet.decisions[${index}]`;
    if (!closed(item, path, DECISION_KEYS, errors)) continue;
    if (!nonEmpty(item.caseId) || !caseById.has(item.caseId)) errors.push(`${path}.caseId: must reference a case in the reporting split`);
    else if (decisionById.has(item.caseId)) errors.push(`${path}.caseId: duplicate receipt`);
    else decisionById.set(item.caseId, item);
    if (item.split !== mode || item.split !== caseById.get(item.caseId)?.split) errors.push(`${path}.split: must match the frozen case split`);
    if (!nonEmpty(item.producerId)) errors.push(`${path}.producerId: required`);
    if (!nonEmpty(item.reference)) errors.push(`${path}.reference: protected exact receipt reference required`);
    else if (decisionReferenceByValue.has(item.reference)) errors.push(`${path}.reference: duplicate protected decision receipt reference (also ${decisionReferenceByValue.get(item.reference)})`);
    else decisionReferenceByValue.set(item.reference, path);
    if (!digest(item.contentSha256)) errors.push(`${path}.contentSha256: exact receipt digest required`);
    if (!validTimestamp(item.capturedAt)) errors.push(`${path}.capturedAt: valid RFC 3339 timestamp required`);
    else if (!Number.isFinite(Date.parse(item.capturedAt)) || (latestFreeze !== null && Date.parse(item.capturedAt) <= latestFreeze)) errors.push(`${path}.capturedAt: must be after all protected freezes`);
    if (!nonEmpty(item.candidateManifestVersion) || item.candidateManifestVersion !== receiptSet.candidateManifestVersion) errors.push(`${path}.candidateManifestVersion: candidate version drift`);
    if (!digest(item.candidateManifestSha256) || item.candidateManifestSha256 !== receiptSet.candidateManifestSha256) errors.push(`${path}.candidateManifestSha256: candidate digest drift`);
    if (!nonEmpty(item.evaluationBatchId) || item.evaluationBatchId !== receiptSet.evaluationBatchId) errors.push(`${path}.evaluationBatchId: evaluation batch drift`);
    strings(item.candidateExposedToolIds, `${path}.candidateExposedToolIds`, errors, catalogIds);
    if (item.disposition === 'accepted') {
      const proposed = route(item.proposal, `${path}.proposal`, errors, catalogIds);
      const selected = route(item.selection, `${path}.selection`, errors, catalogIds);
      if (item.fallbackReason !== null) errors.push(`${path}.fallbackReason: accepted decisions cannot be fallback`);
      if (proposed && selected && (item.proposal.label !== item.selection.label || !sameSequence(item.proposal.sequence, item.selection.sequence))) errors.push(`${path}.selection: must equal the accepted proposal`);
      if (selected && Array.isArray(item.candidateExposedToolIds)) {
        const exposed = new Set(item.candidateExposedToolIds);
        if (!item.selection.sequence.every((id) => exposed.has(id)) ||
            (catalogIds.has(item.selection.label) && !exposed.has(item.selection.label))) errors.push(`${path}.candidateExposedToolIds: selected tools must be exposed`);
      }
    } else if (item.disposition === 'fallback') {
      if (item.proposal !== null || item.selection !== null || !Array.isArray(item.candidateExposedToolIds) || item.candidateExposedToolIds.length || !nonEmpty(item.fallbackReason)) errors.push(`${path}: fallback must have no candidate/selection/exposure and an explicit reason`);
    } else errors.push(`${path}.disposition: unknown disposition`);
  }
  for (const item of modeCases) if (!decisionById.has(item.caseId)) errors.push(`receiptSet.decisions: missing receipt for ${item.caseId}`);

  const oracleById = new Map();
  const oracleReferenceByValue = new Map();
  if (Object.hasOwn(receiptSet, 'requiredCapabilityOracles') && !Array.isArray(receiptSet.requiredCapabilityOracles)) {
    errors.push('receiptSet.requiredCapabilityOracles: must be an array when supplied');
  } else if (Array.isArray(receiptSet.requiredCapabilityOracles)) {
    for (let index = 0; index < receiptSet.requiredCapabilityOracles.length; index++) {
      const item = receiptSet.requiredCapabilityOracles[index];
      const path = `receiptSet.requiredCapabilityOracles[${index}]`;
      if (!closed(item, path, ORACLE_KEYS, errors)) continue;
      const adjudicated = caseById.get(item.caseId);
      if (!nonEmpty(item.caseId) || !adjudicated) errors.push(`${path}.caseId: must reference a case in the reporting split`);
      else if (oracleById.has(item.caseId)) errors.push(`${path}.caseId: duplicate required-capability oracle`);
      else oracleById.set(item.caseId, item);
      if (!nonEmpty(item.reviewerId) || item.reviewerId === decisionById.get(item.caseId)?.producerId) errors.push(`${path}.reviewerId: independent reviewer required`);
      if (!nonEmpty(item.reference) || !nonEmpty(item.version) || !digest(item.contentSha256)) errors.push(`${path}: versioned protected oracle reference and digest required`);
      if (nonEmpty(item.reference)) {
        if (oracleReferenceByValue.has(item.reference)) errors.push(`${path}.reference: duplicate protected required-capability oracle reference (also ${oracleReferenceByValue.get(item.reference)})`);
        else oracleReferenceByValue.set(item.reference, path);
      }
      if (strings(item.requiredToolIds, `${path}.requiredToolIds`, errors, catalogIds) && adjudicated &&
          Array.isArray(adjudicated.adjudication?.acceptableSequences)) {
        const sequences = adjudicated.adjudication.acceptableSequences;
        const common = sequences.length && sequences.every(Array.isArray)
          ? [...new Set(sequences[0])].filter((id) => sequences.every((sequence) => sequence.includes(id)))
          : [];
        const requiredSet = new Set(item.requiredToolIds);
        if (requiredSet.size !== common.length || common.some((id) => !requiredSet.has(id))) {
          errors.push(`${path}.requiredToolIds: must exactly match tools common to every adjudicated acceptable sequence`);
        }
      }
    }
  }

  // The old per-run routing label is an assertion, not ground truth. Reject a claimed
  // success that contradicts the bound decision and adjudicated workflow oracle.
  if (Array.isArray(record?.runs)) {
    const runById = new Map(record.runs.filter((item) => object(item)).map((item) => [item.caseId, item]));
    for (const item of modeCases) {
      const decision = decisionById.get(item.caseId);
      const run = runById.get(item.caseId);
      if (decision && run && !acceptableWorkflow(item, decision) &&
          ['correct', 'acceptable_alternative'].includes(run.scores?.routing)) {
        errors.push(`runs.${item.caseId}.scores.routing: claimed success contradicts the decision receipt`);
      }
    }
  }

  if (errors.length) return {
    structuralReady: false, metricInputsComplete: false, evidenceAuthenticated: false, promotionAllowed: false, errors, blockers,
    report: scorelessReport(mode ?? null),
  };

  let acceptable = 0;
  let accepted = 0;
  let fallbacks = 0;
  const perFamily = Object.fromEntries(options.familyFreeze.familyIds.map((id) => [id, { cases: 0, acceptableWorkflows: 0, rate: null }]));
  for (const item of modeCases) {
    const decision = decisionById.get(item.caseId);
    const correct = acceptableWorkflow(item, decision);
    if (decision.disposition === 'accepted') accepted++;
    else fallbacks++;
    if (correct) acceptable++;
    for (const id of item.familyIds) if (Object.hasOwn(perFamily, id)) {
      perFamily[id].cases++;
      if (correct) perFamily[id].acceptableWorkflows++;
    }
  }
  for (const [id, result] of Object.entries(perFamily)) {
    result.rate = ratio(result.acceptableWorkflows, result.cases);
    if (!result.cases) blockers.push(`no_reporting_split_cases_for_promoted_family:${id}`);
  }
  if (!modeCases.length) blockers.push('no_cases_in_reporting_split');
  if (!accepted) blockers.push('no_accepted_decision_denominator');

  let required = 0;
  let retained = 0;
  const missingOracleIds = modeCases.filter((item) => !oracleById.has(item.caseId)).map((item) => item.caseId);
  const disjunctiveIds = modeCases.filter((item) => {
    const sequences = item.adjudication.acceptableSequences;
    return sequences.length > 1 && sequences.some((sequence) => !sameToolSet(sequences[0], sequence));
  }).map((item) => item.caseId);
  if (missingOracleIds.length) blockers.push(`independent_required_capability_oracle_missing:${missingOracleIds.join(',')}`);
  if (disjunctiveIds.length) blockers.push(`disjunctive_required_capability_coverage_oracle_missing:${disjunctiveIds.join(',')}`);
  if (!missingOracleIds.length && !disjunctiveIds.length) for (const item of modeCases) {
    const oracle = oracleById.get(item.caseId);
    const decision = decisionById.get(item.caseId);
    required += oracle.requiredToolIds.length;
    if (decision.disposition === 'accepted') {
      const exposed = new Set(decision.candidateExposedToolIds);
      retained += oracle.requiredToolIds.filter((id) => exposed.has(id)).length;
    }
  }
  if (!missingOracleIds.length && !disjunctiveIds.length && !required) blockers.push('no_required_capability_denominator');

  return {
    structuralReady: true,
    metricInputsComplete: blockers.length === 0,
    evidenceAuthenticated: false,
    promotionAllowed: false,
    errors,
    blockers,
    report: {
      mode,
      overall: { cases: modeCases.length, acceptableWorkflows: acceptable, rate: ratio(acceptable, modeCases.length) },
      perFamily,
      acceptedDecisionPrecision: { accepted, acceptable, rate: ratio(acceptable, accepted) },
      fallback: { count: fallbacks, rate: ratio(fallbacks, modeCases.length) },
      requiredCapabilityRecall: missingOracleIds.length || disjunctiveIds.length || !required
        ? { required: null, retained: null, rate: null }
        : { required, retained, rate: ratio(retained, required) },
    },
  };
}

function acceptableWorkflow(adjudicated, decision) {
  if (decision.disposition !== 'accepted' || !object(decision.selection)) return false;
  if (!Array.isArray(decision.selection.sequence)) return false;
  const oracle = adjudicated.adjudication;
  if (!Array.isArray(oracle?.acceptableRoutes) || !oracle.acceptableRoutes.includes(decision.selection.label)) return false;
  if (!Array.isArray(oracle.acceptableSequences)) return false;
  return oracle.acceptableSequences.length
    ? oracle.acceptableSequences.some((sequence) => sameSequence(sequence, decision.selection.sequence))
    : decision.selection.sequence.length === 0;
}
