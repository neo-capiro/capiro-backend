#!/usr/bin/env node
/** Pure DOM/text normalization for main-vs-preview browser comparisons. */

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\b/g;
const REQUEST_ID = /\b(?:request|trace)[-_ ]?id[:= ]+[a-z0-9._:-]+\b/gi;
const SIGNED_URL = /https?:\/\/[^\s"'<>]+(?:X-Amz-|Signature=|sig=)[^\s"'<>]*/gi;
const SERVICE_META = /\b(?:release|service)[-_ ]?(?:sha|id|name)?[:= ]+[a-z0-9._:-]+\b/gi;

export function normalizeVisibleText(value) {
  return String(value ?? '')
    .replace(ISO_INSTANT, '<ISO_INSTANT>')
    .replace(REQUEST_ID, '<REQUEST_ID>')
    .replace(SIGNED_URL, '<SIGNED_URL>')
    .replace(SERVICE_META, '<SERVICE_META>')
    .replace(/Engagement API preview\s*[—-]\s*External actions are disabled/gi, '')
    .replace(/Turn off preview/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a serialized DOM snapshot. Only the Phase 3 indicator and fields
 * explicitly permitted by the plan are removed. Labels, controls, counts,
 * statuses, selected-tab text, layout, hrefs and business record identifiers
 * remain comparable. In particular, deterministic fixture UUIDs are NOT masked:
 * a main/preview record-identity mismatch is a parity failure, not dynamic noise.
 */
export function normalizeDomSnapshot(value) {
  return normalizeVisibleText(
    String(value ?? '')
      .replace(
        /<aside\b[^>]*class=["'][^"']*engagement-preview-indicator[^"']*["'][\s\S]*?<\/aside>/gi,
        '',
      )
      .replace(/\s(?:data-request-id|data-trace-id)=["'][^"']*["']/gi, '')
      .replace(/\s(?:aria-describedby|aria-controls)=["'][^"']*:[^"']*["']/gi, ''),
  );
}

export function compareNormalizedDom(mainValue, previewValue) {
  const main = normalizeDomSnapshot(mainValue);
  const preview = normalizeDomSnapshot(previewValue);
  return { equal: main === preview, main, preview };
}
