#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const usage = 'Usage: node scripts/prepare-phase8-session6-federal-funding-corpus.mjs --prepare';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 1 || args[0] !== '--prepare') {
  console.error(usage);
  process.exit(2);
}
const corpusPath = path.join(root, 'docs/defense-budget/phase8-session6-federal-funding-corpus.json');
const outDir = path.resolve(process.env.PHASE8_SESSION6_WORKDIR || path.join(root, '.session6-federal-funding'));
const outputPath = path.join(outDir, 'prepared-corpus.json');
const allowedHosts = new Set(['www.govinfo.gov', 'govinfo.gov', 'www.congress.gov', 'congress.gov']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function assertHttpsOfficialUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new Error(`Refusing non-official Session 6 source URL: ${raw}`);
  }
  return url;
}

function allocationFromProvision(provision) {
  const authoritativeAmountUsd = provision.authoritativeAmountUsd ?? null;
  if (
    authoritativeAmountUsd !== null &&
    (provision.mappingMaturity === 'capability_inference' ||
      provision.mappingMaturity === 'unmapped' ||
      provision.targetType === 'capability' ||
      provision.inferredRelevance === true ||
      provision.reviewState !== 'verified')
  ) {
    throw new Error(`Unsafe authoritative allocation in ${provision.section}`);
  }
  return {
    targetType: provision.targetType,
    targetNativeKey: provision.targetNativeKey ?? null,
    targetId: null,
    allocationStage: 'statutory',
    mappingMaturity: provision.mappingMaturity,
    reviewState: provision.reviewState,
    authoritativeAmountUsd,
    inferredRelevance: provision.inferredRelevance === true,
    confidence: provision.reviewState === 'verified' ? 1 : null,
    baseRequestStatus: 'unknown',
    potentialDoubleCount: true,
    fundingPosture: 'one_time',
    obligationReference: null,
    executionReference: null,
  };
}

await fs.mkdir(outDir, { recursive: true });
const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
if (corpus.schemaVersion !== 'phase8_session6_federal_funding_corpus_v1') {
  throw new Error(`Unsupported corpus schema: ${corpus.schemaVersion}`);
}

const downloadCache = new Map();
async function materialize(urlText) {
  const url = assertHttpsOfficialUrl(urlText).toString();
  if (downloadCache.has(url)) return downloadCache.get(url);
  const response = await fetch(url, {
    headers: { 'user-agent': 'Capiro-Phase8-Session6/1.0 source-grounded-ingestion' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Source download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = { bytes, sha256: sha256(bytes), byteSize: bytes.length };
  downloadCache.set(url, result);
  return result;
}

const preparedSources = [];
for (const source of corpus.sources) {
  const downloaded = await materialize(source.officialUrl);
  if (source.sourceSha256 && source.sourceSha256 !== downloaded.sha256) {
    throw new Error(`Pinned source SHA mismatch for ${source.sourceKey}`);
  }
  const fileName = `${source.sourceKey}-${downloaded.sha256.slice(0, 12)}.pdf`;
  await fs.writeFile(path.join(outDir, fileName), downloaded.bytes, { flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(path.join(outDir, fileName));
    if (sha256(existing) !== downloaded.sha256) throw new Error(`Existing source artifact hash mismatch: ${fileName}`);
  });

  const measureBasis = {
    sourceSha256: downloaded.sha256,
    sourceKey: source.sourceKey,
    measureType: source.measureType,
    fiscalYear: source.fiscalYear,
    legislationId: source.legislationId,
    publicLawNumber: source.publicLawNumber,
  };
  const measureDedupKey = sha256(canonicalJson(measureBasis));

  const provisions = source.provisions.map((provision) => {
    const evidenceBinding = {
      sourceSha256: downloaded.sha256,
      evidencePage: provision.evidencePage,
      section: provision.section,
      statedAmountUsd: provision.statedAmountUsd,
      purposeText: provision.purposeText,
    };
    const evidenceSha256 = sha256(canonicalJson(evidenceBinding));
    const provisionDedupKey = sha256(canonicalJson({ measureDedupKey, ...evidenceBinding }));
    const allocation = allocationFromProvision(provision);
    const allocationDedupKey = sha256(canonicalJson({
      provisionDedupKey,
      targetType: allocation.targetType,
      targetNativeKey: allocation.targetNativeKey,
      allocationStage: allocation.allocationStage,
      mappingMaturity: allocation.mappingMaturity,
    }));
    return {
      ...provision,
      evidenceSha256,
      dedupKey: provisionDedupKey,
      allocation: { ...allocation, evidenceSha256, dedupKey: allocationDedupKey },
    };
  });

  preparedSources.push({
    ...source,
    sourceSha256: downloaded.sha256,
    byteSize: downloaded.byteSize,
    materializedFileName: fileName,
    measureDedupKey,
    provisions,
  });
}

const prepared = {
  schemaVersion: 'phase8_session6_prepared_federal_funding_corpus_v1',
  sourceCorpusSchemaVersion: corpus.schemaVersion,
  preparedAt: new Date().toISOString(),
  semanticRule: corpus.semanticRule,
  sources: preparedSources,
};
await fs.writeFile(outputPath, `${JSON.stringify(prepared, null, 2)}\n`, { flag: 'w' });
console.log(`[phase8-session6] PREPARED sources=${preparedSources.length} output=${outputPath}`);
console.log(`[phase8-session6] corpusSha256=${sha256(canonicalJson(preparedSources))}`);
