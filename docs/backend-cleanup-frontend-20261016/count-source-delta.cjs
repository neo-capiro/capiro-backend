const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = '016e79b585c14f20d13669e13c987c01e3dd29dd';
const parent = '4e0c189c5d0522098be1c4916a033bb681d11c0b';
const baselineReceiptSHA256 = 'fad456de08566e2e7857a0b104d18d446362ace22696d06b8219c1620e63fed6';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const raw = fs.readFileSync(process.argv[2]);
if (hash(raw) !== baselineReceiptSHA256) throw new Error('Unrecognized baseline receipt');
const receipt = JSON.parse(raw);
if (receipt.commit !== baseline) throw new Error('Wrong baseline commit');
const git = (...args) => execFileSync('git', args, {
  cwd: root, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const head = git('rev-parse', 'HEAD').toString().trim();
const original = new Map([
  ...receipt.files.map((entry) => [entry.path, { ...entry, mirror: false }]),
  ...receipt.mirrorFiles.map((entry) => [entry.path, { ...entry, mirror: true }]),
]);
const sourceExtensions = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.cts','.mts','.py','.sql','.prisma','.sh','.ps1','.cmd','.bat','.css','.scss','.html','.hcl','.tf','.go','.rs','.java','.c','.h','.cpp','.hpp','.rb','.php','.cs','.fs','.lua']);
const configExtensions = new Set(['.json','.yaml','.yml','.toml','.conf']);
const generatedHeader = /(?:^|\n)\s*(?:(?:\/\/|\/\*|\*|#|--|<!--)\s*)?(?:GENERATED FILE\b|@generated\b|(?:this (?:file|code) (?:is|was)\s+)?auto[- ]?generated\b|this (?:file|code) (?:is|was) generated\b|Code generated .*DO NOT EDIT)/i;
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
function category(file) {
  if (/(?:^|\/)(?:test|tests|__tests__|__fixtures__|fixtures|eval|evals|e2e)(?:\/|$)|(?:\.spec\.|\.test\.|\.e2e-spec\.|(?:^|\/)test[_-]|[._-]test-support\.)/.test(file)) return 'tests-fixtures-evals';
  if (/^(?:infra|scripts|docker)\//.test(file) || /\/scripts\//.test(file) || /\/(?:prisma|migrations)\//.test(file) || /(?:^|\/)Dockerfile(?:\.|$)/.test(file) || /(?:^|\/)(?:jest|vite|postcss|tailwind|playwright|eslint|webpack|vitest)[^/]*config/.test(file)) return 'infra-scripts-schema-config';
  if (/^apps\/(?:web|onboard-web)\//.test(file)) return 'retained-frontend-app-source';
  return 'backend-app-library-source';
}
const before = { unique: receipt.authoredSourceWithoutTrustedMirror, mirror: receipt.trustedFirstPartyMirror, physical: receipt.physicalFirstPartyTotalIncludingTrustedMirror };
const after = structuredClone(before);
const changes = [], excludedChanges = [];
for (const row of git('diff','--no-renames','--name-status',baseline,head).toString().trim().split('\n')) {
  if (!row) continue;
  const [status,file] = row.split('\t');
  const old = original.get(file);
  const reason = excluded(file);
  if (!old && reason) { excludedChanges.push({path:file,status,reason}); continue; }
  let entry = null;
  if(status !== 'D') {
    const row=git('ls-tree',head,'--',file).toString().trim();
    const match=row.match(/^(\d+) (\S+) ([a-f0-9]{40})\t/);
    if(!match)throw new Error('Unresolvable changed Git entry: '+file);
    entry={mode:match[1],type:match[2],blob:match[3]};
  }
  const regularBlob=entry?.type==='blob' && ['100644','100755'].includes(entry.mode);
  if(entry&&!regularBlob&&!old){excludedChanges.push({path:file,status,reason:'non-regular-or-non-blob',...entry});continue;}
  const bytes = regularBlob ? git('show',`${head}:${file}`) : null;
  let included = !!bytes && !reason;
  if (included) {
    try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { included = false; }
    if (generatedHeader.test(bytes.toString('utf8').split(/\r?\n/).slice(0,30).join('\n'))) included = false;
  }
  const lines = included ? bytes.toString('utf8').split(/\r\n|\n|\r/) : [];
  const previous = old ? {files:1,nonblankLines:old.nonblankLines,physicalLines:old.totalLines} : {files:0,nonblankLines:0,physicalLines:0};
  const next = included ? {files:1,nonblankLines:lines.filter(line=>/\S/u.test(line)).length,physicalLines:lines.length-(lines.at(-1)===''?1:0)} : {files:0,nonblankLines:0,physicalLines:0};
  const delta = Object.fromEntries(Object.keys(next).map(key=>[key,next[key]-previous[key]]));
  const mirror = old?.mirror ?? file.startsWith('apps/defense-api/runtime-source/');
  for (const bucket of [mirror?'mirror':'unique','physical']) for (const key of Object.keys(delta)) after[bucket][key]+=delta[key];
  changes.push({path:file,status,mirror,category:old?.category??category(file),before:previous,after:next,delta,beforeBlob:old?.oid??null,afterBlob:entry?.blob??null,afterMode:entry?.mode??null});
}
const prior = JSON.parse(git('show',`${parent}:docs/backend-cleanup-20261016/CODE-COUNTS.json`));
const deltaFromParent = Object.fromEntries(Object.keys(after).map(bucket=>[bucket,Object.fromEntries(Object.keys(after[bucket]).map(key=>[key,after[bucket][key]-prior.after[bucket][key]]))]));
const historicalQualificationData = excludedChanges.filter(e=>e.path.startsWith('tests/support/legacy-web/')&&e.path.endsWith('.txt')&&e.status!=='D').map(entry=>{
  const bytes=git('show',`${head}:${entry.path}`);return {path:entry.path,bytes:bytes.length,nonblankLines:bytes.toString('utf8').split(/\r\n|\n|\r/).filter(line=>/\S/u.test(line)).length};
});
const report = {baseline,parent,sourceHead:head,baselineReceiptSHA256,method:'Sealed baseline plus all changed Git-blob deltas, same UTF-8/nonblank/comment/exclusion/category rules; deleted files use sealed per-blob counts; no full rescan.',before,after,priorSlice:prior.after,deltaFromParent,changes,excludedChanges,historicalQualificationData,limits:'Approximate source size, not language-aware SLOC or coverage/runtime qualification. Explicitly retired main Web suites and duplicate mirror copies are accounted by exact path/blob manifests; canonical backend tests/support/data remain. Archived source operands are nonexecuted qualification data excluded under the original .txt rule and disclosed separately, not destroyed bytes.'};
fs.writeFileSync(path.join(__dirname,'CODE-COUNTS.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({baseline,parent,sourceHead:head,before,after,deltaFromParent,changedCodeFiles:changes.length,excludedChangedFiles:excludedChanges.length},null,2));
