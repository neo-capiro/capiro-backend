import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Layout contract for the module's viewport-sized panes (Phase 3 briefing
 * lesson 1, district-nexus-layout.contract.test.ts precedent).
 *
 * The vNext shell SCROLLS THE PAGE — nothing above these panes has a definite
 * height — so any `flex: 1` / `height: 100%` chain silently inflates to
 * content height (the DN map shipped as a 1511px canvas exactly this way).
 * jsdom performs no layout, so declared intent is the only catchable form:
 * these assertions pin the stylesheet source.
 *
 * Two panes in this module size against the viewport:
 *   - .intel-graph-canvas   — the Cytoscape scene (canonical used a fixed
 *                             620px; the port keeps a clamp() over 100vh)
 *   - .intel-coming-preview — the Intelligence Center mockup iframe
 *                             (canonical used 82vh with a 700px floor)
 */

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'intelligence-vnext.css');

function ruleBody(css: string, selector: string, from = 0): { body: string; end: number } {
  const start = css.indexOf(selector, from);
  expect(start, `selector ${selector} must exist`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return { body: css.slice(open + 1, close), end: close };
}

describe('Intelligence deep-link layout contract', () => {
  // Strip comments first — the stylesheet's prose explains the regression in
  // terms ("flex: 1", "100vh") that would otherwise satisfy or trip the
  // assertions from inside a comment.
  const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the knowledge-graph canvas owns a definite viewport-derived height — never flex-grown content height', () => {
    const { body } = ruleBody(css, '.intel-graph-canvas');
    expect(body).toMatch(/height:\s*clamp\(\s*\d+px\s*,\s*calc\(100vh[^)]*\)\s*,\s*\d+px\s*\)/);
    expect(body).not.toMatch(/flex:\s*1/);
    expect(body).not.toMatch(/height:\s*100%/);
  });

  it('the coming-soon preview iframe is viewport-bounded with the canonical 700px floor', () => {
    const { body } = ruleBody(css, '.intel-coming-preview');
    expect(body).toMatch(/height:\s*max\(\s*82vh\s*,\s*700px\s*\)/);
    expect(body).not.toMatch(/flex:\s*1/);
  });
});
