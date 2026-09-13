import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { GovInfoService, HearingText } from '../external/govinfo/govinfo.service.js';
import { observeOfficialRecord } from './published-record-observations.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const parserVersion = 'govinfo-normalized-character-locators-v2';
type Cursor = { since: string; until: string; next: string | null; offset: number };

export async function persistOfficialTranscript(
  prisma: PrismaClient,
  congress: number,
  doc: HearingText,
) {
  if (!doc.packageId.startsWith(`CHRG-${congress}`)) throw Error('GOVINFO_CONGRESS_MISMATCH');
  if (
    !doc.dateIssued ||
    !/^\d{4}-\d{2}-\d{2}$/.test(doc.dateIssued) ||
    !Number.isFinite(Date.parse(doc.dateIssued)) ||
    new Date(doc.dateIssued).toISOString().slice(0, 10) !== doc.dateIssued ||
    doc.text.trim().length < 200
  )
    throw Error('GOVINFO_INCOMPLETE_TRANSCRIPT');
  const publishedDate = doc.dateIssued;
  const documentClass = /\bERRATA\b/i.test(doc.title ?? doc.text.slice(0, 300))
    ? 'errata'
    : 'hearing_transcript';
  const raw = doc.raw ?? doc.text,
    contentHash = hash(raw),
    extractionHash = hash(
      JSON.stringify({
        text: doc.text,
        heldDates: doc.heldDates ?? [],
        committees: doc.committees ?? [],
        title: doc.title,
        publishedDate,
        sourceUrl: doc.sourceUrl,
        documentClass,
      }),
    );
  const chamber = /CHRG-\d+s/i.test(doc.packageId)
    ? 'Senate'
    : /CHRG-\d+h/i.test(doc.packageId)
      ? 'House'
      : 'Joint';
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${doc.packageId},0))`;
    const old = await tx.officialHearingTranscript.findUnique({ where: { id: doc.packageId } });
    const pinned = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM official_hearing_transcript_revision WHERE package_id=${doc.packageId} LIMIT 1`;
    if (old && !pinned.length) {
      // Pin the earlier current projection before any changed-package update.
      await tx.$executeRaw`INSERT INTO official_hearing_transcript_revision(package_id,content_hash,extraction_hash,parser_version,source_url,published_date,observed_at,raw_content,extracted_text,metadata)
        VALUES(${old.id},${hash(old.text)},${hash(old.text)},'legacy-normalized-text',${old.sourceUrl},${old.publishedAt?.toISOString().slice(0, 10) ?? null},${old.fetchedAt},${old.text},${old.text},'{"rawUnavailable":true}'::jsonb)
        ON CONFLICT DO NOTHING`;
    }
    const data = {
      source: 'govinfo',
      congress,
      chamber,
      title: doc.title ?? '(untitled published hearing)',
      date: new Date(publishedDate),
      publishedAt: new Date(publishedDate),
      sourceUrl: doc.sourceUrl,
      format: doc.format,
      text: doc.text,
      charCount: doc.text.length,
      fetchedAt: new Date(),
    };
    await tx.officialHearingTranscript.upsert({
      where: { id: doc.packageId },
      create: { id: doc.packageId, hearingId: null, ...data },
      update: data,
    });
    const metadata = JSON.stringify({
      heldDates: doc.heldDates ?? [],
      committees: doc.committees ?? [],
      title: doc.title,
      documentClass,
      locator: { type: 'normalized_characters', length: doc.text.length },
      coverage: documentClass === 'errata' ? 'correction_only' : 'published_package_only',
      publisher: 'GPO / GovInfo',
    });
    await tx.$executeRaw`INSERT INTO official_hearing_transcript_revision(package_id,content_hash,extraction_hash,parser_version,source_url,source_modified_at,published_date,raw_content,extracted_text,metadata)
      VALUES(${doc.packageId},${contentHash},${extractionHash},${parserVersion},${doc.sourceUrl},${doc.lastModified ?? null},${doc.dateIssued},${raw},${doc.text},${metadata}::jsonb) ON CONFLICT DO NOTHING`;
    const revisions = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM official_hearing_transcript_revision
      WHERE package_id=${doc.packageId} AND content_hash=${contentHash} AND extraction_hash=${extractionHash} AND parser_version=${parserVersion}`;
    const revisionId = revisions[0]!.id;
    const sourceChanged = await observeOfficialRecord(tx, doc.packageId, revisionId);
    // An exact package URL is an explicit event reference. A published-date row
    // is not fuzzy-merged with a held-date event. Separate event links may coexist.
    await tx.$executeRaw`INSERT INTO official_hearing_transcript_event(revision_id,hearing_id,method)
      SELECT ${revisionId}::uuid,id,'explicit_source_url' FROM committee_hearing WHERE visibility='public'
        AND geographic_jurisdiction='US' AND congress=${congress} AND url=${doc.sourceUrl}
      ON CONFLICT DO NOTHING`;
    for (const date of doc.heldDates ?? [])
      for (const body of doc.committees ?? []) {
        if (body.congress !== String(congress) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const matches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM committee_hearing
        WHERE visibility='public' AND geographic_jurisdiction='US' AND congress=${congress}
        AND committee_code=${body.authorityId} AND date=${date}::date
        AND chamber=${body.chamber === 'H' ? 'House' : body.chamber === 'S' ? 'Senate' : 'Joint'} LIMIT 2`;
        if (matches.length === 1)
          await tx.$executeRaw`INSERT INTO official_hearing_transcript_event(revision_id,hearing_id,method,held_date)
        VALUES(${revisionId}::uuid,${matches[0]!.id},'qualified_body_held_date',${date}) ON CONFLICT DO NOTHING`;
      }
    await tx.$executeRaw`INSERT INTO official_hearing_transcript_check(package_id,state,checked_at,source_modified_at) VALUES(${doc.packageId},'success',now(),${doc.lastModified ?? null})
      ON CONFLICT(package_id) DO UPDATE SET state='success',checked_at=now(),attempted_at=now(),source_modified_at=EXCLUDED.source_modified_at,last_error=NULL`;
    return { revisionId, inserted: !old, changed: sourceChanged };
  });
}

