#!/usr/bin/env node
/**
 * vNext outreach-decision stylesheet generator and drift gate.
 *
 * apps/web/src/vnext/pages/engagement/outreach-decision-vnext.css declares
 * itself GENERATED from four canonical Outreach V3 stylesheets, but until this
 * script existed the "transform" was applied by hand — and drifted. The entire
 * `.ov3-sample-*` block (the tail of planning-surfaces.css, styling the
 * style-samples wizard step) was never ported, so os.capiro.ai rendered that
 * step unstyled while app.capiro.ai — which imports the canonical files
 * directly — was fine. Nothing detected it, because nothing re-ran the
 * transform. This script is that missing half.
 *
 * The transform itself is documented in the generated file's own banner:
 *   1. prefix every selector outside @keyframes with
 *      `:where(.capiro-vnext-root .engagement-vnext)`
 *   2. drop the `--ov3-*` token DEFINITIONS from outreach-v3.css's .ov3-root
 *      block (outreach-body-vnext.css supplies the vNext palette instead)
 *
 * The banner is deliberately NOT templated here. It is hand-authored prose
 * about *why* the file exists; only the rule bodies below it are generated.
 * Templating it would duplicate 40 lines of prose into a second file and
 * create exactly the kind of drift this script exists to prevent, so --write
 * preserves the leading block comment verbatim and regenerates everything
 * after it. That also means --write cannot recreate the file from nothing: if
 * the banner is gone, this script fails loudly rather than inventing one.
 *
 * Line endings are git's business, not this script's. There is no *.css rule
 * in .gitattributes and core.autocrlf is on for this repo, so the blob is LF
 * while a Windows working tree checks out CRLF — meaning a byte-exact CRLF
 * comparison would report phantom drift on any Linux checkout (i.e. CI).
 * --check therefore compares LF-normalized content, and --write re-emits with
 * whatever ending the file already uses, so it never churns the working tree.
 *
 * Usage:
 *   node scripts/port-outreach-decision-vnext-css.mjs --check
 *   node scripts/port-outreach-decision-vnext-css.mjs --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The vNext wrapper the ported rules are scoped to, at zero added specificity. */
export const PREFIX = ':where(.capiro-vnext-root .engagement-vnext)';

const CANONICAL_DIR = path.join(ROOT, 'apps/web/src/pages/engagement/outreach/v3');

/**
 * Canonical sources, in the order their sections appear in the generated file.
 * Order is part of the artifact: changing it rewrites the whole file and, worse,
 * silently reorders the cascade.
 */
export const SOURCES = [
  'context-review-surface.css',
  'target-workspace.css',
  'outreach-v3.css',
  'planning-surfaces.css',
];

export const GENERATED_PATH = path.join(
  ROOT,
  'apps/web/src/vnext/pages/engagement/outreach-decision-vnext.css',
);

const toLf = (text) => text.replace(/\r\n/g, '\n');

/** The ending the file already uses, so --write reproduces it. */
export function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

const withEol = (text, eol) => (eol === '\n' ? toLf(text) : toLf(text).replace(/\n/g, '\r\n'));

/**
 * Prefix every selector outside @keyframes; optionally drop the --ov3-* token
 * definitions inside the .ov3-root block.
 *
 * Line-oriented on purpose. The canonical files are Prettier-formatted, one
 * declaration per line, so a brace/comment state machine reproduces them
 * exactly while a real CSS parser would reprint (and thus reformat) them.
 *
 * @param {string} text canonical stylesheet source, LF
 * @param {{ dropOv3Tokens: boolean }} options
 * @returns {string} transformed stylesheet, LF
 */
