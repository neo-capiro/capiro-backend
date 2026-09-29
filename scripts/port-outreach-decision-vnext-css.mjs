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
 * Reviewed source-specific vNext design policies run before the mechanical
 * transform; they preserve the foundation and warm-surface changes already
 * merged in bac572623 and 470aa86f8. See the qualification document.
 *
 * The mechanical transform itself is documented in the generated file's own banner:
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

/**
 * Intended vNext policy, qualified against bac572623 and 470aa86f8.
 * These exact source-specific anchors preserve the merged port, not a general
 * CSS normalization. A canonical anchor edit needs an explicit policy review.
 * The generated output is never read as adaptation input.
 */
export const VNEXT_DESIGN_POLICIES = {
  'context-review-surface.css': [
    {
      policy: 'foundation typography',
      before: `  font-family: 'IBM Plex Mono', monospace;
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 2,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 1180px) {
`,
      after: `@media (max-width: 1179px) {
`,
      count: 1,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 760px) {
`,
      after: `@media (max-width: 779px) {
`,
      count: 2,
    },
  ],
  'target-workspace.css': [
    {
      policy: 'foundation typography',
      before: `  font-family: "IBM Plex Mono", monospace;
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 2,
    },
    {
      policy: 'foundation typography',
      before: `  font-family: "Instrument Sans", sans-serif;
`,
      after: `  font-family: var(--capiro-type-family-sans, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
`,
      count: 1,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 760px) {
`,
      after: `@media (max-width: 779px) {
`,
      count: 2,
    },
    {
      policy: 'foundation typography',
      before: `  font-family: var(--ov3-font-mono);
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 1,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 1180px) {
`,
      after: `@media (max-width: 1179px) {
`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-target-workspace.is-compact .ov3-search-bar {
  margin-top: 12px;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: #f9fafb;
  box-shadow: inset 0 0 0 1px #e4e7ec;
}
`,
      after: `.ov3-target-workspace.is-compact .ov3-search-bar {
  margin-top: 12px;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: #faf9f6;
  box-shadow: 0 0 0 1px #e8e5df;
}
`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-dir__head {
  padding-block: 8px;
  border-bottom: 1px solid var(--ov3-border);
  background: var(--ov3-canvas);
  color: var(--ov3-muted);
  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
`,
      after: `.ov3-dir__head {
  padding-block: 8px;
  border-bottom: 1px solid var(--ov3-border);
  background: var(--ov3-canvas);
  color: var(--ov3-muted);
  /*
   * \`--ov3-font-mono\` is never defined anywhere in the tree. With no
   * fallback this declaration was invalid at computed-value time, so the
   * property fell back to \`unset\` and this element inherited the SANS
   * family while every sibling that spelled the same var() with a fallback
   * rendered mono. Pointed at the foundation token.
   */
  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
`,
      count: 1,
    },
  ],
  'outreach-v3.css': [
    {
      policy: 'foundation typography',
      before: `  font-family: "Instrument Sans", "Hanken Grotesk", Inter, ui-sans-serif, system-ui, sans-serif;
`,
      after: `  font-family: var(--capiro-type-family-sans, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
`,
      count: 1,
    },
    {
      policy: 'foundation typography',
      before: `  font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 1,
    },
    {
      policy: 'foundation typography',
      before: `  font-family: "IBM Plex Mono", monospace;
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 6,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 760px) {
`,
      after: `@media (max-width: 779px) {
`,
      count: 1,
    },
    {
      policy: 'foundation typography',
      before: `  font-family: var(--ov3-font-mono, 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace);
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 2,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-root {
  --ov3-canvas: var(--capiro-color-bg-canvas, #f4f7fb);
  --ov3-surface: var(--capiro-color-bg-surface, #ffffff);
  --ov3-subtle: var(--capiro-color-bg-subtle, #edf1f6);
  --ov3-selected: var(--capiro-color-bg-selected, #e7edf8);
  --ov3-ink: var(--capiro-color-text-primary, #121722);
  --ov3-secondary: var(--capiro-color-text-secondary, #4e5868);
  --ov3-muted: var(--capiro-color-text-muted, #697587);
  --ov3-accent: var(--capiro-color-text-accent, #244f70);
  --ov3-cobalt: var(--capiro-color-action-meri-default, #3468f5);
  --ov3-border: var(--capiro-color-border-default, #d9e0e9);
  --ov3-border-quiet: var(--capiro-color-border-quiet, #e9edf2);
  --ov3-border-strong: var(--capiro-color-border-strong, #acb7c6);
  --ov3-success: var(--capiro-color-text-success, #2f7455);
  --ov3-warning: var(--capiro-color-text-warning, #8e6415);
  --ov3-danger: var(--capiro-color-text-destructive, #ad3128);
  color: var(--ov3-ink);
  background:
    radial-gradient(circle at 38% -15%, rgba(52, 104, 245, 0.08), transparent 38%),
    var(--ov3-canvas);
  border: 1px solid var(--ov3-border);
  border-radius: 16px;
  box-shadow:
    0 1px 3px rgba(7, 16, 29, 0.05),
    0 22px 64px -36px rgba(7, 16, 29, 0.24);
  display: flex;
  flex-direction: column;
  font-family: var(--capiro-type-family-sans, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
  min-height: min(900px, calc(100dvh - 146px));
  overflow: hidden;
  width: 100%;
}`,
      after: `.ov3-root {
  --ov3-canvas: var(--capiro-color-bg-canvas, #f4f7fb);
  --ov3-surface: var(--capiro-color-bg-surface, #ffffff);
  --ov3-subtle: var(--capiro-color-bg-subtle, #edf1f6);
  --ov3-selected: var(--capiro-color-bg-selected, #e7edf8);
  --ov3-ink: var(--capiro-color-text-primary, #121722);
  --ov3-secondary: var(--capiro-color-text-secondary, #4e5868);
  --ov3-muted: var(--capiro-color-text-muted, #697587);
  --ov3-accent: var(--capiro-color-text-accent, #244f70);
  --ov3-cobalt: var(--capiro-color-action-meri-default, #3468f5);
  --ov3-border: var(--capiro-color-border-default, #d9e0e9);
  --ov3-border-quiet: var(--capiro-color-border-quiet, #e9edf2);
  --ov3-border-strong: var(--capiro-color-border-strong, #acb7c6);
  --ov3-success: var(--capiro-color-text-success, #2f7455);
  --ov3-warning: var(--capiro-color-text-warning, #8e6415);
  --ov3-danger: var(--capiro-color-text-destructive, #ad3128);
  color: var(--ov3-ink);
  background:
    radial-gradient(circle at 38% -15%, rgba(52, 104, 245, 0.08), transparent 38%),
    var(--ov3-canvas);
  border: 1px solid var(--ov3-border);
  border-radius: 16px;
  box-shadow:
    0 1px 3px rgba(7, 16, 29, 0.05),
    0 22px 64px -36px rgba(7, 16, 29, 0.24);
  display: flex;
  flex-direction: column;
  /* Was Instrument Sans first — a third family inside this one module. */
  font-family: var(--capiro-type-family-sans, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
  min-height: min(900px, calc(100dvh - 146px));
  overflow: hidden;
  width: 100%;
}`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-toolbar {
  align-items: center;
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--ov3-border);
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(270px, 1fr) auto minmax(390px, 1fr);
  min-height: 64px;
  padding: 9px 14px;
  position: relative;
  z-index: 4;
}`,
      after: `.ov3-toolbar {
  align-items: center;
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--ov3-border);
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(270px, 1fr) auto minmax(390px, 1fr);
  min-height: 64px;
  padding: 9px 14px;
  position: relative;
  z-index: var(--eng-layer-sticky, 20);
}`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-button:focus-visible,
.ov3-icon-button:focus-visible,
.ov3-send-button:focus-visible,
.ov3-root input:focus-visible,
.ov3-root textarea:focus-visible,
.ov3-root select:focus-visible,
.ov3-stage-rail button:focus-visible,
.ov3-choice-card:focus-visible,
.ov3-tab-row button:focus-visible,
.ov3-segmented button:focus-visible {
  outline: 3px solid rgba(52, 104, 245, 0.28);
  outline-offset: 2px;
}`,
      after: `.ov3-button:focus-visible,
.ov3-icon-button:focus-visible,
.ov3-send-button:focus-visible,
.ov3-root input:focus-visible,
.ov3-root textarea:focus-visible,
.ov3-root select:focus-visible,
.ov3-stage-rail button:focus-visible,
.ov3-choice-card:focus-visible,
.ov3-tab-row button:focus-visible,
.ov3-segmented button:focus-visible {
  /*
   * \`.ov3-stage-rail\` is \`overflow-x: auto\` (line 1179) and the tab rows
   * scroll on narrow viewports, so an outer box-shadow ring is clipped by the
   * scroll container and the control appears to have no focus at all. The
   * inset twin paints inside the control's own box and survives the clip.
   */
  box-shadow: var(--capiro-focus-ring-inset);
}`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-conversation {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}`,
      after: `.ov3-conversation {
  /* Meri chat panel — the assistant tier (WARM-SURFACE-PALETTE.md), warmer
     than the white data surface the sibling panels keep. */
  background: var(--eng-surface-assistant, #fffdfa);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}`,
      count: 1,
    },
    {
      policy: 'omit unsupported request dialog (prototype parity section 5a)',
      before: `.ov3-request-modal__backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(13 24 38 / 42%);
}

.ov3-request-modal {
  width: min(680px, 100%);
  max-height: min(760px, calc(100vh - 48px));
  overflow: auto;
  padding: 28px;
  border: 1px solid var(--ov3-border, #d8dee8);
  border-radius: 18px;
  background: var(--ov3-surface, #fff);
  box-shadow: 0 24px 80px rgb(13 24 38 / 22%);
}

.ov3-request-modal > .ov3-panel-header {
  margin-bottom: 22px;
}

`,
      after: ``,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-goal-readback__goal {
  padding: 14px 16px;
  border-radius: 10px;
  background: #f9fafb;
  box-shadow: inset 0 0 0 1px #e4e7ec;
  font-size: 14px;
  line-height: 21px;
  color: #101828;
  text-wrap: pretty;
}
`,
      after: `.ov3-goal-readback__goal {
  padding: 14px 16px;
  border-radius: 10px;
  background: #faf9f6;
  box-shadow: 0 0 0 1px #e8e5df;
  font-size: 14px;
  line-height: 21px;
  color: #101828;
  text-wrap: pretty;
}
`,
      count: 1,
    },
  ],
  'planning-surfaces.css': [
    {
      policy: 'foundation typography',
      before: `  font-family: "IBM Plex Mono", monospace;
`,
      after: `  font-family: var(--capiro-type-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
`,
      count: 3,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 1180px) {
`,
      after: `@media (max-width: 1179px) {
`,
      count: 1,
    },
    {
      policy: 'foundation responsive boundary',
      before: `@media (max-width: 760px) {
`,
      after: `@media (max-width: 779px) {
`,
      count: 1,
    },
    {
      policy: 'preserve merged vNext rule',
      before: `.ov3-delivery-card:hover,
.ov3-delivery-card.is-selected {
  background: var(--ov3-selected);
  border-color: var(--ov3-active);
  box-shadow: inset 0 0 0 1px var(--ov3-active);
}`,
      after: `.ov3-delivery-card:hover,
.ov3-delivery-card.is-selected {
  background: var(--ov3-selected);
  border-color: var(--ov3-active);
  box-shadow: 0 0 0 1px var(--ov3-active);
}`,
      count: 1,
    },
  ],
};

/** Apply reviewed vNext choices before the mechanical selector/token transform. */
export function applyVNextDesign(name, source) {
  const policies = VNEXT_DESIGN_POLICIES[name];
  if (!Object.hasOwn(VNEXT_DESIGN_POLICIES, name)) {
    throw new Error(`No vNext design policy for ${name}`);
  }
  let adapted = toLf(source);
  for (const { policy, before, after, count } of policies) {
    const actual = adapted.split(before).length - 1;
    if (actual !== count) {
      throw new Error(`${name}: ${policy} anchor expected ${count}, found ${actual}`);
    }
    adapted = adapted.split(before).join(after);
  }
  if (/\.ov3-request-modal[\w-]*/.test(adapted)) {
    throw new Error(`${name}: unqualified request dialog rule remains`);
  }
  return adapted;
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
    const body = transform(applyVNextDesign(name, readSource(name)), {
      dropOv3Tokens: name === 'outreach-v3.css',
    });
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
