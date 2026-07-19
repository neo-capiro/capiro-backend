import { MERI_TOOL_NAMES } from '@capiro/shared';
import { TOOL_SELECTION_FIXTURES } from './tool-selection-fixtures.js';

// Token-free validity gate for the tool-selection eval fixtures. Runs in CI
// (no model, no network); the live-model accuracy check is
// scripts/eval-clio-tool-selection.ts, nightly via clio-evals.yml.
describe('tool-selection fixtures validity', () => {
  test('has fixtures', () => {
    expect(TOOL_SELECTION_FIXTURES.length).toBeGreaterThan(10);
  });

  test('fixture ids are unique', () => {
    const ids = TOOL_SELECTION_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every expectedTool is a real manifest tool (or null)', () => {
    for (const f of TOOL_SELECTION_FIXTURES) {
      if (f.expectedTool !== null) {
        expect(MERI_TOOL_NAMES).toContain(f.expectedTool);
      }
    }
  });

  test('forbiddenTools are real manifest tools and never equal the expectedTool', () => {
    for (const f of TOOL_SELECTION_FIXTURES) {
      for (const t of f.forbiddenTools ?? []) {
        expect(MERI_TOOL_NAMES).toContain(t);
        expect(t).not.toBe(f.expectedTool);
      }
    }
  });
});
