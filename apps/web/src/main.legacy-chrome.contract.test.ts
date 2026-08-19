import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Final invariant of the os.capiro.ai old-UI purge (Phases 1–3): the vNext
 * surface mounts NO legacy chrome. One bundle serves two surfaces, so the
 * legacy theme and antd context must be gated on `isVNextSurface`, never
 * loaded unconditionally. `no-legacy-ui.contract.test.ts` proves nothing
 * under vnext/** reaches antd/legacy CSS; this test proves the app ROOT
 * doesn't hand them to the vNext tree from above.
 *
 * jsdom does no bundling or layout, so the catchable form is the declared
 * source contract (same approach as the module height-contract tests).
 */
const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

describe('main.tsx legacy chrome is legacy-surface-only', () => {
  it('never imports theme.css statically', () => {
    expect(mainSource).not.toMatch(/^import\s+['"]\.\/theme\.css['"]/m);
  });

  it('loads theme.css only behind !isVNextSurface', () => {
    expect(mainSource).toMatch(
      /if\s*\(!isVNextSurface\)\s*\{\s*void\s+import\(['"]\.\/theme\.css['"]\)/,
    );
  });

  it('returns the provider core without antd chrome on the vNext surface', () => {
    const foundation = mainSource.slice(mainSource.indexOf('function FoundationProviders'));
    const vnextReturn = foundation.indexOf('if (isVNextSurface) return core;');
    const antdMount = foundation.indexOf('<ConfigProvider');
    expect(vnextReturn).toBeGreaterThan(-1);
    expect(antdMount).toBeGreaterThan(-1);
    expect(vnextReturn).toBeLessThan(antdMount);
  });
});
