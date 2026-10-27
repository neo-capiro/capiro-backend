import { describe, expect, test } from '@jest/globals';
import { SPOTLIGHT_CLOSE, SPOTLIGHT_OPEN } from '../outreach-prompt/prompt-spec-v2.js';
import { buildGatewayPrompt, GATEWAY_PROMPT_SPEC_VERSION } from '../generation/gateway-prompt.js';
import { GATEWAY_EVAL_FIXTURES } from './gateway-fixtures.js';

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
    });
  }

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
