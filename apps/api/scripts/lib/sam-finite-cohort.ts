import { PrismaClient } from '@prisma/client';
import { isAbsolute } from 'node:path';
import { AcquisitionContinuityStore } from '../../src/program-element/acquisition-continuity/acquisition-continuity.store.js';
import { capturePrismaDeadline, runPrismaTransaction } from '../../src/prisma/prisma-transaction-deadline.js';
import { awardKey, canonicalJson, mapSamAction, parseAwardId, SAM_ACTION_CONTRACT, transactionInput, validProducerRun,
  type AwardCandidate, type ProducerRun, type SamRecord } from './sam-contract-action.js';
import { exactInstant } from './sam-exact-instant.js';
import { assertLosslessSamJsonSupport } from './sam-response-json.js';
import { createPrivateEvidenceDirectory, readCohortFile, sha256Bytes, stageSamPage, type FiniteEvidence } from './sam-finite-evidence.js';

export interface FiniteSamConfig {
  keys: readonly string[]; cohortBytes: Buffer; cohortSha256: string; evidenceDir: string;
  run: ProducerRun; commit: boolean; enabled: boolean; apiKey: string; expiresAt: string;
  startedAt: number; deadlineAt: number; maxPages: number; maxRecords: number; maxBodyBytes: number; maxTotalBytes: number; responseMs: number;
}
const OPTIONS = new Set(['award-keys-file', 'award-keys-sha256', 'evidence-dir', 'expires-at', 'producer-commit',
  'image-digest', 'run-id', 'target-id', 'max-pages', 'max-records', 'max-body-bytes', 'max-total-bytes', 'response-timeout-ms', 'task-timeout-ms']);
