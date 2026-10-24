import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { buildDocumentReadPage, parseDocumentReadInput } from '../meri-document-read.helpers.js';
import { documentContractV02 } from './documents-contract.js';
import { NO_DOCUMENT_PROVIDER_CALLS, projectDocumentRead, type TrustedClientReadContext } from './documents-monday.js';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const clientId = id('a');
const binding = { tenantId: id('1'), actorId: 'reader', conversationId: id('2'), runId: id('3'),
  attemptId: id('4'), workerId: id('5'), writerFence: 1 };
const subject = { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId: binding.tenantId,
  actorId: binding.actorId, policyRevision: 'policy-1', rosterVersionId: null,
  scopes: [{ tenantId: binding.tenantId, kind: 'client', resourceId: clientId, policyRevision: 'policy-1' }] };
const current: TrustedClientReadContext = { binding, subject, selectedClientId: clientId };
const digest = (data: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(data)).digest('hex');
const context = { binding, subject };
const normalized = (request: Record<string, unknown>) => documentContractV02.normalizeClientDocumentsInput(request, context);
const contentHash = 'c'.repeat(64);
function page(request: Record<string, unknown> = { clientId, documentId: 'doc-1' }, text = 'Verified local text') {
  const result = JSON.parse(JSON.stringify(buildDocumentReadPage(clientId, parseDocumentReadInput(request, clientId), {
    attachmentId: 'doc-1', fileName: 'Evidence.txt', contentType: 'text/plain', contentHash,
    source: 'text', text,
  })));
  result.generatedAt = '2026-10-18T09:00:00Z';
  return result;
}
const project = (data: unknown, request: Record<string, unknown> = { clientId, documentId: 'doc-1' }) =>
  projectDocumentRead(data, normalized(request), current, NO_DOCUMENT_PROVIDER_CALLS,
    { resultSha256: digest(data), observedAt: '2026-10-18T10:00:00Z' });

describe('complete pinned document 0.2 contract', () => {
  it('pins exact Meri PR158 document schema bytes', () => {
    expect(createHash('sha256').update(readFileSync(join(__dirname, 'client-documents.schema.json'))).digest('hex'))
      .toBe('71dd53119af2c0226372916e3645765687e8653da2f48b60d55c1a7a75c05247');
  });
  it('accepts full and partial UTF-16 ranges with source-bound continuation', () => {
    const request = { clientId, documentId: 'doc-1', limit: 5 };
    const first = project(page(request), request);
    const next = { clientId, documentId: 'doc-1', cursor: first.data.coverage.nextCursor, limit: 5 };
    expect(project(page(next), next).data.coverage.characterStart).toBe(5);
    expect(project(page()).data.coverage.complete).toBe(true);
  });
  it.each([
    ['extra top-level field', (p: any) => { p.extra = true; }],
    ['missing nested field', (p: any) => { delete p.records[0].payload.sectionKind; }],
    ['wrong document name', (p: any) => { p.records[0].payload.fileName = 'Other.txt'; }],
    ['wrong source table', (p: any) => { p.records[0].provenance.sourceTable = 'other'; }],
    ['wrong reference', (p: any) => { p.records[0].recordId = 'other'; }],
    ['wrong UTF-16 range', (p: any) => { p.records[0].payload.characterEnd++; }],
    ['wrong source hash', (p: any) => { p.records[0].provenance.contentHash = 'd'.repeat(64); }],
    ['wrong section hash', (p: any) => { p.records[0].provenance.sectionHash = 'd'.repeat(64); }],
    ['invented completeness', (p: any) => { p.coverage.extractionTruncated = true; }],
    ['invented continuation', (p: any) => { p.coverage.nextCursor = 'document:e30'; }],
    ['omitted evidence', (p: any) => { p.records = []; }],
    ['unpaired spreadsheet rows', (p: any) => { p.records[0].payload.rowStart = 1; }],
    ['undisclosed empty extraction', (p: any) => { p.coverage.extractedSectionEmpty = true; }],
    ['future source timestamp', (p: any) => { p.generatedAt = '2026-10-18T11:00:00Z'; }],
    ['provider transcript in forbidden mode', (p: any) => { p.records[0].payload.source = 'transcription'; }],
    ['provider metadata in forbidden mode', (p: any) => { p.coverage.extractionMetadata = { source: 'transcription' }; }],
    ['provider vision metadata in forbidden mode', (p: any) => {
      p.coverage.extractionMetadata = { readability: { method: 'openai_pdf' } };
    }],
    ['missing coverage', (p: any) => { delete p.coverage; }],
  ])('rejects %s', (_label, change) => {
    const body = page();
    change(body);
    expect(() => project(body)).toThrow();
  });
  it('refuses changed content or section extraction during continuation', () => {
    const request = { clientId, documentId: 'doc-1', limit: 5 };
    const first = project(page(request), request);
    const next = { clientId, documentId: 'doc-1', cursor: first.data.coverage.nextCursor, limit: 5 };
    const body = page(next);
    body.document.contentHash = 'd'.repeat(64);
    expect(() => project(body, next)).toThrow();
    const changed = page(next);
    changed.records[0].provenance.sectionHash = 'e'.repeat(64);
    expect(() => project(changed, next)).toThrow();
  });
  it('retains truthful missing-content disclosure for a blank PDF text layer', () => {
    const request = { clientId, documentId: 'doc-1' };
    const body = JSON.parse(JSON.stringify(buildDocumentReadPage(clientId, parseDocumentReadInput(request, clientId), {
      attachmentId: 'doc-1', fileName: 'Scan.pdf', contentType: 'application/pdf', contentHash,
      source: 'pdf', text: '', section: 1, sectionCount: 2, sectionKind: 'page', sectionLabel: 'Page 1',
      readability: { status: 'no_readable_text', method: 'text', scope: 'section', section: 1,
        sectionCount: 2, chars: 0, note: 'Provider extraction disabled; no text layer.' },
    })));
    body.generatedAt = '2026-10-18T09:00:00Z';
    expect(project(body).data.coverage).toMatchObject({ continuationBlocked: true, missingContent: true,
      complete: false, nextCursor: null, explicitNextSection: 2 });
    delete body.coverage.missingContent;
    expect(() => project(body)).toThrow();
  });
});
