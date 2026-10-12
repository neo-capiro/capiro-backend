import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const script = resolve(process.cwd(), 'scripts/sync-federal-register.ts');
const compiled = ts.transpileModule(readFileSync(script, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function run(entry: boolean, configured: boolean) {
  let constructors = 0, fetches = 0;
  const exits: number[] = [];
  const entryModule = { exports: {} };
  const modules: Record<string, unknown> = {
    dotenv: { config() {} },
    '@prisma/client': { PrismaClient: class { constructor() { constructors++; throw new Error('Synthetic constructor prevents all DB access'); } } },
    '../src/ingestion/sync-run.helper.js': { runWithSyncRun() { throw new Error('Forbidden owner execution'); } },
    '../src/federal-register/effective-date-evidence.js': { FR_API: 'https://example.invalid/documents', dateOnly: () => null, canonicalDocumentNumber: () => null },
    '../src/federal-register/federal-register-observation.js': { persistFederalRegisterObservation() { throw new Error('Forbidden mutation'); } },
  };
  const requireMock = Object.assign((name: string) => {
    if (!(name in modules)) throw new Error('Forbidden unmocked import');
    return modules[name];
  }, { main: entry ? entryModule : {} });
  runInNewContext(compiled, { exports: entryModule.exports, module: entryModule, require: requireMock,
    process: { argv: ['node', script], env: configured ? { DATABASE_URL: 'synthetic-no-connection' } : {},
      exit(code: number) { exits.push(code); if (code === 2) throw new Error('Synthetic terminal exit'); } },
    console: { log() {}, warn() {}, error() {} }, URL, Date, Set, Error, Promise,
    fetch() { fetches++; throw new Error('Forbidden provider'); }, setTimeout() {} }, { timeout: 1000 });
  await new Promise<void>(done => setImmediate(done));
  return { constructors, fetches, exits };
}

describe('composed Federal Register importer lifecycle', () => {
  it.each([false, true])('import with configured=%s never constructs a client or calls a provider', async configured => {
    expect(await run(false, configured)).toEqual({ constructors: 0, fetches: 0, exits: [] });
  });
  it('unconfigured CLI reaches its terminal configuration guard before constructing a client', async () => {
    const result = await run(true, false);
    expect(result.exits[0]).toBe(2); expect(result.constructors).toBe(0); expect(result.fetches).toBe(0);
  });
  it('configured CLI reaches the existing owner while the synthetic constructor forbids database access', async () => {
    const result = await run(true, true);
    expect(result.constructors).toBe(1); expect(result.exits).toEqual([1]); expect(result.fetches).toBe(0);
  });
});
