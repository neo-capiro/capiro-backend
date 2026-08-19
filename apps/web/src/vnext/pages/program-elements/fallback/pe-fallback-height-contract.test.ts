/**
 * Height contract (Phase 3 lesson #1): the vNext shell SCROLLS THE PAGE —
 * unlike the legacy shell's fixed-height chain — so any pane sized with
 * `flex: 1` / `height: 100%` against the viewport silently inflates to content
 * height. jsdom does no layout, so declared intent is the only catchable form:
 * this suite pins the explicit bounded heights on the module's chart panes and
 * keeps the stylesheet on the token layer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = resolve(process.cwd(), 'src/vnext/pages/program-elements/fallback');

function read(name: string): string {
  return readFileSync(resolve(HERE, name), 'utf8');
}

describe('PE fallback height contract', () => {
  it('the recharts funding timeline declares an explicit bounded height', () => {
    const chart = read('PeFyHistoryChartVNext.tsx');
    // The ResponsiveContainer's 100% chain must terminate at a fixed wrapper
    // (420px) so it never reaches the scrolling page (DN-map failure mode).
    expect(chart).toContain('height: 420');
    expect(chart).toContain('ResponsiveContainer width="100%" height="100%"');
  });

  it('the overview line chart pane is bounded, not flex-grown', () => {
    const css = read('pe-fallback.css');
    expect(css).toMatch(/\.pe-fb-overview-chart\s*\{[^}]*min-height:\s*250px/);
    // The overview chart itself carries a fixed height prop at the call site.
    const overview = read('PeProfileOverviewVNext.tsx');
    expect(overview).toContain('height={220}');
  });

  it('the relationship graph pane is bounded via its explicit h prop', () => {
    const panels = read('pe-fallback-budget-line-panels.tsx');
    expect(panels).toContain('h={400}');
  });

  it('the module stylesheet never sizes against the viewport', () => {
    const css = read('pe-fallback.css');
    expect(css).not.toMatch(/height:\s*100vh/);
    expect(css).not.toMatch(/min-height:\s*100vh/);
  });

  it('the module stylesheet is token-only (no raw hex / rgba colors)', () => {
    const css = read('pe-fallback.css');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\s*\(/i);
  });
});
