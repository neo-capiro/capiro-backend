#!/usr/bin/env node
/**
 * Tests for the vNext outreach-decision stylesheet generator and drift gate.
 *
 * The checked-in generated file is the artifact under test: the integration
 * test below IS the drift gate. The unit tests use negative controls — a rule
 * the transform must NOT touch alongside the one it must — so each invariant is
 * proven to bite rather than merely to exist.
 *
 * Run: node scripts/port-outreach-decision-vnext-css.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  GENERATED_PATH,
  PREFIX,
  SOURCES,
  applyVNextDesign,
  readCanonical,
  build,
  detectEol,
  extractBanner,
  transform,
} from './port-outreach-decision-vnext-css.mjs';

const lf = (text) => text.replace(/\r\n/g, '\n');

test('the checked-in generated stylesheet is current with its canonical sources', () => {
  const { current, expected } = build();
  // LF-normalized: the blob is LF but a Windows checkout is CRLF, so comparing
  // raw bytes would fail on exactly one of the two platforms.
  assert.equal(
    current,
    expected,
    'outreach-decision-vnext.css has drifted — run: node scripts/port-outreach-decision-vnext-css.mjs --write',
  );
});

test('the drift gate is line-ending agnostic, and --write preserves the file ending', () => {
  // Regression control for a gate that passed on Windows and failed on CI:
  // build() compares LF-normalized content, but expectedBytes must carry the
  // ending the file on disk already uses so --write never churns line endings.
  const { current, expected, expectedBytes } = build();
  assert.ok(!current.includes('\r'), 'build().current must be LF-normalized');
  assert.ok(!expected.includes('\r'), 'build().expected must be LF-normalized');

  const onDisk = readFileSync(GENERATED_PATH, 'utf8');
  assert.equal(detectEol(expectedBytes), detectEol(onDisk), 'expectedBytes changed the ending');
  assert.equal(lf(expectedBytes), expected, 'expectedBytes and expected disagree on content');

  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
});

test('the .ov3-sample-* block reaches vNext', () => {
  // The regression this generator was written for: the whole style-samples
  // block was missing, so the wizard step rendered unstyled on os.capiro.ai
  // while app.capiro.ai was fine. Named explicitly so the specific bug cannot
  // return even if the byte comparison above is ever loosened.
  const ported = lf(readFileSync(GENERATED_PATH, 'utf8'));
  for (const rule of [
    '.ov3-sample-list',
    '.ov3-sample-card',
    '.ov3-sample-card__head',
    '.ov3-sample-card__index',
    '.ov3-sample-card__title',
    '.ov3-sample-card__preview',
    '.ov3-sample-form',
  ]) {
    assert.ok(ported.includes(`\n${PREFIX} ${rule} {`), `missing ported rule: ${rule}`);
  }
});

test('every canonical source contributes a section, in order', () => {
  // Section order is part of the artifact: reordering SOURCES silently
  // reorders the cascade.
  const ported = lf(readFileSync(GENERATED_PATH, 'utf8'));
  const offsets = SOURCES.map((name) => ported.indexOf(`/* ==== ported from ${name} ==== */`));
  for (const [index, offset] of offsets.entries()) {
    assert.notEqual(offset, -1, `missing section for ${SOURCES[index]}`);
  }
  assert.deepEqual(
    offsets,
    [...offsets].sort((a, b) => a - b),
    'sections are out of source order',
  );
});

test('top-level selectors are prefixed and declarations are not', () => {
  assert.equal(
    transform('.a {\n  color: red;\n}', { dropOv3Tokens: false }),
    `${PREFIX} .a {\n  color: red;\n}`,
  );
});

test('every entry of a multi-line selector list is prefixed', () => {
  assert.equal(
    transform('.a,\n.b {\n  color: red;\n}', { dropOv3Tokens: false }),
    `${PREFIX} .a,\n${PREFIX} .b {\n  color: red;\n}`,
  );
});

test('selectors nested in an at-rule are prefixed, the at-rule itself is not', () => {
  assert.equal(
    transform('@media (max-width: 760px) {\n  .a {\n    color: red;\n  }\n}', {
      dropOv3Tokens: false,
    }),
    `@media (max-width: 760px) {\n  ${PREFIX} .a {\n    color: red;\n  }\n}`,
  );
});

test('keyframe offsets are left alone — prefixing them would break the animation', () => {
  // The negative control for the at-rule case above: @media descends into
  // selectors, @keyframes descends into offsets. `:where(...) from` is not a
  // valid keyframe selector and would silently drop the animation.
  const source =
    '@keyframes spin {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}';
  assert.equal(transform(source, { dropOv3Tokens: false }), source);
});

test('a commented-out selector is not mistaken for a selector', () => {
  assert.equal(
    transform('/* .a */\n.b {\n  color: red;\n}', { dropOv3Tokens: false }),
    `/* .a */\n${PREFIX} .b {\n  color: red;\n}`,
  );
});

test('--ov3-* definitions are dropped only inside .ov3-root', () => {
  const source =
    '.ov3-root {\n  --ov3-ink: #000;\n  color: red;\n}\n\n.other {\n  --ov3-ink: #111;\n}';
  const result = transform(source, { dropOv3Tokens: true });

  // Dropped inside .ov3-root...
  assert.ok(!result.includes('--ov3-ink: #000'), '--ov3-ink definition survived .ov3-root');
  // ...but the block's other declarations, and definitions elsewhere, survive.
  assert.ok(result.includes('color: red'), 'non-token declaration was dropped with the tokens');
  assert.ok(result.includes('--ov3-ink: #111'), 'definition outside .ov3-root was wrongly dropped');
});

test('--ov3-* definitions survive when token dropping is off', () => {
  // Negative control: only outreach-v3.css is transformed with dropOv3Tokens,
  // so the other three sources must keep any --ov3-* they define.
  const source = '.ov3-root {\n  --ov3-ink: #000;\n}';
  assert.ok(transform(source, { dropOv3Tokens: false }).includes('--ov3-ink: #000'));
});

test('extractBanner refuses a file with no leading block comment', () => {
  // build() depends on this to fail loudly rather than regenerate the file
  // without its hand-authored banner.
  assert.equal(extractBanner('.a {\n  color: red;\n}\n'), null);
  assert.equal(extractBanner('/* unterminated\n'), null);
  assert.equal(extractBanner('/* kept */\n.a {\n}\n'), '/* kept */\n');
});

// These fixtures exercise the actual canonical sources and explicit intended
// vNext values, independent of the policy table's own expected strings.
test('all four sources use foundation type and the existing responsive boundaries', () => {
  for (const name of SOURCES) {
    const adapted = applyVNextDesign(name, readCanonical(name));
    assert.ok(adapted.includes('font-family: var(--capiro-type-family-mono,'), name);
    assert.ok(adapted.includes('@media (max-width: 779px)'), name);
    assert.doesNotMatch(adapted, /font-family: (?:['"]IBM|['"]Instrument|var\(--ov3-font)/);
    assert.doesNotMatch(adapted, /@media \(max-width: (760|1180)px\)/);
  }
});

test('the existing vNext surfaces, layers and clipped focus treatment survive', () => {
  const target = applyVNextDesign('target-workspace.css', readCanonical('target-workspace.css'));
  const outreach = applyVNextDesign('outreach-v3.css', readCanonical('outreach-v3.css'));
  const planning = applyVNextDesign(
    'planning-surfaces.css',
    readCanonical('planning-surfaces.css'),
  );
  assert.match(target, /background: #faf9f6;\n  box-shadow: 0 0 0 1px #e8e5df;/);
  assert.match(outreach, /background: #faf9f6;\n  box-shadow: 0 0 0 1px #e8e5df;/);
  assert.ok(outreach.includes('z-index: var(--eng-layer-sticky, 20);'));
  assert.ok(outreach.includes('box-shadow: var(--capiro-focus-ring-inset);'));
  assert.ok(outreach.includes('background: var(--eng-surface-assistant, #fffdfa);'));
  assert.ok(planning.includes('box-shadow: 0 0 0 1px var(--ov3-active);'));
  assert.doesNotMatch(outreach, /outline: 3px solid|outline-offset: 2px/);
});

test('missing, changed and duplicate typography anchors fail closed', () => {
  const name = 'context-review-surface.css';
  const original = readCanonical(name);
  const anchor = "  font-family: 'IBM Plex Mono', monospace;\n";
  for (const mutated of [
    original.replace(anchor, ''),
    original.replace(anchor, '  font-family: unexpected;\n'),
    `${original}\n.extra {\n${anchor}}\n`,
  ]) {
    assert.throws(() => applyVNextDesign(name, mutated), /anchor expected 2, found [13]/);
  }
});

test('changed selector context, surface value and focus value cannot silently lose policy', () => {
  const cases = [
    ['target-workspace.css', '.ov3-target-workspace.is-compact .ov3-search-bar {', '.renamed {'],
    ['target-workspace.css', 'background: #f9fafb;', 'background: #000000;'],
    ['outreach-v3.css', 'outline-offset: 2px;', 'outline-offset: 4px;'],
    ['outreach-v3.css', 'z-index: 4;', 'z-index: 5;'],
  ];
  for (const [name, before, after] of cases) {
    const source = readCanonical(name);
    assert.ok(source.includes(before));
    assert.throws(
      () => applyVNextDesign(name, source.replace(before, after)),
      /anchor expected 1, found 0/,
    );
  }
});

test('request dialog omission is exact, while the mechanical legacy port retains its rules', () => {
  const source = readCanonical('outreach-v3.css');
  const adapted = applyVNextDesign('outreach-v3.css', source);
  assert.doesNotMatch(adapted, /\.ov3-request-modal/);
  const mechanical = transform(source, { dropOv3Tokens: true });
  for (const selector of [
    '.ov3-request-modal__backdrop',
    '.ov3-request-modal',
    '.ov3-request-modal > .ov3-panel-header',
  ]) {
    assert.ok(mechanical.includes(`${PREFIX} ${selector} {`));
  }
  // No constructor, file writer, or runtime component participates in adapting.
  assert.equal(source, readCanonical('outreach-v3.css'));
});

test('changed, missing, duplicated or additional request dialog rules fail closed', () => {
  const name = 'outreach-v3.css';
  const source = readCanonical(name);
  const start = source.indexOf('.ov3-request-modal__backdrop {');
  const end = source.indexOf('.ov3-selection-box,', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  for (const mutated of [
    source.replace('max-height: min(760px, calc(100vh - 48px));', 'max-height: 10px;'),
    source.replace(block, ''),
    source + '\n' + block,
    source + '\n.ov3-request-modal .new-control { color: red; }\n',
    source + '\n.ov3-request-modal--new { color: red; }\n',
  ]) {
    assert.throws(
      () => applyVNextDesign(name, mutated),
      /anchor expected|unqualified request dialog/,
    );
  }
});

test('neutral declarations, dimensions and selectors keep their canonical meaning', () => {
  const neutral =
    '\n.neutral {\n  color: #f9fafb;\n  border: 1px solid #e4e7ec;\n  height: 760px;\n  font-family: serif;\n  z-index: 4;\n}\n';
  const name = 'target-workspace.css';
  const adapted = applyVNextDesign(name, readCanonical(name) + neutral);
  assert.ok(adapted.endsWith(neutral), 'policy leaked beyond its qualified anchors');
  assert.throws(() => applyVNextDesign('unknown.css', neutral), /No vNext design policy/);
});
