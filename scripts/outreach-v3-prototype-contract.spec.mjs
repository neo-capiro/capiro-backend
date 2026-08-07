#!/usr/bin/env node
/**
 * Tests for the Outreach V3 prototype contract extractor.
 *
 * Three layers, so CI stays hermetic while the real contract is still proven:
 *
 *   1. Committed-fixture assertions — the real extracted contract is in the
 *      repository, so the shape of the real prototype is tested with no
 *      external file present.
 *   2. Synthetic-bundle assertions — failure modes and negative controls run
 *      against tiny in-memory bundles.
 *   3. Drift check — only when the real prototype is available, proving the
 *      committed fixture still matches it. Loudly skipped otherwise, never
 *      silently passed.
 *
 * Run: node scripts/outreach-v3-prototype-contract.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  PrototypeContractError,
  buildManifest,
  extractPrototypeSource,
  readBundle,
  serializeManifest,
  slugify,
} from './outreach-v3-prototype-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(
  ROOT,
  'apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json',
);

const EXPECTED_VISIBLE_STAGES = ['Goal', 'Targets', 'Delivery', 'Context', 'Drafts', 'Send'];
const EXPECTED_INTERNAL_STAGES = [
  'goal',
  'readback',
  'sponsor',
  'criteria',
  'targets',
  'coverage',
  'delivery',
  'context',
  'strategy',
  'samples',
  'drafts',
  'preflight',
  'sent',
];

// ───────────────────────────────────────────────── synthetic bundle builder

const BASE_RULES = [
  'The screen is not split. One workbench, with the conversation docked across the bottom and its history expandable over the work.',
  'Meri recommends targets but never pre-adds them.',
];

const LEFT_PANE_RULES = [
  'The interface uses a left conversation pane beside the work surface.',
  'Meri recommends targets but never pre-adds them.',
];

function xdcSource({ rules = BASE_RULES, flowLabels, extraSource = '' } = {}) {
  const flow = flowLabels ?? ['1 · Outreach landing', '2 · Read-back, no client required'];
  const list = (values) => values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(',');
  const items = (values) => values.map((v) => `{label:'${v.replace(/'/g, "\\'")}', go: jump({})}`).join(',');
  return `
class Component extends DCLogic {
  STAGES = [${list(EXPECTED_INTERNAL_STAGES)}];
  GROUP_LABELS = [${list(EXPECTED_VISIBLE_STAGES)}];
  GROUP_ENTRY = ['goal','targets','delivery','context','drafts','preflight'];
  CTX = [{id:'a',cat:'required'},{id:'b',cat:'writing'},{id:'c',cat:'facts'},{id:'d',cat:'target'}];
  ${extraSource}
  draftStatus(id) {
    const r = this.state.dv[id];
    if (!r) return 'Not generated';
    if (r.failed) return 'Failed';
    return 'Ready for review';
  }
  cmds() {
    C.FIND_TARGETS = {label:'Find targets', run: () => this.findTargets()};
    C.SEND = elig.length === 0
      ? {label:'Resolve blockers', kind:'blocked', run: () => this.stop()}
      : {label:'Send ' + elig.length + ' email', kind:'send', run: () => this.doSend()};
    return C;
  }
  view() {
    v.stateMenu = [
      {label:'New in this version', items:[${items(['Bottom chat bar · conversation-led flow'])}]},
      {label:'Flow', items:[${items(flow)}]},
      {label:'Target and context edge cases', items:[${items(['Missing target email'])}]},
      {label:'Empty', items:[${items(['No targets selected'])}]},
      {label:'Loading', items:[${items(['Searching the Directory'])}]},
      {label:'Error and timeout', items:[${items(['Directory search failed'])}]},
      {label:'System', items:[${items(['Mobile stacked layout'])}]},
    ];
    v.sponsorOptions = [['firm','Our firm','x'],['client','A client','y']];
    v.tabs = [['recommended','Recommended'],['directory','Directory']];
    v.deliveryOptions = [{id:'personalized', label:'Personalized emails'},{id:'shared', label:'One shared email'}];
    v.notesResponsive = pair([
      ['Desktop ≥1280px','One workbench with the conversation bar docked underneath.'],
      ['Tablet 900–1280px','Resizable split with a 360px conversation minimum.'],
      ['Mobile <900px','Stacked. Conversation first with the live question pinned.'],
    ]);
    v.notesRules = [${list(rules)}].map(name => ({name}));
    return v;
  }
  setScenarios() { this.setScenario('hill'); this.setScenario('agency'); }
}`;
}

/** Build a minimal but structurally faithful bundle. */
function makeBundle(options = {}) {
  const {
    includeManifest = true,
    corruptAsset = false,
    fontBytes = Buffer.from('FONTBYTESFONTBYTES'.repeat(8)),
    ...sourceOptions
  } = options;

  const template = `<!DOCTYPE html><html><head></head><body>
<script src="asset-uuid"></script>
<script type="text/x-dc" data-dc-script="" data-props="{}">${xdcSource(sourceOptions)}</script>
</body></html>`;

  const assets = {
    'aaaaaaaa-0000-0000-0000-000000000001': {
      mime: 'text/javascript',
      compressed: true,
      data: corruptAsset
        ? Buffer.from('this is not gzip at all').toString('base64')
        : gzipSync(Buffer.from('// dc-runtime stub\n')).toString('base64'),
    },
    'aaaaaaaa-0000-0000-0000-000000000002': {
      mime: 'font/woff2',
      compressed: false,
      data: fontBytes.toString('base64'),
    },
  };

  // The real bundler escapes "/" as / so an embedded "</script>" can never
  // terminate the host block early. Mirror that exactly, or the synthetic
  // bundles would be unrepresentative of the artifact under test.
  const embed = (value) => JSON.stringify(value).replace(/\//g, '\\u002F');

  const manifestBlock = includeManifest
    ? `<script type="__bundler/manifest">\n${embed(assets)}\n</script>`
    : '';

  return Buffer.from(
    `<!DOCTYPE html><html><body>
${manifestBlock}
<script type="__bundler/template">\n${embed(template)}\n</script>
</body></html>`,
    'utf8',
  );
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ─────────────────────────────────────────── 1. committed-fixture assertions

test('committed fixture exists and declares schema version 1', () => {
  assert.ok(existsSync(FIXTURE), `missing fixture: ${FIXTURE}`);
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.prototypeSha256, /^[0-9a-f]{64}$/);
});

test('six visible stages are exactly Goal, Targets, Delivery, Context, Drafts, Send', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(manifest.visibleStages, EXPECTED_VISIBLE_STAGES);
});

