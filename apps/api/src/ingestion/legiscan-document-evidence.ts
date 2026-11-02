import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { LegiscanDocument } from '../external/legiscan/legiscan.client.js';
import {
  BILL_EXTRACTION_VERSION,
  extractBillDocumentStructure,
} from './bill-document-structure.js';
import { observeStateRecord } from './published-record-observations.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const DOCUMENT_EXTRACTOR_VERSION = BILL_EXTRACTION_VERSION;
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
  const contentHash = sha(bytes);
  const mime = doc.mime?.toLowerCase().split(';')[0]?.trim();
  const structure = await extractBillDocumentStructure(bytes, mime ?? '');
  const extractionState =
    structure.completeness === 'complete' ? 'extracted' : structure.completeness;
  const coverage =
    structure.completeness === 'complete'
      ? 'complete_document'
      : structure.completeness === 'partial'
        ? 'partial'
        : 'unknown';
  const sections = structure.sections.map((section) => ({ ...section, hash: sha(section.text) }));
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
    versionType: doc.type ?? null,
    date: publicationDate,
    rawDate: doc.date ?? null,
    mime: mime ?? null,
    contentHash,
    providerHash: doc.text_hash ?? null,
    parserVersion: DOCUMENT_EXTRACTOR_VERSION,
    structure,
    ...(doc.acquisition ? { acquisition: doc.acquisition } : {}),
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
  qualifiedStub?: {
    id: number;
    kind: 'text' | 'amendment' | 'supplement';
    billId: number;
    providerHash?: string | null;
  },
) {
  const kind = doc.document_kind ?? 'text';
  const version =
    kind === 'text'
      ? await prisma.stateBillVersion.findUnique({ where: { legiscanDocId: doc.doc_id } })
      : null;
  const bill = await prisma.stateBill.findUnique({
    where: { id: billKey },
    select: { legiscanBillId: true, reportSourceFacts: true },
  });
  const facts = bill?.reportSourceFacts as {
    retainedDocumentStubs?: unknown;
    documentInventory?: { stubs?: unknown };
  } | null;
  const inventory = [facts?.retainedDocumentStubs, facts?.documentInventory?.stubs].flatMap(
    (rows) => (Array.isArray(rows) ? rows : []),
  );
  const validDate =
    typeof doc.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(doc.date) &&
    Number.isFinite(Date.parse(doc.date)) &&
    new Date(doc.date).toISOString().slice(0, 10) === doc.date;
  const frozenText =
    kind === 'text' &&
    !version &&
    !validDate &&
    qualifiedStub?.kind === 'text' &&
    qualifiedStub.id === doc.doc_id &&
    qualifiedStub.billId === doc.bill_id &&
    typeof qualifiedStub.providerHash === 'string' &&
    /^[a-f0-9]{32}$/i.test(qualifiedStub.providerHash) &&
    qualifiedStub.providerHash.toLowerCase() === doc.text_hash?.toLowerCase() &&
    inventory.some(
      (stub) =>
        stub?.kind === 'text' &&
        stub.providerId === doc.doc_id &&
        typeof stub.providerHash === 'string' &&
        stub.providerHash.toLowerCase() === qualifiedStub.providerHash!.toLowerCase(),
    );
  if (
    (kind === 'text' && (version ? version.billKey !== billKey : !frozenText)) ||
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
  const identity = version?.id ?? `legiscan:${kind}:${doc.doc_id}`;
  await prisma.$transaction(async (tx) => {
    await tx.stateBillPublishedRecord.createMany({
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
    });
    await observeStateRecord(tx, billKey, 'document', identity, revisionHash);
  });
  return evidence.extractionState;
}
