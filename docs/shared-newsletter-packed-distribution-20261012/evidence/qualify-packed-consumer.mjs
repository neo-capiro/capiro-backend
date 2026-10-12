import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evidence = path.dirname(fileURLToPath(import.meta.url));
const packet = path.dirname(evidence);
const repository = path.resolve(packet, '../..');
const stage = '/tmp/capiro-shared-newsletter-dist-fe50-20261012';
const consumer = path.join(stage, process.env.PACKED_CONSUMER_DIRECTORY ?? 'consumer');
const pack = path.join(packet, 'artifact/capiro-shared-0.0.0.tgz');
const tsPath = '/workspace/capirov2/node_modules/typescript/lib/typescript.js';
const tsc = '/workspace/capirov2/node_modules/typescript/bin/tsc';
const npm = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/lib/node_modules/npm/bin/npm-cli.js';
const esbuildPath = '/workspace/capirov2/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/lib/main.js';
const require = createRequire(import.meta.url);
const ts = require(tsPath);
const esbuild = require(esbuildPath);
const { characterize } = require(path.join(evidence, 'renderer-characterizations.cjs'));
const sha256 = contents => crypto.createHash('sha256').update(contents).digest('hex');
const checks = [];
const check = (name, action) => { action(); checks.push({ name, pass: true }); };
const run = (name, command, options = {}) => {
  const result = spawnSync(command[0], command.slice(1), { cwd: consumer, encoding: 'utf8', ...options });
  fs.writeFileSync(path.join(evidence, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  fs.writeFileSync(path.join(evidence, `${name}.command.json`), JSON.stringify({ command,
    cwd: options.cwd ?? consumer, exitCode: result.status, signal: result.signal,
    spawnError: result.error ? String(result.error) : null }, null, 2) + '\n');
  return result;
};
assert(!fs.existsSync(consumer), 'qualification starts with an empty, uninstalled consumer');
fs.mkdirSync(path.join(consumer, 'node_modules/@capiro/shared'), { recursive: true });
const extraction = run('packed-extraction', ['python3', '-c', `import pathlib,tarfile
p=pathlib.Path(${JSON.stringify(pack)})
root=pathlib.Path(${JSON.stringify(path.join(consumer, 'node_modules/@capiro/shared'))})
with tarfile.open(p,'r:gz') as t:
 for m in t.getmembers():
  q=pathlib.PurePosixPath(m.name)
  assert m.isfile() and q.parts[0]=='package' and '..' not in q.parts and not q.is_absolute()
  out=root.joinpath(*q.parts[1:]); out.parent.mkdir(parents=True,exist_ok=True)
  assert not out.exists()
  out.write_bytes(t.extractfile(m).read())
print('All regular package entries extracted without symlink, path traversal, install or lifecycle.')`]);
assert.equal(extraction.status, 0);
const installed = path.join(consumer, 'node_modules/@capiro/shared');
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'packed-newsletter-consumer',
  version: '0.0.0', private: true, type: 'module' }, null, 2));
