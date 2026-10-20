const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..'), id = process.argv[2];
if (!/^\d\d$/.test(id || '')) throw new Error('new two-digit attempt required');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const paths = ['apps/api/src/context/meetings-context-plane.runtime.ts', 'apps/api/src/context/meetings-context-plane.runtime.spec.ts'];
const bind = () => paths.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))), blob: git('rev-parse', `HEAD:${file}`).trim() }));
const before = bind(), sourceHead = git('rev-parse', 'HEAD').trim(), sourceTree = git('rev-parse', 'HEAD^{tree}').trim();
const tmpdir = path.join(root, '.qualification-cache/tmp'); fs.mkdirSync(tmpdir, { recursive: true });
const args = [path.join(root, 'apps/api/node_modules/jest/bin/jest.js'), '--config', path.join(__dirname, 'focused.jest.cjs'), '--runInBand', '--json', '--outputFile', path.join(__dirname, `${id}-jest-result.json`)];
const run = cp.spawnSync(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir, NODE_ENV: 'test', NODE_OPTIONS: `--require=${path.join(__dirname, 'source-refusal-preload.cjs')}` }, maxBuffer: 4 * 1024 * 1024, timeout: 90000 });
for (const stream of ['stdout', 'stderr']) { const data = run[stream] || Buffer.alloc(0); fs.writeFileSync(path.join(__dirname, `${id}-${stream}.lossless.json`), JSON.stringify({ encoding: 'base64', bytes: data.length, sha256: hash(data), data: data.toString('base64') }, null, 2) + '\n'); }
const unchanged = JSON.stringify(before) === JSON.stringify(bind());
const receipt = { id, sourceHead, sourceTree, bindings: before, boundSourcesUnchanged: unchanged, exitCode: run.status, signal: run.signal, error: run.error && String(run.error), command: [process.execPath, ...args], tmpdir, ownedCacheDirectory: path.join(root, '.qualification-cache/meetings-unit'), qualification: 'Actual canonical factories/runtime/service source with inert ports and synthetic provider capture; no native DB/provider/paid/network/model calls.' };
fs.writeFileSync(path.join(__dirname, `${id}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ id, exitCode: run.status, boundSourcesUnchanged: unchanged }));
if (run.status !== 0) console.log((run.stdout || Buffer.alloc(0)).toString() + (run.stderr || Buffer.alloc(0)).toString());
process.exitCode = run.status || (!unchanged || run.error ? 1 : 0);
