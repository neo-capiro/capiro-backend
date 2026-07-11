// Outreach deterministic eval suite (Wave 1.1). Runs each golden fixture's
// prompt-assembly assertions through the REAL buildOutreachPrompt with no LLM —
// this is the CI-gating half of the outreach evals (the live-LLM baseline +
// judge run manually via `pnpm eval:outreach`, key-gated). It protects the W0
// prompt guarantees (greeting/collective, tone directive, direction, template,
// injection-handling text) and grows as PromptSpec v2 (W2) lands.

import { describe, expect, test } from '@jest/globals';
import { EngagementAiService, type OutreachDraftInput } from '../engagement-ai.service.js';
import {
  buildOutreachPromptV2,
  type OutreachPromptV2Input,
} from '../outreach-prompt/prompt-spec-v2.js';
import {
  OUTREACH_EVAL_FIXTURES,
  type OutreachArchetype,
  type OutreachEvalFixture,
} from './fixtures.js';

/**
 * Assemble a fixture's prompt for its declared spec version. v1 (default) invokes
 * the legacy private buildOutreachPrompt (returns one user string; system ''). v2
 * invokes buildOutreachPromptV2, whose guardrails/length/revision text live in a
 * real system block separate from the user block. Both are returned so callers can
 * assert against the combined prompt (v1: user only; v2: system + user).
 */
function buildPrompt(fx: OutreachEvalFixture): { system: string; user: string } {
  if (fx.specVersion === 'v2') {
    const spec = buildOutreachPromptV2(fx.input as unknown as OutreachPromptV2Input);
    return { system: spec.system, user: spec.user };
  }
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  const user = (
    svc as unknown as { buildOutreachPrompt(i: OutreachDraftInput): string }
  ).buildOutreachPrompt(fx.input);
  return { system: '', user };
}

describe('outreach deterministic eval suite (W1.1)', () => {
  for (const fx of OUTREACH_EVAL_FIXTURES) {
    describe(`${fx.id} (${fx.archetype})`, () => {
      const { system, user: prompt } = buildPrompt(fx);
      // Needles may target either block; assert against the combined text so a
      // v2 system-block needle (e.g. a length directive) and a v1 user-block
      // needle both resolve without the fixture caring where the text lives.
      const combined = `${system}\n${prompt}`;

      test('assembled prompt is non-empty and names the client', () => {
        expect(prompt.length).toBeGreaterThan(200);
        const clientName = (fx.input.client as { name?: string } | null)?.name;
        if (clientName) expect(combined).toContain(clientName);
      });

      for (const needle of fx.promptMustContain) {
        test(`prompt contains: ${JSON.stringify(needle)}`, () => {
          expect(combined).toContain(needle);
        });
      }

      for (const needle of fx.promptMustNotContain ?? []) {
        test(`prompt does NOT contain: ${JSON.stringify(needle)}`, () => {
          expect(combined).not.toContain(needle);
        });
      }

      test('campaign prompt always carries the anti-fabrication + no-token guards', () => {
        // Invariants that hold for every campaign draft regardless of archetype.
        // v2's guardrails live in the SYSTEM block with different wording than v1's.
        if (fx.specVersion === 'v2') {
          expect(system).toContain('Never emit unresolved template variables');
          expect(system).toMatch(
            /does NOT invent committees, bills, votes, meetings, numbers, dates, or positions/,
          );
        } else {
          expect(prompt).toContain('Do not invent facts.');
          expect(prompt).toContain('Never return unresolved template variables');
        }
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
      'length',
      'revision',
    ];
    for (const a of expected) expect(covered.has(a)).toBe(true);
  });

  test('fixture ids are unique', () => {
    const ids = OUTREACH_EVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
