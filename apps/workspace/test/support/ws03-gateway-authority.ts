/** Explicit cross-repository qualification only; intentionally outside *.spec.ts.
 * Set WS03_FRONTEND_CHECKOUT to the frontend checkout, then use the unchanged
 * workspace Jest config with --testMatch explicitly selecting this file.
 * No database, Clerk session, external provider, or production service is used.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  createDescendantApp, createDescendantHarness, DESCENDANT_ROUTES, ADJACENT_ROUTES, WS03_IDS,
} from './ws03-descendant-harness.js';

type Harness = ReturnType<typeof createDescendantHarness>;
function fixtureControl(h: Harness): Server {
  return createServer(async (request, response) => {
    try {
      let payload: unknown;
      if (request.method === 'GET' && request.url === '/manifest') {
        payload = { ids: WS03_IDS, routes: DESCENDANT_ROUTES, adjacentRoutes: ADJACENT_ROUTES };
      } else if (request.method === 'GET' && request.url === '/observations') {
        payload = { reads: h.reads, effects: h.effects };
      } else if (request.method === 'POST' && request.url === '/reset') {
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 8192) throw new Error('Fixture request is too large');
        }
        h.reset(JSON.parse(body));
        payload = { reset: true };
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch {
      response.writeHead(400).end();
    }
  });
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}
async function childExit(child: ChildProcess): Promise<string> {
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Frontend gateway test exited ${code ?? signal}\n${output}`));
      });
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}

test('actual frontend gateways preserve Workspace descendant authority over local HTTP', async () => {
  const checkout = process.env.WS03_FRONTEND_CHECKOUT;
  if (!checkout || !isAbsolute(checkout))
    throw new Error('Set WS03_FRONTEND_CHECKOUT to an explicit absolute frontend checkout');
  const web = join(checkout, 'apps/web');
  const requireFrontend = createRequire(join(web, 'package.json'));
  const vitest = join(dirname(requireFrontend.resolve('vitest/package.json')), 'vitest.mjs');
  const reportPath = process.env.WS03_GATEWAY_REPORT ?? join(await mkdtemp(join(tmpdir(), 'ws03-gateway-')), 'vitest.json');
  const h = createDescendantHarness();
  const app = await createDescendantApp(h);
  const control = fixtureControl(h);
  let child: ChildProcess | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const controlUrl = await listen(control);
    child = spawn(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts',
      'tests/workspace-descendant-gateway.test.ts', '--maxWorkers', '1',
      '--reporter=json', '--outputFile', reportPath], {
      cwd: web,
      env: { ...process.env, WS03_WORKSPACE_TEST_URL: `${await app.getUrl()}/workspace-api`, WS03_WORKSPACE_CONTROL_URL: controlUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await childExit(child);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.success).toBe(true);
    expect(report.numFailedTests).toBe(0);
    expect(report.numPendingTests).toBe(0);
    expect(report.numTotalTests).toBeGreaterThan(16);
    console.log(JSON.stringify({ integrationEnabled: true, reportPath, tests: report.numTotalTests,
      failed: report.numFailedTests, skipped: report.numPendingTests, output: output.trim() }));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    control.closeAllConnections();
    if (control.listening) await new Promise<void>((resolve, reject) => control.close(error => error ? reject(error) : resolve()));
    await app.close();
  }
}, 120_000);