export function parseFiniteSamConfig(args: readonly string[], env: NodeJS.ProcessEnv, now = Date.now(), read = readCohortFile): FiniteSamConfig {
  const values = new Map<string, string>(); let commit = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === '--commit' && !commit) { commit = true; continue; }
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (!OPTIONS.has(name) || values.has(name) || !args[index + 1] || args[index + 1]!.startsWith('--'))
      throw new Error('FINITE_FLAGS_INVALID_OR_MIXED');
    values.set(name, args[++index]!);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`FINITE_REQUIRED_${key.toUpperCase().replaceAll('-', '_')}`); return value; };
  const bounded = (key: string, max: number, fallback = max) => {
    const value = values.get(key) ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('FINITE_BOUND_INVALID');
    return Number(value);
  };
  const run = { contract: SAM_ACTION_CONTRACT, producerCommit: required('producer-commit'), imageDigest: required('image-digest'),
    runId: required('run-id'), targetId: required('target-id') };
  if (!validProducerRun(run)) throw new Error('FINITE_PROVENANCE_INVALID');
  const expiresAt = exactInstant(required('expires-at'));
  if (!expiresAt || Date.parse(expiresAt) <= now) throw new Error('FINITE_EXPIRY_INVALID');
  const evidenceDir = required('evidence-dir');
  if (!isAbsolute(evidenceDir)) throw new Error('FINITE_EVIDENCE_PATH_INVALID');
  const config = { maxPages: bounded('max-pages', 25), maxRecords: bounded('max-records', 2500),
    maxBodyBytes: bounded('max-body-bytes', 2 * 1024 * 1024), maxTotalBytes: bounded('max-total-bytes', 16 * 1024 * 1024),
    responseMs: bounded('response-timeout-ms', 10000), taskMs: bounded('task-timeout-ms', 120000) };
  const expected = required('award-keys-sha256');
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('FINITE_COHORT_DIGEST_INVALID');
  const cohortBytes = read(required('award-keys-file'));
  if (cohortBytes.length > 16384 || sha256Bytes(cohortBytes) !== expected) throw new Error('FINITE_COHORT_DIGEST_MISMATCH');
  let keys: unknown;
  try { keys = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cohortBytes)); } catch { throw new Error('FINITE_COHORT_JSON_INVALID'); }
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 25 || new Set(keys).size !== keys.length
    || keys.some((key) => {
      if (typeof key !== 'string' || key.length > 512 || !key.startsWith('usaspending|award|')) return true;
      const id = key.slice('usaspending|award|'.length), parts = parseAwardId(id);
      return !parts || awardKey(id) !== key || id !== `CONT_AWD_${parts.piid}_${parts.agency}_${parts.parentPiid ?? '-NONE-'}_${parts.parentAgency ?? '-NONE-'}`;
    })) throw new Error('FINITE_COHORT_KEYS_INVALID');
  if (new Set(keys.map((key) => parseAwardId(key.slice('usaspending|award|'.length))!.piid)).size > config.maxPages)
    throw new Error('FINITE_PAGE_BUDGET_BELOW_COHORT');
  const apiKey = env.SAM_GOV_API_KEY?.trim();
  if (!apiKey) throw new Error('FINITE_API_KEY_REQUIRED');
  assertLosslessSamJsonSupport();
  return { ...config, keys: Object.freeze(keys), cohortBytes, cohortSha256: expected, evidenceDir, run, commit,
    enabled: commit && env.PROGRAM_ACQUISITION_CONTINUITY_ENABLED === 'true', apiKey, expiresAt,
    startedAt: now, deadlineAt: Math.min(now + config.taskMs, Date.parse(expiresAt)) };
}
export interface FiniteSamReceipt {
  contract: 'sam-finite-cohort/1'; state: 'STAGING' | 'DRY_RUN' | 'COMPLETED_BOUNDED' | 'REFUSED' | 'TRANSACTION_OUTCOME_UNRESOLVED';
  coverage: 'bounded_observation_only'; mode: 'COMMIT' | 'DRY_RUN'; run: ProducerRun; cohortSha256: string; awardIdentityKeys: readonly string[];
  expiresAt: string; deadlineAt: number; finishedAt: string | null; plannedPages: number;
  pages: Array<{ piid: string; offset: 0; limit: 100; attempts: 1; file: string; records: number | null; historyIncomplete: boolean | null;
    totalReported: number | null; observedAt: string | null; status: number | null; responseBodyComplete: boolean }>;
  artifacts: Array<{ file: string; bytes: number; sha256: string }>; examined: number; mapped: number; unvalidated: number; rejected: Record<string, number>;
  inserted: number | null; existing: number | null; provisionalRows: Array<{ id: string; inserted: boolean;
    sourcePayloadHash: string; awardIdentityKey: string; observedAt: string; file: string; row: number }>;
  outcomes: Array<{ file: string; row: number; outcome: string }>;
  reason: string | null; qualification: 'independent_review_required';
}
export interface FiniteSamPorts {
  createClient(): PrismaClient; createEvidence(path: string): FiniteEvidence; fetch: typeof fetch; now(): number;
}
const defaultPorts: FiniteSamPorts = { createClient: () => new PrismaClient(), createEvidence: createPrivateEvidenceDirectory, fetch, now: Date.now };
const bytes = (value: unknown) => {
  const content = Buffer.from(JSON.stringify(value, null, 2));
  if (content.length > 4 * 1024 * 1024) throw new Error('FINITE_RECEIPT_SIZE_LIMIT');
  return content;
};

