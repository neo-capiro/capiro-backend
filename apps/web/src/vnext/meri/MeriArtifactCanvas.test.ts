import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriArtifactCanvas — in-rail doc canvas, real fields only', () => {
  test('takes the real CanvasArtifact shape', () => {
    const source = readMeri('MeriArtifactCanvas.tsx');
    expect(source).toContain("import type { CanvasArtifact } from '../../components/chat/MeriCanvas.js'");
    expect(source).toContain('artifact: CanvasArtifact');
  });

  test('drops the prototype fields with no real backing: figures grid, next steps, citation count, type switcher, open-as-page', () => {
    const source = readMeri('MeriArtifactCanvas.tsx');
    expect(source).not.toContain('artFigures');
    expect(source).not.toContain('NEXT STEPS');
    expect(source).not.toContain('CITATIONS');
    expect(source).not.toContain('artTypes');
    expect(source).not.toContain('Open as page');
    expect(source).not.toContain('artIsSheet');
    expect(source).not.toContain('artIsDeck');
  });

  test('downloads office docs from the real artifact download endpoint, falls back to a markdown blob otherwise', () => {
    const source = readMeri('MeriArtifactCanvas.tsx');
    expect(source).toContain('/api/clio/artifacts/${artifact.id}/download');
    expect(source).toContain("type: 'text/markdown;charset=utf-8'");
  });

  test('is reachable as the rail\'s ARTIFACT panel, replacing the legacy fixed-overlay MeriCanvas in vNext', () => {
    const rail = readMeri('VNextMeriContextRail.tsx');
    expect(rail).toContain('activeArtifact');
    expect(rail).toContain('<MeriArtifactCanvas');

    const conversation = readMeri('VNextMeriConversation.tsx');
    expect(conversation).not.toContain('MeriCanvas');

    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain('activeArtifact={controller.activeArtifact}');
    expect(shell).toContain('onCloseArtifact={() => controller.setActiveArtifact(null)}');
  });

  test('expands the rail automatically when a document starts streaming in', () => {
    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toMatch(/if \(controller\.activeArtifact\) setRailCollapsed\(false\);/);
  });
});
