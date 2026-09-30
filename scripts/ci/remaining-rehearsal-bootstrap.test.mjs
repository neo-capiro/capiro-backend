import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function rehearsal(session, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rehearsal-prerequisite-'));
  const log = path.join(dir, 'commands.log');
  const common = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"SELECT NOT (r.rolsuper"* ]]; then
 printf 'READ_WORKER\\n' >> "$BOOTSTRAP_TEST_LOG"
 printf '%s\\n' "$BOOTSTRAP_TEST_WORKER_SAFE"
 exit 0
fi
if [[ "$args" == *"current_database"* ]]; then exit 91; fi
body=""
if [[ "$args" == *"DO "* ]]; then body="$args"; elif [[ "$args" != *" -c "* ]]; then body="$(cat)"; fi
if [[ "$body" == *"CREATE ROLE capiro_worker"* ]]; then
 printf 'CREATE_WORKER\\n' >> "$BOOTSTRAP_TEST_LOG"
 [[ "$BOOTSTRAP_TEST_MODE" == owned ]] || exit 92
 [[ "$BOOTSTRAP_TEST_WORKER_SAFE" == t ]] || exit 93
fi
printf 'SQL\\n' >> "$BOOTSTRAP_TEST_LOG"
`;
  writeFileSync(path.join(dir, 'psql'), common, { mode: 0o755 });
  writeFileSync(
    path.join(dir, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'DOCKER %s\\n' "$1" >> "$BOOTSTRAP_TEST_LOG"
if [[ "$*" == *" psql "* ]]; then
 [[ "$BOOTSTRAP_TEST_MODE" == owned ]] || exit 94
 exec psql "$@"
fi
`,
    { mode: 0o755 },
  );
  for (const command of ['pnpm', 'npx'])
    writeFileSync(
      path.join(dir, command),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$BOOTSTRAP_TEST_MODE" == owned ]]; then
 grep -q '^CREATE_WORKER$' "$BOOTSTRAP_TEST_LOG" || exit 95
 [[ "$PGHOSTADDR" == '127.0.0.1' && -z "\${PGSERVICE+x}\${PGSERVICEFILE+x}\${PGOPTIONS+x}" ]] || exit 96
else
 grep -q '^READ_WORKER$' "$BOOTSTRAP_TEST_LOG" || exit 97
 ! grep -q '^CREATE_WORKER$' "$BOOTSTRAP_TEST_LOG" || exit 98
fi
printf 'MIGRATE_REACHED\\n' >> "$BOOTSTRAP_TEST_LOG"
exit 79
`,
      { mode: 0o755 },
    );
  const env = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    BOOTSTRAP_TEST_LOG: log,
    BOOTSTRAP_TEST_MODE: mode.startsWith('owned') ? 'owned' : 'external',
    BOOTSTRAP_TEST_WORKER_SAFE: mode.endsWith('unsafe') ? 'f' : 't',
    PGHOSTADDR: '203.0.113.8',
    PGSERVICE: 'redirect',
    PGSERVICEFILE: 'untrusted',
    PGOPTIONS: '-c search_path=untrusted',
  };
  if (mode.startsWith('owned')) delete env.REHEARSAL_DATABASE_URL;
  else env.REHEARSAL_DATABASE_URL = 'postgresql://fixture:fixture@invalid.invalid/owned_test';
  const result = spawnSync(
    'bash',
    [path.join(root, `scripts/verify-phase8-session${session}-db.sh`)],
    { env, encoding: 'utf8', timeout: 15000 },
  );
  return { result, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}
for (const session of [7, 8, 9, 10]) {
  test(`Session ${session} supplies the restricted prerequisite before its owned replay`, () => {
    const { result, log } = rehearsal(session, 'owned');
    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null, result.stderr);
    assert.match(log, /CREATE_WORKER/);
    assert.match(log, /MIGRATE_REACHED/);
    assert.ok(log.indexOf('CREATE_WORKER') < log.indexOf('MIGRATE_REACHED'));
  });
  test(`Session ${session} rejects an unsafe owned worker before replay`, () => {
    const { result, log } = rehearsal(session, 'owned-unsafe');
    assert.notEqual(result.status, 0);
    assert.match(log, /CREATE_WORKER/);
    assert.doesNotMatch(log, /MIGRATE_REACHED/);
  });
  test(`Session ${session} checks an external worker without creating one or using Docker`, () => {
    const { result, log } = rehearsal(session, 'external');
    assert.notEqual(result.status, 0);
    assert.match(log, /READ_WORKER/);
    assert.match(log, /MIGRATE_REACHED/);
    assert.doesNotMatch(log, /CREATE_WORKER|DOCKER/);
  });
  test(`Session ${session} refuses an unsafe external worker before SQL writes`, () => {
    const { result, log } = rehearsal(session, 'external-unsafe');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing safe capiro_worker/);
    assert.match(log, /READ_WORKER/);
    assert.doesNotMatch(log, /CREATE_WORKER|MIGRATE_REACHED|SQL|DOCKER/);
  });
  test(`Session ${session} shell syntax is valid`, () => {
    const r = spawnSync(
      'bash',
      ['-n', path.join(root, `scripts/verify-phase8-session${session}-db.sh`)],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
  });
}
