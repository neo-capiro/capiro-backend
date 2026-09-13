/** Explicit, bounded read qualification using the existing provider clients.
 * Only a disposable local DB is accepted. No worker, recipient or flag changes. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  getSessionList,
  getMasterListRaw,
  getBill,
  getRollCall,
  getBillText,
  getSupportingDocument,
} from '../src/external/legiscan/legiscan.client.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
} from '../src/ingestion/legiscan-normalize.js';
import { persistVoteRevision } from '../src/ingestion/legiscan-vote-revisions.js';
import { persistPublishedRecords } from '../src/ingestion/legiscan-published-records.js';
import { persistDocumentEvidence } from '../src/ingestion/legiscan-document-evidence.js';
import { GovInfoService } from '../src/external/govinfo/govinfo.service.js';
import { persistOfficialTranscript } from '../src/ingestion/govinfo-hearing-records.js';
async function main() {
  if (
    process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
    !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
  )
    throw Error('DISPOSABLE_DATABASE_REQUIRED');
  const out = resolve(process.env.PHASE5_QUALIFICATION_OUTPUT ?? 'work/phase5-qualification');
  await mkdir(out, { recursive: true });
  const p = new PrismaClient(),
    results: {
      startedAt: string;
      legiscan: unknown[];
      govinfo: unknown[];
      errors: string[];
      networkRequests: number;
    } = {
      startedAt: new Date().toISOString(),
      legiscan: [],
      govinfo: [],
      errors: [],
      networkRequests: 0,
    };
  const originalFetch = globalThis.fetch;
  const failure = (error: unknown) => {
    let message = error instanceof Error ? error.message : 'FAILED';
    for (const secret of [process.env.LEGISCAN_API_KEY, process.env.GOVINFO_API_KEY])
      if (secret) message = message.split(secret).join('[redacted]');
    return message.replace(/(api_key|key)=[^&\s]+/gi, '$1=[redacted]').slice(0, 600);
  };
  globalThis.fetch = async (...args) => {
    if (++results.networkRequests > 30) throw Error('QUALIFICATION_REQUEST_CAP');
    return originalFetch(...args);
  };
  const artifact = async (name: string, value: unknown) => {
    const content = JSON.stringify(value, null, 2);
    await writeFile(resolve(out, name + '.json'), content);
    return createHash('sha256').update(content).digest('hex');
  };
  try {
    const key = process.env.LEGISCAN_API_KEY;
    if (key) {
      try {
        const sessions = await getSessionList(key, 'FL'),
          session = sessions.find((s) => s.year_start === 2026 && !s.special);
        if (!session) throw Error('REGULAR_SESSION_UNAVAILABLE');
        const master = await getMasterListRaw(key, session.session_id);
        await artifact('legiscan-session-scope', { session, masterCount: master.length });
        for (const wanted of ['S0474', 'H1211']) {
          const stub = master.find((b) => b.number.toUpperCase().replace(/\s/g, '') === wanted);
          if (!stub) throw Error('EXACT_BILL_UNAVAILABLE');
          const raw = await getBill(key, stub.bill_id);
          if (!raw) throw Error('BILL_UNAVAILABLE');
          const normalized = normalizeLegiscanBill(raw, 'FL');
          if (!normalized || normalized.sessionKey !== '2026')
            throw Error('EXACT_SESSION_MISMATCH');
          await upsertNormalizedStateBill(p, normalized);
          await persistPublishedRecords(p, normalized.billKey, raw);
          const billHash = await artifact('legiscan-' + wanted, raw),
            votes = [];
          const selected = (raw.votes ?? [])
            .filter((v) => wanted === 'H1211' || v.date === '2026-03-09' || v.date === '2026-01-26')
            .slice(0, 2);
          for (const v of selected) {
            const detail = await getRollCall(key, v.roll_call_id);
            if (!detail) throw Error('VOTE_DETAIL_UNAVAILABLE');
            await persistVoteRevision(p, 'FL', normalized.billKey, detail, {
              providerBillHash: raw.change_hash,
              stub: v,
            });
            votes.push({
              id: v.roll_call_id,
              artifactHash: await artifact('legiscan-vote-' + v.roll_call_id, detail),
              members: detail.votes?.length,
              tally: [detail.yea, detail.nay, detail.nv, detail.absent],
              source: v.state_link ?? v.url ?? null,
            });
          }
          const documents = [];
          const text = raw.texts?.at(-1);
          if (text) {
            const doc = await getBillText(key, text.doc_id);
            if (doc) {
              documents.push({
                kind: 'text',
                id: doc.doc_id,
                state: await persistDocumentEvidence(p, normalized.billKey, doc),
                artifactHash: await artifact('legiscan-document-' + doc.doc_id, doc),
              });
            }
          }
          const amendment = raw.amendments?.at(-1);
          if (amendment && wanted === 'S0474') {
            const doc = await getSupportingDocument(key, 'amendment', amendment.amendment_id);
            if (doc)
              documents.push({
                kind: 'amendment',
                id: doc.doc_id,
                state: await persistDocumentEvidence(p, normalized.billKey, doc, {
                  id: doc.doc_id,
                  kind: 'amendment',
                  billId: raw.bill_id,
                }),
                artifactHash: await artifact('legiscan-amendment-' + doc.doc_id, doc),
              });
          }
          results.legiscan.push({
            billId: normalized.billKey,
            providerId: raw.bill_id,
            billHash,
            votes,
            documents,
            sourceCoverage: await p.stateBill.findUnique({
              where: { id: normalized.billKey },
              select: { reportSourceFacts: true },
            }),
          });
        }
      } catch (error) {
        results.errors.push('LEGISCAN_QUALIFICATION_' + failure(error));
      }
    }
    if (process.env.GOVINFO_API_KEY) {
      try {
        const gov = new GovInfoService(
          p as never,
          new ConfigService({
            GOVINFO_API_KEY: process.env.GOVINFO_API_KEY,
            AWS_REGION_DEFAULT: 'us-east-1',
          }) as never,
        );
        const until = new Date().toISOString(),
          since = '2025-01-01T00:00:00Z',
          first = await gov.listHearingsPage(119, since, until),
          second = first.nextPage
            ? await gov.listHearingsPage(119, since, until, first.nextPage)
            : null;
        await artifact('govinfo-two-pages', { first, second });
        const selected = [...first.packages, ...(second?.packages ?? [])].find(
          (r) => r.packageId.startsWith('CHRG-119') && !/ERRATA/i.test(r.title ?? ''),
        );
        if (!selected) throw Error('CONGRESS_PACKAGE_UNAVAILABLE');
        const doc = await gov.getHearingText(selected.packageId),
          revision = await persistOfficialTranscript(p, 119, doc);
        results.govinfo.push({
          pages: second ? 2 : 1,
          packages: first.packages.length + (second?.packages.length ?? 0),
          uniquePackages: new Set(
            [...first.packages, ...(second?.packages ?? [])].map((p) => p.packageId),
          ).size,
          continuationAvailable: !!second?.nextPage,
          packageId: doc.packageId,
          publishedDate: doc.dateIssued,
          heldDates: doc.heldDates,
          committees: doc.committees,
          characters: doc.text.length,
          revision,
          artifactHash: await artifact('govinfo-selected-transcript', doc),
        });
      } catch (error) {
        results.errors.push('GOVINFO_QUALIFICATION_' + failure(error));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await artifact('qualification-results', results);
    await p.$disconnect();
  }
  console.log(
    JSON.stringify({
      legiscanBills: results.legiscan.length,
      govinfoPackages: results.govinfo.length,
      networkRequests: results.networkRequests,
      errors: results.errors,
    }),
  );
}
main().catch(() => {
  console.error('QUALIFICATION_ABORTED_CHECK_LOCAL_PREREQUISITES');
  process.exitCode = 1;
});
