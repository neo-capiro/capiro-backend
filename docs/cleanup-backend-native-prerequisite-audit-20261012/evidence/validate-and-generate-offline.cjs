'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = '/tmp/capirov2-local-native-prerequisite-20261012';
const source = path.resolve(__dirname, '../../..');
assert.deepEqual(Object.keys(process.env).sort(), ['PATH', 'XDG_CACHE_HOME']);
assert.equal(process.env.XDG_CACHE_HOME, path.join(root, 'cache'));
const internals = '/tmp/capiro-prisma-objective-tools/node_modules/@prisma/internals';
const client = '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client';
assert.equal(require(internals + '/package.json').version, '5.22.0');
assert.equal(require(client + '/package.json').version, '5.22.0');
const { validate, getConfig, getDMMF, Generator } = require(internals);
const generatorPath = path.join(client, 'generator-build/index.js');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(fs.readFileSync(generatorPath)), '1697ccccd6b9ef9bfe00277ab8347d656080854d12680568940546e1ef4602ee');
const binaries = {
  'debian-openssl-3.0.x': '/workspace/capirov2/node_modules/.pnpm/@prisma+engines@5.22.0/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node',
  'linux-arm64-openssl-3.0.x': '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node',
};
const engineVersion = '605197351a3c8bdd595af2d2a9bc3025bca48ea2';
for (const filename of Object.values(binaries)) assert(fs.readFileSync(filename).includes(Buffer.from(engineVersion)), 'cached library lacks expected embedded engine commit');
const scopes = [
  ['core', 'apps/api/prisma/schema.prisma', '215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb', 464],
  ['workspace', 'apps/workspace/prisma/schema.prisma', 'e67b41d7e5105937c201cab382e222817009dd8ec4843d045af2c754d756fa02', 37],
];
const results = [];
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
(async () => {
  for (const [scope, relative, expected, models] of scopes) {
    const original = fs.readFileSync(path.join(source, relative), 'utf8');
    assert.equal(sha(original), expected);
    const schemaPath = path.join(root, scope + '-schema.prisma');
    fs.writeFileSync(schemaPath, original);
    validate({ schemas: [[schemaPath, original]] });
    assert.throws(() => validate({ schemas: [[schemaPath, original + '\nmodel DeliberatelyInvalid {\n}\n']] }), /validation|model|field/i);
    const config = await getConfig({ datamodel: original, ignoreEnvVarErrors: true });
    for (const ds of config.datasources) assert(!ds.url?.value, 'refusing any environment-resolved datasource URL');
    const gc = config.generators[0];
    // Official getConfig resolves the original native target for this host.
    assert.deepEqual(gc.binaryTargets.map(t => t.value), ['debian-openssl-3.0.x', 'linux-arm64-openssl-3.0.x']);
    const dmmf = await getDMMF({ datamodel: original, previewFeatures: gc.previewFeatures });
    assert.equal(dmmf.datamodel.models.length, models);
    const output = path.join(root, scope + '-client');
    assert(!fs.existsSync(output), 'refusing existing generator output');
    fs.mkdirSync(output);
    gc.output = { value: output, fromEnvVar: null };
    gc.isCustomOutput = true;
    const generator = new Generator(generatorPath, gc, true);
    try {
      await generator.init();
      generator.setOptions({ datamodel: original, datasources: config.datasources, generator: gc, dmmf, otherGenerators: [], schemaPath, version: engineVersion, noEngine: false, binaryPaths: { libqueryEngine: binaries }, envPaths: { rootEnvPath: null, schemaEnvPath: undefined } });
      await generator.generate();
    } finally { generator.stop(); }
    assert.equal(fs.readFileSync(path.join(output, 'schema.prisma'), 'utf8'), original);
    for (const [target, filename] of Object.entries(binaries)) assert.equal(sha(fs.readFileSync(path.join(output, path.basename(filename)))), sha(fs.readFileSync(filename)), target + ' copied binary differs');
    const emitted = files(output).map(p => ({ path: p, bytes: fs.statSync(p).size, sha256: sha(fs.readFileSync(p)) }));
    results.push({ scope, sourcePath: relative, schemaSha256: expected, modelCount: models, schemaValidation: 'official5.22WASM', negativeSchemaRejected: true, binaryTargets: gc.binaryTargets, nativeLibraryExecution: false, output, emitted });
    console.log('PASS ' + scope + ': exact schema validation, invalid control rejected, isolated two-target native-bearing client generation/copy');
  }
  fs.writeFileSync(path.join(__dirname, 'offline-generation-receipt.json'), JSON.stringify({ source: '61e9b467295235829e7d8097368ce41b0434818a', sourceTree: '6b49311aae5c26e31101c31a07ae2fc7865af3df', engineVersion, generatorPath, generatorSha256: sha(fs.readFileSync(generatorPath)), binaries: Object.entries(binaries).map(([target, filename]) => ({ target, filename, sha256: sha(fs.readFileSync(filename)) })), parentEnvironment: ['PATH', 'XDG_CACHE_HOME'], childAdditionalEnvironment: ['PRISMA_GENERATOR_INVOCATION'], downloaderFactoryInvoked: false, prismaCLIInvoked: false, clientInstantiated: false, databaseConnected: false, queryEngineLoaded: false, results, qualification: 'Offline exact-schema WASM validation and local native-library copy generation only; native schema-engine --version separately qualified. ARM64 library copied/identified but not executed. No native PostgreSQL, RLS, SQL, migrations, runtime client query or full production build acceptance.' }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
