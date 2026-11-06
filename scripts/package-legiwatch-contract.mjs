import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/package-legiwatch-contract.mjs --out DIRECTORY\nBuild @capiro/shared first. Packages only its canonical LegiWatch contract; never replaces other frontend shared contracts.');
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--out' || !args[1]) {
  console.error('Expected --out DIRECTORY; use --help.');
  process.exit(2);
}
const outputDirectory = resolve(args[1]);
const sourcePath = 'packages/shared/src/legiwatch-impact.ts';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(join(root, sourcePath));
const declaration = await readFile(join(root, 'packages/shared/dist/legiwatch-impact.d.ts'));
const implementation = await readFile(join(root, 'packages/shared/dist/legiwatch-impact.js'));
const packageRoot = await mkdtemp(join(tmpdir(), 'capiro-legiwatch-contract-'));
try {
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(join(packageRoot, 'dist'));
  const metadata = {
    name: '@capiro/legiwatch-contracts', version: '0.1.0', private: true,
    description: 'Generated public LegiWatch contracts from Capiro Core shared source.',
    license: 'UNLICENSED', main: './dist/index.js', types: './dist/index.d.ts',
    files: ['dist', 'SOURCE.json'],
    exports: { '.': { types: './dist/index.d.ts', require: './dist/index.js', import: './dist/index.js', default: './dist/index.js' } },
  };
  const provenance = {
    repository: 'neo-capiro/capiro-backend', sourcePath,
    sourceBlobSha: execFileSync('git', ['hash-object', sourcePath], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: hash(source), declarationSha256: hash(declaration), implementationSha256: hash(implementation),
  };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(packageRoot, 'SOURCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(join(packageRoot, 'dist/index.d.ts'), declaration);
  await writeFile(join(packageRoot, 'dist/index.js'), implementation);
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: packageRoot, encoding: 'utf8' }));
  const bytes = await readFile(join(packageRoot, packed.filename));
  const artifactSha256 = hash(bytes);
  const filename = `capiro-legiwatch-contracts-0.1.0-${artifactSha256.slice(0, 12)}.tgz`;
  await copyFile(join(packageRoot, packed.filename), join(outputDirectory, filename));
  console.log(JSON.stringify({ ...provenance, name: metadata.name, version: metadata.version, filename, artifactSha256, integrity: packed.integrity }, null, 2));
} finally {
  await rm(packageRoot, { recursive: true, force: true });
}
