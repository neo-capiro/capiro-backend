// Build source strings only. Never import or execute these shell bodies.
export function sourceAdversaries(original) {
  const active = 'scripts/entrypoint.sh';
  const clone = () => original.map(({ path, source }) => ({ path, source }));
  const cases = [];
  function add(name, transform, expected = false) {
    const snapshots = clone();
    transform(snapshots);
    cases.push({ name, snapshots, expected });
  }
  function edit(name, fn, path = active) {
    add(name, (snapshots) => {
      const snap = snapshots.find((item) => item.path === path);
      snap.source = fn(snap.source);
    });
  }
  function arm(source, mode, fn) {
    const start = source.indexOf(`  migrate-resolve-${mode})\n`);
    const end = source.indexOf('    ;;\n', start) + '    ;;\n'.length;
    if (start < 0 || end < start) throw new Error('fixture cannot locate exact manual arm');
    return source.slice(0, start) + fn(source.slice(start, end)) + source.slice(end);
  }
  add('exact LF snapshots', () => {}, true);
  add('exact trio supplied in reverse order', (snapshots) => snapshots.reverse(), true);
  add('CRLF normalization only', (snapshots) => snapshots.forEach((snap) => { snap.source = snap.source.replace(/\n/g, '\r\n'); }), true);
  add('mixed platform newline snapshots', (snapshots) => { snapshots[0].source = snapshots[0].source.replace(/\n/g, '\r\n'); }, true);
  for (const path of original.map((item) => item.path)) {
    add('missing snapshot ' + path, (snapshots) => snapshots.splice(snapshots.findIndex((item) => item.path === path), 1));
    add('duplicate snapshot ' + path, (snapshots) => snapshots.push({ ...snapshots.find((item) => item.path === path) }));
    edit('changed raw comment ' + path, (source) => source + '# independently unreviewed source change\n', path);
    edit('changed whitespace ' + path, (source) => source + '\n', path);
    edit('raw BOM ' + path, (source) => '\ufeff' + source, path);
  }
  add('extra clean snapshot', (snapshots) => snapshots.push({ path: 'scripts/other.sh', source: '# harmless\n' }));
  add('swapped path/source identities', (snapshots) => { [snapshots[0].source, snapshots[1].source] = [snapshots[1].source, snapshots[0].source]; });
  for (const path of ['entrypoint.sh', './scripts/entrypoint.sh', 'scripts/../scripts/entrypoint.sh', 'SCRIPTS/entrypoint.sh', 'scripts\\entrypoint.sh', '/app/apps/api/scripts/entrypoint.sh', 'scripts/entrypoint.sh\u200b'])
    add('unsupported active identity ' + JSON.stringify(path), (snapshots) => { snapshots[0].path = path; });
  add('pre-stripped whole trio', (snapshots) => snapshots.forEach((snap) => { snap.source = snap.source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n'); }));
  edit('stray carriage return is not CRLF', (source) => source.replace('set -e\n', 'set -e\r'));
  edit('changed default selector', (source) => source.replace('case "${1:-serve}" in', 'case "${1:-migrate-resolve-applied}" in'));
  edit('disabled fail closed envelope', (source) => source.replace('set -e\n', 'set +e\n'));
  edit('manual resolver before case', (source) => source.replace('case "${1:-serve}" in', 'prisma migrate resolve --applied hidden\ncase "${1:-serve}" in'));
  edit('nested selector envelope', (source) => source.replace('case "${1:-serve}" in', 'if false; then\ncase "${1:-serve}" in') + '\nfi\n');
  edit('resolve in normal deploy arm', (source) => source.replace('    echo "Seeding workflow templates"', '    prisma migrate resolve --applied hidden\n    echo "Seeding workflow templates"'));
  edit('automatic recovery token', (source) => source + '\nautoResolve() { prisma migrate resolve --applied hidden; }\n');
  edit('history table in operator arm', (source) => arm(source, 'applied', (body) => body.replace('    compose_database_url\n', '    echo _prisma_migrations\n    compose_database_url\n')));
  edit('rollback timestamp in operator arm', (source) => arm(source, 'rolled-back', (body) => body.replace('    compose_database_url\n', '    echo "rolled_back_at = NOW()"\n    compose_database_url\n')));
  for (const mode of ['applied', 'rolled-back']) {
    const mutate = (name, fn) => edit(mode + ': ' + name, (source) => arm(source, mode, fn));
    mutate('duplicate canonical arm', (body) => body + body);
    mutate('remove arm', () => '');
    mutate('selector alternative', (body) => body.replace(`migrate-resolve-${mode})`, `migrate-resolve-${mode}|serve)`));
    mutate('selector nested indentation', (body) => '  ' + body.replace(/\n/g, '\n  '));
    mutate('remove shift', (body) => body.replace('    shift\n', ''));
    mutate('shift two arguments', (body) => body.replace('    shift\n', '    shift 2\n'));
    mutate('remove missing-name check', (body) => body.replace(/    if \[ -z "\$\{1:-\}" \]; then[\s\S]*?    fi\n/, ''));
    mutate('empty-name check inverted', (body) => body.replace('[ -z "${1:-}" ]', '[ -n "${1:-}" ]'));
    mutate('remove composition', (body) => body.replace('    compose_database_url\n', ''));
    mutate('changed diagnostic', (body) => body.replace('(controlled recovery, see runbook)', '(automatic recovery)'));
    mutate('missing exec', (body) => body.replace('    exec node ', '    node '));
    mutate('different binary', (body) => body.replace('    exec node ', '    exec sh '));
    mutate('different schema', (body) => body.replace('--schema=./prisma/schema.prisma', '--schema=./other.prisma'));
    mutate('other resolution mode', (body) => body.replace(`--${mode} "$1"`, `--${mode === 'applied' ? 'rolled-back' : 'applied'} "$1"`));
    mutate('unquoted migration argument', (body) => body.replace(`--${mode} "$1"`, `--${mode} $1`));
    mutate('extra argument forwarding', (body) => body.replace(`--${mode} "$1"`, `--${mode} "$@"`));
    mutate('extra shell token', (body) => body.replace('    ;;\n', '    echo hidden\n    ;;\n'));
    mutate('pipe before terminator', (body) => body.replace(`--${mode} "$1"\n`, `--${mode} "$1" | cat\n`));
    mutate('semicolon after exec', (body) => body.replace(`--${mode} "$1"\n`, `--${mode} "$1"; echo hidden\n`));
    mutate('fallthrough terminator', (body) => body.replace('    ;;\n', '    ;&\n'));
    mutate('continued fallthrough terminator', (body) => body.replace('    ;;\n', '    ;;&\n'));
    mutate('continuation hides trailing command', (body) => body.replace(`--${mode} "$1"\n`, `--${mode} "$1" \\\n      extra\n`));
  }
  return cases;
}
