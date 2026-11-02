/** @cleanup-smoke noArgsExit=2 */
/** Bounded FY26 document hydration from retained metadata; no getBill discovery. */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../src/external/legiscan/us-states.js';
import { STATE_FY26_SQL } from '../src/ingestion/bill-text-scope.js';
import { withStateBillWriter } from '../src/ingestion/state-bill-writer.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  retrieveStateDocument,
  StateDocumentRetrievalError,
} from '../src/ingestion/state-document-retrieval.js';
import { persistDocumentEvidence } from '../src/ingestion/legiscan-document-evidence.js';
import type { StateDocumentStub } from '../src/ingestion/state-document-stub.js';

const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
export function parseStateTextArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let limit = 10,
    commit = false,
    publisherOnly = false,
    expectedHost = '';
  let selected = env.LEGISCAN_STATES ?? '';
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--commit') commit = true;
    else if (key === '--publisher-only') publisherOnly = true;
    else if (key === '--limit') limit = Number(argv[++i]);
    else if (key === '--states') selected = argv[++i] ?? '';
    else if (key === '--expected-host') expectedHost = argv[++i] ?? '';
    else throw Error('UNKNOWN_STATE_TEXT_ARGUMENT');
  }
  const states = selected.split(',').map((value) => value.trim().toUpperCase());
  if (
    !states.length ||
    new Set(states).size !== states.length ||
    states.some((state) => !(ALL_US_STATE_CODES as readonly string[]).includes(state)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw Error('INVALID_STATE_TEXT_SCOPE');
  if (!env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const db = new URL(env.DATABASE_URL);
  if (commit && (expectedHost !== HOST || db.hostname !== HOST || db.pathname !== '/capiro'))
    throw Error('STATE_TEXT_COMMIT_DATABASE_MISMATCH');
  return { states, limit, commit, publisherOnly };
}

type DueDocument = {
  billKey: string;
  providerBillId: number;
  state: string;
  cursorId: string;
  identity: string;
  attempts: number;
  facts: {
    retainedDocumentStubs?: StateDocumentStub[];
    documentInventory?: { stubs?: StateDocumentStub[] };
  };
};

export async function drainStateDocuments(
  prisma: PrismaClient,
  options: { states: string[]; limit: number; commit: boolean; publisherOnly: boolean },
) {
  // Expand legacy per-provider-ID work into exact version checks. Each frozen
  // hash owns its own retry count/backoff; one unavailable old hash must never
  // starve a retrievable later hash under a small run cap.
  if (options.commit) {
    const legacy = await prisma.$queryRawUnsafe<DueDocument[]>(
      `SELECT d.bill_key AS "billKey",d.source_identity AS identity,b.report_source_facts AS facts
       FROM state_bill_record_check d JOIN state_bill b ON b.id=d.bill_key
       WHERE d.kind='document' AND d.next_check_at<=clock_timestamp()
       AND d.source_identity ~ '^(text|amendment|supplement):[0-9]+$'
       AND upper(b.state)=ANY($1::text[]) AND ${STATE_FY26_SQL}
       ORDER BY CASE WHEN d.source_identity ~ '^(text|amendment):' THEN 0 ELSE 1 END,d.next_check_at,d.bill_key,d.source_identity LIMIT $2`,
      options.states,
      options.limit,
    );
    for (const row of legacy) {
      if (!/^(text|amendment|supplement):[0-9]+$/.test(row.identity)) continue;
      const stubs = (
        row.facts?.retainedDocumentStubs ??
        row.facts?.documentInventory?.stubs ??
        []
      ).filter((stub) => `${stub.kind}:${stub.providerId}` === row.identity);
      if (!stubs.length) continue;
      await prisma.$transaction(async (tx) => {
        for (const stub of stubs) {
          const identity = `${stub.kind}:${stub.providerId}:${stub.providerHash?.toLowerCase() ?? 'unknown'}`;
          await tx.$executeRaw`INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at)
            VALUES(${row.billKey},'document',${identity},'pending',0,clock_timestamp()) ON CONFLICT DO NOTHING`;
        }
        await tx.$executeRaw`UPDATE state_bill_record_check SET state='metadata_only',error_code='EXACT_VERSION_CHECKS_ENQUEUED',next_check_at=NULL
          WHERE bill_key=${row.billKey} AND kind='document' AND source_identity=${row.identity}`;
      });
    }
  }
  const due = await prisma.$queryRawUnsafe<DueDocument[]>(
    `SELECT d.bill_key AS "billKey",b.legiscan_bill_id AS "providerBillId",upper(b.state) AS state,
      c.id AS "cursorId",d.source_identity AS identity,d.attempts,b.report_source_facts AS facts
     FROM state_bill_record_check d JOIN state_bill b ON b.id=d.bill_key
     JOIN state_sync_cursor c ON upper(c.state)=upper(b.state) AND c.session_key=b.session_key
     WHERE d.kind='document' AND d.next_check_at<=clock_timestamp() AND d.state<>'review_required'
       AND d.source_identity ~ '^(text|amendment|supplement):[0-9]+:'
       AND upper(b.state)=ANY($1::text[]) AND b.legiscan_bill_id IS NOT NULL AND ${STATE_FY26_SQL}
     ORDER BY CASE WHEN d.source_identity ~ '^(text|amendment):' THEN 0 ELSE 1 END,d.next_check_at,d.bill_key,d.source_identity LIMIT $2`,
    options.states,
    options.limit,
  );
  const counts = { inserted: 0, updated: 0, skipped: 0, errors: 0, complete: false };
  if (!options.commit) return { ...counts, skipped: due.length };
  let attempted = 0;
  for (const row of due) {
    const stubs = (
      row.facts?.retainedDocumentStubs ??
      row.facts?.documentInventory?.stubs ??
      []
    ).filter(
      (stub) =>
        `${stub.kind}:${stub.providerId}:${stub.providerHash?.toLowerCase() ?? 'unknown'}` ===
        row.identity,
    );
    if (!stubs.length) {
      await prisma.$executeRaw`UPDATE state_bill_record_check SET state='metadata_only',error_code='RETAINED_DOCUMENT_METADATA_REQUIRED',
        next_check_at=clock_timestamp()+interval '3 hours' WHERE bill_key=${row.billKey} AND kind='document' AND source_identity=${row.identity}`;
      counts.skipped++;
      continue;
    }
    let allComplete = true,
      failure = '',
      retryAfter = 3 * 3600_000,
      failed = false;
    for (const stub of stubs) {
      const retained = await prisma.$queryRaw<
        Array<{ id: string; evidence: any; complete: boolean }>
      >`
        SELECT p.id::text,p.evidence,EXISTS(SELECT 1 FROM bill_text_extraction x WHERE x.source_kind='state'
          AND x.revision_id=p.id AND x.parser_version='bill-structure-v1' AND x.completeness='complete') AS complete
        FROM state_bill_published_record p WHERE p.bill_key=${row.billKey} AND p.kind='document'
        AND p.evidence->>'documentKind'=${stub.kind} AND p.evidence->>'providerId'=${String(stub.providerId)}
        AND lower(p.evidence->>'providerHash')=lower(${stub.providerHash})`;
      const valid = retained.find((item) => {
        const base64 = item.evidence?.contentSnapshotBase64;
        if (
          typeof base64 !== 'string' ||
          !base64.length ||
          base64.length > 28000000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
        )
          return false;
        const bytes = Buffer.from(base64, 'base64');
        return (
          bytes.length > 0 &&
          bytes.length <= 20000000 &&
          (stub.size == null || stub.size === bytes.length) &&
          createHash('md5').update(bytes).digest('hex') === stub.providerHash?.toLowerCase() &&
          createHash('sha256').update(bytes).digest('hex') === item.evidence.contentHash
        );
      });
      if (valid) {
        if (!valid.complete && valid.evidence?.structure?.completeness !== 'complete') {
          allComplete = false;
          failure = 'DOCUMENT_EXTRACTION_PENDING';
        }
        counts.skipped++;
        continue;
      }
      if (attempted >= options.limit) {
        allComplete = false;
        failure = 'DOCUMENT_RUN_LIMIT';
        break;
      }
      attempted++;
      try {
        const result = await retrieveStateDocument(prisma, {
          state: row.state,
          billKey: row.billKey,
          providerBillId: row.providerBillId,
          cursorId: row.cursorId,
          stub,
          apiKey: process.env.LEGISCAN_API_KEY,
          publisherOnly: options.publisherOnly,
        });
        const extraction = await persistDocumentEvidence(prisma, row.billKey, result.document, {
          id: stub.providerId,
          kind: stub.kind,
          billId: row.providerBillId,
          providerHash: stub.providerHash,
        });
        if (extraction !== 'extracted') {
          allComplete = false;
          failure = 'DOCUMENT_EXTRACTION_PARTIAL';
        }
        counts.inserted++;
      } catch (error) {
        allComplete = false;
        if (error instanceof StateDocumentRetrievalError) {
          failure = error.message;
          retryAfter = Math.max(retryAfter, error.retryAfterMs);
          failed = !['EXISTING_PROVIDER_BUDGET_HOLD', 'EXISTING_PROVIDER_CAPACITY_HOLD'].includes(
            failure,
          );
        } else {
          failure = 'DOCUMENT_EXTRACTION_FAILED';
          failed = true;
        }
        if (failed) counts.errors++;
        else counts.skipped++;
      }
    }
    if (allComplete) {
      await prisma.$executeRaw`UPDATE state_bill_record_check SET state='available',checked_at=clock_timestamp(),error_code=NULL,
        provider_hash=${stubs[stubs.length - 1]!.providerHash},next_check_at=clock_timestamp()+interval '7 days'
        WHERE bill_key=${row.billKey} AND kind='document' AND source_identity=${row.identity}`;
      counts.updated++;
    } else {
      const state = failed ? (row.attempts >= 9 ? 'review_required' : 'failed') : 'pending';
      await prisma.$executeRaw`UPDATE state_bill_record_check SET state=${state},error_code=${failure},attempted_at=clock_timestamp(),
        attempts=attempts+${failed ? 1 : 0},next_check_at=clock_timestamp()+${retryAfter}*interval '1 millisecond'
        WHERE bill_key=${row.billKey} AND kind='document' AND source_identity=${row.identity}`;
    }
    if (attempted >= options.limit) break;
  }
  // A drained due queue is not proof of frozen-inventory coverage; coverage owns that denominator.
  return counts;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseStateTextArgs(argv, process.env),
    prisma = new PrismaClient();
  try {
    if (!args.commit) {
      console.log(JSON.stringify(await drainStateDocuments(prisma, args)));
      return;
    }
    const counts = await withStateBillWriter(prisma, args.states, (writer) =>
      runWithSyncRun(
        writer,
        'sync-state-text-drain:fy26:' + args.states.join(','),
        () => drainStateDocuments(writer, args),
        { skipIfRunning: false, metricFormat: 'json' },
      ),
    );
    if (counts.errors) throw Error('STATE_TEXT_DRAIN_ERRORS');
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: sync-state-text-drain --states CA[,NY] [--limit 1..1000] [--publisher-only] [--commit --expected-host host] (DATABASE_URL required; dry run default)',
    );
  } else if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL_REQUIRED');
    process.exitCode = 2;
  } else
    void main().catch((error) => {
      console.error(error instanceof Error ? error.message : 'STATE_TEXT_DRAIN_FAILED');
      process.exitCode = 1;
    });
}
