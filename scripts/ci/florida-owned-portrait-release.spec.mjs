import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = 'ed62dd1e67be152b6b760815f79bc475925659e7';
const importerPath = 'apps/api/scripts/ingest-florida-legislative-directories.ts';
const original = execFileSync('git', ['show', `${baseline}:${importerPath}`], { cwd: root, encoding: 'utf8' });
const current = readFileSync(join(root, importerPath), 'utf8');
const sha = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(sha(original), '672acd6cb361d8a7bbfa7bf58e46b4aa03b2f7f304cdb13b868ad457a6c8f6d3');
const manifestPath = 'apps/api/data/florida-legislative-directory/directory-enrichment.json';
const manifestBytes = readFileSync(join(root, manifestPath));
assert.equal(sha(manifestBytes), '755aabc31e31b426f9cffa224fc85c96e69bebfb175651ad84cd179c3558f73c');
const manifest = JSON.parse(manifestBytes);
const portraitRoot = join(root, 'apps/api/data/florida-legislative-directory/portraits');
const members = manifest.house.members.filter((member) => !member.vacant);
const portraits = new Map(members.map((member) => [member.portrait.filename, readFileSync(join(portraitRoot, member.portrait.filename))]));

const oldSelection = `  const candidates = [
    join(__dirname, '../../web/public/florida-directory/portraits'),
    join(__dirname, '../data/florida-legislative-directory/portraits'),
  ];
  let directory: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      directory = candidate;
      break;
    } catch {
      // Try the next release-layout candidate.
    }
  }
  if (!directory) throw new Error('Florida portrait assets are absent from this release image');`;
const newSelection = `  const directory = join(__dirname, '../data/florida-legislative-directory/portraits');
  try {
    await access(directory);
  } catch {
    throw new Error('Florida portrait assets are absent from this release image');
  }`;

function segment(source, start, end) {
  const index = source.indexOf(start);
  assert.ok(index >= 0);
  const stop = source.indexOf(end, index + start.length);
  assert.ok(stop > index);
  return source.slice(index, stop);
}

/** Erase only the known primitive annotations in isolated pure function data. */
function pureDefinitions(source) {
  const pieces = [
    segment(source, 'function normalized(', 'function surname('),
    segment(source, 'function sha256(', 'function strictIsoDate('),
    segment(source, 'function strictIsoDate(', 'export function officialKey('),
    segment(source, 'function jpegDimensions(', 'export function validateManifest('),
    segment(source, 'export function validateManifest(', 'async function validatePortraitAssets('),
    segment(source, 'async function validatePortraitAssets(', 'function sourceFor('),
  ];
  let code = pieces.join('\n').replaceAll('export ', '')
    .replace('normalized(value: string): string', 'normalized(value)')
    .replace('sha256(value: Uint8Array | string): string', 'sha256(value)')
    .replace('canonical(value: unknown): string', 'canonical(value)')
    .replaceAll('value as JsonRecord', 'value')
    .replace('strictIsoDate(value: string): boolean', 'strictIsoDate(value)')
    .replace('jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null', 'jpegDimensions(bytes)')
    .replace('validateManifest(manifest: FloridaDirectoryManifest, inventory: Inventory): void', 'validateManifest(manifest, inventory)')
    .replace('const failures: string[]', 'const failures')
    .replace('const expectedCounts: Record<string, number>', 'const expectedCounts')
    .replace('new Set<string>()', 'new Set()')
    .replace('validatePortraitAssets(manifest: FloridaDirectoryManifest): Promise<string>', 'validatePortraitAssets(manifest)')
    .replace('let directory: string | null', 'let directory')
    .replace('const assetProof: Array<{ filename: string; sha256: string; width: number; height: number }>', 'const assetProof')
    .replace('member.portrait!', 'member.portrait')
    .replace(/(bytes\[[^\]]+\])!/g, '$1');
  assert.doesNotMatch(code, /\b(?:import|dotenvConfig|PrismaClient|process|main)\b/);
  return code;
}