/** Existing scheduler, sync-run and GovInfo client; resumable within a source
 * page. Commit the checkpoint only after qualified content is committed. */
export async function syncGovInfoHearingRecords(
  prisma: PrismaClient,
  gov: GovInfoService,
  congress: number,
  year: number,
  cap = Math.max(1, Math.min(100, Number(process.env.HEARING_TRANSCRIPT_RECORD_CAP) || 25)),
) {
  const source = `govinfo-chrg:${congress}:${year}`;
  const token = randomUUID();
  const claimed = await prisma.$queryRaw<
    Array<{ cursor: Cursor | null; status: string; completedAt: Date | null }>
  >`INSERT INTO govinfo_hearing_record_checkpoint(source,lease_token,lease_until)
    VALUES(${source},${token}::uuid,clock_timestamp()+interval '15 minutes') ON CONFLICT(source) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until
    WHERE govinfo_hearing_record_checkpoint.lease_until IS NULL OR govinfo_hearing_record_checkpoint.lease_until<clock_timestamp()
    RETURNING cursor,status,completed_at AS "completedAt"`;
  if (!claimed[0])
    return { inserted: 0, updated: 0, skipped: 0, errors: 0, complete: false, busy: true };
  const old = claimed[0];
  const fresh: Cursor = {
    since: old?.completedAt
      ? new Date(old.completedAt.getTime() - 48 * 3600_000).toISOString()
      : '1970-01-01T00:00:00Z',
    until: new Date().toISOString(),
    next: null,
    offset: 0,
  };
  const cursor: Cursor = old.cursor && old.status !== 'completed' ? old.cursor : fresh;
  let inserted = 0,
    updated = 0,
    skipped = 0,
    errors = 0,
    processed = 0,
    pages = 0,
    complete = false;
  try {
    while (processed < cap && pages++ < 3) {
      const scannedBefore = processed,
        insertedBefore = inserted;
      const page = await gov.listHearingsPage(congress, cursor.since, cursor.until, cursor.next);
      for (; cursor.offset < page.packages.length && processed < cap; cursor.offset++) {
        const row = page.packages[cursor.offset]!;
        if (row.congress != null && Number(row.congress) !== congress) {
          skipped++;
          continue;
        }
        if (row.dateIssued && new Date(row.dateIssued).getUTCFullYear() !== year) {
          skipped++;
          continue;
        }
        processed++;
        const revisions = await prisma.$queryRaw<
          Array<{ modified: string | null }>
        >`SELECT source_modified_at AS modified
          FROM official_hearing_transcript_check WHERE package_id=${row.packageId} AND state='success'`;
        if (row.lastModified && revisions[0]?.modified === row.lastModified) {
          await prisma.$executeRaw`UPDATE official_hearing_transcript_check SET checked_at=now(),attempted_at=now() WHERE package_id=${row.packageId}`;
          skipped++;
          continue;
        }
        await prisma.$executeRaw`INSERT INTO official_hearing_transcript_check(package_id,state) VALUES(${row.packageId},'pending') ON CONFLICT(package_id) DO UPDATE SET state='pending',attempted_at=now()`;
        let result: Awaited<ReturnType<typeof persistOfficialTranscript>>;
        try {
          const doc = await gov.getHearingText(row.packageId);
          result = await persistOfficialTranscript(prisma, congress, {
            ...doc,
            lastModified: doc.lastModified ?? row.lastModified,
          });
        } catch (error) {
          await prisma.$executeRaw`UPDATE official_hearing_transcript_check SET state='failed',last_error='GOVINFO_RETRIEVAL_OR_PARSE_FAILED' WHERE package_id=${row.packageId}`;
          throw error;
        }
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else skipped++;
      }
      if (cursor.offset >= page.packages.length) {
        cursor.next = page.nextPage;
        cursor.offset = 0;
        if (!cursor.next) complete = true;
      }
      const saved =
        await prisma.$executeRaw`UPDATE govinfo_hearing_record_checkpoint SET cursor=${JSON.stringify(cursor)}::jsonb,status=${complete ? 'completed' : 'running'},
        completed_at=${complete ? new Date(cursor.until) : null},last_error=NULL,scanned=scanned+${processed - scannedBefore},created=created+${inserted - insertedBefore},
        lease_until=clock_timestamp()+interval '15 minutes',updated_at=now() WHERE source=${source} AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`;
      if (saved !== 1) throw Error('GOVINFO_CHECKPOINT_LEASE_EXPIRED');
      if (complete) break;
    }
  } catch {
    errors++;
    await prisma.$executeRaw`UPDATE govinfo_hearing_record_checkpoint SET cursor=${JSON.stringify(cursor)}::jsonb,status='failed',last_error='GOVINFO_RETRIEVAL_OR_PARSE_FAILED',
      failed=failed+1,completed_at=NULL,updated_at=now() WHERE source=${source} AND lease_token=${token}::uuid`;
  } finally {
    await prisma.$executeRaw`UPDATE govinfo_hearing_record_checkpoint SET lease_token=NULL,lease_until=NULL WHERE source=${source} AND lease_token=${token}::uuid`;
  }
  return { inserted, updated, skipped, errors, complete };
}
