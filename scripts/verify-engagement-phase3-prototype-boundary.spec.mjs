#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBoundary } from './verify-engagement-phase3-prototype-boundary.mjs';

test('accepts current Phase 3 preview/parity files', () => {
  assert.deepEqual(
    verifyBoundary({
      changed: [
        'apps/web/src/lib/engagement-api-preview.ts',
        'apps/web/scripts/engagement-phase3-browser-parity.mjs',
        'docs/plans/engagement-api/phase-3-to-outreach-v3-handoff.md',
      ],
      addedLines: "import { EngagementPreviewBoundary } from './EngagementPreviewBoundary.js';",
      deleted: [],
    }),
    [],
  );
});

test('negative control: V3 production component path fails', () => {
  const issues = verifyBoundary({
    changed: ['apps/web/src/pages/engagement/outreach/v3/OutreachV3Wizard.tsx'],
    addedLines: '',
    deleted: [],
  });
  assert.equal(issues.some((issue) => issue.includes('forbidden Phase 3 path')), true);
});

test('negative control: LangGraph source addition fails', () => {
  const issues = verifyBoundary({
    changed: ['apps/web/src/pages/engagement/EngagementPage.tsx'],
    addedLines: "import { StateGraph } from '@langchain/langgraph';",
    deleted: [],
  });
  assert.equal(issues.some((issue) => issue.includes('source addition')), true);
});

test('negative control: prototype asset shipping fails', () => {
  const issues = verifyBoundary({
    changed: ['docs/assets/outreach-prototype.png'],
    addedLines: '',
    deleted: [],
  });
  assert.equal(issues.some((issue) => issue.includes('prototype asset')), true);
});

test('negative control: removing Outreach v2 source fails', () => {
  const issues = verifyBoundary({
    changed: [],
    addedLines: '',
    deleted: ['apps/web/src/pages/engagement/OutreachView.tsx'],
  });
  assert.equal(issues.some((issue) => issue.includes('Outreach v2 removal')), true);
});
