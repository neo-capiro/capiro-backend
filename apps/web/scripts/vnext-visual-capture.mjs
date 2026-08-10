#!/usr/bin/env node
/**
 * vNext foundation screenshot capture using the repo's existing Lighthouse +
 * chrome-launcher stack. It targets only the dev-only component workshop and
 * empty shell fixtures; product screens are intentionally excluded.
 *
 * Start Vite first, then run:
 *   VNEXT_VISUAL_BASE_URL=http://127.0.0.1:4173 pnpm --filter @capiro/web visual:vnext:capture
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const baseUrl = (process.env.VNEXT_VISUAL_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(process.env.VNEXT_VISUAL_OUTPUT_DIR ?? 'artifacts/vnext-visual');

const targets = [
  { name: 'component-gallery-desktop', path: '/vnext-workshop.html', width: 1440, height: 1200 },
  { name: 'shell-desktop-expanded', path: '/vnext-shell.html', width: 1600, height: 1000 },
  { name: 'shell-desktop-collapsed', path: '/vnext-shell.html?collapsed=1', width: 1600, height: 1000 },
  { name: 'shell-tablet', path: '/vnext-shell.html', width: 900, height: 1000 },
  { name: 'shell-mobile', path: '/vnext-shell.html', width: 390, height: 844 },
];

await mkdir(outputDir, { recursive: true });
const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });
const manifest = { generatedAt: new Date().toISOString(), baseUrl, captures: [] };

try {
  for (const target of targets) {
    const url = `${baseUrl}${target.path}`;
    const result = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: ['performance'],
      formFactor: 'desktop',
      screenEmulation: {
        mobile: false,
        disabled: false,
        width: target.width,
        height: target.height,
        deviceScaleFactor: 1,
      },
    });
    if (!result?.lhr) throw new Error(`Lighthouse returned no result for ${target.name}`);

    const fullPage = result.lhr.audits['full-page-screenshot']?.details;
    const final = result.lhr.audits['final-screenshot']?.details;
    const dataUri =
      fullPage && typeof fullPage === 'object' && 'screenshot' in fullPage
        ? fullPage.screenshot?.data
        : final && typeof final === 'object' && 'data' in final
          ? final.data
          : undefined;
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) {
      throw new Error(`No Lighthouse screenshot data was available for ${target.name}`);
    }

    const encoded = dataUri.slice(dataUri.indexOf(',') + 1);
    const bytes = Buffer.from(encoded, 'base64');
    const filename = `${target.name}.png`;
    await writeFile(path.join(outputDir, filename), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    manifest.captures.push({
      name: target.name,
      file: filename,
      path: target.path,
      viewport: { width: target.width, height: target.height },
      sha256,
    });
    console.log(`${target.name}: ${bytes.length} bytes sha256:${sha256}`);
  }
} finally {
  await chrome.kill();
}

await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote vNext visual captures to ${outputDir}`);
