const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..'), id = process.argv[2];
if (!/^\d\d$/.test(id || '')) throw new Error('new two-digit attempt required');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const files = ['apps/api/src/context/meetings-context-plane.runtime.ts', 'apps/api/src/context/meetings-context-plane.runtime.spec.ts'];
const bind = () => files.map(file => ({ path: file, blob: git('rev-parse', `HEAD:${file}`).trim(), sha256: hash(fs.readFileSync(path.join(root, file))) }));
const before = bind(), head = git('rev-parse', 'HEAD').trim(), tree = git('rev-parse', 'HEAD^{tree}').trim();
const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'check-types.cjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: path.join(root, '.qualification-cache/tmp') }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
for (const stream of ['stdout', 'stderr']) { const data = run[stream] || Buffer.alloc(0); fs.writeFileSync(path.join(__dirname, `${id}-types-${stream}.lossless.json`), JSON.stringify({ encoding: 'base64', bytes: data.length, sha256: hash(data), data: data.toString('base64') }, null, 2) + '\n'); }
let result; try { result = JSON.parse((run.stdout || Buffer.alloc(0)).toString()); } catch {}
const unchanged = JSON.stringify(before) === JSON.stringify(bind());
const receipt = { head, tree, bindings: before, boundSourcesUnchanged: unchanged, exitCode: run.status, signal: run.signal, error: run.error && String(run.error),
  sourceFiles: result?.sources?.length, diagnostics: result?.diagnostics, command: [process.execPath, path.join(__dirname, 'check-types.cjs')],
  qualification: 'Actual strict/noUnchecked/noEmit changed-entry closure; workspace packages pinned to this Git source; published Engagement body read only for type compilation; cached third-party/Prisma declarations, no generator/DB/provider/native execution.' };
fs.writeFileSync(path.join(__dirname, `${id}-types-receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ id, exitCode: run.status, sourceFiles: result?.sources?.length, diagnostics: result?.diagnostics?.length, boundSourcesUnchanged: unchanged }));
if (run.status !== 0) console.log(result?.diagnostics || (run.stderr || Buffer.alloc(0)).toString());
process.exitCode = run.status || (!unchanged || run.error ? 1 : 0);
