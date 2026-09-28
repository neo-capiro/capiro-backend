import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { previewGateProblems } from './outreach-v3-preview-gate-contract.mjs';
const original =
  "const v3Enabled = previewMode === 'v3' && isEngagementPreviewActive() && !hasClassicDraft;";
const current =
  "const forceClassic = false; const v3Enabled = !forceClassic && !hasClassicDraft && previewMode === 'v3' && isEngagementPreviewActive();";
test('historical, reordered and current gates retain every protection', () => {
  for (const source of [
    original,
    current,
    "const v3Enabled = (!hasClassicDraft && (isEngagementPreviewActive() && previewMode === 'v3'));",
    fs.readFileSync('apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx', 'utf8'),
  ]) {
    assert.deepEqual(previewGateProblems(source), []);
  }
});
test('each missing switch or Classic protection fails', () => {
  for (const term of [
    "previewMode === 'v3' && ",
    ' && isEngagementPreviewActive()',
    '!hasClassicDraft && ',
    '!forceClassic && ',
  ]) {
    assert.ok(previewGateProblems(current.replace(term, '')).length);
  }
});
test('OR, bypass, duplicate declarations and malformed source fail', () => {
  for (const source of [
    original.replace('&&', '||'),
    original.replace('!hasClassicDraft', '(!hasClassicDraft || true)'),
    original + original,
    'const v3Enabled = ;',
  ]) {
    assert.ok(previewGateProblems(source).length);
  }
});

test('literal values and comparison/call structure cannot be normalized into acceptance', () => {
  for (const source of [
    original.replace("'v3'", "'v 3'"),
    original.replace('===', '=='),
    original.replace('isEngagementPreviewActive()', 'isEngagementPreviewActive(true)'),
    original.replace('!hasClassicDraft', 'hasClassicDraft'),
  ]) {
    assert.ok(previewGateProblems(source).length);
  }
});
