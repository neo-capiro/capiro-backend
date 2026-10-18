const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const text = (...args) => git(...args).toString().trim();
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const common = 'be12f4a2a2ecec43b5d02ea279d9448763415e24';
const directory = '507a789238bf9b594d93401e53a3ad73f45e4160';
const corrective = '2090c6afb26795edcfb73c46b9f3add3512ecdd8';
const head = text('rev-parse', 'HEAD');
function tree(ref) {
  return new Map(git('ls-tree', '-rz', '--full-tree', ref).toString().split('\0').filter(Boolean).map(row => {
    const [info, name] = row.split('\t'); const [mode, type, oid] = info.split(' '); return [name, { mode, type, oid }];
  }));
}
const base = tree(common), left = tree(directory), right = tree(corrective), final = tree(head);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changes = (candidate) => [...new Set([...base.keys(), ...candidate.keys()])].filter(file => !equal(base.get(file), candidate.get(file))).sort();
const directoryDelta = changes(left), correctiveDelta = changes(right);
const overlaps = directoryDelta.filter(file => correctiveDelta.includes(file));
if (overlaps.length) throw new Error(`Unexpected source/path intersection:${overlaps}`);
const mismatches = [...new Set([...base.keys(), ...left.keys(), ...right.keys(), ...final.keys()])].filter(file => {
  const expected = directoryDelta.includes(file) ? left.get(file) : correctiveDelta.includes(file) ? right.get(file) : base.get(file);
  return !equal(expected, final.get(file));
});
if (mismatches.length) throw new Error(`Unreviewed merge-tree changes:${mismatches}`);
const evidence = path.join(__dirname, 'evidence');
const types = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(path.join(evidence, '07-types-stdout.raw.lossless.json'))).data, 'base64'));
const bindings = types.sources.map(row => {
  if (row.blob) {
    const file = path.relative(root, row.path).split(path.sep).join('/'), actual = final.get(file);
    if (!actual || actual.oid !== row.blob || hash(git('cat-file', 'blob', actual.oid)) !== row.sha256) throw new Error(`Qualified Git binding changed:${file}`);
    return { ...row, relative: file, unchanged: true };
  }
  if (hash(fs.readFileSync(row.path)) !== row.sha256) throw new Error(`Cached declaration/type input changed:${row.path}`);
  return { ...row, unchanged: true };
});
const configNames = [...base.keys()].filter(file => file === 'tsconfig.base.json' || /^apps\/api\/(?:package|tsconfig(?:\.[^/]+)?)\.json$/.test(file) || /^packages\/[^/]+\/(?:package|tsconfig(?:\.[^/]+)?)\.json$/.test(file));
const configBindings = configNames.map(file => {
  if (!equal(base.get(file), final.get(file))) throw new Error(`Tracked configuration changed:${file}`);
  return { path: file, ...final.get(file), unchanged: true };
});
const result = { head, tree: text('rev-parse', 'HEAD^{tree}'), parents: text('show', '-s', '--format=%P', head).split(' '),
  commonBase: common, directoryParent: directory, correctiveParent: corrective, testedDirectorySource: '53dc10fad8eb9f2bfc77b0ddc28a7c6f29a06fc0',
  directoryDelta, correctiveDelta, overlaps, exactUnion: true, checkedRepositoryLeaves: final.size, configBindings,
  checkedGitSources: bindings.filter(row => row.blob).length, checkedCachedInputs: bindings.filter(row => !row.blob).length, bindings,
  qualification: 'Exact Git-tree and preserved checked source/config/cached-input union; no tests rerun, no new native/RLS/live or whole Core acceptance.' };
fs.writeFileSync(path.join(__dirname, 'MERGE-RECEIPT.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ head, tree: result.tree, exactUnion: true, overlaps, gitBindings: result.checkedGitSources, cachedBindings: result.checkedCachedInputs, configBindings: configBindings.length }) + '\n');
