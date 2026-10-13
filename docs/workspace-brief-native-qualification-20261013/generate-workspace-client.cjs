'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = '/tmp/workspace-brief-native-client-20261013';
const client = '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client';
const generatorPath = path.join(client, 'generator-build/index.js');
const internals = '/tmp/capiro-prisma-objective-tools/node_modules/@prisma/internals';
const { validate, getConfig, getDMMF, Generator } = require(internals);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.deepEqual(Object.keys(process.env).sort(), ['PATH', 'XDG_CACHE_HOME']);
assert.equal(process.env.XDG_CACHE_HOME, '/tmp/workspace-brief-native-generator-cache-20261013');
assert.equal(require(client + '/package.json').version, '5.22.0');
assert.equal(require(internals + '/package.json').version, '5.22.0');
assert.equal(sha(fs.readFileSync(generatorPath)), '1697ccccd6b9ef9bfe00277ab8347d656080854d12680568940546e1ef4602ee');
const binaries = {
  'debian-openssl-3.0.x': '/workspace/capirov2/node_modules/.pnpm/@prisma+engines@5.22.0/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node',
  'linux-arm64-openssl-3.0.x': '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node',
};
assert.equal(sha(fs.readFileSync(binaries['debian-openssl-3.0.x'])), '35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8');
const engineVersion = '605197351a3c8bdd595af2d2a9bc3025bca48ea2';
for (const filename of Object.values(binaries)) assert(fs.readFileSync(filename).includes(Buffer.from(engineVersion)));
(async () => {
  const schemaPath = path.join(root, 'apps/workspace/prisma/schema.prisma');
  const original = fs.readFileSync(schemaPath, 'utf8');
  assert(original.includes('sourceBriefVersion'));
  validate({ schemas: [[schemaPath, original]] });
  const config = await getConfig({ datamodel: original, ignoreEnvVarErrors: true });
  assert(config.datasources.every(ds => !ds.url?.value));
  const gc = config.generators[0];
  assert.deepEqual(gc.binaryTargets.map(t => t.value), ['debian-openssl-3.0.x', 'linux-arm64-openssl-3.0.x']);
  const dmmf = await getDMMF({ datamodel: original, previewFeatures: gc.previewFeatures });
  assert.equal(dmmf.datamodel.models.length, 37);
  assert(dmmf.datamodel.models.find(m => m.name === 'WsDocument').fields.some(f => f.name === 'sourceBriefVersion'));
  assert(!fs.existsSync(output), 'Refuse existing generator output');
  const ownership = { sourceHead: '76f50b2667d06a121b2dd772abc9d64adb556c36', output, schemaSha256: sha(original), mustNotPreexist: true };
  fs.writeFileSync(path.join(__dirname, 'evidence/generation-intent.json'), JSON.stringify(ownership, null, 2) + '\n', { flag: 'wx' });
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, '.workspace-brief-native-owned.json'), JSON.stringify(ownership) + '\n', { flag: 'wx' });
  gc.output = { value: output, fromEnvVar: null };
  gc.isCustomOutput = true;
  const generator = new Generator(generatorPath, gc, true);
  try {
    await generator.init();
    generator.setOptions({ datamodel: original, datasources: config.datasources, generator: gc, dmmf, otherGenerators: [], schemaPath, version: engineVersion, noEngine: false, binaryPaths: { libqueryEngine: binaries }, envPaths: { rootEnvPath: null, schemaEnvPath: undefined } });
    await generator.generate();
  } finally { generator.stop(); }
  assert.equal(fs.readFileSync(path.join(output, 'schema.prisma'), 'utf8'), original);
  const rows = Object.entries(binaries).map(([target, filename]) => {
    const emitted = path.join(output, path.basename(filename));
    assert.equal(sha(fs.readFileSync(emitted)), sha(fs.readFileSync(filename)));
    return { target, source: filename, sha256: sha(fs.readFileSync(emitted)), bytes: fs.statSync(emitted).size };
  });
  const receipt = { sourceHead: '76f50b2667d06a121b2dd772abc9d64adb556c36', sourceTree: 'd6e615533e4c36970779962b1391af90e5576314', schemaPath: 'apps/workspace/prisma/schema.prisma', schemaSha256: sha(original), modelCount: 37, sourceBriefVersionFieldGenerated: true, output, generatorSha256: sha(fs.readFileSync(generatorPath)), engineVersion, binaries: rows, nativeLibraryExecutedDuringGeneration: false, databaseConnectedDuringGeneration: false, installDownloadOrChecksumDisabling: false };
  fs.writeFileSync(path.join(__dirname, 'evidence/generated-workspace-client.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log('PASS exact current Workspace schema: offline native-bearing client generated with sourceBriefVersion');
})().catch(error => { console.error(error); process.exitCode = 1; });
