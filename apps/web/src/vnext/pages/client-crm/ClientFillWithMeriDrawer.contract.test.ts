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

  it('keeps review before writes and says tags are proposed from the document', () => {
    expect(drawer).toContain('propose capability cards, descriptions, and tags');
    expect(drawer).toContain('written until you apply it.');
  });
});