test('internal stage machine matches the prototype stage list', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(manifest.internalStages, EXPECTED_INTERNAL_STAGES);
});

test('primary flow contains 22 named states, numbered 1..22 in order', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(manifest.primaryFlowStates.length, 22);
  assert.deepEqual(
    manifest.primaryFlowStates.map((s) => s.flowNumber),
    Array.from({ length: 22 }, (_, i) => i + 1),
  );
  for (const state of manifest.primaryFlowStates) {
    assert.ok(state.id.length > 0, `state has no id: ${state.label}`);
    assert.ok(state.label.length > 0);
  }
});

test('bottom-docked conversation layout is detected', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(manifest.layout, {
    workbench: 'single',
    conversation: 'bottom_docked',
    history: 'expandable_overlay',
    mobile: 'stacked_conversation_first',
  });
});

test('edge, loading, error, empty and system states are all populated', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const key of [
    'edgeStates',
    'loadingStates',
    'errorStates',
    'emptyStates',
    'systemStates',
  ]) {
    assert.ok(Array.isArray(manifest[key]), `${key} is not an array`);
    assert.ok(manifest[key].length > 0, `${key} is empty`);
    for (const state of manifest[key]) {
      assert.ok(state.menuGroup, `${key} entry lost its source group`);
    }
  }
});

