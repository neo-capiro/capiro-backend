'use strict';
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const IMAGE_PREFIX = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:';
const BILL = 'fl-2026-h1211',
  BILL_HASH = '3184aa249ff092c0a182468355c62819';
const SCOPE = {
  billId: BILL,
  jurisdiction: 'FL',
  sessionKey: '2026',
  providerBillId: 2068308,
  providerSessionId: 2220,
};
const RESERVATION_SOURCE = 'legiscan-hb1211-dataset-reservation';
const CANDIDATE_SOURCE = 'legiscan-hb1211-dataset-candidate';
const APPLIED_SOURCE = 'legiscan-hb1211-dataset-inventory';
const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
const hash = (x) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
const bytesHash = (x) => createHash('sha256').update(x).digest('hex');
const iso = (x) => new Date(x).toISOString();
function runtimeBinding(env) {
  const sourceSha = env.HB1211_DATASET_SOURCE_SHA,
    image = env.HB1211_DATASET_IMAGE;
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
    env.GIT_SHA !== sourceSha ||
    env.RELEASE_SHA !== sourceSha
  )
    throw Error('EXPLICIT_REVIEWED_SOURCE_REQUIRED');
  if (
    typeof image !== 'string' ||
    !image.startsWith(IMAGE_PREFIX) ||
    !/^[a-f0-9]{64}$/.test(image.slice(IMAGE_PREFIX.length))
  )
    throw Error('EXPLICIT_REVIEWED_IMAGE_REQUIRED');
  return { sourceSha, image };
}
function environment(env) {
  runtimeBinding(env);
  if (env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED !== 'true')
    throw Error('EXISTING_OWNER_GATE_REQUIRED');
  const cap = Number(env.LEGISCAN_HARD_CAP ?? 30000);
  if (!Number.isSafeInteger(cap) || cap < 8 || cap > 30000)
    throw Error('EXISTING_HARD_CAP_INVALID');
  return cap;
}
function approval(env, expectedHash, now = new Date()) {
  if (env.HB1211_DATASET_APPROVED_PLAN !== expectedHash) throw Error('REVIEW_PLAN_DRIFT');
  const expires = Date.parse(env.HB1211_DATASET_EXPIRES_AT ?? '');
  if (
    !Number.isFinite(expires) ||
    expires <= now.getTime() ||
    expires - now.getTime() > 2 * 3600000
  )
    throw Error('REVIEW_EXPIRED');
}
async function transaction(db, readOnly, fn) {
  await db.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
async function snapshot(db) {
  const b = (
    await db.query(
      `SELECT id,state,session_key,legiscan_bill_id,legiscan_change_hash,
    report_source_facts->'documentInventory' AS inventory,
    md5((to_jsonb(b)-'report_source_facts')::text) AS protected_hash,
    md5((coalesce(report_source_facts,'{}'::jsonb)-'documentInventory')::text) AS other_facts_hash
    FROM state_bill b WHERE id=$1`,
      [BILL],
    )
  ).rows[0];
  const sessions = (
    await db.query(
      "SELECT legiscan_session_id FROM state_session WHERE state='FL' AND session_key='2026'",
    )
  ).rows;
  const cursor = (
    await db.query(
      "SELECT id,state,session_id,session_key FROM state_sync_cursor WHERE id='FL-2220'",
    )
  ).rows[0];
  const usage = (
    await db.query(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month,coalesce(sum(queries_used),0)::int AS used FROM state_sync_cursor WHERE quota_month=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM')",
    )
  ).rows[0];
  const versions = (
    await db.query(
      "SELECT count(*)::int AS count,md5(coalesce(string_agg(to_jsonb(v)::text,'|' ORDER BY id),'')) AS hash FROM state_bill_version v WHERE bill_key=$1",
      [BILL],
    )
  ).rows[0];
  const permissions = (
    await db.query(`SELECT name,privilege,has_table_privilege(current_user,name,privilege) AS allowed FROM (VALUES
    ('state_bill','SELECT'),('state_bill','UPDATE'),('state_session','SELECT'),('state_sync_cursor','SELECT'),('state_sync_cursor','UPDATE'),
    ('state_bill_version','SELECT'),('legal_source_receipt','SELECT'),('legal_source_receipt','INSERT'),
    ('legal_dataset_archive','SELECT'),('legal_dataset_archive','INSERT'),('legiwatch_research_document_source','SELECT'),('sync_run','SELECT')) p(name,privilege)`)
  ).rows;
  const activeLegacy = (
    await db.query(
      "SELECT source FROM sync_run WHERE status='running' AND (source='sync-legiscan-bills' OR source='backfill-legiscan-datasets' OR source LIKE 'sync-legiscan-masterlist%') LIMIT 20",
    )
  ).rows;
  return { bill: b, sessions, cursor, usage, versions, permissions, activeLegacy };
}
function identity(s, release) {
  if (
    !release ||
    !/^[a-f0-9]{40}$/.test(release.sourceSha ?? '') ||
    typeof release.image !== 'string'
  )
    throw Error('RELEASE_BINDING_REQUIRED');
  const b = s.bill;
  if (
    !b ||
    b.id !== BILL ||
    b.state !== 'FL' ||
    b.session_key !== '2026' ||
    b.legiscan_bill_id !== 2068308 ||
    b.legiscan_change_hash !== BILL_HASH
  )
    throw Error('EXACT_CANONICAL_REVISION_REQUIRED');
  if (
    s.sessions.length !== 1 ||
    s.sessions[0].legiscan_session_id !== 2220 ||
    s.cursor?.id !== 'FL-2220' ||
    s.cursor.state !== 'FL' ||
    s.cursor.session_id !== 2220 ||
    s.cursor.session_key !== '2026'
  )
    throw Error('EXACT_EXISTING_SESSION_CURSOR_REQUIRED');
  if (s.permissions.length !== 12 || s.permissions.some((p) => p.allowed !== true))
    throw Error('EXISTING_ROLE_INSUFFICIENT');
  return {
    scope: SCOPE,
    ...release,
    providerChangeHash: BILL_HASH,
    protectedHash: b.protected_hash,
    otherFactsHash: b.other_facts_hash,
    versions: s.versions,
  };
}
function previewPlan(s, cap, release) {
  const exact = identity(s, release);
  if (s.bill.inventory !== null) throw Error('MISSING_INVENTORY_ONLY');
  if (s.activeLegacy?.length) throw Error('LEGACY_PROVIDER_OWNER_RUNNING');
  if (!Number.isSafeInteger(s.usage.used) || s.usage.used < 0 || s.usage.used + 8 > cap)
    throw Error('EXISTING_HARD_CAP_HOLD');
  return {
    ...exact,
    mode: 'retrieve_dataset_only',
    quotaMonth: s.usage.month,
    hardCap: cap,
    reservedMaximum: 8,
    providerOperations: ['getDatasetList:FL', 'getDataset:2220'],
    billWrites: 0,
  };
}
function selectListing(list) {
  if (!Array.isArray(list) || list.length > 1000) throw Error('INVALID_DATASET_LIST');
  const matches = list.filter((x) => x?.session_id === 2220);
  if (matches.length !== 1) throw Error('EXACT_DATASET_LISTING_REQUIRED');
  const x = matches[0];
  if (
    typeof x.dataset_hash !== 'string' ||
    !x.dataset_hash.trim() ||
    typeof x.access_key !== 'string' ||
    !x.access_key.trim()
  )
    throw Error('INVALID_DATASET_LISTING');
  return x;
}
function decodeDataset(listing, result) {
  if (!result || result.session_id !== 2220 || result.dataset_hash !== listing.dataset_hash)
    throw Error('DATASET_REVISION_MISMATCH');
  if (listing.dataset_date && result.dataset_date !== listing.dataset_date)
    throw Error('DATASET_DATE_MISMATCH');
  if (
    typeof result.zip !== 'string' ||
    result.zip.length > 160000000 ||
    !result.zip.length ||
    result.zip.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(result.zip)
  )
    throw Error('INVALID_DATASET_BASE64');
  const zip = Buffer.from(result.zip, 'base64');
  if (zip.toString('base64') !== result.zip || zip.length > 120000000)
    throw Error('INVALID_DATASET_BYTES');
  return zip;
}
function qualifyParsed(parsed, reportSourceFacts, observedAt, provenance) {
  if (
    !parsed ||
    !Array.isArray(parsed.bills) ||
    Object.values(parsed.skipped ?? {}).length !== 3 ||
    Object.values(parsed.skipped).some((x) => x !== 0)
  )
    throw Error('DATASET_PARSE_INCOMPLETE');
  const matches = parsed.bills.filter((x) => x?.bill_id === 2068308);
  if (matches.length !== 1) throw Error('EXACT_DATASET_BILL_REQUIRED');
  const raw = matches[0];
  if (raw.state !== 'FL' || raw.session?.session_id !== 2220 || raw.change_hash !== BILL_HASH)
    throw Error('DATASET_CANONICAL_REVISION_MISMATCH');
  const inventory = { ...reportSourceFacts(raw).documentInventory, observedAt, provenance };
  if (
    inventory.sourceListComplete !== true ||
    !Array.isArray(inventory.expected) ||
    inventory.expected.length > 500
  )
    throw Error('PROVIDER_INVENTORY_INCOMPLETE');
  const keys = new Set();
  for (const x of inventory.expected) {
    if (
      !['text', 'amendment', 'supplement'].includes(x.kind) ||
      !Number.isSafeInteger(x.providerId) ||
      x.providerId < 1 ||
      typeof x.providerHash !== 'string' ||
      !x.providerHash.trim()
    )
      throw Error('DOCUMENT_IDENTITY_UNQUALIFIED');
    const key = x.kind + ':' + x.providerId;
    if (keys.has(key)) throw Error('DUPLICATE_DOCUMENT_IDENTITY');
    keys.add(key);
  }
  return inventory;
}
async function gaps(db, inventory) {
  const rows = (
    await db.query(
      "SELECT document_kind,provider_id,provider_hash FROM legiwatch_research_document_source WHERE bill_id=$1 AND is_current AND coverage='complete_document' AND extraction_state='extracted'",
      [BILL],
    )
  ).rows;
  return inventory.expected.filter(
    (x) =>
      !rows.some(
        (r) =>
          r.document_kind === x.kind &&
          String(r.provider_id) === String(x.providerId) &&
          r.provider_hash === x.providerHash,
      ),
  );
}
async function writeReceipt(db, id, source, manifest, complete, observedAt) {
  await db.query(
    'INSERT INTO legal_source_receipt(id,source,scope,manifest,complete,observed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
    [id, source, JSON.stringify(SCOPE), JSON.stringify(manifest), complete, observedAt],
  );
}
async function providerStep(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const http = /^LegiScan HTTP (\d{3}) for op=/.exec(message);
    const category = http ? `HTTP_${http[1]}`
      : /^(TimeoutError|AbortError)$/.test(error?.name ?? '') ? 'TIMEOUT'
      : /^LegiScan op=\w+ status=/.test(message) ? 'PROVIDER_REJECTED'
      : 'UNEXPECTED_FAILURE';
    // Never log a provider URL, credential, access key, or arbitrary response text.
    throw Error(`HB1211_${stage}_${category}`);
  }
}
async function retrieve(db, deps, env) {
  const cap = environment(env),
    release = runtimeBinding(env),
    before = await transaction(db, true, () => snapshot(db)),
    plan = previewPlan(before, cap, release);
  approval(env, hash(plan));
  if (!env.LEGISCAN_API_KEY) throw Error('EXISTING_PROVIDER_REQUIRED');
  const reservationId = randomUUID();
  await transaction(db, false, async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))");
    const fresh = await snapshot(db);
    if (hash(previewPlan(fresh, cap, release)) !== hash(plan)) throw Error('PRE_RESERVATION_DRIFT');
    const updated = await db.query(
      "UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=$1 THEN queries_used+8 ELSE 8 END,quota_month=$1 WHERE id='FL-2220' AND state='FL' AND session_id=2220 AND session_key='2026'",
      [plan.quotaMonth],
    );
    if (updated.rowCount !== 1) throw Error('EXISTING_CURSOR_CHANGED');
    await writeReceipt(
      db,
      reservationId,
      RESERVATION_SOURCE,
      { plan, planHash: hash(plan), reservedQueries: 8, refund: 0, legacyWorkersShareLock: false },
      false,
      new Date(),
    );
  });
  // A failed/unknown attempt keeps the conservative reservation. Never auto-replay.
  const listing = selectListing(await providerStep('DATASET_LIST', () => deps.getDatasetList(env.LEGISCAN_API_KEY, 'FL')));
  const result = await providerStep('DATASET_DOWNLOAD', () => deps.getDataset(env.LEGISCAN_API_KEY, 2220, listing.access_key));
  const receivedAt = new Date().toISOString(),
    zip = decodeDataset(listing, result),
    archiveHash = bytesHash(zip);
  const parsed = await providerStep('DATASET_PARSE', () => deps.parseDatasetZip(zip));
  // Validate before archive storage; no state_bill mutation in this phase.
  qualifyParsed(parsed, deps.reportSourceFacts, receivedAt, {});
  return transaction(db, false, async () => {
    const fresh = await snapshot(db);
    if (
      hash(identity(fresh, release)) !== hash(identity(before, release)) ||
      fresh.bill.inventory !== null
    )
      throw Error('CANONICAL_DRIFT_AFTER_FETCH');
    await db.query(
      'INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64,observed_at) VALUES($1,$2,$3) ON CONFLICT(content_hash) DO NOTHING',
      [archiveHash, result.zip, receivedAt],
    );
    const archive = (
      await db.query(
        'SELECT original_bytes_base64,observed_at FROM legal_dataset_archive WHERE content_hash=$1',
        [archiveHash],
      )
    ).rows[0];
    if (!archive || archive.original_bytes_base64 !== result.zip)
      throw Error('ARCHIVE_HASH_COLLISION_OR_DRIFT');
    const observedAt = iso(archive.observed_at);
    const provenance = {
      kind: 'legiscan_dataset',
      archiveHash,
      providerDatasetHash: result.dataset_hash,
      providerDatasetDate: result.dataset_date ?? null,
      retrievedAt: receivedAt,
      archiveObservedAt: observedAt,
    };
    const inventory = qualifyParsed(parsed, deps.reportSourceFacts, observedAt, provenance);
    const candidateId = randomUUID(),
      applyPlan = {
        ...identity(fresh, release),
        mode: 'apply_inventory_only',
        candidateId,
        archiveHash,
        inventory,
        inventoryHash: hash(inventory),
        expectedPriorInventory: null,
      };
    const missing = await gaps(db, inventory);
    await writeReceipt(
      db,
      candidateId,
      CANDIDATE_SOURCE,
      {
        applyPlan,
        planHash: hash(applyPlan),
        reservationId,
        missingDocuments: missing,
        sessionWideComplete: false,
      },
      true,
      receivedAt,
    );
    return {
      candidateId,
      applyPlan,
      planHash: hash(applyPlan),
      missingDocuments: missing,
      providerOperations: 2,
      reservedMaximum: 8,
      billWrites: 0,
    };
  });
}
async function apply(db, deps, env) {
  environment(env);
  const release = runtimeBinding(env);
  const id = env.HB1211_DATASET_CANDIDATE_ID;
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw Error('EXACT_CANDIDATE_REQUIRED');
  return transaction(db, false, async () => {
    await db.query('SELECT id FROM state_bill WHERE id=$1 FOR UPDATE', [BILL]);
    const before = await snapshot(db);
    identity(before, release);
    if (before.bill.inventory !== null) throw Error('MISSING_INVENTORY_ONLY');
    const receipt = (
      await db.query(
        'SELECT source,scope,manifest,complete FROM legal_source_receipt WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (
      !receipt ||
      receipt.source !== CANDIDATE_SOURCE ||
      receipt.complete !== true ||
      hash(receipt.scope) !== hash(SCOPE)
    )
      throw Error('CANDIDATE_RECEIPT_UNQUALIFIED');
    const plan = receipt.manifest?.applyPlan;
    if (
      !plan ||
      plan.candidateId !== id ||
      plan.mode !== 'apply_inventory_only' ||
      plan.expectedPriorInventory !== null ||
      receipt.manifest.planHash !== hash(plan)
    )
      throw Error('CANDIDATE_PLAN_CORRUPT');
    approval(env, hash(plan));
    const expected = {
      ...identity(before, release),
      mode: plan.mode,
      candidateId: id,
      archiveHash: plan.archiveHash,
      inventory: plan.inventory,
      inventoryHash: plan.inventoryHash,
      expectedPriorInventory: null,
    };
    if (hash(expected) !== hash(plan)) throw Error('PROTECTED_DATA_DRIFT');
    const archive = (
      await db.query(
        'SELECT original_bytes_base64,observed_at FROM legal_dataset_archive WHERE content_hash=$1',
        [plan.archiveHash],
      )
    ).rows[0];
    if (!archive) throw Error('QUALIFIED_ARCHIVE_REQUIRED');
    const zip = Buffer.from(archive.original_bytes_base64, 'base64');
    if (bytesHash(zip) !== plan.archiveHash) throw Error('ARCHIVE_CORRUPT');
    const inventory = qualifyParsed(
      await deps.parseDatasetZip(zip),
      deps.reportSourceFacts,
      iso(archive.observed_at),
      plan.inventory.provenance,
    );
    if (hash(inventory) !== plan.inventoryHash || hash(inventory) !== hash(plan.inventory))
      throw Error('ARCHIVE_INVENTORY_DRIFT');
    const updated = await db.query(
      `UPDATE state_bill SET report_source_facts=jsonb_set(coalesce(report_source_facts,'{}'::jsonb),'{documentInventory}',$1::jsonb)
      WHERE id=$2 AND state='FL' AND session_key='2026' AND legiscan_bill_id=2068308 AND legiscan_change_hash=$3 AND report_source_facts->'documentInventory' IS NULL`,
      [JSON.stringify(inventory), BILL, BILL_HASH],
    );
    if (updated.rowCount !== 1) throw Error('EXACT_MISSING_ROW_UPDATE_FAILED');
    const after = await snapshot(db);
    if (
      hash(identity(after, release)) !== hash(identity(before, release)) ||
      hash(after.bill.inventory) !== hash(inventory)
    )
      throw Error('PROTECTED_DATA_CHANGED');
    const missing = await gaps(db, inventory);
    await writeReceipt(
      db,
      randomUUID(),
      APPLIED_SOURCE,
      {
        candidateId: id,
        planHash: hash(plan),
        inventory,
        missingDocuments: missing,
        sessionWideComplete: false,
      },
      true,
      new Date(),
    );
    return {
      billId: BILL,
      inventory,
      missingDocuments: missing,
      billWrites: 1,
      providerRequests: 0,
      protectedDataUnchanged: true,
    };
  });
}
async function main() {
  const env = process.env,
    mode = env.HB1211_DATASET_MODE;
  if (!['preview', 'retrieve', 'apply', 'verify'].includes(mode))
    throw Error('EXPLICIT_MODE_REQUIRED');
  const cap = environment(env),
    release = runtimeBinding(env);
  const r = await fetch('https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem', {
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('RDS_CA_UNAVAILABLE');
  const roots = (await r.text())
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    ?.filter((pem) => {
      const c = new X509Certificate(pem);
      return c.subject.includes('us-east-1') && c.subject.includes('RSA2048');
    });
  if (roots?.length !== 1) throw Error('EXACT_RDS_ROOT_REQUIRED');
  const { Client } = require('pg');
  const db = new Client({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: { rejectUnauthorized: true, ca: roots[0] },
  });
  await db.connect();
  try {
    const held = (
      await db.query(
        "SELECT pg_try_advisory_lock(hashtextextended('hb1211-dataset-reviewed-v1',0)) AS held",
      )
    ).rows[0].held;
    if (!held) throw Error('REVIEW_TASK_ALREADY_RUNNING');
    let result;
    if (mode === 'preview' || mode === 'verify') {
      const s = await transaction(db, true, () => snapshot(db));
      const exact = identity(s, release);
      result =
        mode === 'preview'
          ? {
              plan: previewPlan(s, cap, release),
              planHash: hash(previewPlan(s, cap, release)),
              usage: s.usage,
            }
          : { ...exact, inventory: s.bill.inventory, usage: s.usage };
    } else {
      const deps = {
        ...require(process.cwd() + '/src/external/legiscan/legiscan.client.ts'),
        ...require(process.cwd() + '/src/external/legiscan/legiscan-dataset.util.ts'),
        ...require(process.cwd() + '/src/ingestion/legiscan-published-records.ts'),
      };
      result = mode === 'retrieve' ? await retrieve(db, deps, env) : await apply(db, deps, env);
    }
    console.log('HB1211_DATASET ' + JSON.stringify({ mode, at: new Date().toISOString(), result }));
  } finally {
    await db.end();
  }
}
module.exports = {
  providerStep,
  runtimeBinding,
  BILL,
  BILL_HASH,
  SCOPE,
  hash,
  bytesHash,
  environment,
  approval,
  identity,
  previewPlan,
  selectListing,
  decodeDataset,
  qualifyParsed,
  transaction,
  snapshot,
  retrieve,
  apply,
};
if (require.main === module)
  main().catch((e) => {
    console.error(
      'HB1211_DATASET_FAILED ' +
        (/^[A-Z0-9_]+$/.test(e?.message ?? '') ? e.message : 'UNEXPECTED_RUNTIME_FAILURE'),
    );
    process.exitCode = 1;
  });
