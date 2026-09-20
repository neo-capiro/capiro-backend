import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('web build-surface boundaries', () => {
  it('declares an explicit vNext artifact target for the vNext image and workflows', () => {
    const dockerfile = read('apps/web/Dockerfile');
    const deploy = read('.github/workflows/web-vnext-deploy.yml');
    const foundation = read('.github/workflows/web-vnext-foundation.yml');

    expect(dockerfile).toContain('CAPIRO_WEB_BUILD_SURFACE');
    expect(dockerfile).toContain('VITE_BUILD_WEB_SURFACE=${CAPIRO_WEB_BUILD_SURFACE}');
    expect(deploy).toContain('CAPIRO_WEB_BUILD_SURFACE: vnext');
    expect(foundation).toContain('CAPIRO_WEB_BUILD_SURFACE: vnext');
  });

  it('keeps the canonical image explicit instead of inheriting the vNext Docker default', () => {
    const webImage = read('.github/workflows/web-image.yml');
    expect(webImage).toContain('CAPIRO_WEB_BUILD_SURFACE=canonical');
  });

  it('guards the canonical District Nexus route at compile time', () => {
    const app = read('apps/web/src/App.tsx');
    expect(app).toContain("import.meta.env.VITE_BUILD_WEB_SURFACE !== 'vnext'");
    expect(app).toContain("import('./pages/intelligence/district-nexus/DistrictNexusPage.js')");
  });

  it('fails vNext builds when forbidden legacy District Nexus UI reaches output', () => {
    const vite = read('apps/web/vite.config.ts');
    expect(vite).toContain('districtNexusBuildSurfaceGuard');
    expect(vite).toContain('DistrictNexusPage.tsx');
    expect(vite).toContain('DistrictFederalMarketPanel.tsx');
    expect(vite).toContain('Shared District Nexus modules missing from vNext output');
  });

  it('watches every source/config file that can change vNext artifact membership', () => {
    const deploy = read('.github/workflows/web-vnext-deploy.yml');
    for (const path of [
      "'apps/web/src/App.tsx'",
      "'apps/web/vite.config.ts'",
      "'apps/web/src/pages/intelligence/district-nexus/**'",
    ]) {
      expect(deploy).toContain(path);
    }
  });
});
