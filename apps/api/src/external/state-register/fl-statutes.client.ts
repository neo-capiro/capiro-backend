import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { parseFloridaCitation, legalReferenceKey, type LegalReference } from '@capiro/shared';
import { fetchPublisherBytes } from './publisher-fetch.js';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function statuteSourceUrl(edition: string, reference: LegalReference) {
  if (
    !/^20\d{2}$/.test(edition) ||
    reference.code !== 'statute' ||
    reference.jurisdiction !== 'FL' ||
    reference.kind === 'subsection'
  )
    throw Error('STATUTE_SCOPE_UNQUALIFIED');
  return `https://www.flsenate.gov/Laws/Statutes/${edition}/${reference.kind === 'chapter' ? `Chapter${reference.chapter}/All` : reference.section}`;
}
export function parseFloridaStatutes(
  html: string,
  finalUrl: string,
  edition: string,
  reference: LegalReference,
) {
  const expected = statuteSourceUrl(edition, reference);
  if (new URL(finalUrl).pathname.toLowerCase() !== new URL(expected).pathname.toLowerCase())
    throw Error('STATUTE_REDIRECT_IDENTITY_MISMATCH');
  const $ = cheerio.load(html);
  const sectionNodes = $('div.Section').toArray();
  if (!sectionNodes.length) throw Error('STATUTE_LAYOUT_UNQUALIFIED');
  const revisions = sectionNodes.map((node) => {
    const $section = $(node),
      raw = $section.find('.SectionNumber').first().text().trim();
    const identity = parseFloridaCitation(raw);
    if (
      !identity ||
      identity.chapter !== reference.chapter ||
      (reference.kind === 'section' && identity.section !== reference.section)
    )
      throw Error('STATUTE_IDENTITY_MISMATCH');
    const title = $section.find('.CatchlineText').first().text().trim();
    const body = $section.find('.SectionBody').first();
    const sections = body
      .children()
      .toArray()
      .map((el, index) => {
        const text = $(el).text().trim();
        return {
          locator: `section:${identity.section}:paragraph:${index + 1}`,
          text,
          hash: sha(text),
        };
      });
    if (!sections.length && body.text().trim()) {
      const text = body.text().trim();
      sections.push({ locator: `section:${identity.section}:paragraph:1`, text, hash: sha(text) });
    }
    if (!title || !sections.length || sections.some((s) => s.text.includes('\uFFFD')))
      throw Error('STATUTE_EXTRACTION_INCOMPLETE');
    const contentHash = sha(html),
      extractionHash = sha(JSON.stringify(sections)),
      id = sha(JSON.stringify([legalReferenceKey(identity), edition, contentHash, extractionHash]));
    return {
      id,
      reference: identity,
      edition,
      title,
      sourceUrl: expected,
      contentHash,
      extractionHash,
      parserVersion: 'fl-senate-section-v1',
      sections,
      historyText: $section.find('.HistoryText').text().trim() || null,
      originalHtml: html,
      complete: true,
      coverage: {
        scope: 'selected_page',
        sectionCount: sectionNodes.length,
        sourceEdition: edition,
      },
    };
  });
  return { reference, edition, revisions, complete: true };
}
export async function fetchFloridaStatutes(edition: string, reference: LegalReference) {
  const url = statuteSourceUrl(edition, reference);
  const response = await fetchPublisherBytes(url, ['www.flsenate.gov', 'flsenate.gov']);
  if (response.contentType !== 'text/html') throw Error('STATUTE_SOURCE_UNAVAILABLE');
  const html = response.bytes.toString('utf8');
  return parseFloridaStatutes(html, response.url, edition, reference);
}
