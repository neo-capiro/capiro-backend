#!/usr/bin/env node
/**
 * Serve the real web entry with the offline route-capture Vite config for the
 * Playwright runner. Not a test artifact — the Playwright `webServer` starts it
 * and waits on http://127.0.0.1:4190/.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', '..', 'web');
const viteBin = path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(
  process.execPath,
  [viteBin, '--config', 'src/vnext/testing/visual/vite.routes-visual.config.ts', '--host', '127.0.0.1', '--port', '4190', '--strictPort'],
  {
    cwd: WEB,
    env: {
      ...process.env,
      VITE_WEB_SURFACE: 'vnext',
      VITE_BUILD_WEB_SURFACE: 'vnext',
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_visual_fixture',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
const shutdown = () => { try { child.kill(); } catch { /* best effort */ } };
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
