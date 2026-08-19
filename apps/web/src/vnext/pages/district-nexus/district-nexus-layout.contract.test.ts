import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Layout contract for the District Nexus split (map + rail).
 *
 * Why this exists: jsdom performs no layout, so no component test can catch a
 * broken CSS height chain — and one shipped. The vNext shell scrolls the page
 * (nothing above this module has a definite height), so the original
 * `flex: 1` on `.dnx-split` resolved to CONTENT height; the rail's one-row-
 * per-district table inflated the row to ~1500px, MapLibre sized its canvas
 * to the whole card, and the CONUS fit centered in that tall canvas — live QA
 * (2026-08-18, os.capiro.ai) saw northern Canada in the first viewport and
 * "no polygons", because the choropleth and legend sat 700px below the card
 * fold. This test pins the declared-intent fix the way no-legacy-ui pins
 * imports: statically, on the stylesheet source.
 *
 * (A static assertion cannot prove the COMPUTED style wins — only live
 * getComputedStyle can, per the Engagement reskin lesson — but the defect
 * here was a missing declaration, which is exactly what this catches.)
 */

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'district-nexus-vnext.css');

function ruleBody(css: string, selector: string, from = 0): { body: string; end: number } {
  const start = css.indexOf(selector, from);
  expect(start, `selector ${selector} must exist`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return { body: css.slice(open + 1, close), end: close };
}

describe('District Nexus split layout contract', () => {
  // Strip comments first — the stylesheet's own prose explains the regression
  // in terms ("flex: 1", ".dnx-rail-scroll") that would otherwise satisfy or
  // trip the assertions below from inside a comment.
  const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the desktop split owns a definite viewport-derived height — never flex-grown content height', () => {
    const { body } = ruleBody(css, '.dnx-split');
    // A clamp() over 100vh: definite at every viewport, floored at the
    // canonical 520px minimum, capped so the rail keeps useful density.
    expect(body).toMatch(/height:\s*clamp\(\s*\d+px\s*,\s*calc\(100vh[^)]*\)\s*,\s*\d+px\s*\)/);
    // The exact regression that shipped: flex-basis growth against an
    // indefinite parent. `flex: none` (or no flex-grow at all) is required.
    expect(body).not.toMatch(/flex:\s*1/);
  });

  it('the single-column breakpoint releases the shared height and sizes each panel explicitly', () => {
    const media = css.indexOf('@media (max-width: 1180px)');
    expect(media).toBeGreaterThan(-1);
    const splitInMedia = ruleBody(css, '.dnx-split', media);
    expect(splitInMedia.body).toMatch(/height:\s*auto/);
    const mapcardInMedia = ruleBody(css, '.dnx-mapcard', media);
    expect(mapcardInMedia.body).toMatch(/height:\s*min\(/);
  });

  it('the rail scrolls internally — its scroll container must be able to shrink', () => {
    const { body } = ruleBody(css, '.dnx-rail-scroll');
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*auto/);
  });
});