export function transform(text, { dropOv3Tokens }) {
  const out = [];
  const stack = []; // 'rule' | 'at' | 'keyframes' | 'keyframe'
  let pendingSelector = false;
  let inOv3Root = false;
  let inComment = false;

  for (const line of toLf(text).split('\n')) {
    const trimmed = line.trim();
    const startedInComment = inComment;
    const ctx = stack[stack.length - 1];
    // At top level, or directly inside an at-rule block (@media/@supports), the
    // next non-brace line is a selector. Inside a rule it is a declaration.
    const selectorExpected = ctx === undefined || ctx === 'at';
    const inSelectorPosition = !startedInComment && (selectorExpected || pendingSelector);

    let emitted = line;
    if (
      inSelectorPosition &&
      trimmed !== '' &&
      !trimmed.startsWith('/*') &&
      !trimmed.startsWith('}') &&
      !trimmed.startsWith('@') &&
      ctx !== 'keyframes' // `from`/`to`/`50%` are offsets, not selectors
    ) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      emitted = `${indent}${PREFIX} ${trimmed}`;
    }

    const isDroppedToken =
      dropOv3Tokens && inOv3Root && !startedInComment && /^--ov3-[\w-]+\s*:/.test(trimmed);
    if (!isDroppedToken) out.push(emitted);

    // A selector list continues across lines while entries end in a comma.
    if (!(startedInComment || trimmed === '' || trimmed.startsWith('/*'))) {
      pendingSelector = inSelectorPosition && trimmed.endsWith(',');
    }

    // Track brace nesting and comment state from the raw line.
    for (let i = 0; i < line.length; i += 1) {
      if (inComment) {
        if (line.startsWith('*/', i)) {
          inComment = false;
          i += 1;
        }
        continue;
      }
      if (line.startsWith('/*', i)) {
        inComment = true;
        i += 1;
        continue;
      }
      if (line[i] === '{') {
        const top = stack[stack.length - 1];
        if (top === 'keyframes') stack.push('keyframe');
        else if (/^@keyframes/.test(trimmed)) stack.push('keyframes');
        else if (/^@/.test(trimmed)) stack.push('at');
        else stack.push('rule');
        if (/^\.ov3-root\s*\{/.test(trimmed)) inOv3Root = true;
      } else if (line[i] === '}') {
        const popped = stack.pop();
        if (popped === 'rule' && inOv3Root) inOv3Root = false;
      }
    }
  }
  return out.join('\n');
}

/** Extract the hand-authored leading block comment, which --write preserves. */
export function extractBanner(generated) {
  const text = toLf(generated);
  if (!text.startsWith('/*')) return null;
  const end = text.indexOf('*/\n');
  if (end === -1) return null;
  return text.slice(0, end + 3);
}

/**
 * Render the full stylesheet: preserved banner, then one section per canonical
 * source in SOURCES order.
 *
 * @param {string} banner leading block comment, LF, ending in `*\/\n`
 * @param {(name: string) => string} readSource resolves a canonical source
 * @returns {string} the complete stylesheet, LF
 */
export function renderStylesheet(banner, readSource) {
  const parts = [banner];
  for (const name of SOURCES) {
    const body = transform(readSource(name), { dropOv3Tokens: name === 'outreach-v3.css' });
    parts.push(`\n/* ==== ported from ${name} ==== */\n\n`);
    parts.push(`${body.replace(/^\n+/, '').replace(/\n+$/, '')}\n`);
  }
  return parts.join('');
}

/** Read a canonical source from the working tree. */
export function readCanonical(name) {
  return toLf(readFileSync(path.join(CANONICAL_DIR, name), 'utf8'));
}

/**
 * Build the expected generated file from the working tree.
 *
 * `current`/`expected` are LF-normalized for comparison; `expectedBytes` carries
 * the file's own line ending, and is what --write puts on disk.
 */
export function build() {
  let current;
  try {
    current = readFileSync(GENERATED_PATH, 'utf8');
  } catch {
    throw new Error(`${path.relative(ROOT, GENERATED_PATH)} does not exist`);
  }
  const banner = extractBanner(current);
  if (banner === null) {
    throw new Error(
      `${path.relative(ROOT, GENERATED_PATH)} does not start with the hand-authored banner comment`,
    );
  }
  const rendered = renderStylesheet(banner, readCanonical);
  return {
    current: toLf(current),
    expected: rendered,
    expectedBytes: withEol(rendered, detectEol(current)),
  };
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const relative = path.relative(ROOT, GENERATED_PATH).replace(/\\/g, '/');

  let current;
  let expected;
  let expectedBytes;
  try {
    ({ current, expected, expectedBytes } = build());
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    console.error('\nOUTREACH_DECISION_VNEXT_CSS_UNBUILDABLE');
    process.exit(1);
  }

  const ruleLines = expected.split('\n').length - 1;

  if (mode === 'write') {
    if (current === expected) {
      console.log(`${relative} already current (${ruleLines} lines)`);
      return;
    }
    writeFileSync(GENERATED_PATH, expectedBytes, 'utf8');
    console.log(`wrote ${relative} (${ruleLines} lines from ${SOURCES.length} canonical sources)`);
    return;
  }

  if (current !== expected) {
    console.error(`FAIL  ${relative} has drifted from its canonical sources`);
    for (const name of SOURCES)
      console.error(`      source: apps/web/src/pages/engagement/outreach/v3/${name}`);
    console.error('      run: node scripts/port-outreach-decision-vnext-css.mjs --write');
    console.error('\nOUTREACH_DECISION_VNEXT_CSS_DRIFTED');
    process.exit(1);
  }

  console.log(
    `OUTREACH_DECISION_VNEXT_CSS_CURRENT (${ruleLines} lines from ${SOURCES.length} canonical sources)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
