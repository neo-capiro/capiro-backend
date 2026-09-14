import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { legalReferenceKey, parseFloridaConstitutionCitation } from '@capiro/shared';
import { fetchPublisherBytes } from './publisher-fetch.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const url = 'https://www.flsenate.gov/Laws/Constitution';
/** Publisher-current text has an observation time and content revision, no invented annual edition. */
export function parseFloridaConstitution(html: string, article: string) {
  const parent = parseFloridaConstitutionCitation('Article ' + article);
  if (!parent || parent.kind !== 'article') throw Error('CONSTITUTION_ARTICLE_NOT_QUALIFIED');
  const $ = cheerio.load(html),
    nodes = $('div.Constitution div.Article').toArray();
  const found = nodes.filter(
    (n) => $(n).children('.ArticleNumber').text().trim() === 'ARTICLE ' + parent.chapter,
  );
  if (found.length !== 1) throw Error('CONSTITUTION_SOURCE_IDENTITY_MISMATCH');
  const node = $(found[0]!),
    sections = node
      .children('div.Section')
      .toArray()
      .map((n) => {
        const section = $(n),
          match = section
            .find('.SectionNumber')
            .first()
            .text()
            .match(/^SECTION\s+(\d+)\./);
        if (!match) throw Error('CONSTITUTION_SECTION_IDENTITY_MISMATCH');
        const text = section.find('.SectionBody').text().trim();
        if (!text) throw Error('CONSTITUTION_TEXT_MISSING');
        return { locator: `article:${parent.chapter}:section:${match[1]}`, text, hash: sha(text) };
      });
  if (!sections.length) throw Error('CONSTITUTION_LAYOUT_UNQUALIFIED');
  const reference = parent,
    contentHash = sha(html),
    extractionHash = sha(JSON.stringify(sections)),
    complete = sections.every((s) => !s.text.includes('\uFFFD'));
  return {
    id: sha(JSON.stringify([legalReferenceKey(reference), contentHash, extractionHash])),
    reference,
    edition: null,
    title: node.children('.ArticleName').text().trim(),
    sourceUrl: url,
    contentHash,
    extractionHash,
    parserVersion: 'fl-constitution-article-v1',
    sections,
    originalHtml: html,
    historyText: null,
    complete,
    coverage: {
      scope: 'selected_article',
      sourceEdition: 'publisher_current_observed_snapshot',
      reason: complete ? null : 'PUBLISHER_ENCODING_LOSS',
      sectionCount: sections.length,
    },
  };
}
export async function fetchFloridaConstitution(article: string) {
  const result = await fetchPublisherBytes(url, ['www.flsenate.gov', 'flsenate.gov']);
  if (
    result.contentType !== 'text/html' ||
    new URL(result.url).pathname.toLowerCase() !== '/laws/constitution'
  )
    throw Error('CONSTITUTION_SOURCE_UNAVAILABLE');
  return parseFloridaConstitution(result.bytes.toString('utf8'), article);
}
