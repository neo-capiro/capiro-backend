import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const packet = fileURLToPath(new URL('./', import.meta.url));
const helper = join(root, 'apps/api/scripts/lib/pe-phase-9-owned-postgres.sh');
const replay = readFileSync(join(root, 'apps/api/scripts/pe-phase-9-migration-replay.sh'), 'utf8');
const dir = mkdtempSync(join(packet, 'inert-probes-'));
const rows = [];
function check(name, callback) {
  try { callback(); rows.push({name, passed:true}); }
  catch (error) { rows.push({name, passed:false, error:error.message}); }
}
function bash(code, extra = {}) {
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', code], {
    encoding:'utf8', timeout:10000,
    env:{PATH:'/usr/bin:/bin', ...extra},
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
const fn = name => {
  const match = replay.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
};
try {
  check('actual helper readiness exhaustion refuses after sixty fake probes and cleans only its created ID', () => {
    const log=join(dir,'fake-docker.log');
    const id='abc01234'.repeat(8);
    const code=`set -euo pipefail
source "$PE_PROBE_HELPER"
NAME=owned-fixture; PORT=55439; IMAGE=inert-fixture; USER_NAME=fixture; PASS=fixture; KEEP=0
docker() {
  printf '%s\\n' "$*" >>"$PE_PROBE_LOG"
  if [[ "$1" == container ]]; then return 1; fi
  if [[ "$1" == run ]]; then printf '%s\\n' "$PE_PROBE_ID"; return 0; fi
  if [[ "$1" == exec ]]; then return 1; fi
  if [[ "$1" == rm ]]; then return 0; fi
  return 99
}
sleep() { :; }
trap cleanup EXIT
start_owned_postgres
printf 'MUST_NOT_REACH\\n'
`;
    const result=bash(code,{PE_PROBE_HELPER:helper,PE_PROBE_LOG:log,PE_PROBE_ID:id});
    assert.equal(result.status,1); assert.match(result.stderr,/did not become ready/);
    assert.doesNotMatch(result.stdout,/MUST_NOT_REACH/);
    const calls=readFileSync(log,'utf8').trim().split('\n');
    assert.equal(calls.filter(line=>line.startsWith('exec ')).length,60);
    assert.equal(calls.at(-1),`rm -f -v ${id}`);
  });
  for (const [input, expected] of [
    ['/c/temp directory/migrations','C:/temp directory/migrations'],
    ['/d/HEAD list.txt','D:/HEAD list.txt'],
    ['/e/MAIN list.txt','E:/MAIN list.txt'],
    ['/tmp/replay fixtures/head.txt','/tmp/replay fixtures/head.txt'],
    ['C:/already mixed/migrations','C:/already mixed/migrations'],
  ]) check(`retained actual Windows path helper: ${input}`, () => {
    const result=bash(`set -euo pipefail\ncygpath() { return 1; }\n${fn('to_win_path')}\nto_win_path "$PE_PROBE_PATH"`,{PE_PROBE_PATH:input});
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,expected+'\n');
  });
  check('actual restore block propagates fake pg_restore error and cannot reach later checks', () => {
    const start=replay.indexOf('RESTORE_LOG="$(mktemp)"');
    const end=replay.indexOf('\nHAS_TABLE=',start);
    assert.ok(start>0&&end>start);
    const block=replay.slice(start,end);
    const result=bash(`set -euo pipefail
PASS=fixture; CONTAINER_ID=${'a'.repeat(64)}; USER_NAME=fixture; DB_UPGRADE=fixture
docker() { printf 'synthetic restore refusal\\n' >&2; return 43; }
${block}
printf 'MUST_NOT_REACH\\n'
`,{TMPDIR:dir});
    assert.equal(result.status,1); assert.match(result.stderr,/base dump restore failed/);
    assert.match(result.stderr,/synthetic restore refusal/); assert.doesNotMatch(result.stdout,/MUST_NOT_REACH/);
  });
  check('recovery trap is installed before the first aside move and pg_restore keeps fail-closed flags', () => {
    assert.ok(replay.indexOf("trap 'restore_branch_migs; cleanup' EXIT") < replay.indexOf('mv "$MIG_DIR/$mig" "$ASIDE_HOST/$mig"'));
    assert.ok(replay.includes('--no-owner --no-acl --exit-on-error'));
    assert.ok(replay.includes('"$(to_win_path "$HEAD_LIST")" "$(to_win_path "$MAIN_LIST")"'));
  });
  check('fresh aside directory replaces the old destructive predictable pre-clear', () => {
    assert.ok(replay.includes('ASIDE_HOST="$(mktemp -d "${TMPDIR:-/tmp}/pe-phase9-mig-aside.XXXXXX")"'));
    assert.ok(!replay.includes('ASIDE_HOST="${TMPDIR:-/tmp}/pe-phase9-mig-aside-$$"'));
  });
  check('restore function preserves an already present destination and leaves the original aside intact', () => {
    const aside=join(dir,'aside'), migrations=join(dir,'migrations'), name='20260000000000_inert_fixture';
    mkdirSync(join(aside,name),{recursive:true});mkdirSync(join(migrations,name),{recursive:true});
    writeFileSync(join(aside,name,'original-marker.txt'),'original');
    writeFileSync(join(migrations,name,'replacement-marker.txt'),'replacement');
    const result=bash(`set -euo pipefail\n${fn('restore_branch_migs')}\nrestore_branch_migs`,{ASIDE_HOST:aside,MIG_DIR:migrations});
    assert.equal(result.status,0);assert.ok(existsSync(join(aside,name,'original-marker.txt')));
    assert.ok(existsSync(join(migrations,name,'replacement-marker.txt')));
    // This is an inherited boundary: later successful-path aside deletion is
    // unsuitable for concurrent edits. No historical source directory was used.
  });
} finally {
  rmSync(dir,{recursive:true,force:true});
}
const result={total:rows.length,passed:rows.filter(row=>row.passed).length,failed:rows.filter(row=>!row.passed).length,cases:rows,
  actualDocker:false,fullDriver:false,SQL:false,Prisma:false,nativeReplay:false,
  limits:['mocked Bash/functions only','Windows path conversion, not Windows native replay','inherited concurrent destination/aside collision remains outside tested exclusive-worktree assumption']};
writeFileSync(join(packet,'evidence/07-source-control-probes.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.failed?1:0;
