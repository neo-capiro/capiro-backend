import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Client Fill with Meri document-upload contract', () => {
  const drawer = readFileSync(resolve(__dirname, './ClientFillWithMeriDrawer.tsx'), 'utf8');
  const adapter = readFileSync(
    resolve(__dirname, '../../adapters/legacy/useClientFillWithMeri.ts'),
    'utf8',
  );

  it('offers a document upload and sends the stored attachment id into the enrichment run', () => {
    expect(drawer).toContain('Upload a capability document');
    expect(drawer).toContain("/api/engagement/attachments/upload-url");
    expect(drawer).toContain("/api/engagement/attachments/confirm");
    expect(drawer).toContain('fill.startForAttachment(confirmed.id)');
    expect(adapter).toContain('attachmentId?: string');
    expect(adapter).toContain('{ attachmentId }');
  });

  it('lets the user choose document fill instead of auto-starting a competing source run', () => {
    expect(drawer).toContain('Start enrichment');
    expect(drawer).not.toContain('useEffect');
    expect(drawer).not.toContain('startedRef');
  });

  it('retries a failed document run with the same selected attachment instead of default sources', () => {
    expect(drawer).toContain('selectedAttachmentId');
    expect(drawer).toContain('documentAttachmentId(fill.run?.sourceStates)');
    expect(drawer).toContain('const attachmentId = isDocumentRun ? persistedAttachmentId ?? selectedAttachmentId : null;');
    expect(drawer).toContain('fill.startForAttachment(attachmentId)');
    expect(drawer).toContain('const isDocumentRun = Object.prototype.hasOwnProperty.call(');
    expect(drawer).toContain("'client_document'");
    expect(drawer).toContain('onRetry={retrySelectedDocument}');
  });

  it('fails closed when a document run has no recoverable attachment id', () => {
    expect(drawer).toContain('Document retry is unavailable because the original attachment could not be identified.');
    expect(drawer).toContain('setRetryError');
    expect(drawer).toContain('if (isDocumentRun)');
  });

  it('keeps review before writes and says tags are proposed from the document', () => {
    expect(drawer).toContain('propose capability cards, descriptions, and tags');
    expect(drawer).toContain('written until you apply it.');
  });

  it('lets the user enter a website in the drawer and seeds it on start', () => {
    expect(drawer).toContain('Company website');
    expect(drawer).toContain('websiteInput');
    expect(drawer).toContain('fill.start({ website');
    expect(adapter).toContain('website?: string');
    expect(adapter).toContain('website: input.website');
  });

  it('surfaces informational PE/LDA/bill context instead of pretending nothing was found', () => {
    expect(adapter).toContain("finding.status === 'informational'");
    expect(drawer).toContain('contextFindings');
    expect(drawer).toContain('Related context');
  });

  it('gives Advocacy History its own review group instead of the generic client-profile field list (§22)', () => {
    expect(drawer).toContain('isAdvocacyFinding');
    expect(drawer).toContain("finding.kind === 'advocacy_record' || finding.kind === 'advocacy_outcome'");
    expect(drawer).toContain('Advocacy History ·');
    expect(drawer).toContain('AdvocacyFindingRow');
  });

  it('offers "Not advocacy" on a pending advocacy finding, distinct from a generic reject, and never creates a client_advocacy_record for it', () => {
    expect(drawer).toContain('Not advocacy');
    expect(drawer).toContain('onNotAdvocacy');
    expect(drawer).toContain('fill.rejectFinding(finding.id,');
    expect(adapter).toContain('rejectFinding: (findingId: string, reason?: string)');
    expect(adapter).toContain('/findings/${findingId}/reject');
  });

  it('never claims a detected outcome was caused by advocacy before a human reviews it (§17 causality contract)', () => {
    expect(drawer).toContain('This may be a related outcome. Applying it does not claim advocacy caused it.');
    expect(drawer).toContain("isOutcome = finding.kind === 'advocacy_outcome'");
  });

  it('invalidates the Advocacy Matters query key on apply so an accepted finding shows up without a manual reload', () => {
    expect(adapter).toContain("['client-advocacy-matters', clientId]");
  });
});