const consumerRequire = createRequire(path.join(consumer, 'consumer.cjs'));
const n = consumerRequire('@capiro/shared/newsletter');
const r = consumerRequire('@capiro/shared/newsletter-render');
const packedManifest = JSON.parse(fs.readFileSync(path.join(packet, 'PACKED-MANIFEST.json')));
check('extracted package entries match every packed SHA256', () => {
  for (const item of packedManifest.packedEntries)
    assert.equal(sha256(fs.readFileSync(path.join(installed, item.path.replace(/^package\//, '')))), item.sha256, item.path);
});
check('existing package metadata and both public exports are unchanged', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  assert.equal(pkg.name, '@capiro/shared'); assert.equal(pkg.version, '0.0.0'); assert.equal(pkg.private, true);
  for (const sub of ['newsletter', 'newsletter-render']) {
    assert.equal(consumerRequire.resolve(`@capiro/shared/${sub}`), path.join(installed, `dist/${sub}.js`));
    assert.equal(pkg.exports[`./${sub}`].types, `./dist/${sub}.d.ts`);
  }
  assert.deepEqual(pkg, JSON.parse(fs.readFileSync(path.join(stage, 'packages/shared/package.json'))));
});
check('actual packed CommonJS public imports render and expose legacy stage defaults', () => {
  assert.equal(n.NEWSLETTER_TEMPLATE_ID, 'bp_weekly_newsletter');
  assert.equal(n.defaultNewsletterConfig().schedule.mode, 'now');
  assert.equal(r.newsletterSafeUrl('javascript:bad'), '');
  const design = { version: 1, styles: n.defaultNewsletterStyles(), sections: [] };
  assert.match(r.renderNewsletterDesign(design, n.defaultNewsletterConfig()), /<!doctype html>/);
});
check('private dist and source subpaths remain unavailable via package exports', () => {
  for (const sub of ['dist/newsletter.js', 'src/newsletter.ts', 'newsletter-fonts'])
    assert.throws(() => consumerRequire.resolve(`@capiro/shared/${sub}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
const esmSource = `import assert from 'node:assert/strict';
import { defaultNewsletterConfig, NEWSLETTER_TEMPLATE_ID } from '@capiro/shared/newsletter';
import { newsletterSafeUrl, renderNewsletterDesign } from '@capiro/shared/newsletter-render';
assert.equal(NEWSLETTER_TEMPLATE_ID,'bp_weekly_newsletter');
assert.equal(defaultNewsletterConfig().schedule.mode,'now');
assert.equal(newsletterSafeUrl('javascript:bad'),'');
assert.equal(typeof renderNewsletterDesign,'function');
console.log('Actual Node ESM named imports resolved both packed public subpaths.');\n`;
fs.writeFileSync(path.join(consumer, 'consumer.mjs'), esmSource);
check('actual packed ESM named public imports', () => assert.equal(run('packed-esm-imports', ['node', 'consumer.mjs']).status, 0));
for (const name of ['consumer-positive.ts', 'consumer-negative.ts'])
  fs.copyFileSync(path.join(evidence, name), path.join(consumer, name));
const tsCommon = { target: 'ES2022', strict: true, noUncheckedIndexedAccess: true, noEmit: true,
  skipLibCheck: false, types: [], lib: ['ES2022', 'DOM'] };
for (const [kind, module, moduleResolution] of [['node', 'NodeNext', 'NodeNext'], ['browser', 'ESNext', 'Bundler']]) {
  fs.writeFileSync(path.join(consumer, `tsconfig-${kind}.json`), JSON.stringify({ compilerOptions: { ...tsCommon, module, moduleResolution }, files: ['consumer-positive.ts'] }, null, 2));
  const positive = run(`packed-types-${kind}-positive`, ['node', tsc, '-p', `tsconfig-${kind}.json`]);
  check(`actual packed declarations strict ${kind} consumer`, () => assert.equal(positive.status, 0));
  fs.writeFileSync(path.join(consumer, `tsconfig-${kind}-negative.json`), JSON.stringify({ compilerOptions: { ...tsCommon, module, moduleResolution }, files: ['consumer-negative.ts'] }, null, 2));
  const negative = run(`packed-types-${kind}-negative`, ['node', tsc, '-p', `tsconfig-${kind}-negative.json`]);
  check(`actual packed declarations refuse invented ${kind} DTO/platform/kind`, () => {
    assert.equal(negative.status, 2);
    assert.equal((negative.stdout.match(/error TS/g) ?? []).length, 3);
    assert.match(negative.stdout, /invented-kind/); assert.match(negative.stdout, /invented-platform/);
    assert.match(negative.stdout, /number.*not assignable to type 'string'/);
  });
}
const closure = ['newsletter', 'newsletter-render', 'newsletter-fonts', 'newsletter-fonts.catalog', 'newsletter-social-share'];
const sourceBindings = [];
const originalCodes = new Map();
for (const name of closure) {
  const sourcePath = `packages/shared/src/${name}.ts`;
  const original = spawnSync('git', ['show', `1e99f0921b207318c6d2abf03927b5c4daa5768b:${sourcePath}`], { cwd: repository });
  assert.equal(original.status, 0);
  const current = fs.readFileSync(path.join(stage, sourcePath));
  const w = spawnSync('git', ['show', `193703e34f2bedbb69d87d6a8ee303f65ab8dbda:${sourcePath}`], { cwd: repository });
  assert.equal(w.status, 0); assert.deepEqual(original.stdout, current); assert.deepEqual(w.stdout, current);
  const compiled = ts.transpileModule(original.stdout.toString(), { fileName: `${name}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  originalCodes.set(name, compiled);
  sourceBindings.push({ sourcePath, originalCHead: '1e99f0921b207318c6d2abf03927b5c4daa5768b',
    originalWHead: '193703e34f2bedbb69d87d6a8ee303f65ab8dbda', currentHead: packedManifest.sourceHead,
    sourceSha256: sha256(current), originalTranspiledSha256: sha256(compiled),
    packedJsSha256: sha256(fs.readFileSync(path.join(installed, `dist/${name}.js`))),
    packedDeclarationsSha256: sha256(fs.readFileSync(path.join(installed, `dist/${name}.d.ts`))) });
}
const sandbox = () => {
  const milliseconds = Date.parse('2026-10-12T12:00:00.000Z');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [milliseconds])); } static now() { return milliseconds; } }
  const context = vm.createContext({ URL, structuredClone, Date: FixedDate });
  vm.runInContext('Math.random=()=>0.125', context);
  return context;
};
const loadClosedModules = (codes, context) => {
  const cache = new Map();
  const load = name => {
    assert(closure.includes(name), `Noncanonical dependency refused: ${name}`);
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} }; cache.set(name, module);
    const wrapper = vm.runInContext(`(function(exports,require,module){${codes.get(name)}\n})`, context, { filename: `${name}.js` });
    wrapper(module.exports, specifier => { assert.match(specifier, /^\.\/[a-z.-]+\.js$/); return load(specifier.slice(2, -3)); }, module);
    return module.exports;
  };
  return { news: load('newsletter'), render: load('newsletter-render'), loaded: [...cache.keys()].sort() };
};
const originalApi = loadClosedModules(originalCodes, sandbox());
const originalResults = characterize(originalApi.news, originalApi.render);
fs.writeFileSync(path.join(evidence, 'original-C-renderer-golden.json'), JSON.stringify(originalResults, null, 2) + '\n');
const packedCodes = new Map(closure.map(name => [name, fs.readFileSync(path.join(installed, `dist/${name}.js`), 'utf8')]));
const packedApi = loadClosedModules(packedCodes, sandbox());
const packedResults = characterize(packedApi.news, packedApi.render);
fs.writeFileSync(path.join(evidence, 'packed-renderer-results.json'), JSON.stringify(packedResults, null, 2) + '\n');
check('entire fixed renderer corpus matches original C source before packed candidate', () => assert.equal(JSON.stringify(packedResults), JSON.stringify(originalResults)));
check('original C, original W and packed runtime close over exactly five modules', () => {
  assert.deepEqual(originalApi.loaded, [...closure].sort()); assert.deepEqual(packedApi.loaded, [...closure].sort());
});
const get = name => originalResults.find(item => item.name === name)?.value;
check('meaningful legacy renderer and social refusal expectations', () => {
  assert.equal(get('safe link/javascript:alert(1)'), '');
  assert.equal(get('safe link/https://u:p@example.test/'), '');
  assert.equal(get('social target/https://example.test/engagement/newsletter-public/token'), '');
  assert.equal(get('social target/https://example.test/engagement/%6eewsletter-public/token'), '');
  assert.equal(get('social url/forward/https://example.test/public?a=1'), '');
  assert.equal(get('visibility without recipient denies'), '');
  assert.match(get('editor shows conditional block'), /opacity:.65/);
  assert.match(get('merge tags live preserve unknown tags'), /Ada <&> Lovelace ada@example.test 2026 \*\|UNKNOWN\|\*/);
  assert.match(get('saved survey no callback disabled'), /aria-disabled="true"/);
  assert.match(get('saved survey authorized caller callback'), /href="https:\/\/example.test\/survey"/);
  assert.match(get('image sizing crop asset and rewrite callback'), /width:42%/);
  assert.match(get('image sizing crop asset and rewrite callback'), /https:\/\/app.example.test\/newsletter\/capitol.png/);
  assert.match(get('explicit sanitizer remains caller policy'), /style="color:#ffffff;text-decoration:underline"/);
  assert.match(get('full rich document rendering'), /fonts.googleapis.com/);
});
fs.copyFileSync(path.join(evidence, 'renderer-characterizations.cjs'), path.join(consumer, 'renderer-characterizations.cjs'));
fs.writeFileSync(path.join(consumer, 'browser-entry.mjs'), `import * as news from '@capiro/shared/newsletter';\nimport * as render from '@capiro/shared/newsletter-render';\nimport corpus from './renderer-characterizations.cjs';\nexport const results=corpus.characterize(news,render);\n`);
const browser = await esbuild.build({ absWorkingDir: consumer, entryPoints: ['browser-entry.mjs'],
  outfile: 'browser-bundle.js', bundle: true, platform: 'browser', format: 'iife', globalName: 'PackedNewsletter',
  target: ['es2022'], write: false, metafile: true, sourcemap: 'external' });
fs.writeFileSync(path.join(evidence, 'browser-metafile.json'), JSON.stringify(browser.metafile, null, 2)+'\n');
for (const file of browser.outputFiles) fs.writeFileSync(path.join(evidence, path.basename(file.path)), file.contents);
const browserInputs = Object.keys(browser.metafile.inputs).sort();
check('actual browser bundle uses only both public exports, five packed modules and own corpus', () => {
  assert.deepEqual(browserInputs, ['browser-entry.mjs', 'renderer-characterizations.cjs',
    ...closure.map(name => `node_modules/@capiro/shared/dist/${name}.js`)].sort());
  for (const item of Object.values(browser.metafile.inputs)) for (const edge of item.imports) assert.notEqual(edge.external, true);
  for (const output of Object.values(browser.metafile.outputs)) assert.deepEqual(output.imports, []);
});
const browserContext = sandbox();
vm.runInContext(browser.outputFiles.find(file => file.path.endsWith('.js')).text, browserContext, { timeout: 10000 });
const browserResults = vm.runInContext('JSON.stringify(PackedNewsletter.results)', browserContext);
fs.writeFileSync(path.join(evidence, 'browser-renderer-results.json'), JSON.stringify(JSON.parse(browserResults), null, 2)+'\n');
check('actual browser bundle renderer corpus is byte-equal to original C and packed results', () => assert.equal(browserResults, JSON.stringify(originalResults)));
check('browser qualification supplied no Node require/process/Buffer/fetch or application/provider globals', () => {
  for (const key of ['require', 'process', 'Buffer', 'fetch', 'XMLHttpRequest']) assert.equal(vm.runInContext(`typeof ${key}`, browserContext), 'undefined');
});
check('packed source/declaration/JS maps use relative package sources without checkout paths', () => {
  for (const item of packedManifest.packedEntries.filter(item => item.path.endsWith('.map'))) {
    const mapPath = path.join(installed, item.path.replace(/^package\//, ''));
    const map = JSON.parse(fs.readFileSync(mapPath));
    assert.equal(map.sourceRoot, '');
    for (const relative of map.sources) {
      assert(!path.isAbsolute(relative), relative);
      assert(!relative.includes('/tmp/') && !relative.includes('/workspace/'));
      const resolved = path.resolve(path.dirname(mapPath), relative);
      assert(resolved.startsWith(path.join(installed, 'src') + path.sep), relative);
      assert(fs.existsSync(resolved), relative);
    }
  }
});
const toolPaths = { node: fs.realpathSync(process.execPath), typescript: tsPath,
  typescriptCli: tsc, npmCli: npm, esbuildJavaScript: esbuildPath };
const tools = Object.entries(toolPaths).map(([name, filename]) => ({ name, filename,
  sha256: sha256(fs.readFileSync(filename)) }));
const result = { sourceHead: packedManifest.sourceHead, sourceTree: packedManifest.sourceTree,
  tarballSha256: packedManifest.packs[0].sha256, integrity: packedManifest.packs[0].integrity,
  nodeVersion: process.version, typescriptVersion: ts.version, esbuildVersion: esbuild.version,
  checks, characterizationCases: originalResults.length, characterizationCasesOriginalCPackedBrowserEqual: true,
  sourceBindings, tools, browserInputs, noInstall: true, noLifecycle: true, noProvider: true,
  actualBrowserPageExecuted: false, frontendTreeChanged: false,
  limits: ['Synthetic fixed clock/random qualify existing time behavior, not production IDs.',
    'Browser-platform bundle and isolated VM execution; no browser UI or native application acceptance.',
    'NewsletterStage rich-stage contracts remain distinct from WsDocVersion snapshots.'] };
fs.writeFileSync(path.join(packet, 'CONSUMER-QUALIFICATION.json'), JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify({ checks: checks.length, characterizationCases: originalResults.length,
  packedCommonJs: 'PASS', packedEsm: 'PASS', strictNodeAndBrowserTypes: 'PASS', negativeTypes: '3 refusals each',
  browserBundleClosed: true, originalCPackedBrowserEqual: true }, null, 2));
