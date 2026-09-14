import { createHash } from 'node:crypto';
import { extractAttachmentSection } from '../../engagement/attachment-section-extract.js';
import { extractPdfText } from '../../meri/meri-attachment-extract.js';
import { fetchFlRuleHistory, publisherLink } from './fl-far.client.js';
import { fetchPublisherBytes } from './publisher-fetch.js';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** A caller selects a link actually present in this rule's publisher history. */
export async function fetchAdoptedRuleText(ruleNumber: string, selectedUrl: string) {
  const history = await fetchFlRuleHistory(ruleNumber),
    url = publisherLink(selectedUrl);
  if (!url || !history.attachments.some((a) => a.url === url))
    throw Error('ADOPTED_TEXT_LINK_NOT_IN_SOURCE_HISTORY');
  const result = await fetchPublisherBytes(url, ['flrules.org', 'www.flrules.org'], 20_000_000),
    bytes = result.bytes;
  const sections: Array<{ locator: string; text: string; hash: string }> = [];
  let complete = false,
    format = 'unsupported',
    reason: string | null = null;
  if (bytes.subarray(0, 5).toString() === '%PDF-' && result.contentType === 'application/pdf') {
    format = 'pdf';
    const parsed = await extractPdfText(bytes, {
      onPage: (page, text) => sections.push({ locator: `page:${page}`, text, hash: sha(text) }),
    });
    complete = !parsed.truncated && !parsed.unreadablePages.length;
  } else if (
    bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' &&
    ['application/msword', 'application/octet-stream', 'application/download'].includes(
      result.contentType,
    )
  ) {
    format = 'doc';
    const parsed = await extractAttachmentSection(
      bytes,
      'docx',
      1,
      true,
      AbortSignal.timeout(30000),
    );
    if (parsed.text.length > 2_000_000) throw Error('ADOPTED_TEXT_EXTRACTION_LIMIT');
    sections.push({ locator: 'document:1', text: parsed.text, hash: sha(parsed.text) });
    // Legacy Word text extraction cannot prove that embedded objects were read.
    reason = 'LEGACY_WORD_MARKUP_AND_EMBEDDED_OBJECTS_REQUIRE_REVIEW';
  } else throw Error('ADOPTED_TEXT_BYTES_OR_TYPE_UNQUALIFIED');
  if (!sections.some((s) => s.text.trim()) || sections.some((s) => s.text.includes('\uFFFD')))
    throw Error('ADOPTED_TEXT_UNREADABLE');
  if (!sections.some((s) => s.text.includes(ruleNumber)))
    throw Error('ADOPTED_TEXT_RULE_IDENTITY_NOT_CONFIRMED');
  return {
    ruleNumber,
    sourceUrl: url,
    finalUrl: result.url,
    historyHash: history.contentHash,
    contentHash: sha(bytes),
    extractionHash: sha(JSON.stringify(sections)),
    parserVersion: `fac-${format}-existing-extractor-v1`,
    originalBytesBase64: bytes.toString('base64'),
    sections,
    complete,
    coverage: { format, reason, selectedPublisherLink: true },
    sourceDates: [],
  };
}
