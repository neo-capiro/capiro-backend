import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, runTextSync, type TextSyncDeps } from './sync-tango-opportunity-text.js';

/**
 * The text seeding run (P30).
 *
 * The substance of the phase is in `opportunity-document-text.service.ts`. This
 * file covers the two decisions only the RUN makes: what status to seed, and
 * which attachments are still uncovered.
 */

type Row = Parameters<TextSyncDeps['writeStatus']>[0];

function makeDeps(over: { attachments?: Array<{ id: string; contentSha256: string; fileName: string | null }> } = {}) {
  const written: Row[] = [];
  const deps: TextSyncDeps = {
    readUncovered: async () =>
      over.attachments ?? [{ id: 'att-1', contentSha256: 'a'.repeat(64), fileName: 'SOW.pdf' }],
    writeStatus: async (row) => {
      written.push(row);
    },
  };
  return { deps, written };
}

describe('entitlement is an INPUT, never guessed at', () => {
  test('without --entitled the seeded status is not_entitled', () => {
    expect(parseArgs([]).entitled).toBe(false);
  });

  test('the seeded status follows the flag, and the summary carries the sentence a reader sees', async () => {
    const off = makeDeps();
    const withoutFlag = await runTextSync(off.deps, { commit: true, entitled: false, limit: 10 });
    expect(withoutFlag.status).toBe('not_entitled');
    expect(withoutFlag.explanation).toMatch(/says nothing about the document/i);

    const on = makeDeps();
    const withFlag = await runTextSync(on.deps, { commit: true, entitled: true, limit: 10 });
    expect(withFlag.status).toBe('pending');
    expect(withFlag.explanation).toMatch(/has not been attempted/i);
  });

  test('a seeded row carries the attachment binding and NO text', async () => {
    const { deps, written } = makeDeps();
    await runTextSync(deps, { commit: true, entitled: true, limit: 10 });
    expect(written[0]).toMatchObject({
      attachmentId: 'att-1',
      attachmentContentSha256: 'a'.repeat(64),
      status: 'pending',
      text: null,
      charCount: null,
      extractionMethod: null,
    });
  });

  test('a dry run reports what it would seed and writes nothing', async () => {
    const { deps, written } = makeDeps();
    const summary = await runTextSync(deps, { commit: false, entitled: true, limit: 10 });
    expect(summary.scanned).toBe(1);
    expect(summary.seeded).toBe(0);
    expect(written).toHaveLength(0);
  });
});

describe('the script is honest about what the provider cannot do', () => {
  const source = readFileSync(join(__dirname, 'sync-tango-opportunity-text.ts'), 'utf8');

  test('it records that the SDK has no per-document text call', () => {
    // The only text path is a SEMANTIC SEARCH taking a query. There is no
    // getAttachmentText(id), so "give me the text of THIS document" is not a
    // question this SDK can ask.
    expect(source).toMatch(/searchOpportunityAttachments/);
    expect(source).toMatch(/no per-document text call/i);
  });

  test('it does NOT invent a query to stand in for a document id', () => {
    // Binding returned text to an attachment it merely resembles is the fuzzy
    // identity substitution P02 forbids for award history.
    expect(source).not.toMatch(/q:\s*['"`]/);
    expect(source).not.toMatch(/solicitationNumber.*includeExtractedText/s);
  });

  test('it never calls the provider at all — entitlement comes from P17, not from a failed call', () => {
    // Re-deriving entitlement from a failed call would turn one rate-limit into
    // "the account lost its entitlement".
    expect(source).not.toMatch(/TangoGatewayService|TangoResilienceService|TANGO_API_KEY/);
  });

  test('the uncovered query joins on the BINDING, not just the attachment id', () => {
    // A reposted document has a new hash, so its old text row no longer covers
    // it and it correctly reappears — which is how a stale extraction gets
    // replaced rather than silently kept.
    expect(source).toMatch(/t\.attachment_content_sha256 = a\.content_sha256/);
    expect(source).toMatch(/a\.status = 'archived'/);
  });

  test('it never writes text — only a status row', () => {
    expect(source).not.toMatch(/text:\s*['"`]/);
    expect(source).toMatch(/buildUnavailableText/);
    expect(source).not.toMatch(/buildAvailableText/);
  });
});