test('every state id is unique across all buckets — 2.2 joins on it', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const all = [
    ...manifest.primaryFlowStates,
    ...manifest.edgeStates,
    ...manifest.loadingStates,
    ...manifest.errorStates,
    ...manifest.emptyStates,
    ...manifest.systemStates,
  ];
  assert.equal(all.length, 62, 'expected 62 extracted prototype states');
  const ids = all.map((s) => s.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(duplicates, [], 'state ids must be unique to serve as a join key');
});

test('the send control is present and never classified as a plain safe action', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const send = manifest.commands.find((c) => c.id === 'SEND');
  assert.ok(send, 'SEND command is missing from the contract');
  assert.deepEqual(send.kinds, ['blocked', 'review', 'send']);
});

test('no font bytes, base64 asset payload, data URI or email enters the fixture', () => {
  const raw = readFileSync(FIXTURE, 'utf8');
  const withoutHashes = raw.replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
  assert.doesNotMatch(withoutHashes, /[A-Za-z0-9+/]{64,}={0,2}/, 'base64-looking blob present');
  assert.doesNotMatch(raw, /data:[a-z]+\/[a-z0-9.+-]+;base64,/i, 'data URI present');
  assert.doesNotMatch(
    raw,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    'email address present',
  );
  const manifest = JSON.parse(raw);
  assert.equal(manifest.assetSummary.opaqueAssets, 16);
  assert.deepEqual(manifest.assetSummary.mimes, ['font/woff2', 'text/javascript']);
});

test('fixture stores no volatile timestamp', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(manifest.extractedAt, null);
});

test('scenario data is labelled fictional', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(manifest.provenance.scenarioDataIsFictional, true);
});

// ──────────────────────────────────────────── 2. synthetic-bundle assertions

test('a valid synthetic bundle extracts the expected stage machine', () => {
  const bytes = makeBundle();
  const manifest = buildManifest(bytes);
  assert.deepEqual(manifest.visibleStages, EXPECTED_VISIBLE_STAGES);
  assert.deepEqual(manifest.internalStages, EXPECTED_INTERNAL_STAGES);
  assert.equal(manifest.layout.conversation, 'bottom_docked');
});

test('checksum mismatch fails', () => {
  const bytes = makeBundle();
  assert.throws(
    () => buildManifest(bytes, { expectedSha256: 'f'.repeat(64) }),
    (error) =>
      error instanceof PrototypeContractError && /checksum mismatch/i.test(error.message),
  );
  // and the matching checksum still succeeds, so the gate is not always-fail
  assert.ok(buildManifest(bytes, { expectedSha256: sha256(bytes) }));
});

test('a malformed expected checksum fails rather than being ignored', () => {
  assert.throws(
    () => buildManifest(makeBundle(), { expectedSha256: 'not-a-hash' }),
    /malformed/i,
  );
});

test('missing bundle manifest fails', () => {
  assert.throws(
    () => buildManifest(makeBundle({ includeManifest: false })),
    (error) =>
      error instanceof PrototypeContractError && /manifest block is missing/i.test(error.message),
  );
});

test('corrupt compressed asset fails', () => {
  assert.throws(
    () => buildManifest(makeBundle({ corruptAsset: true })),
    (error) =>
      error instanceof PrototypeContractError &&
      /corrupt compressed asset/i.test(error.message),
  );
});

test('output is deterministic across repeated extraction', () => {
  const bytes = makeBundle();
  const first = serializeManifest(buildManifest(bytes));
  const second = serializeManifest(buildManifest(bytes));
  assert.equal(first, second);
});

test('font bytes never reach the output even when they look like text', () => {
  // A font payload whose base64 would trip the blob guard if it were copied.
  const bytes = makeBundle({ fontBytes: Buffer.alloc(4096, 0x41) });
  const manifest = buildManifest(bytes);
  const serialized = serializeManifest(manifest);
  assert.doesNotMatch(serialized.replace(/\b[0-9a-f]{64}\b/g, '<sha256>'), /[A-Za-z0-9+/]{64,}/);
  assert.equal(manifest.assetSummary.opaqueAssets, 1);
});

// ────────────────────────────────────────────────────── 3. negative controls

