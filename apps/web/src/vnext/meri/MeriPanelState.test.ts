import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriPanelState', () => {
  test('reduced motion turns off the loading spinner via a CSS class, not inline animation', () => {
    const source = readMeri('MeriPanelState.tsx');
    expect(source).not.toMatch(/animation:\s*['"]vnext-meri-spin/);
    expect(source).toContain('is-spinning');
    const css = readMeri('vnext-meri.css');
    expect(css).toContain('.vnext-meri__panel-state-icon.is-spinning');
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*panel-state-icon\.is-spinning/);
  });

  test('replaces bare-text rail states in the context rail — every real loading/error/empty flag gets the icon treatment', () => {
    const source = readMeri('VNextMeriContextRail.tsx');
    // Pin the actual state boundaries, not a count of component usages: other
    // sections now own their states inside their extracted components.
    expect(source).toMatch(/packetLoading\s*\?\s*<MeriPanelState tone="loading">/);
    expect(source).toMatch(/packetError\s*\?\s*<MeriPanelState tone="error">/);
    expect(source).toMatch(/!packetLoading && !packetError\s*\?\s*<MeriPanelState tone="empty">/);
    // Empty-state content comes from the actual compiled packet, preserving
    // unknown/empty context rather than claiming portfolio-wide coverage.
    expect(source).toContain(
      '<MeriPanelState tone="empty">{contextPacketSummary(packet)}</MeriPanelState>',
    );
  });
});
