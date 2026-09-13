import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { LegiscanDocument } from '../external/legiscan/legiscan.client.js';
import { extractPdfText } from '../meri/meri-attachment-extract.js';
import { stripHtmlTags } from '../external/govinfo/govinfo.service.js';
import {observeStateRecord} from './published-record-observations.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const DOCUMENT_EXTRACTOR_VERSION = 'meri-pdf-native-pages-v1';
export async function documentEvidence(
  doc: LegiscanDocument,
  expected: { billId: number; docId: number },
) {
  if (doc.bill_id !== expected.billId || doc.doc_id !== expected.docId)
    throw Error('DOCUMENT_SUBJECT_MISMATCH');
  if (
    typeof doc.doc !== 'string' ||
    doc.doc.length > 28_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(doc.doc)
  )
    throw Error('DOCUMENT_ENCODING_OR_SIZE');
  const bytes = Buffer.from(doc.doc, 'base64');
  if (
    !bytes.length ||
    bytes.length > 20_000_000 ||
    (doc.text_size != null && doc.text_size !== bytes.length)
  )
    throw Error('DOCUMENT_SIZE_MISMATCH');
  if (
    doc.text_hash &&
    createHash('md5').update(bytes).digest('hex') !== doc.text_hash.toLowerCase()
  )
    throw Error('DOCUMENT_PROVIDER_HASH_MISMATCH');
  const contentHash = sha(bytes),
    sections: Array<{ locator: string; text: string; hash: string }> = [];
  let extractionState = 'unreadable',
    coverage = 'unknown';
  const mime = doc.mime?.toLowerCase();
  if (mime === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-') {
    const result = await extractPdfText(bytes, {
      onPage: (page, text) => sections.push({ locator: `page:${page}`, text, hash: sha(text) }),
    });
    extractionState = result.unreadablePages.length
      ? 'image_only_or_partial'
      : result.truncated
        ? 'partial'
        : 'extracted';
    coverage = result.truncated || result.unreadablePages.length ? 'partial' : 'complete_document';
  } else if (mime === 'text/plain' || mime === 'text/html') {
    const text =
      mime === 'text/html' ? stripHtmlTags(bytes.toString('utf8')) : bytes.toString('utf8');
    if (text.includes('\uFFFD')) throw Error('DOCUMENT_TEXT_ENCODING_UNQUALIFIED');
    for (let offset = 0; offset < text.length; offset += 12_000) {
      const part = text.slice(offset, offset + 12_000);
      sections.push({
        locator: `characters:${offset}-${offset + part.length}`,
        text: part,
        hash: sha(part),
      });
    }
    extractionState = text.trim()?'extracted':'unreadable';
    coverage = text.trim()?'complete_document':'unknown';
  }
  // Permitted durable content snapshot; public reads omit raw bytes by default.
  // Activation is an operator decision for the existing provider/source terms.
  const publicationDate =
    doc.date &&
    /^\d{4}-\d{2}-\d{2}$/.test(doc.date) &&
    Number.isFinite(Date.parse(doc.date)) &&
    new Date(doc.date).toISOString().slice(0, 10) === doc.date
      ? doc.date
      : null;
  const suppliedUrl = doc.state_link ?? doc.url;
  let url: string | null = null;
  try {
    const u = new URL(suppliedUrl ?? '');
    if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) url = u.href;
  } catch {}
  const evidence = {
    provider: 'LegiScan',
    publisher:
      doc.state_link && url ? 'legislature (source link supplied by LegiScan)' : 'LegiScan',
    providerId: doc.doc_id,
    providerBillId: doc.bill_id,
    url,
    documentKind: doc.document_kind ?? 'text',
    title: doc.title ?? doc.type,
    date: publicationDate,
    rawDate: doc.date ?? null,
    mime: mime ?? null,
    contentHash,
    providerHash: doc.text_hash ?? null,
    parserVersion:
      mime === 'text/html' ? 'govinfo-html-normalizer-locators-v1' : mime==='text/plain'?'utf8-normalized-character-locators-v1':DOCUMENT_EXTRACTOR_VERSION,
    extractionState,
    coverage,
    sections,
    contentSnapshotBase64: bytes.toString('base64'),
    sourcePublicationTime: null,
  };
  return { evidence, revisionHash: sha(JSON.stringify(evidence)) };
}
export async function persistDocumentEvidence(
  prisma: PrismaClient,
  billKey: string,
  doc: LegiscanDocument,
  qualifiedStub?: { id: number; kind: 'amendment' | 'supplement'; billId: number },
) {
  const kind = doc.document_kind ?? 'text';
  const version =
    kind === 'text'
      ? await prisma.stateBillVersion.findUnique({ where: { legiscanDocId: doc.doc_id } })
      : null;
  const bill = await prisma.stateBill.findUnique({
    where: { id: billKey },
    select: { legiscanBillId: true },
  });
  if (
    (kind === 'text' && (!version || version.billKey !== billKey)) ||
    (kind !== 'text' &&
      (!qualifiedStub ||
        qualifiedStub.kind !== kind ||
        qualifiedStub.id !== doc.doc_id ||
        qualifiedStub.billId !== doc.bill_id)) ||
    bill?.legiscanBillId !== doc.bill_id
  )
    throw Error('DOCUMENT_SUBJECT_MISMATCH');
  const { evidence, revisionHash } = await documentEvidence(doc, {
    billId: doc.bill_id,
    docId: doc.doc_id,
  });
  const identity=version?.id ?? `legiscan:${kind}:${doc.doc_id}`;
  await prisma.$transaction(async tx=>{await tx.stateBillPublishedRecord.createMany({
    data: [
      {
        billKey,
        kind: 'document',
        sourceIdentity: identity,
        revisionHash,
        eventDate: evidence.date,
        sourceOrder: 0,
        evidence,
      },
    ],
    skipDuplicates: true,
  });await observeStateRecord(tx,billKey,'document',identity,revisionHash);});
  return evidence.extractionState;
}
