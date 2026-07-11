// Outreach deterministic eval suite (Wave 1.1). Runs each golden fixture's
// prompt-assembly assertions through the REAL buildOutreachPrompt with no LLM —
// this is the CI-gating half of the outreach evals (the live-LLM baseline +
// judge run manually via `pnpm eval:outreach`, key-gated). It protects the W0
// prompt guarantees (greeting/collective, tone directive, direction, template,
// injection-handling text) and grows as PromptSpec v2 (W2) lands.

import { describe, expect, test } from '@jest/globals';
import { EngagementAiService, type OutreachDraftInput } from '../engagement-ai.service.js';
import { OUTREACH_EVAL_FIXTURES, type OutreachArchetype } from './fixtures.js';

function buildPrompt(input: OutreachDraftInput): string {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  return (
    svc as unknown as { buildOutreachPrompt(i: OutreachDraftInput): string }
  ).buildOutreachPrompt(input);
}

describe('outreach deterministic eval suite (W1.1)', () => {
  for (const fx of OUTREACH_EVAL_FIXTURES) {
    describe(`${fx.id} (${fx.archetype})`, () => {
      const prompt = buildPrompt(fx.input);

      test('assembled prompt is non-empty and names the client', () => {
        expect(prompt.length).toBeGreaterThan(200);
        const clientName = (fx.input.client as { name?: string } | null)?.name;
        if (clientName) expect(prompt).toContain(clientName);
      });

      for (const needle of fx.promptMustContain) {
        test(`prompt contains: ${JSON.stringify(needle)}`, () => {
          expect(prompt).toContain(needle);
        });
      }

      for (const needle of fx.promptMustNotContain ?? []) {
        test(`prompt does NOT contain: ${JSON.stringify(needle)}`, () => {
          expect(prompt).not.toContain(needle);
        });
      }

      test('campaign prompt always carries the anti-fabrication + no-token guards', () => {
        // Invariants that hold for every campaign draft regardless of archetype.
        expect(prompt).toContain('Do not invent facts.');
        expect(prompt).toContain('Never return unresolved template variables');
      });
    });
  }

  test('fixture set covers every archetype', () => {
    const covered = new Set(OUTREACH_EVAL_FIXTURES.map((f) => f.archetype));
    const expected: OutreachArchetype[] = [
      'individual',
      'group',
      'thin-context',
      'template-memo',
      'direction-on-behalf',
      'direction-to-clients',
      'tone',
      'injection-note',
      'injection-context',
      'voice',
    ];
    for (const a of expected) expect(covered.has(a)).toBe(true);
  });

  test('fixture ids are unique', () => {
    const ids = OUTREACH_EVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