/** No provider/DB activity until config has passed; no write until every staged page has been mapped. */
export async function runFiniteSamCohort(config: FiniteSamConfig, ports: FiniteSamPorts = defaultPorts,
  registerDeadlineEvidence?: (retain: () => void) => void): Promise<FiniteSamReceipt> {
  if (ports.now() < config.startedAt) throw new Error('FINITE_DEADLINE_EXCEEDED');
  const deadline = capturePrismaDeadline({ at: config.deadlineAt, now: ports.now });
  const remaining = () => { try { return deadline.remaining(); } catch { throw new Error('FINITE_DEADLINE_EXCEEDED'); } };
  remaining();
  const receipt: FiniteSamReceipt = { contract: 'sam-finite-cohort/1', state: 'STAGING', coverage: 'bounded_observation_only',
    mode: config.enabled ? 'COMMIT' : 'DRY_RUN', run: config.run, cohortSha256: config.cohortSha256, awardIdentityKeys: config.keys,
    expiresAt: config.expiresAt, deadlineAt: config.deadlineAt, finishedAt: null,
    plannedPages: new Set(config.keys.map((key) => parseAwardId(key.slice('usaspending|award|'.length))!.piid)).size,
    pages: [], artifacts: [], examined: 0, mapped: 0, unvalidated: 0, rejected: {}, inserted: 0, existing: 0,
    provisionalRows: [], outcomes: [], reason: null, qualification: 'independent_review_required' };
  const privateEvidence = ports.createEvidence(config.evidenceDir);
  const evidence: FiniteEvidence = { write(file, content) {
    privateEvidence.write(file, content); receipt.artifacts.push({ file, bytes: content.byteLength, sha256: sha256Bytes(content) });
  } };
  evidence.write('cohort.json', config.cohortBytes);
  evidence.write('invocation.json', bytes({ ...receipt, limits: { pages: config.maxPages, records: config.maxRecords,
    bodyBytes: config.maxBodyBytes, totalBytes: config.maxTotalBytes, responseMs: config.responseMs, deadlineAt: config.deadlineAt, attempts: 1 } }));
  let prisma: PrismaClient | undefined, writeAttempted = false;
  const retainDeadline = () => evidence.write('task-expired.json', bytes({ contract: receipt.contract, run: config.run,
    cohortSha256: config.cohortSha256, deadlineAt: config.deadlineAt, state: writeAttempted ? 'TRANSACTION_OUTCOME_UNRESOLVED' : 'REFUSED',
    inserted: writeAttempted ? null : 0, existing: writeAttempted ? null : 0, reason: 'FINITE_DEADLINE_EXCEEDED',
    supersedesReceipt: true, serverTerminationOrRollbackEstablished: false }));
  registerDeadlineEvidence?.(retainDeadline);
  try {
    const staged = await stageCohort(config, ports, evidence, receipt, remaining);
    remaining();
    prisma = ports.createClient();
    // Durable intent precedes any transaction admission. A missing final receipt never implies rollback.
    if (config.enabled) evidence.write('write-intent.json', bytes({ ...receipt, state: 'TRANSACTION_OUTCOME_UNRESOLVED', inserted: null, existing: null }));
    await runPrismaTransaction((work, options) => prisma!.$transaction(work, options), async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
    }, async (tx) => {
      remaining();
      const piids = [...new Set(config.keys.map((key) => parseAwardId(key.slice('usaspending|award|'.length))!.piid))];
      const candidates = await tx.$queryRaw<AwardCandidate[]>`
        SELECT * FROM (
          SELECT DISTINCT a.piid, a.award_unique_id AS "awardUniqueId", r.identity_key AS "identityKey"
          FROM public.federal_award a JOIN public.acquisition_record_revision r
            ON r.source_record_id=a.award_unique_id AND r.record_kind='award' AND r.source_system='usaspending'
          WHERE a.piid=ANY(${piids}::text[])
        ) candidates ORDER BY "awardUniqueId" COLLATE "C", "identityKey" COLLATE "C", piid COLLATE "C" LIMIT 26`;
      remaining();
      const accepted = validateStagedCohort(staged, candidates, config.keys, receipt);
      const existing = await tx.$queryRaw<Array<{ present: boolean }>>`
        SELECT true AS present FROM public.acquisition_award_transaction_revision
        WHERE source_system='sam_gov' AND raw_jsonb#>>'{acquisitionProvenance,contract}'=${config.run.contract}
          AND raw_jsonb#>>'{acquisitionProvenance,producerCommit}'=${config.run.producerCommit}
          AND raw_jsonb#>>'{acquisitionProvenance,imageDigest}'=${config.run.imageDigest}
          AND raw_jsonb#>>'{acquisitionProvenance,runId}'=${config.run.runId}
          AND raw_jsonb#>>'{acquisitionProvenance,targetId}'=${config.run.targetId} LIMIT 1`;
      remaining();
      if (existing.length) throw new Error('FINITE_PRIOR_RUN_REFUSED');
      const store = new AcquisitionContinuityStore(tx as never);
      for (const item of accepted) {
        remaining();
        if (!config.enabled) continue;
        writeAttempted = true;
        const result = await store.appendTransaction(transactionInput(item.record, item.mapped, config.run, item.observedAt));
        receipt.provisionalRows.push({ id: result.id, inserted: result.inserted, sourcePayloadHash: item.mapped.sourcePayloadHash,
          awardIdentityKey: item.mapped.awardIdentityKey, observedAt: item.observedAt, file: item.file, row: item.row }); remaining();
      }
    }, { readOnly: !config.enabled, isolationLevel: 'ReadCommitted', timeoutMs: Math.min(15000, remaining() - 1000),
      deadline: { at: config.deadlineAt - 1000, now: deadline.deadline.now } });
    remaining();
    receipt.state = config.enabled ? 'COMPLETED_BOUNDED' : 'DRY_RUN';
    receipt.inserted = receipt.provisionalRows.filter((row) => row.inserted).length;
    receipt.existing = receipt.provisionalRows.filter((row) => !row.inserted).length;
  } catch (error) {
    receipt.reason = error instanceof Error && /^(?:FINITE_[A-Z0-9_]+|SOURCE_[A-Z0-9_]+)$/.test(error.message) ? error.message : 'FINITE_OPERATION_FAILED';
    receipt.state = writeAttempted ? 'TRANSACTION_OUTCOME_UNRESOLVED' : 'REFUSED';
    if (writeAttempted) { receipt.inserted = null; receipt.existing = null; }
  } finally {
    if (prisma) try { await prisma.$disconnect(); remaining(); } catch {
      receipt.reason = 'FINITE_CLEANUP_FAILED';
      if (writeAttempted) { receipt.state = 'TRANSACTION_OUTCOME_UNRESOLVED'; receipt.inserted = null; receipt.existing = null; }
      else receipt.state = 'REFUSED';
    }
  }
  receipt.unvalidated = receipt.outcomes.filter((outcome) => outcome.outcome === 'staged_not_validated').length;
  receipt.finishedAt = new Date(ports.now()).toISOString();
  try { evidence.write('receipt.json', bytes(receipt)); } catch {
    receipt.reason = 'FINITE_RECEIPT_WRITE_FAILED';
    receipt.state = writeAttempted ? 'TRANSACTION_OUTCOME_UNRESOLVED' : 'REFUSED';
    if (writeAttempted) { receipt.inserted = null; receipt.existing = null; }
  }
  try { remaining(); } catch {
    receipt.reason = 'FINITE_DEADLINE_EXCEEDED';
    receipt.state = writeAttempted ? 'TRANSACTION_OUTCOME_UNRESOLVED' : 'REFUSED';
    if (writeAttempted) { receipt.inserted = null; receipt.existing = null; }
    try { retainDeadline(); } catch { /* Durable write intent remains the reconciliation authority. */ }
  }
  return receipt;
}
type StagedRecord = { record: SamRecord; observedAt: string; file: string; row: number };
async function stageCohort(config: FiniteSamConfig, ports: FiniteSamPorts, evidence: FiniteEvidence, receipt: FiniteSamReceipt, remaining: () => number) {
  const staged: StagedRecord[] = []; let totalBytes = 0;
  const piids = [...new Set(config.keys.map((key) => parseAwardId(key.slice('usaspending|award|'.length))!.piid))];
  for (const piid of piids) {
    remaining();
    if (totalBytes >= config.maxTotalBytes) throw new Error('FINITE_TOTAL_BODY_LIMIT');
    const page = { piid, offset: 0 as const, limit: 100 as const, attempts: 1 as const, file: `page-${receipt.pages.length + 1}.bin`,
      records: null as number | null, historyIncomplete: null as boolean | null, totalReported: null as number | null,
      observedAt: null as string | null, status: null as number | null, responseBodyComplete: false };
    receipt.pages.push(page);
    const result = await stageSamPage({ apiKey: config.apiKey, piid, file: page.file, evidence, remaining,
      maxBytes: Math.min(config.maxBodyBytes, config.maxTotalBytes - totalBytes), responseMs: config.responseMs, fetch: ports.fetch, now: ports.now,
      onResponse: (status) => { page.status = status; }, onBodyComplete: () => { page.responseBodyComplete = true; } });
    page.records = result.records.length; page.historyIncomplete = result.historyIncomplete; page.totalReported = result.totalRecords;
    page.observedAt = result.observedAt; page.status = result.status;
    totalBytes += result.bytes; receipt.examined += result.records.length;
    receipt.outcomes.push(...result.records.map((_record, row) => ({ file: page.file, row, outcome: 'staged_not_validated' })));
    if (receipt.examined > config.maxRecords) throw new Error('FINITE_ROW_LIMIT');
    staged.push(...result.records.map((record, row) => ({ record, observedAt: result.observedAt, file: page.file, row })));
  }
  return staged;
}
function validateStagedCohort(staged: readonly StagedRecord[], candidates: readonly AwardCandidate[], keys: readonly string[], receipt: FiniteSamReceipt) {
  if (candidates.length > 25 || candidates.some((candidate) => awardKey(candidate.awardUniqueId) !== candidate.identityKey
    || parseAwardId(candidate.awardUniqueId)?.piid !== candidate.piid)
    || keys.some((key) => !candidates.some((candidate) => candidate.identityKey === key))) throw new Error('FINITE_CATALOG_SCOPE_INVALID');
  receipt.outcomes = [];
  const accepted: Array<StagedRecord & { mapped: Extract<ReturnType<typeof mapSamAction>, { ok: true }>['value'] }> = [];
  const heads = new Map<string, Set<string>>(); let refused = false;
  for (const item of staged) {
    const mapped = mapSamAction(item.record, candidates);
    if (!mapped.ok) { receipt.outcomes.push({ file: item.file, row: item.row, outcome: mapped.reason }); refused = true; continue; }
    if (!keys.includes(mapped.value.awardIdentityKey)) { receipt.outcomes.push({ file: item.file, row: item.row, outcome: 'out_of_scope' }); continue; }
    const identity = JSON.stringify([mapped.value.sourceTransactionId, mapped.value.sourceRevisionOrder]);
    const payloads = heads.get(identity) ?? new Set<string>(); payloads.add(canonicalJson(item.record)); heads.set(identity, payloads);
    accepted.push({ ...item, mapped: mapped.value });
  }
  for (const item of accepted) {
    const fork = heads.get(JSON.stringify([item.mapped.sourceTransactionId, item.mapped.sourceRevisionOrder]))!.size > 1;
    receipt.outcomes.push({ file: item.file, row: item.row, outcome: fork ? 'source_revision_fork' : 'mapped' });
    if (fork) refused = true;
  }
  for (const outcome of receipt.outcomes) {
    if (outcome.outcome === 'mapped') receipt.mapped++;
    else receipt.rejected[outcome.outcome] = (receipt.rejected[outcome.outcome] ?? 0) + 1;
  }
  if (refused) throw new Error('FINITE_STAGED_MAPPING_REFUSED');
  return accepted;
}