const imageScriptsDir = '/release/apps/api/scripts';
const ownedDir = '/release/apps/api/data/florida-legislative-directory/portraits';
const webDir = '/release/apps/web/public/florida-directory/portraits';
function isolated(source, options = {}) {
  const calls = [];
  const bytes = options.bytes ?? portraits;
  const touch = (kind, path) => {
    calls.push([kind, path]);
    if (options.denyWeb && path.startsWith('/release/apps/web/')) throw new Error('WEB_ACCESS_DENIED');
  };
  const context = vm.createContext({
    createHash, join, __dirname: imageScriptsDir,
    HOUSE_SHA256: 'd22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc',
    SENATE_SHA256: 'f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d',
    access: async (path) => {
      touch('access', path);
      if (path === ownedDir && options.owned !== false) return;
      if (path === webDir && options.web === true) return;
      throw new Error('ENOENT');
    },
    readFile: async (path) => {
      touch('readFile', path);
      assert.ok(path.startsWith(ownedDir + '/') || path.startsWith(webDir + '/'));
      const name = path.split('/').at(-1);
      if (!bytes.has(name)) throw new Error('ENOENT:' + name);
      return bytes.get(name);
    },
  });
  const functions = vm.runInContext(pureDefinitions(source) + '\n({validatePortraitAssets,validateManifest,jpegDimensions});', context);
  return { calls, ...functions };
}

const inventory = { rows: [...manifest.house.committees, ...manifest.senate.committees]
  .map(({ chamber, officialCode, name }) => ({ chamber, officialCode, name })) };
const missingImage = 'Florida portrait assets are absent from this release image';

test('only the obsolete Web directory selection changes; all importer/DB/provider/CLI and existing specs remain intact', () => {
  assert.equal(current.split(newSelection).length, 2);
  assert.equal(current.replace(newSelection, oldSelection), original);
  const spec = 'apps/api/scripts/ingest-florida-legislative-directories.spec.ts';
  assert.equal(readFileSync(join(root, spec), 'utf8'), execFileSync('git', ['show', `${baseline}:${spec}`], { cwd: root, encoding: 'utf8' }));
  assert.ok(!current.includes('../../web/public/'));
  const broken = current.replace('dimensions?.width !== portrait.width', 'false');
  assert.notEqual(broken.replace(newSelection, oldSelection), original);
});

test('all118 owned JPEG bytes, SHA256, dimensions and manifest/public URL contracts are established', () => {
  assert.equal(members.length, 118);
  assert.equal(manifest.counts.housePortraits, 118);
  assert.equal(portraits.size, 118);
  assert.deepEqual(readdirSync(portraitRoot).sort(), [...portraits.keys()].sort());
  assert.ok(!lstatSync(portraitRoot).isSymbolicLink());
  const functions = isolated(current);
  functions.validateManifest(manifest, inventory);
  for (const member of members) {
    const { portrait } = member;
    const bytes = portraits.get(portrait.filename);
    assert.ok(!lstatSync(join(portraitRoot, portrait.filename)).isSymbolicLink());
    assert.equal(bytes.length, portrait.byteLength);
    assert.equal(sha(bytes), portrait.sha256);
    const size = functions.jpegDimensions(bytes);
    assert.equal(size.width, portrait.width); assert.equal(size.height, portrait.height);
    assert.equal(portrait.publicUrl, '/florida-directory/portraits/' + portrait.filename);
    assert.equal(portrait.mediaType, 'image/jpeg');
  }
});

test('Docker build and runtime both copy API-owned data without requiring a Web source tree', () => {
  const docker = readFileSync(join(root, 'apps/api/Dockerfile'), 'utf8');
  assert.match(docker, /^COPY apps\/api\/data apps\/api\/data$/m);
  assert.match(docker, /^COPY --chown=capiro:capiro --from=build \/workspace\/apps\/api\/data \/app\/apps\/api\/data$/m);
  assert.match(docker, /^COPY --chown=capiro:capiro --from=build \/workspace\/apps\/api\/scripts \/app\/apps\/api\/scripts$/m);
  assert.doesNotMatch(docker, /COPY[^\n]*apps\/web/);
  for (const changed of [docker.replace('COPY apps/api/data apps/api/data', 'COPY apps/web/public apps/api/data'), docker.replace('/workspace/apps/api/data /app/apps/api/data', '/workspace/unknown /app/apps/api/data')]) {
    assert.ok(!/^COPY apps\/api\/data apps\/api\/data$/m.test(changed) || !/^COPY --chown=capiro:capiro --from=build \/workspace\/apps\/api\/data \/app\/apps\/api\/data$/m.test(changed));
  }
});

