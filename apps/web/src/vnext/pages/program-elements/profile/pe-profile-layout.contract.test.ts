/**
 * Layout contract for the PE profile's chart panes.
 *
 * Why this exists (Phase 3 lesson #1 / District Nexus map regression): the
 * vNext shell SCROLLS THE PAGE — nothing above this module has a definite
 * height — so any pane sized with `flex: 1` / `height: 100%` silently inflates
 * to content height. jsdom performs no layout, so declared intent in the
 * stylesheet is the only statically catchable form: this test pins that the
 * funding-by-FY bar chart and the fiscal-year sparkline own explicit bounded
 * heights and are never flex-grown.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pe-profile.css');

function ruleBody(css: string, selector: string, from = 0): { body: string; end: number } {
  const start = css.indexOf(selector, from);
  expect(start, `selector ${selector} must exist`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return { body: css.slice(open + 1, close), end: close };
}

describe('PE profile chart-pane layout contract', () => {
  // Strip comments first so prose explaining the regression cannot satisfy or
  // trip the assertions below from inside a comment.
  const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the funding-by-FY bar chart owns an explicit bounded height and is never flex-grown', () => {
    const { body } = ruleBody(css, '.pe-pf-bars ');
    expect(body).toMatch(/height:\s*(\d+px|clamp\()/);
    expect(body).not.toMatch(/height:\s*100%/);
    expect(body).not.toMatch(/flex:\s*1/);
    // Belt-and-braces: it must opt out of flex growth inside any flex parent.
    expect(body).toMatch(/flex:\s*none/);
  });

  it('the fiscal-year sparkline owns an explicit bounded height and is never flex-grown', () => {
    const { body } = ruleBody(css, '.pe-pf-fyspark ');
    expect(body).toMatch(/height:\s*(\d+px|clamp\()/);
    expect(body).not.toMatch(/height:\s*100%/);
    expect(body).not.toMatch(/flex:\s*1/);
    expect(body).toMatch(/flex:\s*none/);
  });

  it('the token layer is the only color source — no raw hex or rgb() literals', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\s*\(/i);
  });

  it('wide ledgers scroll inside their own band, never the page body', () => {
    const { body } = ruleBody(css, '.pe-pf-scroll-x');
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/overscroll-behavior-x:\s*contain/);
  });
});
