import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DescendantRoute } from './support/ws03-descendant-harness.js';

const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: {
    repoRoot: string; coreSchemaPath: string; workspaceSchemaPath: string; extraModels: string;
  }): Promise<{ url: string; schema: string; cleanup(): Promise<void> }>;
};
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;
// Registered even when skipped; a missing disposable PG16 is never a native pass.
const originalNames = ['comment list', 'comment create', 'comment update', 'comment delete',
  'comment suggestion', 'checks', 'lock status', 'lock acquire', 'lock heartbeat',
  'lock release', 'lock request', 'lock take-over', 'anonymization'];
const adjacentNames = ['document list', 'quality fix', 'version list', 'version create', 'version restore'];
const allNames = [...originalNames, ...adjacentNames];
type NativeModule = typeof import('./support/ws03-postgres-harness.js');
type Harness = Awaited<ReturnType<NativeModule['createNativeWorkspaceHarness']>>;

function httpJson(origin: string, route: DescendantRoute, token: string) {
  return new Promise<{ status: number; body: unknown }>((resolveResponse, reject) => {
    const payload = route.body ? JSON.stringify(route.body) : undefined;
    const req = request(`${origin}/workspace-api/${route.path}`, {
      method: route.method.toUpperCase(),
      headers: { authorization: `Bearer ${token}`, 'x-user-id': 'user_owner',
        'x-tenant-id': 'forged-tenant', ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => {
        try { resolveResponse({ status: response.statusCode ?? 0, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Local native HTTP timeout')));
    req.end(payload);
  });
}

native(`WS-03 PostgreSQL16 descendant authority${readiness.available ? '' : ` [SKIP: ${readiness.reason}]`}`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let h: Harness | undefined;
  let runtime: NativeModule;
  let origin: string;
  const route = (name: string) => {
    const found = [...runtime.DESCENDANT_ROUTES, ...runtime.ADJACENT_ROUTES].find(item => item.name === name);
    if (!found) throw new Error(`Missing production-fixture route ${name}`);
    return found;
  };
  beforeAll(async () => {
    database = await helper.createDisposableSchema({
      repoRoot, coreSchemaPath: join(repoRoot, 'apps/api/prisma/schema.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8'),
    });
    // No controller, generated client or database connection loads on a skip.
    runtime = require('./support/ws03-postgres-harness.js') as NativeModule;
    expect(runtime.DESCENDANT_ROUTES.map(item => item.name)).toEqual(originalNames);
    expect(runtime.ADJACENT_ROUTES.map(item => item.name)).toEqual(adjacentNames);
    h = await runtime.createNativeWorkspaceHarness(database.url);
    origin = await h.app.getUrl();
  }, 240_000);
  afterAll(async () => {
    try { await h?.close(); } finally { await database?.cleanup(); }
  }, 60_000);

  test.each(allNames)('unrelated active same-tenant member: %s refuses without native writes', async name => {
    await h!.reset({ actorId: 'user_unrelated' });
    const result = await httpJson(origin, route(name), runtime.NATIVE_TOKEN);
    // The required 13-route matrix and document/quality admissions are opaque404.
    // Existing version ACL intentionally remains403; do not change policy here.
    expect(result.status).toBe(name.startsWith('version') ? 403 : 404);
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE_DESCENDANT_CONTENT');
    expect(h!.reads).toEqual([]);
    expect(h!.effects).toEqual([]);
    expect(await h!.snapshot()).toEqual(h!.original());
  }, 30_000);

  test.each(allNames)('active ordinary owner: %s retains its positive path', async name => {
    await h!.reset();
    const result = await httpJson(origin, route(name), runtime.NATIVE_TOKEN);
    expect(result.status).toBe(route(name).status);
    expect(h!.reads.length + h!.effects.length).toBeGreaterThan(0);
  }, 30_000);

  test('frozen frontend generic and typed gateways reach native authority', async () => {
    const checkout = process.env.WS03_FRONTEND_CHECKOUT;
    if (!checkout || !isAbsolute(checkout)) throw new Error('Set WS03_FRONTEND_CHECKOUT to the explicit frontend #117 checkout');
    // Freeze the reviewed companion tree and the exercised code, while allowing
    // its package cache/generated artifacts to be installed by the gate runner.
    expect(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim())
      .toBe('f27b5f7ede8ee5fc02cc025152da70d6ff68b455');
    execFileSync('git', ['-C', checkout, 'diff', '--exit-code', 'HEAD', '--',
      'apps/web/tests/workspace-descendant-gateway.test.ts',
      'apps/web/src/shared/portfolio/api/proxy.ts', 'apps/web/src/shared/capiro/gateway.ts',
      'apps/web/src/shared/capiro/operations/workspace-comments.ts']);
    const web = join(checkout, 'apps/web');
    const requireFrontend = createRequire(join(web, 'package.json'));
    const vitest = join(dirname(requireFrontend.resolve('vitest/package.json')), 'vitest.mjs');
    const temporary = await mkdtemp(join(tmpdir(), 'ws03-native-gateway-'));
    const reportPath = join(temporary, 'vitest.json');
    const control = fixtureControl(h!, runtime);
    let child: ChildProcess | undefined;
    try {
      const controlUrl = await listen(control);
      // Use the existing frozen file unchanged. Exactly seven applicable cases;
      // its other50 are explicitly filtered, not claimed as native passes.
      const pattern = "^actual gateway to local Workspace HTTP admission ('?same-tenant unrelated member'? receives|preserves authorized '?owner'? access|preserves authorized typed)"
        + "|^classified WS-03 corrections through the actual gateway ('?same-tenant unrelated member'? has|preserves owner role predicates)";
      const childEnv = { ...process.env };
      delete childEnv.A1_NATIVE_PG_URL;
      delete childEnv.DATABASE_URL;
      child = spawn(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts',
        'tests/workspace-descendant-gateway.test.ts', '--maxWorkers', '1', '--testNamePattern', pattern,
        '--reporter=json', '--outputFile', reportPath], {
        cwd: web, env: { ...childEnv, WS03_WORKSPACE_TEST_URL: `${origin}/workspace-api`,
          WS03_WORKSPACE_CONTROL_URL: controlUrl }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = await childExit(child);
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
        success: boolean; numFailedTests: number; numPassedTests: number; numPendingTests: number;
      };
      expect(report.success).toBe(true);
      expect(report.numFailedTests).toBe(0);
      expect(report.numPassedTests).toBe(7);
      expect(report.numPendingTests).toBe(50);
      console.log(JSON.stringify({ nativeGateway: true, passed: report.numPassedTests,
        filtered: report.numPendingTests, output: output.trim() }));
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      control.closeAllConnections();
      if (control.listening) await new Promise<void>((done, reject) => control.close(error => error ? reject(error) : done()));
      await rm(temporary, { recursive: true, force: true });
    }
  }, 150_000);
});

function fixtureControl(h: Harness, runtime: NativeModule): Server {
  return createServer(async (req, response) => {
    try {
      let payload: unknown;
      if (req.method === 'GET' && req.url === '/manifest') {
        payload = { ids: runtime.WS03_IDS, routes: runtime.DESCENDANT_ROUTES, adjacentRoutes: runtime.ADJACENT_ROUTES };
      } else if (req.method === 'POST' && req.url === '/reset') {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 2048) throw new Error('Oversize local fixture reset');
        }
        await h.reset(JSON.parse(body) as Record<string, unknown>);
        payload = { reset: true };
      } else if (req.method === 'GET' && req.url === '/observations') {
        if (h.state.actorId === 'user_unrelated') expect(await h.snapshot()).toEqual(h.original());
        payload = { reads: h.reads, effects: h.effects };
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch { response.writeHead(500).end(); }
  });
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture failed to bind');
  return `http://127.0.0.1:${address.port}`;
}
async function childExit(child: ChildProcess) {
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Native gateway child exited ${code ?? signal}\n${output}`)));
    });
    return output;
  } finally { clearTimeout(timer); }
}
