import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface MeriManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  prefer_related_applications: boolean;
  icons: ManifestIcon[];
}

const webRoot = process.cwd();
const manifestPath = resolve(webRoot, 'public/meri-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MeriManifest;

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('Meri installable-app contract', () => {
  test('launches the authenticated Meri route as a standalone app', () => {
    expect(manifest).toMatchObject({
      id: '/meri',
      name: 'Meri',
      short_name: 'Meri',
      start_url: '/meri',
      // Root scope keeps the Clerk sign-in route in the installed window.
      scope: '/',
      display: 'standalone',
      background_color: '#F2F4F7',
      theme_color: '#FFFFFF',
      prefer_related_applications: false,
    });
  });

  test.each([
    ['192x192', 192],
    ['512x512', 512],
  ] as const)('ships a real %s maskable PNG', (declaredSize, pixels) => {
    const icon = manifest.icons.find((candidate) => candidate.sizes === declaredSize);
    expect(icon).toBeDefined();
    expect(icon).toMatchObject({ type: 'image/png' });
    expect(icon?.purpose.split(/\s+/)).toContain('any');
    expect(icon?.purpose.split(/\s+/)).toContain('maskable');

    const iconPath = resolve(webRoot, 'public', icon!.src.replace(/^\//, ''));
    expect(existsSync(iconPath)).toBe(true);
    expect(pngDimensions(iconPath)).toEqual({ width: pixels, height: pixels });
  });

  test('keeps the shared legacy HTML free of an unconditional Meri manifest', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
    const main = readFileSync(resolve(webRoot, 'src/main.tsx'), 'utf8');

    expect(html).not.toContain('meri-manifest.json');
    expect(main).toContain('initializeMeriInstallExperience();');
    expect(main.indexOf('initializeMeriInstallExperience();')).toBeGreaterThan(
      main.indexOf('} else {'),
    );
  });

  test('forces installed launches edge-to-edge and removes redundant internal window controls', () => {
    const shell = readFileSync(resolve(webRoot, 'src/vnext/meri/VNextMeriShell.tsx'), 'utf8');
    const topBar = readFileSync(resolve(webRoot, 'src/vnext/meri/VNextMeriTopBar.tsx'), 'utf8');
    const button = readFileSync(resolve(webRoot, 'src/vnext/meri/MeriInstallButton.tsx'), 'utf8');

    expect(shell).toContain("install.isStandalone\n    ? 'maximized'");
    expect(shell).toContain('showWindowControls={!install.isStandalone}');
    expect(shell).toContain("install.isStandalone ? 'Meri' : 'Meri — Capiro'");
    expect(topBar).toContain('<MeriInstallButton />');
    expect(button).toContain('aria-label="Install Meri"');
  });
});