test('NC-2.1-A drift: replacing one state label changes the manifest', () => {
  const base = buildManifest(makeBundle());
  const drifted = buildManifest(
    makeBundle({ flowLabels: ['1 · Outreach landing', '2 · Read-back, CLIENT REQUIRED'] }),
  );
  assert.notDeepEqual(base.primaryFlowStates, drifted.primaryFlowStates);
  assert.equal(drifted.primaryFlowStates[1].label, '2 · Read-back, CLIENT REQUIRED');
  assert.notEqual(
    serializeManifest(base),
    serializeManifest(drifted),
    'a changed state label must produce a visible manifest diff',
  );
});

test('NC-2.1-B layout: a left-pane prototype is reported as left_pane, not bottom_docked', () => {
  const manifest = buildManifest(makeBundle({ rules: LEFT_PANE_RULES }));
  assert.equal(manifest.layout.conversation, 'left_pane');
  assert.equal(manifest.layout.workbench, 'split');
  assert.notEqual(
    manifest.layout.conversation,
    'bottom_docked',
    'the layout contract must track the prototype, not a hardcoded answer',
  );
});

test('NC-2.1-C side effect: prototype JavaScript is never executed', () => {
  delete globalThis.__OUTREACH_V3_PROTOTYPE_EXECUTED__;
  const hostile = `
    globalThis.__OUTREACH_V3_PROTOTYPE_EXECUTED__ = true;
    process.exit(97);
    throw new Error('prototype code ran');
  `;
  const manifest = buildManifest(makeBundle({ extraSource: hostile }));
  assert.equal(
    globalThis.__OUTREACH_V3_PROTOTYPE_EXECUTED__,
    undefined,
    'prototype JavaScript was executed',
  );
  // Extraction still produced a contract from the surrounding source.
  assert.deepEqual(manifest.visibleStages, EXPECTED_VISIBLE_STAGES);
});

test('the extractor contains no dynamic code-execution primitive', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/outreach-v3-prototype-contract.mjs'), 'utf8');
  const body = source.replace(/^[\s\S]*?\*\//, ''); // drop the header comment
  for (const forbidden of ['eval(', 'new Function', 'node:vm', 'require(', 'child_process']) {
    assert.ok(!body.includes(forbidden), `extractor references ${forbidden}`);
  }
});

test('slugify is stable and url-safe', () => {
  assert.equal(slugify('2 · Read-back, no client required'), '2-read-back-no-client-required');
  assert.equal(slugify('Meri unavailable · options still work'), 'meri-unavailable-options-still-work');
  assert.equal(slugify('I’m done selecting'), 'im-done-selecting');
});

test('bundle reader rejects a template that is not a string', () => {
  const bad = Buffer.from(
    `<script type="__bundler/manifest">{}</script>
     <script type="__bundler/template">{"not":"a string"}</script>`,
    'utf8',
  );
  assert.throws(() => readBundle(bad.toString('utf8')), /must decode to a string/i);
});

test('a template without a prototype source script fails', () => {
  assert.throws(
    () => extractPrototypeSource('<html><body>no dc script here</body></html>'),
    /text\/x-dc/i,
  );
});

// ────────────────────────────────────────────────── 4. real-prototype drift

const prototypePath = process.env.OUTREACH_V3_PROTOTYPE_PATH;
const prototypeAvailable = Boolean(prototypePath) && existsSync(prototypePath);

test('committed fixture matches the real prototype', { skip: !prototypeAvailable }, () => {
  const bytes = readFileSync(prototypePath);
  const expectedSha256 = process.env.EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256;
  const manifest = buildManifest(bytes, { expectedSha256 });
  assert.equal(
    serializeManifest(manifest),
    readFileSync(FIXTURE, 'utf8'),
    'prototype contract drift — regenerate the fixture and review the diff',
  );
});

if (!prototypeAvailable) {
  console.warn(
    '\n[outreach-v3-prototype-contract] NOTE: the real-prototype drift check did NOT run.\n' +
      '  Set OUTREACH_V3_PROTOTYPE_PATH (and EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256) to enable it.\n' +
      '  Every other assertion ran against the committed fixture and synthetic bundles.\n',
  );
}