test('owned-present success preserves original118-image proof and removes only the first Web probe', async () => {
  const old = isolated(original, { denyWeb: true });
  const next = isolated(current, { denyWeb: true });
  const oldProof = await old.validatePortraitAssets(manifest);
  const newProof = await next.validatePortraitAssets(manifest);
  assert.equal(newProof, oldProof); assert.match(newProof, /^[a-f0-9]{64}$/);
  assert.deepEqual(old.calls[0], ['access', webDir]);
  assert.deepEqual(next.calls, old.calls.slice(1));
  assert.equal(next.calls.length, 119);
  assert.equal(next.calls[0][1], ownedDir);
});

test('owned absent while Web present refuses the exact missing-image error with zero Web attempts', async () => {
  const old = isolated(original, { owned: false, web: true });
  assert.match(await old.validatePortraitAssets(manifest), /^[a-f0-9]{64}$/);
  assert.ok(old.calls.some(([, path]) => path.startsWith(webDir)));
  const next = isolated(current, { owned: false, web: true, denyWeb: true });
  await assert.rejects(next.validatePortraitAssets(manifest), { message: missingImage });
  assert.deepEqual(next.calls, [['access', ownedDir]]);
});

test('both directories absent retain the original missing-image error but eliminate the Web probe', async () => {
  const old = isolated(original, { owned: false });
  const next = isolated(current, { owned: false, denyWeb: true });
  await assert.rejects(old.validatePortraitAssets(manifest), { message: missingImage });
  await assert.rejects(next.validatePortraitAssets(manifest), { message: missingImage });
  assert.deepEqual(next.calls, [['access', ownedDir]]);
});

test('corrupt/missing image and unchanged-byte incorrect width/height retain original refusal semantics', async () => {
  const name = members[0].portrait.filename;
  const corrupt = Buffer.from(portraits.get(name)); corrupt[100] ^= 1;
  for (const variant of ['corrupt', 'missing', 'width', 'height']) {
    const bytes = new Map(portraits);
    const data = structuredClone(manifest);
    if (variant === 'corrupt') bytes.set(name, corrupt);
    if (variant === 'missing') bytes.delete(name);
    if (variant === 'width' || variant === 'height') data.house.members.find((member) => member.portrait?.filename === name).portrait[variant] += 1;
    const expected = variant === 'missing' ? 'ENOENT:' + name : 'Portrait asset proof failed: ' + name;
    for (const source of [original, current]) {
      const functions = isolated(source, { bytes, denyWeb: true });
      await assert.rejects(functions.validatePortraitAssets(data), { message: expected });
      assert.equal(functions.calls.filter(([, path]) => path.startsWith(webDir)).length, source === original ? 1 : 0);
    }
  }
});

test('invalid JPEG with matching byte hash still refuses dimensions and never probes Web', async () => {
  const name = members[0].portrait.filename;
  const bytes = new Map(portraits); bytes.set(name, Buffer.from('not JPEG'));
  const data = structuredClone(manifest);
  data.house.members.find((member) => member.portrait?.filename === name).portrait.sha256 = sha(bytes.get(name));
  const functions = isolated(current, { bytes, denyWeb: true });
  await assert.rejects(functions.validatePortraitAssets(data), { message: 'Portrait asset proof failed: ' + name });
});

test('original manifest schema/source/vocabulary/public URL/minimum dimensions and filename uniqueness gates remain effective', () => {
  for (const mutate of [
    (data) => { data.schemaVersion = 2; },
    (data) => { data.sources.houseDirectory.sha256 = '0'.repeat(64); },
    (data) => { data.house.members.find((member) => !member.vacant).portrait.publicUrl = '/removed/a.jpg'; },
    (data) => { data.house.members.find((member) => !member.vacant).portrait.width = 1; },
    (data) => { const seated = data.house.members.filter((member) => !member.vacant); seated[1].portrait = { ...seated[0].portrait }; },
  ]) {
    const data = structuredClone(manifest); mutate(data);
    for (const source of [original, current]) assert.throws(() => isolated(source).validateManifest(data, inventory), /Florida directory manifest invalid:/);
  }
});
