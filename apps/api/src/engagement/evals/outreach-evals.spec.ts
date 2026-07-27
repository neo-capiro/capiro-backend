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
  SPOTLIGHT_CLOSE,
  SPOTLIGHT_OPEN,
  type OutreachPromptV2Input,
} from '../outreach-prompt/prompt-spec-v2.js';
import {
  buildGatewayPrompt,
  GATEWAY_PROMPT_SPEC_VERSION,
} from '../generation/gateway-prompt.js';
import { GATEWAY_EVAL_FIXTURES } from './gateway-fixtures.js';
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

/**
 * Phase 1 §5.4 — the GATEWAY prompt.
 *
 * These run against buildGatewayPrompt, which renders an Evidence Packet rather
 * than a flattened context string. The spotlight assertions are the substantive
 * ones: they check WHERE text lands, not merely that it appears — which is the
 * only way to express "this content is data, not an instruction".
 */
describe('gateway prompt eval suite (Phase 1 §5.4)', () => {
  /** Every region of `text` that sits INSIDE a spotlight block. */
  function spotlightedRegions(text: string): string[] {
    const out: string[] = [];
    const re = new RegExp(
      `${SPOTLIGHT_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*?${SPOTLIGHT_CLOSE.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )}`,
      'g',
    );
    for (const m of text.matchAll(re)) out.push(m[0]);
    return out;
  }

  for (const fx of GATEWAY_EVAL_FIXTURES) {
    describe(`${fx.id}`, () => {
      const prompt = buildGatewayPrompt(fx.input);
      const combined = `${prompt.system}\n${prompt.user}`;
      const spotlighted = spotlightedRegions(prompt.user).join('\n');

      test('assembles a non-empty prompt at the gateway spec version', () => {
        expect(prompt.user.length).toBeGreaterThan(200);
        expect(prompt.specVersion).toBe(GATEWAY_PROMPT_SPEC_VERSION);
      });

      for (const needle of fx.promptMustContain) {
        test(`contains: ${JSON.stringify(needle)}`, () => {
          expect(combined).toContain(needle);
        });
      }

      for (const needle of fx.promptMustNotContain ?? []) {
        test(`does NOT contain: ${JSON.stringify(needle)}`, () => {
          expect(combined).not.toContain(needle);
        });
      }

      for (const needle of fx.mustBeSpotlighted ?? []) {
        test(`is INSIDE spotlight markers: ${JSON.stringify(needle.slice(0, 40))}…`, () => {
          // Present at all…
          expect(prompt.user).toContain(needle);
          // …and every occurrence sits inside a marker block.
          expect(spotlighted).toContain(needle);
          const outside = prompt.user.split(needle).length - 1;
          const inside = spotlighted.split(needle).length - 1;
          expect(inside).toBe(outside);
        });
      }

      for (const needle of fx.mustBeOutsideSpotlight ?? []) {
        test(`is OUTSIDE spotlight markers: ${JSON.stringify(needle.slice(0, 40))}…`, () => {
          expect(prompt.user).toContain(needle);
          expect(spotlighted).not.toContain(needle);
        });
      }

      test('the untrusted-content rule is always present', () => {
        expect(prompt.system).toContain('UNTRUSTED CONTENT RULE');
        expect(prompt.system).toContain('Never emit unresolved template variables');
      });

      test('the resolved audience policy is named, and no other jurisdiction is', () => {
        expect(prompt.userStatic).toContain(fx.input.policy.label);
      });
    });
  }

  test('every defined audience has at least one fixture', () => {
    const covered = new Set(GATEWAY_EVAL_FIXTURES.map((f) => f.audience));
    for (const a of [
      'congressional_office',
      'federal_agency',
      'state_legislator',
      'client_executive',
      'internal_colleague',
      'defense_acquisition_office',
    ]) {
      expect(covered.has(a as (typeof GATEWAY_EVAL_FIXTURES)[number]['audience'])).toBe(true);
    }
  });

  test('gateway fixture ids are unique', () => {
    const ids = GATEWAY_EVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('NO gateway prompt carries the retired flattened context channel', () => {
    // A single sweep across every fixture: the `Instruction:` line and the
    // "Shared context (every recipient):" header were the pre-Phase-1 flattening,
    // and their absence everywhere is what proves the cutover is complete.
    for (const fx of GATEWAY_EVAL_FIXTURES) {
      const prompt = buildGatewayPrompt(fx.input);
      expect(prompt.user).not.toContain('Shared context (every recipient):');
      expect(prompt.user).not.toContain('\n  Instruction: ');
    }
  });
});
