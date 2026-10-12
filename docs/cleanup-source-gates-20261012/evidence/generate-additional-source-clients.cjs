// Official pinned Prisma WASM/DMMF + client generator protocol. No engine download,
// database, migration or client instantiation; writes only ignored local clients.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const internalsRoot = '/tmp/capiro-prisma-objective-tools/node_modules/@prisma/internals';
const internals = require(internalsRoot);
if (require(path.join(internalsRoot, 'package.json')).version !== '5.22.0') throw Error('Expected pinned Prisma 5.22.0');
const root = process.cwd();
const targets = [
  ['Intel', 'apps/intel-api/prisma/schema.prisma', 'apps/intel-api/generated/prisma-client'],
  ['Onboard', 'apps/onboard-api/prisma/schema.prisma', 'apps/onboard-api/generated/prisma-client'],
  ['Defense', 'apps/defense-api/prisma/schema.prisma', 'apps/defense-api/generated/prisma-client'],
];
(async () => {
  for (const [service, schemaRel, outputRel] of targets) {
    const schemaPath = path.join(root, schemaRel);
    const datamodel = fs.readFileSync(schemaPath, 'utf8');
    const dmmf = await internals.getDMMF({ datamodel });
    const config = await internals.getConfig({ datamodel, ignoreEnvVarErrors: true });
    const generator = { ...config.generators[0], output: { value: path.join(root, outputRel), fromEnvVar: null },
      isCustomOutput: service !== 'Core', binaryTargets: [] };
    const datasources = config.datasources.map(source => {
      const clean = { ...source };
      for (const key of ['url', 'directUrl', 'shadowDatabaseUrl']) {
        if (clean[key]?.fromEnvVar) clean[key] = { ...clean[key], value: null };
      }
      return clean;
    });
    const options = { datamodel, schemaPath, dmmf, generator, datasources, otherGenerators: [],
      // The official generator requires the engine-kind map even with noEngine.
      // Empty maps provide no native paths and no engine is copied or executed.
      binaryPaths: { libqueryEngine: {}, queryEngine: {} }, envPaths: {}, version: '605197351a3c8bdd595af2d2a9bc3025bca48ea2',
      noEngine: true, postinstall: false, typedSql: [] };
    const clientRoot = path.dirname(require.resolve('@prisma/client/package.json', { paths: [path.join(root, 'apps/api')] }));
    if (require(path.join(clientRoot, 'package.json')).version !== '5.22.0') throw Error('Client version differs');
    const result = cp.spawnSync(process.execPath, [path.join(clientRoot, 'generator-build/index.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'generate', params: options }) + '\n',
      encoding: 'utf8', env: { ...process.env, PRISMA_GENERATE_NO_ENGINE: 'true' },
    });
    const lines = (result.stdout + result.stderr).split('\n').filter(Boolean);
    const rpc = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.id === 1);
    if (result.status !== 0 || !rpc || rpc.error) throw Error(JSON.stringify({ service, status: result.status, responses: lines }));
    const generatedSchema = fs.readFileSync(path.join(root, outputRel, 'schema.prisma'), 'utf8');
    if (generatedSchema !== datamodel) throw Error(`${service}: generated schema differs from selected source`);
    console.log(JSON.stringify({ service, schema: schemaRel, schemaSha256: crypto.createHash('sha256').update(datamodel).digest('hex'),
      models: dmmf.datamodel.models.length, output: outputRel, version: '5.22.0', noEngine: true,
      nativeDatabaseAcceptance: false }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
