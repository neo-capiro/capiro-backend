import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');
const read = (name: string) => readFileSync(resolve(meriDir, name), 'utf8');

describe('Meri v6 visual contract', () => {
  test('pins the prototype window and three-column geometry', () => {
    const css = read('vnext-meri.css');
    expect(css).toContain('padding: 22px;');
    expect(css).toContain('background: #E7ECF1;');
    expect(css).toContain('max-width: 1480px;');
    expect(css).toContain('height: calc(100dvh - 44px);');
    expect(css).toContain('--meri-topbar-height: 60px;');
    expect(css).toContain('--meri-rail-left-width: 282px;');
    expect(css).toContain('--meri-rail-right-width: 382px;');
    expect(css).toContain('--meri-rail-right-collapsed: 46px;');
    expect(css).toContain('--meri-conversation-max: 720px;');
  });

  test('keeps the v6 cool neutral palette and Inter typography local to Meri', () => {
    const sources = [
      read('vnext-meri.css'),
      read('meri-agent-steps.css'),
      read('meri-analysis-chart-card.css'),
      ...[
        'MeriAnalysisChartCard.tsx',
        'MeriArtifactCanvas.tsx',
        'MeriAttachmentChip.tsx',
        'MeriCoverageWarning.tsx',
        'MeriMemoryTab.tsx',
        'MeriMessageFeedback.tsx',
        'MeriSourceDetail.tsx',
        'MeriStartWork.tsx',
        'VNextMeriMessage.tsx',
      ].map(read),
    ].join('\n');
    expect(sources).not.toMatch(/IBM Plex Mono|#FFFDFA|#FAF9F6|#F2F0EB|#E8E5DF|#E0DCD4/i);
    expect(read('vnext-meri.css')).toContain("--m-font-sans: Inter, -apple-system, 'Segoe UI'");
    expect(read('vnext-meri.css')).toContain("--m-font-mono: Inter, -apple-system, 'Segoe UI'");
  });

  test('prevents shared foundation focus and portal styles from leaking into Meri', () => {
    const css = read('vnext-meri.css');
    expect(css).toContain('outline: 2px solid #4E5BA6;');
    expect(css).toContain('box-shadow: none;');
    expect(css).toContain('.vnext-meri__palette-scrim, .vnext-meri__confirm-scrim');
    expect(css).toContain("font-family: Inter, -apple-system, 'Segoe UI'");
  });

  test('renders the prototype tab and collapsed-panel treatments', () => {
    const rail = read('VNextMeriContextRail.tsx');
    const start = read('MeriStartWork.tsx');
    expect(rail).toContain('{tab.label.toUpperCase()}');
    expect(rail).toContain('vnext-meri__rail-collapsed-label');
    expect(rail).toContain('BEHIND THE ANSWER');
    expect(start).toContain('role="tablist"');
    expect(start).toContain('role="tabpanel"');
    expect(start).toContain("height: 32");
  });
});
