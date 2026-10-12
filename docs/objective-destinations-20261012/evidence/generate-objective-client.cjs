const fs = require('node:fs');
const path = require('node:path');
const { getConfig, getDMMF, Generator } = require('/tmp/capiro-prisma-objective-tools/node_modules/@prisma/internals');

(async () => {
  const root = path.resolve(__dirname, '../../..');
  const schemaPath = path.join(root, 'apps/api/prisma/schema.prisma');
  const datamodel = fs.readFileSync(schemaPath, 'utf8');
  const config = await getConfig({ datamodel, ignoreEnvVarErrors: true });
  const dmmf = await getDMMF({ datamodel, previewFeatures: config.generators[0].previewFeatures });
  const localClient = path.join(root, 'apps/api/node_modules/@prisma/client');
  if (fs.realpathSync(localClient) !== localClient) throw Error('Refusing a shared Prisma generation target');
  const generatorConfig = config.generators[0];
  generatorConfig.output = { value: path.join(root, 'apps/api/node_modules/.prisma/client'), fromEnvVar: null };
  generatorConfig.isCustomOutput = false;
  const generator = new Generator(path.join(localClient, 'generator-build/index.js'), generatorConfig, true);
  try {
    await generator.init();
    generator.setOptions({ datamodel, datasources: config.datasources, generator: generatorConfig,
      dmmf, otherGenerators: [], schemaPath, version: '605197351a3c8bdd595af2d2a9bc3025bca48ea2',
      noEngine: true, binaryPaths: { libqueryEngine: {} }, envPaths: { rootEnvPath: null, schemaEnvPath: undefined } });
    await generator.generate();
    if (!fs.existsSync(path.join(generatorConfig.output.value, 'index.d.ts'))) throw Error('Generated client missing');
    console.log('PASS: official pinned Prisma 5.22 WASM validation/DMMF and noEngine client generation, worktree-local output only.');
  } finally { generator.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
