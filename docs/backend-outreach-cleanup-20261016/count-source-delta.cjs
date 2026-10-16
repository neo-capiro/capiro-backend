const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const parent = 'a2e3eee209dc82d7536f3fc318a9d952c80e628a';
const git = (...args) => execFileSync('git', args, {
  cwd: root, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const head = git('rev-parse', 'HEAD').toString().trim();
const priorBytes = git('show', `${parent}:docs/backend-meri-loop-retirement-20261016/CODE-COUNTS.json`);
const prior = JSON.parse(priorBytes);
const sourceExtensions = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.cts','.mts','.py','.sql','.prisma','.sh','.ps1','.cmd','.bat','.css','.scss','.html','.hcl','.tf','.go','.rs','.java','.c','.h','.cpp','.hpp','.rb','.php','.cs','.fs','.lua']);
const configExtensions = new Set(['.json','.yaml','.yml','.toml','.conf']);
const generatedHeader = /(?:^|\n)\s*(?:(?:\/\/|\/\*|\*|#|--|<!--)\s*)?(?:GENERATED FILE\b|@generated\b|(?:this (?:file|code) (?:is|was)\s+)?auto[- ]?generated\b|this (?:file|code) (?:is|was) generated\b|Code generated .*DO NOT EDIT)/i;
// These are the unchanged original016e classification rules, also printed in
// the sealed PR30 counter. Only changed Git blobs are read; no repository scan.
function excluded(file) {
  if (!/^(?:apps|packages|infra|scripts|tests|evals|docker)\//.test(file)) return 'outside-first-party-code-roots';
  if (/(?:^|\/)(?:node_modules|vendor|third_party|third-party)(?:\/|$)/i.test(file)) return 'dependency-vendor';
  if (/^(?:apps|packages)\/[^/]+\/(?:dist|build|coverage|\.next|\.turbo)\//.test(file) || /^infra\/cdk\/cdk\.out\//.test(file)) return 'build-output';
  if (/^(?:apps|packages)\/[^/]+\/(?:docs|reports|data|public\/assets)\//.test(file) || /^apps\/e2e\/baselines\//.test(file) || /\/scripts\/__data__\//.test(file)) return 'documentation-evidence-or-collected-data';
  if (/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|uv\.lock)$/.test(file)) return 'lockfile';
  if (/(?:^|\/)(?:generated|__generated__)(?:\/|$)|(?:\.generated\.|\.min\.(?:js|css)$)/i.test(file)) return 'generated-name';
  const ext = path.extname(file).toLowerCase();
  if (configExtensions.has(ext)) return 'supplemental-config-data';
  if (!sourceExtensions.has(ext) && !/(?:^|\/)Dockerfile(?:\.[^/]*)?$/.test(file)) return 'non-code-extension-or-non-source-data';
  return null;
}
function measure(ref, file, present) {
  if (!present) return { files: 0, nonblankLines: 0, physicalLines: 0, blob: null };
  const entry = git('ls-tree', ref, '--', file).toString().trim().match(/^(\d+) (\S+) ([a-f0-9]{40})\t/);
  if (!entry || !['100644', '100755'].includes(entry[1]) || entry[2] !== 'blob') throw new Error('Changed source is not a regular Git blob: '+file);
  const bytes = git('show', `${ref}:${file}`);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (generatedHeader.test(content.split(/\r?\n/).slice(0,30).join('\n'))) return { files: 0, nonblankLines: 0, physicalLines: 0, blob: entry[3], excluded: 'generated-header' };
  const lines = content.split(/\r\n|\n|\r/);
  return { files: 1, nonblankLines: lines.filter(line => /\S/u.test(line)).length,
    physicalLines: lines.length-(lines.at(-1)===''?1:0), blob: entry[3] };
}
const before = structuredClone(prior.after);
const after = structuredClone(before);
const changes = [], excludedChanges = [];
for (const row of git('diff', '--no-renames', '--name-status', parent, head).toString().trim().split('\n')) {
  if (!row) continue;
  const [status, file] = row.split('\t');
  const reason = excluded(file);
  if (reason) { excludedChanges.push({ path: file, status, reason }); continue; }
  const old = measure(parent, file, status !== 'A');
  const next = measure(head, file, status !== 'D');
  const delta = Object.fromEntries(['files','nonblankLines','physicalLines'].map(key => [key, next[key]-old[key]]));
  const mirror = file.startsWith('apps/defense-api/runtime-source/');
  for (const bucket of [mirror?'mirror':'unique','physical']) for (const key of Object.keys(delta)) after[bucket][key] += delta[key];
  changes.push({ path: file, status, mirror, before: old, after: next, delta });
}
const deltaFromParent = Object.fromEntries(Object.keys(after).map(bucket => [bucket,
  Object.fromEntries(Object.keys(after[bucket]).map(key => [key, after[bucket][key]-before[bucket][key]]))]));
const report = { parent, sourceHead: head,
  sealedParentReceiptSHA256: createHash('sha256').update(priorBytes).digest('hex'),
  originalBaseline: prior.originalBaseline ?? prior.baseline, originalBefore: prior.originalBefore ?? prior.before,
  method: 'Sealed PR36 after totals plus changed regular Git-blob deltas under unchanged original016e UTF-8/nonblank/comment/exclusion rules. No full source scan.',
  before, after, deltaFromParent, changes, excludedChanges,
  limits: 'Source size only. New source-contract/fixture controls increase source intentionally. No native coverage, runtime, image or frontend acceptance claim. Historical qualification data and all old receipts retain their existing disclosed accounting.' };
fs.writeFileSync(path.join(__dirname, 'CODE-COUNTS.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({ parent, sourceHead: head, before, after, deltaFromParent, changedCodeFiles: changes.length, excludedChangedFiles: excludedChanges.length }, null, 2));
